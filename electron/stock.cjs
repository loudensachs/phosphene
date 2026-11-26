// Stock footage library: downloads free clips (Internet Archive, Wikimedia Commons, NASA) into ~/Movies/Phosphene/Stock,
// keeps a JSON sidecar with licence and credit next to each file, and converts unplayable clips to H.264 with ffmpeg.
// Node APIs only. Requests carry a generic User-Agent and nothing but the URL the renderer asked for.
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { spawn, spawnSync } = require('node:child_process');

const DIR = path.join(os.homedir(), 'Movies', 'Phosphene', 'Stock');
const UA = 'PhospheneStock/1.0 (desktop video app)';
// hosts the JSON proxy may reach (used for endpoints that do not send CORS headers to the renderer)
const PROXY_HOSTS = ['images-assets.nasa.gov', 'images-api.nasa.gov', 'archive.org', 'commons.wikimedia.org'];
const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.ogv']);
const active = new Map(); // destName -> { req, cancelled }

const ensureDir = () => fsp.mkdir(DIR, { recursive: true });
const safeName = n => String(n).replace(/[^\w.\-]+/g, '_').replace(/^\.+/, '').slice(0, 160) || 'clip';
const inDir = n => { const p = path.join(DIR, safeName(n)); if (path.dirname(p) !== DIR) throw new Error('bad name'); return p; };

