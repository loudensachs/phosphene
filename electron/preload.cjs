// Preload: file access and the ffmpeg pipe live here so frames go straight from the renderer process to the encoder.
const { contextBridge, ipcRenderer, webUtils } = require('electron');
const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');
const dgram = require('node:dgram');
const path = require('node:path');
const os = require('node:os');

// Minimal OSC 1.0 decoder: messages and bundles, numeric arguments.
function oscParse(buf, out) {
  const str = o => { let e = o; while (e < buf.length && buf[e] !== 0) e++; return [buf.toString('utf8', o, e), (e + 4) & ~3]; };
  const walk = (o, end) => {
    const [addr, o1] = str(o);
    if (addr === '#bundle') { let q = o1 + 8; while (q + 4 <= end) { const n = buf.readInt32BE(q); q += 4; if (n <= 0 || q + n > end) break; walk(q, q + n); q += n; } return; }
    if (addr[0] !== '/' || o1 >= end) return;
    const [tags, o2] = str(o1);
    let q = o2; const args = [];
    for (const t of tags.slice(1)) {
      if (t === 'f' && q + 4 <= end) { args.push(buf.readFloatBE(q)); q += 4; }
      else if (t === 'i' && q + 4 <= end) { args.push(buf.readInt32BE(q)); q += 4; }
      else if (t === 'd' && q + 8 <= end) { args.push(buf.readDoubleBE(q)); q += 8; }
      else if (t === 'T') args.push(1); else if (t === 'F') args.push(0);
      else if (t === 's') { q = str(q)[1]; }
      else break;
    }
    out.push([addr, args]);
  };
  try { walk(0, buf.length); } catch { /* malformed packet */ }
}
let oscSock = null;
const stems = require('./stems.cjs');
const stock = require('./stock.cjs');

