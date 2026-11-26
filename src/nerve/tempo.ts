// Tempo and downbeat estimation for whole tracks. Pure functions so they can be tested outside the app.

export interface TempoResult { bpm: number; offset: number; confidence: number; candidates: [number, number][] }

/** Onset strength at `fps` frames per second: summed half-wave rectified log-energy flux of a low, a mid and a high band. */
export function onsetEnvelope(x: Float32Array, sr: number, hop: number): { env: Float32Array; low: Float32Array; fps: number } {
  const n = Math.floor(x.length / hop), env = new Float32Array(n), low = new Float32Array(n);
  const aL = 1 - Math.exp(-2 * Math.PI * 150 / sr), aM = 1 - Math.exp(-2 * Math.PI * 2500 / sr);
  let l = 0, m = 0, pl = 0, pm = 0, ph = 0;
  for (let i = 0; i < n; i++) {
    let eL = 0, eM = 0, eH = 0;
    for (let k = 0, o = i * hop; k < hop; k++) {
      const s = x[o + k];
      l += aL * (s - l); m += aM * (s - m);
      const mid = m - l, hi = s - m;
      eL += l * l; eM += mid * mid; eH += hi * hi;
    }
    const a = Math.log(1 + 2000 * eL / hop), b = Math.log(1 + 2000 * eM / hop), c = Math.log(1 + 8000 * eH / hop);
    const fl = Math.max(0, a - pl);
    low[i] = fl; env[i] = fl + Math.max(0, b - pm) + Math.max(0, c - ph);
    pl = a; pm = b; ph = c;
  }
  // remove the local average so sustained loud passages do not dominate
  const w = Math.round(sr / hop), out = new Float32Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += env[i]; if (i >= w) acc -= env[i - w];
    out[i] = Math.max(0, env[i] - acc / Math.min(i + 1, w));
  }
  return { env: out, low, fps: sr / hop };
}

const lerp = (a: Float32Array, i: number) => { const k = Math.floor(i); return k + 1 < a.length ? a[k] + (a[k + 1] - a[k]) * (i - k) : (a[k] ?? 0); };

export function detectTempo(x: Float32Array, sr: number): TempoResult {
  const hop = Math.max(64, Math.round(sr / 187.5));
  // four minutes from the body of the track is plenty and keeps long files fast
  const maxLen = 240 * sr, from = x.length > maxLen ? Math.floor(Math.min(x.length - maxLen, 20 * sr)) : 0;
  const seg = x.length > maxLen ? x.subarray(from, from + maxLen) : x;
  const { env, low, fps } = onsetEnvelope(seg, sr, hop);
  const n = env.length;
  const LO = 85, HI = 180;
  const maxLag = Math.min(n - 1, Math.ceil((60 / LO) * fps * 8) + 2);
  const acf = new Float32Array(maxLag + 1);
  for (let l = 1; l <= maxLag; l++) { let s = 0; for (let i = 0; i + l < n; i++) s += env[i] * env[i + l]; acf[l] = s / (n - l); }
  let a0 = 0; for (let i = 0; i < n; i++) a0 += env[i] * env[i]; a0 = a0 / n || 1;
  const A = (lag: number) => (lag <= maxLag ? lerp(acf, lag) / a0 : 0);
  // a tempo is credible when the envelope repeats at the beat, the half bar and above all the bar and two bars
  const score = (bpm: number) => {
    const T = (60 / bpm) * fps;
    const s = 0.5 * A(T) + 0.8 * A(2 * T) + 1.0 * A(4 * T) + 0.7 * A(8 * T) - 0.35 * (A(3 * T) + A(6 * T)) - 0.25 * A(1.5 * T);
    return s * Math.exp(-0.5 * Math.pow(Math.log2(bpm / 125) / 0.75, 2));
  };
  const cands: [number, number][] = [];
  let best = 120, bestScore = -Infinity;
  for (let bpm = LO; bpm <= HI; bpm += 0.25) { const s = score(bpm); cands.push([bpm, s]); if (s > bestScore) { bestScore = s; best = bpm; } }
  // refine by laying a beat grid over the whole excerpt: a small tempo error slides the far end off the onsets
  const sm = new Float32Array(n);
  for (let i = 1; i < n - 1; i++) sm[i] = 0.25 * env[i - 1] + 0.5 * env[i] + 0.25 * env[i + 1];
  const grid = (bpm: number) => {
    const T = (60 / bpm) * fps;
    let top = 0, at = 0;
    for (let p = 0; p < T; p += 0.5) { let s = 0; for (let k = p; k < n - 1; k += T) s += lerp(sm, k); if (s > top) { top = s; at = p; } }
    return [top / Math.max(1, n / T), at];
  };
  // the strongest few periodicities are often related (2:3, 4:5); let the grid decide between them, since a wrong
  // one puts most of its beats on weak subdivisions
  const peaks: [number, number][] = [];
  for (let i = 1; i < cands.length - 1; i++) if (cands[i][1] > cands[i - 1][1] && cands[i][1] >= cands[i + 1][1] && cands[i][1] > bestScore * 0.6) peaks.push(cands[i]);
  peaks.sort((p, q) => q[1] - p[1]);
  const refine = (c: number): [number, number] => {
    let f = c, fs = -1;
    for (let b = c * 0.985; b <= c * 1.015; b += 0.02) { const [g] = grid(b); if (g > fs) { fs = g; f = b; } }
    return [f, fs];
  };
  let fine = best, fineScore = -1, pick = -Infinity;
  const tried: [number, number, number][] = [];
  for (const [c, sc] of peaks.slice(0, 5)) {
    const [f, g] = refine(c);
    // whole tempos are far more likely than fractional ones
    const v = g * (sc / bestScore) * (Math.abs(f - Math.round(f)) / f < 0.002 ? 1.06 : 1);
    tried.push([f, v, g]);
    if (v > pick) { pick = v; fine = f; fineScore = g; }
  }
  // dotted rhythms leave a ghost at two thirds of the real tempo; on a near tie the faster reading is the real one
  for (const [f, v, g] of tried) if (Math.abs(f / fine - 1.5) < 0.03 && v >= pick * 0.9) { fine = f; fineScore = g; pick = v; break; }
  // produced music sits on whole tempos; take the nearest one unless the grid clearly disagrees
  const whole = Math.round(fine);
  let bpm = Math.round(fine * 100) / 100;
  if (Math.abs(whole - fine) / fine < 0.006 && grid(whole)[0] >= fineScore * 0.9) bpm = whole;
  const [, phase] = grid(bpm);
  const T = (60 / bpm) * fps;
  // downbeat: which of the four beats carries the most low-end onset energy
  let bar = 0, barScore = -1;
  for (let b = 0; b < 4; b++) { let s = 0; for (let k = phase + b * T; k < n - 1; k += T * 4) s += lerp(low, k) + lerp(low, k + 1); if (s > barScore) { barScore = s; bar = b; } }
  const barSec = (60 / bpm) * 4;
  let offset = ((phase + bar * T) / fps + from / sr) % barSec;
  if (offset > barSec - 0.02) offset = 0;
  const others = tried.filter(c => Math.abs(c[0] - fine) > 2).sort((p, q) => q[1] - p[1]);
  return { bpm, offset, confidence: others.length && pick > 0 ? Math.max(0, Math.min(1, 1 - others[0][1] / pick)) : 1, candidates: others.map(c => [Math.round(c[0] * 100) / 100, +c[1].toFixed(3)] as [number, number]) };
}
