// Stem separation service (drums / bass / vocals / other). Implemented by spawning an open-source separator.
// Contract: separate(audioPath, onProgress) resolves { stems: { drums, bass, vocals, other } } with absolute WAV paths,
// or { error } with a short plain message. onProgress receives { stage, fraction } updates. Never rejects.
//
// How it works:
// - Separator: Demucs (htdemucs, 4 stems) from PyPI (`demucs` 4.1+, which loads its weights from Hugging Face and no
//   longer depends on torchaudio, so it installs on current Python). Installed on first use into a private venv at
//   ~/Library/Application Support/Phosphene/stems-env, model weights in .../stems-env/hf. Nothing system-wide.
// - Runs on Apple GPU (MPS) when available, retries on CPU automatically if that fails.
// - The input is normalised with ffmpeg to 44.1 kHz stereo 16-bit WAV (handles mp3/m4a/flac/video files).
// - Results are cached in .../stems-cache/<hash of path+size+mtime>/ ; a manifest.json written last marks a complete set.
// - `fraction` is the progress within the current `stage` (it restarts at 0 when the stage changes).
// - Concurrent calls for the same file share one job; different files are separated one at a time.
// - Child processes are killed when this process exits; the Python side also watches its parent and quits if orphaned.
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const MODEL = 'htdemucs';
const STEMS = ['drums', 'bass', 'vocals', 'other'];
const PACKAGES = ['demucs>=4.1,<5', 'numpy'];
const SETUP_VERSION = 1; // bump to force a reinstall of the environment
const APP_DIR = process.platform === 'darwin'
  ? path.join(os.homedir(), 'Library', 'Application Support', 'Phosphene')
  : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'Phosphene');
const ENV_DIR = path.join(APP_DIR, 'stems-env');
const HF_DIR = path.join(ENV_DIR, 'hf');
const READY_FILE = path.join(ENV_DIR, 'phosphene-ready.json');
const CACHE_DIR = path.join(APP_DIR, 'stems-cache');
const VENV_PY = process.platform === 'win32' ? path.join(ENV_DIR, 'Scripts', 'python.exe') : path.join(ENV_DIR, 'bin', 'python');
const EXTRA_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];

// Runs a module (or a code string when the module is "-") after starting a thread that exits if our process dies.
const PY_WRAPPER = [
  'import os, sys, threading, time, runpy',
  'pp = int(sys.argv[1]); mod = sys.argv[2]',
  'def watch():',
  '    while True:',
  '        time.sleep(1)',
  '        try: os.kill(pp, 0)',
  '        except OSError: os._exit(3)',
  '        if os.getppid() != pp: os._exit(3)',
  'threading.Thread(target=watch, daemon=True).start()',
  'if mod == "-":',
  '    code = sys.argv[3]; sys.argv = ["-c"] + sys.argv[4:]; exec(compile(code, "<phosphene>", "exec"), {"__name__": "__main__"})',
  'else:',
  '    sys.argv = [mod] + sys.argv[3:]; runpy.run_module(mod, run_name="__main__", alter_sys=True)',
].join('\n');

const PY_PREFETCH = [
  'import torch',
  'from demucs.pretrained import get_model',
  `get_model(${JSON.stringify(MODEL)})`,
  'print("PHOSPHENE_MPS=" + ("1" if torch.backends.mps.is_available() else "0"), flush=True)',
].join('\n');

class StemError extends Error {}
const fail = msg => { throw new StemError(msg); };

// ---------- child process tracking ----------
const children = new Set();
let exitHooked = false;
function killAll() {
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  children.clear();
}
function hookExit() {
  if (exitHooked) return;
  exitHooked = true;
  process.once('exit', killAll);
  if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('beforeunload', killAll);
}

function baseEnv(extra) {
  const pathParts = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const p of EXTRA_PATH) if (!pathParts.includes(p)) pathParts.push(p);
  const env = { ...process.env, PATH: pathParts.join(path.delimiter), PYTHONUNBUFFERED: '1', PYTHONNOUSERSITE: '1',
    PIP_DISABLE_PIP_VERSION_CHECK: '1', PIP_NO_INPUT: '1', HF_HOME: HF_DIR, TORCH_HOME: path.join(ENV_DIR, 'torch'),
    HF_HUB_DISABLE_TELEMETRY: '1', HF_HUB_DISABLE_IMPLICIT_TOKEN: '1', HF_HUB_DISABLE_SYMLINKS_WARNING: '1',
    PYTORCH_ENABLE_MPS_FALLBACK: '1', TOKENIZERS_PARALLELISM: 'false', ...extra };
  for (const k of ['PYTHONPATH', 'PYTHONHOME', 'VIRTUAL_ENV', 'ELECTRON_RUN_AS_NODE']) delete env[k];
  return env;
}