function findFfmpeg() {
  for (const p of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']) if (fs.existsSync(p)) return p;
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg']);
  const p = r.status === 0 ? r.stdout.toString().split('\n')[0].trim() : '';
  return p || null;
}

const jobs = new Map();
let seq = 0;

function codecArgs(o) {
  const tags = ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'];
  const crf = String(o.crf ?? 16);
  switch (o.codec) {
    case 'prores422hq': return { v: ['-c:v', 'prores_ks', '-profile:v', '3', '-vendor', 'apl0', '-pix_fmt', 'yuv422p10le', ...tags], a: ['-c:a', 'pcm_s24le'] };
    case 'prores4444': return { v: ['-c:v', 'prores_ks', '-profile:v', '4', '-vendor', 'apl0', '-pix_fmt', 'yuv444p10le', ...tags], a: ['-c:a', 'pcm_s24le'] };
    case 'h265': return { v: ['-c:v', 'libx265', '-preset', 'slow', '-crf', crf, '-pix_fmt', 'yuv420p10le', '-tag:v', 'hvc1', ...tags, '-movflags', '+faststart'], a: ['-c:a', 'aac', '-b:a', '320k'] };
    default: return { v: ['-c:v', 'libx264', '-preset', 'slow', '-crf', crf, '-pix_fmt', 'yuv420p', ...tags, '-movflags', '+faststart'], a: ['-c:a', 'aac', '-b:a', '320k'] };
  }
}

// ---- Claude CLI bridge: the effect assistant shells out to the user's own `claude` command in print mode ----
let aiProc = null;
function findClaude() {
  const home = os.homedir();
  for (const p of [path.join(home, '.local/bin/claude'), path.join(home, '.claude/local/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude']) if (fs.existsSync(p)) return p;
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude']);
  const p = r.status === 0 ? r.stdout.toString().split('\n')[0].trim() : '';
  return p || null;
}
function aiRun(o) {
  const bin = findClaude();
  if (!bin) return Promise.resolve({ ok: false, error: 'The claude command was not found. Install Claude Code and sign in, then try again.' });
  return new Promise(res => {
    // no tools, no saved session, a neutral folder: this is a single question and answer, not an agent with access to the Mac
    const args = ['-p', '--model', o.model, '--output-format', 'json', '--no-session-persistence', '--tools', '', '--system-prompt', o.system, '--json-schema', JSON.stringify(o.schema)];
    if (o.effort) args.push('--effort', o.effort);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphene-ai-'));
    const env = { ...process.env, PATH: `${path.dirname(bin)}:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}` };
    let out = '', err = '';
    const proc = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    aiProc = proc;
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => { err += d.toString(); });
    proc.on('error', e => res({ ok: false, error: String(e.message || e) }));
    proc.on('close', code => {
      if (aiProc === proc) aiProc = null;
      try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
      if (proc.killed) return res({ ok: false, error: 'Cancelled.' });
      try {
        const d = JSON.parse(out.slice(out.indexOf('{')));
        if (d.is_error || !d.structured_output) return res({ ok: false, error: String(d.result || err || `claude exited with code ${code}`).slice(0, 600) });
        const mu = Object.values(d.modelUsage || {})[0] || {};
        res({ ok: true, data: d.structured_output, ms: d.duration_ms, model: Object.keys(d.modelUsage || {})[0], tokens: (mu.inputTokens || 0) + (mu.cacheReadInputTokens || 0) + (mu.cacheCreationInputTokens || 0), outTokens: mu.outputTokens || 0, costBasis: mu.costBasis, cost: d.total_cost_usd });
      } catch { res({ ok: false, error: (err || out || `claude exited with code ${code}`).trim().slice(0, 600) }); }
    });
    proc.stdin.end(o.prompt);
  });
}

// Footage statistics for Auto Edit: a tiny greyscale copy of the clip at a few frames per second, reduced to how much
// changes between frames (motion) and how bright each frame is.
function footageStats(file, rate) {
  const bin = findFfmpeg();
  if (!bin) return Promise.resolve({ error: 'ffmpeg not found' });
  return new Promise(res => {
    const W = 32, H = 18, chunks = [];
    // keyframes only: a few per second on camera footage, and an order of magnitude quicker than decoding everything
    const proc = spawn(bin, ['-v', 'error', '-skip_frame', 'nokey', '-i', file, '-an', '-fps_mode', 'passthrough', '-vf', `scale=${W}:${H}:flags=area,format=gray`, '-f', 'rawvideo', '-'], { stdio: ['ignore', 'pipe', 'ignore'] });
    proc.stdout.on('data', d => chunks.push(d));
    proc.on('error', e => res({ error: String(e) }));
    proc.on('close', () => {
      const buf = Buffer.concat(chunks), n = Math.floor(buf.length / (W * H)), motion = [], luma = [];
      for (let f = 0; f < n; f++) {
        let m = 0, l = 0;
        for (let i = 0; i < W * H; i++) { const v = buf[f * W * H + i]; l += v; if (f) m += Math.abs(v - buf[(f - 1) * W * H + i]); }
        luma.push(l / (W * H * 255)); motion.push(f ? m / (W * H * 255) : 0);
      }
      if (motion.length > 1) motion[0] = motion[1];
      res({ rate: rate > 0 ? n / rate : 4, motion, luma });   // `rate` arrives as the clip's duration
    });
  });
}

// Small colour frames for finding the subject: two per second, 256 pixels wide.
function footageFrames(file, dur) {
  const bin = findFfmpeg();
  if (!bin) return Promise.resolve({ error: 'ffmpeg not found' });
  return new Promise(res => {
    const W = 320, chunks = [];
    const probe = spawn(bin, ['-v', 'error', '-i', file, '-frames:v', '1', '-vf', `scale=${W}:-2`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const pc = [];
    probe.stdout.on('data', d => pc.push(d));
    probe.on('error', e => res({ error: String(e) }));
    probe.on('close', () => {
      const H = Math.round(Buffer.concat(pc).length / W);
      if (!H) { res({ error: 'could not read the footage' }); return; }
      const fps = dur > 120 ? 1 : 2;
      const proc = spawn(bin, ['-v', 'error', '-hwaccel', 'videotoolbox', '-i', file, '-an', '-vf', `fps=${fps},scale=${W}:${H}:flags=area,format=rgba`, '-f', 'rawvideo', '-'], { stdio: ['ignore', 'pipe', 'ignore'] });
      proc.stdout.on('data', d => chunks.push(d));
      proc.on('error', e => res({ error: String(e) }));
      proc.on('close', () => { const buf = Buffer.concat(chunks); res({ rate: fps, w: W, h: H, n: Math.floor(buf.length / (W * H * 4)), data: new Uint8Array(buf.buffer, buf.byteOffset, buf.length) }); });
    });
  });
}

// Shot changes inside a piece of footage: ffmpeg's scene score on a small, 10 fps copy. Returns cut times in seconds.
function footageScenes(file) {
  const bin = findFfmpeg();
  if (!bin) return Promise.resolve({ error: 'ffmpeg not found' });
  return new Promise(res => {
    let err = '';
    const proc = spawn(bin, ['-hide_banner', '-hwaccel', 'videotoolbox', '-i', file, '-an', '-vf', "fps=10,scale=160:-2,select='gt(scene\\,0.3)',showinfo", '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] });
    proc.stderr.on('data', d => { err += d; if (err.length > 4e6) err = err.slice(-2e6); });
    proc.on('error', e => res({ error: String(e) }));
    proc.on('close', () => {
      const cuts = [];
      for (const m of err.matchAll(/pts_time:([0-9.]+)/g)) cuts.push(+(+m[1]).toFixed(2));
      res({ cuts });
    });
  });
}

contextBridge.exposeInMainWorld('phosphene', {
  footageScenes: file => footageScenes(file),
  footageFrames: (file, dur) => footageFrames(file, dur),
  footageStats: (file, rate) => footageStats(file, rate),
  aiRun: o => aiRun(o),
  aiCancel: () => { try { aiProc?.kill(); } catch {} },
  aiAvailable: () => !!findClaude(),
  platform: process.platform,
  stemsSeparate: (audioPath, onProgress) => stems.separate(audioPath, onProgress),
  stock: stock.api,
  /** Listen for OSC over UDP. `cb` receives batches of [address, numbers[]]. Resolves with an error string or null. */
  oscListen(port, cb) {
    return new Promise(res => {
      try { oscSock?.close(); } catch { /* already closed */ }
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      oscSock = sock;
      sock.on('message', m => { const out = []; oscParse(m, out); if (out.length) cb(out); });
      sock.once('error', e => res(String(e.message || e)));
      sock.bind(port, () => res(null));
    });
  },
  fileSize: p => { try { return fs.statSync(p).size; } catch { return 0; } },
  confirmSave: name => ipcRenderer.invoke('confirmSave', name),
  ask: o => ipcRenderer.invoke('ask', o),
  closeNow: () => ipcRenderer.send('closeNow'),
  onCloseRequest: cb => { ipcRenderer.on('closeRequest', () => cb()); },
  onOpenFile: cb => { ipcRenderer.on('openFile', (_e, p) => cb(p)); },
  takePendingOpen: () => ipcRenderer.invoke('takePendingOpen'),
  docState: st => ipcRenderer.send('docState', st),
  addRecent: p => ipcRenderer.send('recent', p),
  clearRecent: () => ipcRenderer.send('clearRecent'),
  setMenu: spec => ipcRenderer.send('menu:set', spec),
  onMenu: cb => { ipcRenderer.on('menu:run', (_e, id) => cb(id)); },
  userPath: n => ipcRenderer.invoke('userPath', n),
  exists: p => ipcRenderer.invoke('exists', p),
  unlink: p => ipcRenderer.invoke('unlink', p),
  pickFile: f => ipcRenderer.invoke('pickFile', f),
  pickPaths: f => ipcRenderer.invoke('pickPaths', f),
  pathFor: file => webUtils.getPathForFile(file),
  openDialog: f => ipcRenderer.invoke('openDialog', f),
  saveDialog: (n, f) => ipcRenderer.invoke('saveDialog', n, f),
  tempPath: n => ipcRenderer.invoke('tempPath', n),
  reveal: p => ipcRenderer.send('reveal', p),
  async readFile(p) {
    try { const b = await fs.promises.readFile(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } catch { return null; }
  },
  writeFile: (p, data) => fs.promises.writeFile(p, typeof data === 'string' ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength)),

  /** Export cache: copy [start, start+dur) of a video into an all-keyframe, near-lossless file that seeks instantly. */
  footageProxy(src, start, dur, out, onProgress) {
    const bin = findFfmpeg();
    if (!bin) return Promise.resolve({ ok: false, log: 'ffmpeg not found' });
    return new Promise(res => {
      const args = ['-y', '-hide_banner', '-loglevel', 'error', '-progress', 'pipe:1', '-ss', String(start), '-i', src, '-t', String(dur), '-an', '-sn',
        '-c:v', 'libx264', '-preset', 'veryfast', '-qp', '10', '-g', '1', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out];
      const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let log = '';
      proc.stderr.on('data', d => { log += d.toString(); });
      proc.stdout.on('data', d => { const m = /out_time_us=(\d+)/.exec(d.toString()); if (m && onProgress) onProgress(Math.min(1, +m[1] / 1e6 / dur)); });
      proc.on('error', e => res({ ok: false, log: String(e) }));
      proc.on('close', code => res({ ok: code === 0, log }));
    });
  },
  async ffmpegStart(o) {
    const bin = findFfmpeg();
    if (!bin) return { error: 'ffmpeg was not found. Install it (brew install ffmpeg) and try again.' };
    const c = codecArgs(o);
    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', o.pixfmt, '-s', `${o.width}x${o.height}`, '-r', String(o.fps), '-i', 'pipe:0'];
    if (o.audioPath) args.push('-i', o.audioPath);
    args.push(...c.v);
    if (o.audioPath) args.push(...c.a, '-shortest');
    args.push(o.path);
    const proc = spawn(bin, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    const job = { proc, log: '', done: null, failed: false };
    proc.stderr.on('data', d => { job.log += d.toString(); });
    proc.stdin.on('error', () => { job.failed = true; });
    job.done = new Promise(res => proc.on('close', code => res({ ok: code === 0, log: job.log })));
    const id = ++seq;
    jobs.set(id, job);
    return { id };
  },
  ffmpegWrite(id, frame) {
    const job = jobs.get(id);
    if (!job || job.failed) return Promise.reject(new Error(job ? job.log || 'ffmpeg closed its input' : 'no such encode job'));
    const buf = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
    return new Promise((res, rej) => {
      const ok = job.proc.stdin.write(buf, err => { if (err) rej(err); });
      if (ok) res(); else job.proc.stdin.once('drain', res);
    });
  },
  async ffmpegFinish(id) {
    const job = jobs.get(id);
    if (!job) return { ok: false, log: 'no such encode job' };
    job.proc.stdin.end();
    const r = await job.done;
    jobs.delete(id);
    return r;
  },
  ffmpegCancel(id) { const job = jobs.get(id); if (job) { job.proc.kill('SIGKILL'); jobs.delete(id); } },
});