/** GET/HEAD with redirects. Resolves the final response (caller consumes or destroys it). */
function request(url, { method = 'GET', redirects = 8, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { reject(new Error('bad URL')); return; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') { reject(new Error('unsupported protocol')); return; }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method, headers: { 'User-Agent': UA, Accept: '*/*', ...headers }, timeout: 30000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) { reject(new Error('too many redirects')); return; }
        // NASA's asset index lists http:// links; upgrade them
        let next = new URL(res.headers.location, u);
        if (next.protocol === 'http:' && u.protocol === 'https:') next.protocol = 'https:';
        request(next.href, { method, redirects: redirects - 1, headers }).then(resolve, reject);
        return;
      }
      resolve(Object.assign(res, { req }));
    });
    req.on('timeout', () => req.destroy(new Error('connection timed out')));
    req.on('error', reject);
    req.end();
  });
}

function netError(e) {
  const c = e && e.code;
  if (c === 'ENOTFOUND' || c === 'EAI_AGAIN' || c === 'ENETUNREACH' || c === 'ECONNREFUSED') return 'Cannot reach the server. Check your internet connection.';
  if (c === 'ECONNRESET') return 'The connection was reset by the server.';
  return String((e && e.message) || e);
}

async function fetchJson(url) {
  const u = new URL(url);
  if (u.protocol === 'http:') u.protocol = 'https:';
  if (!PROXY_HOSTS.includes(u.hostname)) throw new Error('host not allowed');
  const res = await request(u.href);
  if (res.statusCode !== 200) { res.resume(); throw new Error(`HTTP ${res.statusCode}`); }
  const chunks = [];
  for await (const c of res) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function head(url) {
  try {
    const res = await request(url.replace(/^http:/, 'https:'), { method: 'HEAD' });
    res.resume();
    return { ok: res.statusCode === 200, size: +(res.headers['content-length'] || 0), type: String(res.headers['content-type'] || '') };
  } catch (e) { return { ok: false, size: 0, type: '', error: netError(e) }; }
}

/**
 * Download `url` to the library as `destName`. `onProgress(received, total)` is throttled to ~10 Hz.
 * `meta` (title, source, licence, author, credit, ...) is written as `<destName>.json`.
 * Resolves { path, size } or { error }. Never rejects.
 */
async function download(url, destName, onProgress, meta) {
  let dest, part;
  try { await ensureDir(); dest = inDir(destName); part = dest + '.part'; } catch (e) { return { error: netError(e) }; }
  if (active.has(path.basename(dest))) return { error: 'Already downloading.' };
  const job = { req: null, cancelled: false };
  active.set(path.basename(dest), job);
  try {
    const res = await request(url.replace(/^http:/, 'https:'));
    job.req = res.req;
    if (res.statusCode === 429 || res.statusCode === 503) {
      res.resume();
      const wait = Math.ceil((+res.headers['retry-after'] || 60) / 60);
      throw new Error(`The source is busy or rate-limiting downloads. Try again in about ${wait} minute${wait > 1 ? 's' : ''}.`);
    }
    if (res.statusCode !== 200) { res.resume(); throw new Error(`The server answered HTTP ${res.statusCode}.`); }
    const total = +(res.headers['content-length'] || 0);
    let got = 0, last = 0;
    const out = fs.createWriteStream(part);
    await new Promise((resolve, reject) => {
      res.on('data', c => {
        got += c.length;
        const now = Date.now();
        if (onProgress && now - last > 100) { last = now; try { onProgress(got, total); } catch { /* renderer gone */ } }
      });
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('The download was interrupted.')));
      out.on('error', reject);
      out.on('finish', resolve);
      res.pipe(out);
    });
    if (job.cancelled) throw new Error('Cancelled.');
    if (total && got !== total) throw new Error('The download was incomplete.');
    await fsp.rename(part, dest);
    if (onProgress) try { onProgress(got, total || got); } catch { /* ignore */ }
    const side = { ...(meta || {}), file: path.basename(dest), url, size: got, downloaded: new Date().toISOString() };
    await fsp.writeFile(dest + '.json', JSON.stringify(side, null, 2));
    return { path: dest, size: got };
  } catch (e) {
    await fsp.rm(part, { force: true }).catch(() => {});
    return { error: job.cancelled ? 'Cancelled.' : netError(e) };
  } finally { active.delete(path.basename(dest)); }
}

function cancel(destName) {
  const job = active.get(safeName(destName));
  if (job) { job.cancelled = true; job.req?.destroy(new Error('Cancelled.')); }
}

/** Every clip in the library with its sidecar metadata, newest first. */
async function list() {
  await ensureDir();
  const names = await fsp.readdir(DIR);
  const out = [];
  for (const n of names) {
    if (!VIDEO_EXT.has(path.extname(n).toLowerCase())) continue;
    const p = path.join(DIR, n);
    try {
      const st = await fsp.stat(p);
      let meta = {};
      try { meta = JSON.parse(await fsp.readFile(p + '.json', 'utf8')); } catch { /* clip without sidecar */ }
      out.push({ ...meta, file: n, path: p, size: st.size, mtime: st.mtimeMs });
    } catch { /* vanished */ }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** Delete a clip and its sidecar (by file name or absolute path inside the library). */
async function remove(name) {
  const p = inDir(path.basename(name));
  await fsp.rm(p, { force: true });
  await fsp.rm(p + '.json', { force: true });
  return true;
}

function ffmpegPath() {
  for (const p of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']) if (fs.existsSync(p)) return p;
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg']);
  return (r.status === 0 && r.stdout.toString().split('\n')[0].trim()) || null;
}

/**
 * Convert a library clip to H.264/AAC MP4 (≤1080p). Replaces the original and moves its sidecar.
 * `onProgress(fraction)` when the duration is known. Resolves { path } or { error }.
 */
async function convert(name, onProgress) {
  const bin = ffmpegPath();
  if (!bin) return { error: 'ffmpeg was not found. Install it (brew install ffmpeg) to convert clips.' };
  let src;
  try { src = inDir(path.basename(name)); await fsp.access(src); } catch { return { error: 'Clip not found in the library.' }; }
  const base = path.basename(src, path.extname(src));
  const dest = path.join(DIR, (path.extname(src).toLowerCase() === '.mp4' ? base + '.h264' : base) + '.mp4');
  const tmp = dest + '.part.mp4';
  const args = ['-y', '-hide_banner', '-nostdin', '-i', src, '-map', '0:v:0', '-map', '0:a:0?', '-vf', "scale='min(1920,iw)':-2", '-c:v', 'libx264',
    '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', tmp];
  const r = await new Promise(res => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let log = '', dur = 0;
    proc.stderr.on('data', d => {
      const s = d.toString(); log = (log + s).slice(-4000);
      const dm = /Duration: (\d+):(\d+):([\d.]+)/.exec(s); if (dm) dur = +dm[1] * 3600 + +dm[2] * 60 + +dm[3];
      const tm = /time=(\d+):(\d+):([\d.]+)/.exec(s);
      if (tm && dur && onProgress) try { onProgress(Math.min(1, (+tm[1] * 3600 + +tm[2] * 60 + +tm[3]) / dur)); } catch { /* ignore */ }
    });
    proc.on('error', e => res({ ok: false, log: String(e.message) }));
    proc.on('close', code => res({ ok: code === 0, log }));
  });
  if (!r.ok) { await fsp.rm(tmp, { force: true }); return { error: 'Conversion failed: ' + r.log.trim().split('\n').pop() }; }
  await fsp.rename(tmp, dest);
  let meta = {};
  try { meta = JSON.parse(await fsp.readFile(src + '.json', 'utf8')); } catch { /* none */ }
  const st = await fsp.stat(dest);
  await fsp.writeFile(dest + '.json', JSON.stringify({ ...meta, file: path.basename(dest), size: st.size, convertedFrom: path.basename(src) }, null, 2));
  if (dest !== src) { await fsp.rm(src, { force: true }); await fsp.rm(src + '.json', { force: true }); }
  return { path: dest };
}

const wrap = f => async (...a) => { try { return await f(...a); } catch (e) { return { error: netError(e) }; } };

module.exports = {
  dir: DIR,
  download, cancel, list, remove, convert, fetchJson, head, ffmpegPath,
  /** Surface exposed to the renderer through contextBridge. */
  api: {
    dir: DIR,
    download: (url, destName, onProgress, meta) => download(url, destName, onProgress, meta),
    cancel: n => cancel(n),
    list: () => list().catch(() => []),
    remove: n => remove(n).catch(() => false),
    convert: (n, onProgress) => convert(n, onProgress),
    fetchJson: wrap(fetchJson),
    head: u => head(u),
    hasFfmpeg: () => !!ffmpegPath(),
  },
};
