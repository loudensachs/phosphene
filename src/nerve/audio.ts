// NERVE — audio decode, playback and deterministic per-frame analysis.
// Analysis reads PCM directly at the transport time, so realtime preview and offline export see identical values.
import type { AudioFrame, AudioTrackData } from './types';
import { detectTempo } from './tempo';

const N = 2048;
const BINS = 512;

function fft(re: Float32Array, im: Float32Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

interface Loaded { buffer: AudioBuffer; mono: Float32Array; sr: number }

export class AudioEngine {
  ctx: AudioContext | null = null;
  tracks = new Map<string, Loaded>();
  private sources: AudioBufferSourceNode[] = [];
  private startedAt = 0; // ctx time at play
  private startOffset = 0; // transport time at play
  playing = false;
  live: AnalyserNode | null = null;
  private liveStream: MediaStream | null = null;

  private re = new Float32Array(N);
  private im = new Float32Array(N);
  private win = new Float32Array(N);
  private mags = new Float32Array(N / 2);
  private prevLow = 0; private prevFull = 0;
  private avgLow = 0; private avgFull = 0;
  private liveBuf = new Float32Array(N);
  frame: AudioFrame = {
    level: 0, bass: 0, lowmid: 0, mid: 0, high: 0, air: 0, kick: 0, onset: 0,
    spectrum: new Float32Array(BINS), wave: new Float32Array(BINS),
  };

  constructor() { for (let i = 0; i < N; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)); }

  private ensure() { return (this.ctx ??= new AudioContext({ latencyHint: 'interactive' })); }

  async loadTrack(id: string, data: ArrayBuffer) {
    const buffer = await this.ensure().decodeAudioData(data);
    const mono = new Float32Array(buffer.length);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const ch = buffer.getChannelData(c);
      for (let i = 0; i < mono.length; i++) mono[i] += ch[i] / buffer.numberOfChannels;
    }
    this.tracks.set(id, { buffer, mono, sr: buffer.sampleRate });
    return buffer.duration;
  }
  removeTrack(id: string) { this.tracks.delete(id); }

  /** Min/max peaks for waveform display. */
  peaks(id: string, buckets: number): Float32Array | null {
    const t = this.tracks.get(id);
    if (!t) return null;
    const out = new Float32Array(buckets * 2);
    const step = t.mono.length / buckets;
    for (let b = 0; b < buckets; b++) {
      let lo = 1, hi = -1;
      const s = Math.floor(b * step), e = Math.min(t.mono.length, Math.floor((b + 1) * step));
      const stride = Math.max(1, Math.floor((e - s) / 64));
      for (let i = s; i < e; i += stride) { const v = t.mono[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      out[b * 2] = lo; out[b * 2 + 1] = hi;
    }
    return out;
  }

  play(time: number, data: AudioTrackData[]) {
    this.stop();
    const ctx = this.ensure();
    if (ctx.state === 'suspended') void ctx.resume();
    this.startedAt = ctx.currentTime + 0.02;
    this.startOffset = time;
    for (const td of data) {
      const t = this.tracks.get(td.id);
      if (!t || td.mute) continue;
      const src = ctx.createBufferSource();
      src.buffer = t.buffer;
      const gain = ctx.createGain();
      gain.gain.value = td.gain;
      src.connect(gain).connect(ctx.destination);
      const local = time - td.start;
      if (local >= t.buffer.duration) continue;
      if (local >= 0) src.start(this.startedAt, local);
      else src.start(this.startedAt - local);
      this.sources.push(src);
    }
    this.playing = true;
  }
  stop() {
    for (const s of this.sources) { try { s.stop(); } catch { /* not started */ } s.disconnect(); }
    this.sources = [];
    this.playing = false;
  }
  /** Transport time derived from the audio clock while playing. */
  time() { return this.ctx ? Math.max(this.startOffset, this.startOffset + (this.ctx.currentTime - this.startedAt)) : this.startOffset; }

  async setLive(on: boolean) {
    if (!on) { this.liveStream?.getTracks().forEach(t => t.stop()); this.liveStream = null; this.live = null; return; }
    const ctx = this.ensure();
    this.liveStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    const a = ctx.createAnalyser();
    a.fftSize = N; a.smoothingTimeConstant = 0;
    ctx.createMediaStreamSource(this.liveStream).connect(a);
    this.live = a;
  }

  // ---------- stems: separated parts of the song, each its own modulation source ----------
  /** name → samples. Names: drums, bassline, vocals, other. */
  stems = new Map<string, { mono: Float32Array; sr: number; start: number }>();
  private stemState = new Map<string, { level: number; hit: number; prev: number; avg: number }>();
  async loadStem(name: string, data: ArrayBuffer, start: number) {
    const b = await this.ensure().decodeAudioData(data);
    const mono = new Float32Array(b.length);
    for (let c = 0; c < b.numberOfChannels; c++) { const ch = b.getChannelData(c); for (let i = 0; i < mono.length; i++) mono[i] += ch[i] / b.numberOfChannels; }
    this.stems.set(name, { mono, sr: b.sampleRate, start });
  }
  /** Envelope followers and onset detectors per stem, advanced once per frame. */
  private analyzeStems(t: number, dt: number) {
    for (const [name, s] of this.stems) {
      let st = this.stemState.get(name);
      if (!st) this.stemState.set(name, (st = { level: 0, hit: 0, prev: 0, avg: 0 }));
      const end = Math.floor((t - s.start) * s.sr), lo = Math.max(0, end - 1024), hi = Math.min(s.mono.length, end);
      let sum = 0;
      for (let i = lo; i < hi; i++) sum += s.mono[i] * s.mono[i];
      const rms = hi > lo ? Math.sqrt(sum / 1024) : 0;
      const x = Math.min(1, rms * 3.5);
      st.level = x > st.level ? x : st.level + (x - st.level) * (1 - Math.exp(-dt * 12));
      const flux = Math.max(0, rms - st.prev);
      st.avg += (flux - st.avg) * (1 - Math.exp(-dt * 2.5));
      st.hit = flux > st.avg * 2.2 + 0.004 ? 1 : st.hit * Math.exp(-dt * 9);
      st.prev = rms;
    }
  }
  /** Expression lookup: `drums`, `vocals.hit`, … Undefined when the name is not a stem. */
  stemValue(name: string): number | undefined {
    const dot = name.indexOf('.'), base = dot < 0 ? name : name.slice(0, dot);
    if (base !== 'drums' && base !== 'bassline' && base !== 'vocals' && base !== 'other') return undefined;
    const st = this.stemState.get(base);
    return st ? (dot < 0 ? st.level : name.endsWith('.hit') ? st.hit : st.level) : 0;
  }

  /**
   * Song analysis: tempo, first downbeat and sections, from the onset-strength envelope.
   * Deterministic and offline; results are stored in the project.
   */
  analyzeSong(id: string): { bpm: number; offset: number; confidence: number; alt?: number; sections: { t: number; level: number; name: string }[]; profile: { bass: number; bright: number; density: number; dynamic: number } } | null {
    const tr = this.tracks.get(id);
    if (!tr) return null;
    const hop = 512, x = tr.mono, sr = tr.sr, n = Math.floor(x.length / hop);
    if (n < 200) return null;
    // onset strength: half-wave rectified change in log energy of a high-passed signal
    const env = new Float32Array(n), rms = new Float32Array(n);
    let prev = 0, hp = 0, lastS = 0;
    for (let i = 0; i < n; i++) {
      let e = 0, e2 = 0;
      for (let k = 0; k < hop; k++) { const s = x[i * hop + k]; hp = 0.95 * (hp + s - lastS); lastS = s; e += hp * hp; e2 += s * s; }
      const l = Math.log(1 + 1000 * e / hop);
      env[i] = Math.max(0, l - prev); prev = l; rms[i] = Math.sqrt(e2 / hop);
    }
    const fps = sr / hop;
    const tempo = detectTempo(x, sr);
    const bpm = tempo.bpm, offset = tempo.offset, beat = (60 / bpm) * fps;
    // sections: loudness per bar, cut where it shifts and holds
    const barLen = beat * 4, bars: number[] = [];
    for (let k = offset * fps; k + barLen <= n; k += barLen) { let s = 0; for (let i = Math.floor(k); i < k + barLen; i++) s += rms[i]; bars.push(s / barLen); }
    const sorted = [...bars].sort((a, b) => a - b), top = sorted[Math.floor(sorted.length * 0.95)] || 1e-6;
    const lv = bars.map(b => Math.min(1, b / top));
    const sections: { t: number; level: number; name: string }[] = [];
    const barSec = (60 / bpm) * 4;
    const close = (a: number, b: number) => {
      let m = 0; for (let k = a; k < b; k++) m += lv[k]; m /= Math.max(1, b - a);
      sections.push({ t: offset + a * barSec, level: m, name: m > 0.75 ? 'Drop' : m > 0.5 ? 'Main' : m > 0.25 ? 'Build' : 'Break' });
    };
    // a new section starts where loudness leaves the running level of the current one and stays away for two bars
    let start = 0, run = lv[0] ?? 0;
    for (let i = 1; i < lv.length; i++) {
      const away = Math.abs(lv[i] - run) > 0.2 && (i + 1 >= lv.length || Math.abs(lv[i + 1] - run) > 0.2);
      if (away && i - start >= 2) { close(start, i); start = i; run = lv[i]; }
      else run += (lv[i] - run) / Math.min(8, i - start + 1);
    }
    if (lv.length) close(start, lv.length);
    if (sections.length) { sections[0].t = 0; if (sections[0].level <= 0.5) sections[0].name = 'Intro'; }
    // character of the track, each 0..1: low-end weight, brightness, how busy it is, how much it swings between quiet and loud
    let lp = 0, eLow = 0, eAll = 0, zc = 0;
    for (let i = 1; i < x.length; i += 2) { lp += 0.03 * (x[i] - lp); eLow += lp * lp; eAll += x[i] * x[i]; if ((x[i] >= 0) !== (x[i - 1] >= 0)) zc++; }
    let em = 0; for (let i = 0; i < n; i++) em += env[i]; em /= n;
    let peaks = 0; for (let i = 1; i < n - 1; i++) if (env[i] > em * 2.5 && env[i] >= env[i - 1] && env[i] > env[i + 1]) peaks++;
    const lm = lv.reduce((a, b) => a + b, 0) / Math.max(1, lv.length);
    const profile = {
      bass: Math.min(1, Math.sqrt(eLow / Math.max(eAll, 1e-9)) * 1.4),
      bright: Math.min(1, (zc / (x.length / 2)) / 0.16),
      density: Math.min(1, peaks / (x.length / sr) / 7),
      dynamic: Math.min(1, Math.sqrt(lv.reduce((a, b) => a + (b - lm) * (b - lm), 0) / Math.max(1, lv.length)) * 3),
    };
    return { bpm, offset, confidence: tempo.confidence, alt: tempo.candidates[0]?.[0], sections, profile };
  }

  resetState() { this.stemState.clear(); this.prevLow = this.prevFull = this.avgLow = this.avgFull = 0; this.frame.kick = this.frame.onset = 0; }

  /** Analyse the window ending at transport time `t`. Sequential calls carry envelope state. */
  analyze(t: number, dt: number, data: AudioTrackData[]): AudioFrame {
    const { re, im, win, mags, frame } = this;
    let sr = 48000;
    re.fill(0); im.fill(0);
    let any = false;
    if (this.live) {
      this.live.getFloatTimeDomainData(this.liveBuf);
      re.set(this.liveBuf); sr = this.ctx!.sampleRate; any = true;
    } else {
      for (const td of data) {
        const tr = this.tracks.get(td.id);
        if (!tr || td.mute) continue;
        sr = tr.sr; any = true;
        const end = Math.floor((t - td.start) * tr.sr);
        const start = end - N;
        const lo = Math.max(0, start), hi = Math.min(tr.mono.length, end);
        for (let i = lo; i < hi; i++) re[i - start] += tr.mono[i] * td.gain;
      }
    }
    this.analyzeStems(t, dt);
    // waveform + rms
    let sum = 0;
    for (let i = 0; i < N; i++) sum += re[i] * re[i];
    const rms = Math.sqrt(sum / N);
    for (let i = 0; i < BINS; i++) frame.wave[i] = re[N - BINS * 2 + i * 2];
    if (!any) {
      frame.spectrum.fill(0);
      frame.level = frame.bass = frame.lowmid = frame.mid = frame.high = frame.air = 0;
      frame.kick *= Math.exp(-dt * 8); frame.onset *= Math.exp(-dt * 8);
      return frame;
    }
    for (let i = 0; i < N; i++) re[i] *= win[i];
    fft(re, im);
    for (let i = 0; i < N / 2; i++) mags[i] = Math.hypot(re[i], im[i]) / (N / 4);
    const hz = sr / N;
    const norm = (m: number) => Math.min(1, Math.max(0, (20 * Math.log10(m + 1e-9) + 72) / 72));
    // log-spaced display spectrum, 30 Hz .. 16 kHz
    const fmin = 30, fmax = Math.min(16000, sr / 2);
    for (let b = 0; b < BINS; b++) {
      const f0 = fmin * Math.pow(fmax / fmin, b / BINS), f1 = fmin * Math.pow(fmax / fmin, (b + 1) / BINS);
      const i0 = f0 / hz, i1 = Math.max(i0 + 1e-3, f1 / hz);
      let m = 0;
      if (i1 - i0 < 1) { const i = Math.floor(i0), fr = i0 - i; m = mags[i] * (1 - fr) + (mags[i + 1] ?? 0) * fr; }
      else for (let i = Math.floor(i0); i < i1 && i < N / 2; i++) m = Math.max(m, mags[i]);
      frame.spectrum[b] = norm(m);
    }
    const band = (lo: number, hi: number) => {
      let e = 0, n = 0;
      for (let i = Math.max(1, Math.floor(lo / hz)); i <= Math.min(N / 2 - 1, Math.ceil(hi / hz)); i++) { e += mags[i] * mags[i]; n++; }
      return Math.sqrt(e / Math.max(1, n));
    };
    const rawLow = band(30, 150);
    const follow = (prev: number, x: number) => (x > prev ? x : prev + (x - prev) * (1 - Math.exp(-dt * 14)));
    frame.bass = follow(frame.bass, norm(rawLow * 1.6));
    frame.lowmid = follow(frame.lowmid, norm(band(150, 500) * 2.2));
    frame.mid = follow(frame.mid, norm(band(500, 2000) * 3.5));
    frame.high = follow(frame.high, norm(band(2000, 8000) * 6));
    frame.air = follow(frame.air, norm(band(8000, 16000) * 10));
    frame.level = follow(frame.level, Math.min(1, rms * 2.5));
    // onset detection: positive energy flux against a running mean
    const rawFull = rms;
    const fluxLow = Math.max(0, rawLow - this.prevLow), fluxFull = Math.max(0, rawFull - this.prevFull);
    const k = 1 - Math.exp(-dt * 2.5);
    this.avgLow += (fluxLow - this.avgLow) * k; this.avgFull += (fluxFull - this.avgFull) * k;
    const decay = Math.exp(-dt * 9);
    frame.kick = fluxLow > this.avgLow * 2.2 + 0.004 ? 1 : frame.kick * decay;
    frame.onset = fluxFull > this.avgFull * 2.2 + 0.006 ? 1 : frame.onset * decay;
    this.prevLow = rawLow; this.prevFull = rawFull;
    return frame;
  }

  /** Average of the normalised spectrum between two frequencies (Hz). */
  bandHz(lo: number, hi: number) {
    const fmin = 30, fmax = 16000;
    const pos = (f: number) => Math.min(BINS - 1, Math.max(0, Math.floor((Math.log(Math.max(f, fmin) / fmin) / Math.log(fmax / fmin)) * BINS)));
    const a = pos(lo), b = Math.max(a, pos(hi));
    let s = 0;
    for (let i = a; i <= b; i++) s += this.frame.spectrum[i];
    return s / (b - a + 1);
  }
}