/** Spawn a process, stream stderr+stdout lines (split on \r and \n) to onLine, resolve { code, signal, out, tail }. */
function run(cmd, args, { onLine, env, cwd } = {}) {
  hookExit();
  return new Promise(resolve => {
    let child;
    try { child = spawn(cmd, args, { env: env || baseEnv(), cwd, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { resolve({ code: -1, signal: null, out: '', tail: String(e && e.message), spawnError: e }); return; }
    children.add(child);
    let out = '', tail = '', partial = { o: '', e: '' };
    const feed = (key, chunk) => {
      const s = chunk.toString('utf8');
      if (key === 'o') out = (out + s).slice(-200000);
      tail = (tail + s).slice(-30000);
      const parts = (partial[key] + s).split(/[\r\n]/);
      partial[key] = parts.pop();
      if (onLine) for (const l of parts) if (l.trim()) { try { onLine(l); } catch { /* ignore */ } }
    };
    child.stdout.on('data', c => feed('o', c));
    child.stderr.on('data', c => feed('e', c));
    let spawnError = null;
    child.on('error', e => { spawnError = e; });
    child.on('close', (code, signal) => {
      children.delete(child);
      if (onLine) for (const k of ['o', 'e']) if (partial[k].trim()) { try { onLine(partial[k]); } catch { /* ignore */ } }
      resolve({ code: spawnError ? -1 : code, signal, out, tail: spawnError ? String(spawnError.message) : tail, spawnError });
    });
  });
}

const runPy = (py, mod, args, opts) => run(py, ['-I', '-c', PY_WRAPPER, String(process.pid), mod, ...args], opts);

// ---------- error classification ----------
function explain(text, what) {
  const t = String(text || '');
  if (/No space left on device|ENOSPC|Errno 28/i.test(t)) return 'Your disk is full. Free up some space and try again.';
  if (/MemoryError|out of memory|Cannot allocate memory|Errno 12/i.test(t)) return 'Your Mac ran out of memory while separating. Close other apps or try a shorter song.';
  if (/NewConnectionError|Failed to establish|Name or service not known|nodename nor servname|Temporary failure in name resolution|Network is unreachable|ConnectTimeout|ReadTimeout|Connection (refused|reset|aborted)|MaxRetryError|LocalEntryNotFoundError|ConnectionError|SSLError|CERTIFICATE_VERIFY_FAILED|offline mode/i.test(t))
    return what === 'model'
      ? "Couldn't download the separation model. The first run needs an internet connection; check it and try again."
      : "Couldn't download the separation tools. The first run needs an internet connection; check it and try again.";
  if (/No matching distribution|Could not find a version that satisfies/i.test(t))
    return "The separation tools aren't available for this Python version yet. Install Python 3.12 or 3.13 from python.org and try again.";
  if (/Permission denied|EACCES|Errno 13/i.test(t)) return "Phosphene doesn't have permission to read or write a file it needs. Check the song's file permissions and try again.";
  return null;
}

// ---------- discovery ----------
async function findPython() {
  const cands = [
    '/opt/homebrew/bin/python3', '/usr/local/bin/python3',
    '/Library/Frameworks/Python.framework/Versions/Current/bin/python3',
    path.join(os.homedir(), '.pyenv', 'shims', 'python3'),
  ];
  for (const minor of [14, 13, 12, 11, 10]) {
    cands.push(`/opt/homebrew/bin/python3.${minor}`, `/usr/local/bin/python3.${minor}`,
      `/Library/Frameworks/Python.framework/Versions/3.${minor}/bin/python3`);
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir && dir !== '/usr/bin') cands.push(path.join(dir, 'python3'));
  }
  const seen = new Set();
  const found = [];
  for (const c of cands) {
    if (seen.has(c) || !fs.existsSync(c)) continue;
    seen.add(c);
    const r = await run(c, ['-I', '-c', 'import sys, venv, ensurepip; print("%d %d" % sys.version_info[:2])']);
    const m = r.code === 0 && /^(\d+) (\d+)/.exec(r.out.trim());
    if (m) found.push({ path: c, major: +m[1], minor: +m[2] });
  }
  const ok = found.filter(p => p.major === 3 && p.minor >= 10);
  if (!ok.length) return null;
  // Prefer the newest version PyTorch publishes wheels for; fall back to anything newer.
  const supported = ok.filter(p => p.minor <= 14).sort((a, b) => b.minor - a.minor);
  return supported[0] || ok.sort((a, b) => a.minor - b.minor)[0];
}

function findFfmpeg() {
  for (const p of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']) if (fs.existsSync(p)) return p;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const p = dir && path.join(dir, 'ffmpeg');
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

function freeBytes(dir) {
  try { const s = fs.statfsSync(dir); return s.bavail * s.bsize; } catch { return Infinity; }
}

// ---------- progress ----------
function makeReporter(listeners) {
  let lastStage = '', lastFrac = -1, lastT = 0;
  return (stage, fraction, force) => {
    const f = Math.max(0, Math.min(1, Number(fraction) || 0));
    const now = Date.now();
    if (!force && stage === lastStage && (f - lastFrac < 0.01 || now - lastT < 150) && f < 1) return;
    if (stage === lastStage && (f === lastFrac || (f < lastFrac && !force))) return; // no repeats; monotonic per stage
    lastStage = stage; lastFrac = f; lastT = now;
    for (const cb of listeners) { try { cb({ stage, fraction: f }); } catch { /* listener errors are not ours */ } }
  };
}

// ---------- environment setup ----------
let setupPromise = null;

function readReady() {
  try {
    const r = JSON.parse(fs.readFileSync(READY_FILE, 'utf8'));
    if (r.version === SETUP_VERSION && fs.existsSync(VENV_PY)) return r;
  } catch { /* not ready */ }
  return null;
}

function ensureSetup(report) {
  const ready = readReady();
  if (ready) return Promise.resolve(ready);
  if (!setupPromise) setupPromise = doSetup(report).finally(() => { setupPromise = null; });
  return setupPromise;
}

async function doSetup(report) {
  report('Setting up separator', 0, true);
  await fsp.mkdir(APP_DIR, { recursive: true });
  if (freeBytes(APP_DIR) < 2.5e9) fail('Not enough free disk space for the first-time setup of stem separation (it needs about 2.5 GB). Free up some space and try again.');

  // Venv: reuse if its interpreter still runs, otherwise rebuild (e.g. after a Python upgrade removed the old one).
  let venvOk = false;
  if (fs.existsSync(VENV_PY)) {
    const r = await run(VENV_PY, ['-I', '-c', 'import sys; print(sys.version_info[1])']);
    venvOk = r.code === 0;
  }
  if (!venvOk) {
    const py = await findPython();
    if (!py) fail('Stem separation needs Python 3.10 or newer, which was not found on this Mac. Install it from python.org (or with Homebrew), then try again.');
    await fsp.rm(ENV_DIR, { recursive: true, force: true });
    report('Setting up separator', 0.01, true);
    const r = await run(py.path, ['-I', '-m', 'venv', ENV_DIR]);
    if (r.code !== 0) fail(explain(r.tail) || "Couldn't create the separator's Python environment.");
  }

  // pip install, with byte-level progress from --progress-bar raw.
  let doneBytes = 0, curTotal = 0, curDone = 0, expected = 0;
  const EST_TOTAL = 140e6; // rough size of torch + friends for macOS arm64
  const pip = await runPy(VENV_PY, 'pip', ['install', '--no-cache-dir', '--progress-bar', 'raw', '--prefer-binary', ...PACKAGES], {
    env: baseEnv(),
    onLine: l => {
      let m;
      if ((m = /^\s*Progress (\d+) of (\d+)/.exec(l))) {
        const d = +m[1], t = +m[2];
        if (t !== curTotal) { curTotal = t; expected += t; }
        curDone = d;
        if (d >= t) { doneBytes += t; curTotal = 0; curDone = 0; }
        const got = doneBytes + curDone;
        report('Setting up separator', 0.02 + 0.83 * Math.min(1, got / Math.max(EST_TOTAL, expected)));
      } else if (/^Installing collected packages/.test(l)) report('Setting up separator', 0.88);
      else if (/^Successfully installed/.test(l)) report('Setting up separator', 1);
    },
  });
  if (pip.code !== 0) fail(explain(pip.tail) || "Couldn't install the separation tools. Try again; if it keeps failing, delete the folder \"stems-env\" in ~/Library/Application Support/Phosphene.");
  report('Setting up separator', 1, true);

  // Model weights (and verify that everything imports).
  report('Downloading model', 0, true);
  const pre = await runPy(VENV_PY, '-', [PY_PREFETCH], {
    env: baseEnv(),
    onLine: l => { const m = /(\d{1,3})%\|/.exec(l); if (m) report('Downloading model', +m[1] / 100); },
  });
  if (pre.code !== 0) fail(explain(pre.tail, 'model') || "Couldn't load the separation model. Try again; if it keeps failing, delete the folder \"stems-env\" in ~/Library/Application Support/Phosphene.");
  report('Downloading model', 1, true);
  const ready = { version: SETUP_VERSION, model: MODEL, mps: /PHOSPHENE_MPS=1/.test(pre.out), at: new Date().toISOString() };
  await fsp.writeFile(READY_FILE, JSON.stringify(ready, null, 2));
  return ready;
}

// ---------- separation ----------
let queue = Promise.resolve();
let busy = 0; // separations queued or running
const jobs = new Map(); // cache key -> { promise, listeners }

async function cacheKey(audioPath) {
  const real = await fsp.realpath(audioPath);
  const st = await fsp.stat(real);
  if (!st.isFile()) fail("That isn't an audio file.");
  const key = crypto.createHash('sha256').update(`${MODEL}\n${real}\n${st.size}\n${st.mtimeMs}`).digest('hex').slice(0, 24);
  return { key, real, size: st.size };
}

function cachedResult(dir) {
  try {
    const man = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    const stems = {};
    for (const s of STEMS) {
      const p = path.join(dir, `${s}.wav`);
      if (!fs.existsSync(p)) return null;
      stems[s] = p;
    }
    return man && { stems };
  } catch { return null; }
}

async function prepareInput(src, workDir, report) {
  report('Preparing audio', 0, true);
  const ffmpeg = findFfmpeg();
  const out = path.join(workDir, 'input.wav');
  if (!ffmpeg) {
    if (/\.wav$/i.test(src)) return { wav: src, duration: null };
    fail('ffmpeg was not found, so this file could not be converted. Install it (brew install ffmpeg) or use a WAV file.');
  }
  let duration = null;
  const r = await run(ffmpeg, ['-nostdin', '-hide_banner', '-y', '-i', src, '-map', '0:a:0', '-vn', '-sn', '-dn',
    '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', '-f', 'wav', out], {
    onLine: l => {
      let m;
      if (!duration && (m = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(l))) duration = +m[1] * 3600 + +m[2] * 60 + +m[3];
      if (duration && (m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(l))) report('Preparing audio', (+m[1] * 3600 + +m[2] * 60 + +m[3]) / duration);
    },
  });
  if (r.code !== 0) {
    if (/matches no streams|does not contain any stream|Output file .* does not contain/i.test(r.tail)) fail('This file has no audio track.');
    fail(explain(r.tail) || "Couldn't read the audio in this file. It may be damaged or in an unsupported format.");
  }
  const st = await fsp.stat(out).catch(() => null);
  if (!st || st.size <= 44 + 4 * 441) fail('This file has no audio (or it is too short to separate).');
  report('Preparing audio', 1, true);
  return { wav: out, duration };
}

async function runDemucs(wav, outDir, device, report, stage) {
  report(stage, 0, true);
  return runPy(VENV_PY, 'demucs', ['-n', MODEL, '-d', device, '--clip-mode', 'clamp', '-o', outDir,
    '--filename', '{stem}.{ext}', wav], {
    env: baseEnv({ HF_HUB_OFFLINE: '1' }),
    cwd: path.dirname(outDir),
    onLine: l => { const m = /(\d{1,3})%\|/.exec(l); if (m) report(stage, +m[1] / 100); },
  });
}

async function doSeparate(src, dir, report) {
  const ready = await ensureSetup(report);
  await fsp.mkdir(dir, { recursive: true });
  // Remove leftovers of runs whose process died mid-way (a live pid may be another window working on it).
  for (const name of await fsp.readdir(dir).catch(() => [])) {
    const m = /^\.work-(\d+)-/.exec(name);
    if (!m) continue;
    let alive = false;
    try { process.kill(+m[1], 0); alive = +m[1] !== process.pid; } catch { /* dead */ }
    if (!alive) await fsp.rm(path.join(dir, name), { recursive: true, force: true }).catch(() => {});
  }
  const work = path.join(dir, `.work-${process.pid}-${Date.now()}`);
  await fsp.mkdir(work, { recursive: true });
  try {
    const srcSize = (await fsp.stat(src)).size;
    if (freeBytes(dir) < 3e8 + srcSize * 12) fail('Your disk is almost full. Free up some space and try again.');
    const { wav } = await prepareInput(src, work, report);

    const outDir = path.join(work, 'out');
    let r = { code: 1, tail: '' };
    if (ready.mps) r = await runDemucs(wav, outDir, 'mps', report, 'Separating');
    if (r.code !== 0 && !/No space left|ENOSPC|Errno 28/.test(r.tail || '')) {
      if (ready.mps && r.code === 3) fail('Separation was interrupted.');
      r = await runDemucs(wav, outDir, 'cpu', report, ready.mps ? 'Separating (CPU)' : 'Separating');
    }
    if (r.code !== 0) {
      if (/No module named|ModuleNotFoundError|ImportError/.test(r.tail)) {
        await fsp.rm(READY_FILE, { force: true }); // force a fresh setup next time
        fail('The separator installation looks damaged. Try again to reinstall it.');
      }
      if (r.signal === 'SIGKILL') fail('Separation was stopped, probably because your Mac ran low on memory. Close other apps or try a shorter song.');
      fail(explain(r.tail) || "Separation failed for this file. Try converting it to WAV or MP3 and try again.");
    }

    report('Finishing', 0, true);
    const produced = path.join(outDir, MODEL);
    for (const s of STEMS) {
      const from = path.join(produced, `${s}.wav`);
      if (!fs.existsSync(from)) fail('The separator finished but some stems are missing. Try again.');
      await fsp.rename(from, path.join(dir, `${s}.wav`));
    }
    await fsp.writeFile(path.join(dir, 'manifest.json'),
      JSON.stringify({ model: MODEL, source: src, created: new Date().toISOString(), stems: STEMS }, null, 2));
    report('Finishing', 1, true);
    const res = cachedResult(dir);
    if (!res) fail('Could not save the separated stems.');
    return res;
  } finally {
    await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

async function separate(audioPath, onProgress) {
  const cbs = typeof onProgress === 'function' ? [onProgress] : [];
  try {
    if (typeof audioPath !== 'string' || !audioPath) fail('No audio file was given.');
    if (!fs.existsSync(audioPath)) fail("The audio file couldn't be found. It may have been moved or deleted.");
    const { key, real } = await cacheKey(audioPath);
    const dir = path.join(CACHE_DIR, key);
    const hit = cachedResult(dir);
    if (hit) { for (const cb of cbs) { try { cb({ stage: 'Done', fraction: 1 }); } catch { /* ignore */ } } return hit; }

    let job = jobs.get(key);
    if (!job) {
      const listeners = new Set();
      const report = makeReporter(listeners);
      const prev = queue;
      if (busy++ > 0) report('Waiting for another separation', 0, true);
      const promise = (async () => {
        await prev.catch(() => {});
        const again = cachedResult(dir);
        if (again) return again;
        return doSeparate(real, dir, report);
      })();
      queue = promise.catch(() => {});
      job = { promise, listeners, report };
      jobs.set(key, job);
      promise.finally(() => { jobs.delete(key); busy--; }).catch(() => {});
    }
    for (const cb of cbs) job.listeners.add(cb);
    try {
      const res = await job.promise;
      for (const cb of cbs) { try { cb({ stage: 'Done', fraction: 1 }); } catch { /* ignore */ } }
      return res;
    } finally {
      for (const cb of cbs) job.listeners.delete(cb);
    }
  } catch (e) {
    if (e instanceof StemError) return { error: e.message };
    const msg = e && (e.code === 'ENOSPC' ? 'Your disk is full. Free up some space and try again.'
      : e.code === 'EACCES' || e.code === 'EPERM' ? "Phosphene doesn't have permission to read this file or write its stems."
      : e.code === 'ENOENT' ? "A file needed for separation couldn't be found. Try again." : null);
    return { error: msg || 'Stem separation failed unexpectedly. Try again.' };
  }
}

module.exports = { separate };
