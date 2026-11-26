// NERVE signal operators: scalar generators, maths, filters, triggers and audio readers. All deterministic per frame.
import type { OpDef, SigCtx } from '../types';

const sig = (name: string) => ({ name, type: 'sig' as const });
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const fract = (x: number) => x - Math.floor(x);
const smooth = (t: number) => t * t * (3 - 2 * t);
/** Deterministic integer hash → 0..1. */
function hash(n: number, seed = 0): number {
  let h = (Math.floor(n) | 0) ^ Math.imul((seed | 0) + 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
/** One-pole exponential smoothing toward `target` with separate attack/release times (s). */
function follow(cur: number, target: number, attack: number, release: number, dt: number): number {
  const tau = target > cur ? attack : release;
  if (tau <= 0) return target;
  return cur + (target - cur) * (1 - Math.exp(-Math.max(dt, 0) / tau));
}
/** First call or transport reset: clear state and report true. */
function fresh(c: SigCtx): boolean {
  if (c.reset || !c.state.init) {
    for (const k of Object.keys(c.state)) delete c.state[k];
    c.state.init = true;
    return true;
  }
  return false;
}
/** 1D gradient noise, about -1..1. */
function noise1(x: number, seed: number): number {
  const i = Math.floor(x), f = x - i;
  const g0 = hash(i, seed) * 2 - 1, g1 = hash(i + 1, seed) * 2 - 1;
  const t = f * f * f * (f * (f * 6 - 15) + 10);
  return 2 * (g0 * f + (g1 * (f - 1) - g0 * f) * t);
}

const lfo: OpDef = {
  type: 'lfo', label: 'LFO', category: 'Signal', inputs: [], output: 'sig',
  help: 'Low-frequency oscillator, -1..1 before amplitude and offset. Synced rate is beats per cycle.',
  params: [
    { k: 'enum', name: 'shape', options: ['Sine', 'Triangle', 'Saw', 'Square', 'Random S&H', 'Smooth random'], def: 0 },
    { k: 'float', name: 'rate', def: 1, min: 0.01, max: 16, help: 'Beats per cycle when synced, Hz otherwise.' },
    { k: 'bool', name: 'sync', def: true },
    { k: 'float', name: 'phase', def: 0, min: 0, max: 1 },
    { k: 'float', name: 'amp', label: 'Amplitude', def: 1, min: 0, max: 4 },
    { k: 'float', name: 'offset', def: 0, min: -4, max: 4 },
    { k: 'float', name: 'width', label: 'Pulse width', def: 0.5, min: 0, max: 1, help: 'Square duty cycle; triangle skew.' },
  ],
  sig(c) {
    const { shape, rate, sync, phase, amp, offset, width } = c.p;
    const cyc = (sync ? c.beat / Math.max(rate, 1e-4) : c.time * rate) + phase;
    const idx = Math.floor(cyc), ph = cyc - idx;
    const w = clamp(width, 1e-4, 1 - 1e-4);
    let v: number;
    switch (shape) {
      case 1: v = (ph < w ? ph / w : 1 - (ph - w) / (1 - w)) * 2 - 1; break;
      case 2: v = ph * 2 - 1; break;
      case 3: v = ph < width ? 1 : -1; break;
      case 4: v = hash(idx) * 2 - 1; break;
      case 5: v = (hash(idx) + (hash(idx + 1) - hash(idx)) * smooth(ph)) * 2 - 1; break;
      default: v = Math.sin(ph * 2 * Math.PI);
    }
    return v * amp + offset;
  },
};

const sigconst: OpDef = {
  type: 'sigconst', label: 'Constant', category: 'Signal', inputs: [], output: 'sig',
  params: [{ k: 'float', name: 'value', def: 1, min: -10, max: 10 }],
  sig: c => c.p.value,
};

const MATH_OPS = ['Add', 'Subtract', 'Multiply', 'Divide', 'Min', 'Max', 'Power', 'Modulo', 'Abs diff', 'Average'];
const sigmath: OpDef = {
  type: 'sigmath', label: 'Math', category: 'Signal', inputs: [sig('a'), sig('b')], output: 'sig',
  help: 'Combines A and B (B uses the param when unconnected), then scale, offset and optional clamp.',
  params: [
    { k: 'enum', name: 'mode', label: 'Operation', options: MATH_OPS, def: 0 },
    { k: 'float', name: 'b', label: 'B', def: 0, min: -10, max: 10, help: 'Used when input B is unconnected.' },
    { k: 'float', name: 'scale', def: 1, min: -10, max: 10 },
    { k: 'float', name: 'offset', def: 0, min: -10, max: 10 },
    { k: 'bool', name: 'limit', label: 'Clamp', def: false },
    { k: 'float', name: 'lo', label: 'Min', def: 0, min: -10, max: 10 },
    { k: 'float', name: 'hi', label: 'Max', def: 1, min: -10, max: 10 },
  ],
  sig(c) {
    const a = c.ins[0], b = c.connected[1] ? c.ins[1] : c.p.b;
    let v: number;
    switch (c.p.mode) {
      case 1: v = a - b; break;
      case 2: v = a * b; break;
      case 3: v = b === 0 ? 0 : a / b; break;
      case 4: v = Math.min(a, b); break;
      case 5: v = Math.max(a, b); break;
      case 6: v = Math.sign(a) * Math.pow(Math.abs(a), b); break;
      case 7: v = b === 0 ? 0 : a - b * Math.floor(a / b); break;
      case 8: v = Math.abs(a - b); break;
      case 9: v = (a + b) * 0.5; break;
      default: v = a + b;
    }
    if (!Number.isFinite(v)) v = 0;
    v = v * c.p.scale + c.p.offset;
    return c.p.limit ? clamp(v, Math.min(c.p.lo, c.p.hi), Math.max(c.p.lo, c.p.hi)) : v;
  },
};

const remap: OpDef = {
  type: 'remap', label: 'Remap', category: 'Signal', inputs: [sig('in')], output: 'sig',
  help: 'Maps In lo..hi to Out lo..hi with an optional curve.',
  params: [
    { k: 'float', name: 'inLo', label: 'In lo', def: 0, min: -10, max: 10 },
    { k: 'float', name: 'inHi', label: 'In hi', def: 1, min: -10, max: 10 },
    { k: 'float', name: 'outLo', label: 'Out lo', def: 0, min: -10, max: 10 },
    { k: 'float', name: 'outHi', label: 'Out hi', def: 1, min: -10, max: 10 },
    { k: 'bool', name: 'limit', label: 'Clamp', def: true },
    { k: 'float', name: 'curve', def: 1, min: 0.1, max: 8, help: 'Exponent applied to the normalised value (1 = linear).' },
  ],
  sig(c) {
    const { inLo, inHi, outLo, outHi, curve } = c.p;
    let t = inHi === inLo ? 0 : (c.ins[0] - inLo) / (inHi - inLo);
    if (c.p.limit) t = clamp(t, 0, 1);
    t = Math.sign(t) * Math.pow(Math.abs(t), Math.max(curve, 1e-3));
    return outLo + (outHi - outLo) * t;
  },
};

const lag: OpDef = {
  type: 'lag', label: 'Lag', category: 'Signal', inputs: [sig('in')], output: 'sig',
  help: 'Exponential smoothing with separate rise (attack) and fall (release) times.',
  params: [
    { k: 'float', name: 'attack', def: 0.05, min: 0, max: 5, unit: 's' },
    { k: 'float', name: 'release', def: 0.3, min: 0, max: 5, unit: 's' },
  ],
  sig(c) {
    const s = c.state, x = c.ins[0];
    if (fresh(c)) s.v = x;
    s.v = follow(s.v, x, c.p.attack, c.p.release, c.dt);
    return s.v;
  },
};

const spring: OpDef = {
  type: 'spring', label: 'Spring', category: 'Signal', inputs: [sig('in')], output: 'sig',
  help: 'Damped spring follower; low damping overshoots and wobbles.',
  params: [
    { k: 'float', name: 'stiffness', def: 120, min: 1, max: 2000 },
    { k: 'float', name: 'damping', def: 8, min: 0, max: 100 },
  ],
  sig(c) {
    const s = c.state, x = c.ins[0];
    if (fresh(c)) { s.v = x; s.vel = 0; }
    const dt = clamp(c.dt, 0, 0.25);
    const n = clamp(Math.ceil(dt / 0.002), 1, 128);
    const h = dt / n;
    for (let i = 0; i < n; i++) { // semi-implicit Euler, unit mass
      s.vel += (c.p.stiffness * (x - s.v) - c.p.damping * s.vel) * h;
      s.v += s.vel * h;
    }
    return s.v;
  },
};

const trigger: OpDef = {
  type: 'trigger', label: 'Trigger', category: 'Signal', inputs: [sig('in')], output: 'sig',
  help: 'Fires an attack-hold-release envelope (0..1) when the input crosses the threshold.',
  params: [
    { k: 'float', name: 'threshold', def: 0.5, min: 0, max: 1 },
    { k: 'float', name: 'hysteresis', def: 0.1, min: 0, max: 1 },
    { k: 'float', name: 'attack', def: 0.01, min: 0, max: 2, unit: 's' },
    { k: 'float', name: 'hold', def: 0.05, min: 0, max: 2, unit: 's' },
    { k: 'float', name: 'release', def: 0.4, min: 0, max: 5, unit: 's' },
    { k: 'bool', name: 'retrigger', def: true, help: 'Restart the envelope on every trigger, even mid-envelope.' },
  ],
  sig(c) {
    const s = c.state, x = c.ins[0];
    const { threshold, hysteresis, attack, hold, release } = c.p;
    if (fresh(c)) { s.high = x > threshold; s.t = Infinity; s.from = 0; s.env = 0; }
    s.t += c.dt;
    const total = attack + hold + release;
    if (!s.high && x > threshold + hysteresis * 0.5) {
      s.high = true;
      if (c.p.retrigger || s.t >= total) { s.from = s.env; s.t = 0; }
    } else if (s.high && x < threshold - hysteresis * 0.5) s.high = false;
    const t = s.t;
    if (t < attack) s.env = s.from + (1 - s.from) * (t / attack);
    else if (t < attack + hold) s.env = 1;
    else if (t < total) s.env = 1 - (t - attack - hold) / release;
    else s.env = 0;
    return s.env;
  },
};

const counter: OpDef = {
  type: 'counter', label: 'Counter', category: 'Signal', inputs: [sig('in')], output: 'sig',
  help: 'Counts rising edges past the threshold, wrapping at Modulo (0 = never).',
  params: [
    { k: 'float', name: 'threshold', def: 0.5, min: 0, max: 1 },
    { k: 'int', name: 'modulo', def: 8, min: 0, max: 64 },
    { k: 'float', name: 'step', def: 1, min: -10, max: 10 },
  ],
  sig(c) {
    const s = c.state, high = c.ins[0] > c.p.threshold;
    if (fresh(c)) { s.n = 0; s.high = high; }
    if (high && !s.high) s.n += 1;
    s.high = high;
    const v = s.n * c.p.step, m = c.p.modulo;
    return m > 0 ? v - m * Math.floor(v / m) : v;
  },
};

const signoise: OpDef = {
  type: 'signoise', label: 'Noise', category: 'Signal', inputs: [], output: 'sig',
  help: 'Smooth fractal 1D noise over time, about -1..1 before amplitude and offset.',
  params: [
    { k: 'float', name: 'rate', def: 1, min: 0, max: 20, unit: 'Hz' },
    { k: 'int', name: 'octaves', def: 2, min: 1, max: 8 },
    { k: 'float', name: 'amp', label: 'Amplitude', def: 1, min: 0, max: 4 },
    { k: 'float', name: 'offset', def: 0, min: -4, max: 4 },
    { k: 'int', name: 'seed', def: 0, min: 0, max: 999 },
  ],
  sig(c) {
    const x = c.time * c.p.rate;
    const oct = clamp(c.p.octaves, 1, 8);
    let s = 0, n = 0, a = 1, f = 1;
    for (let i = 0; i < oct; i++) { s += a * noise1(x * f + i * 17.3, c.p.seed * 131 + i); n += a; a *= 0.5; f *= 2; }
    return (s / n) * c.p.amp + c.p.offset;
  },
};

const beat: OpDef = {
  type: 'beat', label: 'Beat', category: 'Signal', inputs: [], output: 'sig',
  help: 'Tempo-locked pulse, ramp, step count or gate. Swing delays every second division.',
  params: [
    { k: 'enum', name: 'output', options: ['Pulse', 'Ramp', 'Step', 'Gate'], def: 0 },
    { k: 'float', name: 'division', def: 1, min: 0.0625, max: 16, help: 'Length in beats.' },
    { k: 'float', name: 'decay', def: 0.25, min: 0.01, max: 2, help: 'Pulse decay time as a fraction of the division.' },
    { k: 'float', name: 'duty', def: 0.5, min: 0, max: 1, help: 'Gate on-time fraction.' },
    { k: 'float', name: 'swing', def: 0, min: 0, max: 1 },
  ],
  sig(c) {
    const div = Math.max(c.p.division, 1e-3);
    const pairs = c.beat / (2 * div);
    const k = Math.floor(pairs), pp = pairs - k;
    const split = 0.5 + 0.25 * clamp(c.p.swing, 0, 1);
    const second = pp >= split;
    const ph = second ? (pp - split) / (1 - split) : pp / split;
    switch (c.p.output) {
      case 1: return ph;
      case 2: return 2 * k + (second ? 1 : 0);
      case 3: return ph < c.p.duty ? 1 : 0;
      default: return Math.exp(-ph / Math.max(c.p.decay, 1e-3));
    }
  },
};

const BANDS = ['level', 'bass', 'lowmid', 'mid', 'high', 'air', 'kick', 'onset'] as const;
const audioband: OpDef = {
  type: 'audioband', label: 'Audio Band', category: 'Audio', inputs: [], output: 'sig',
  help: 'Level of one analysis band: gain, threshold (subtract and rescale), curve, then attack/release smoothing.',
  params: [
    { k: 'enum', name: 'band', options: ['Level', 'Bass', 'Low mid', 'Mid', 'High', 'Air', 'Kick', 'Onset'], def: 1 },
    { k: 'float', name: 'gain', def: 1, min: 0, max: 8 },
    { k: 'float', name: 'threshold', def: 0, min: 0, max: 1 },
    { k: 'float', name: 'attack', def: 0.01, min: 0, max: 2, unit: 's' },
    { k: 'float', name: 'release', def: 0.15, min: 0, max: 2, unit: 's' },
    { k: 'float', name: 'exponent', def: 1, min: 0.1, max: 8 },
  ],
  sig(c) {
    const s = c.state;
    const thr = clamp(c.p.threshold, 0, 0.999);
    let v = (c.audio[BANDS[clamp(c.p.band, 0, 7)]] ?? 0) * c.p.gain;
    v = Math.max(0, v - thr) / (1 - thr);
    v = Math.pow(v, Math.max(c.p.exponent, 1e-3));
    if (fresh(c)) s.v = v;
    s.v = follow(s.v, v, c.p.attack, c.p.release, c.dt);
    return s.v;
  },
};

const fftbin: OpDef = {
  type: 'fftbin', label: 'FFT Bin', category: 'Audio', inputs: [], output: 'sig',
  help: 'Average magnitude of a slice of the log spectrum (0 = lowest, 1 = highest frequency).',
  params: [
    { k: 'float', name: 'position', def: 0.1, min: 0, max: 1 },
    { k: 'float', name: 'width', def: 0.02, min: 0, max: 1 },
    { k: 'float', name: 'gain', def: 1, min: 0, max: 8 },
    { k: 'float', name: 'attack', def: 0.01, min: 0, max: 2, unit: 's' },
    { k: 'float', name: 'release', def: 0.15, min: 0, max: 2, unit: 's' },
  ],
  sig(c) {
    const sp = c.audio.spectrum, N = sp.length;
    let v = 0;
    if (N) {
      const x = clamp(c.p.position, 0, 1) * N - 0.5;
      const hw = Math.max(c.p.width, 0) * N * 0.5;
      if (hw < 1) { // narrower than a bin: interpolate
        const i = clamp(Math.floor(x), 0, N - 1), j = Math.min(i + 1, N - 1), f = clamp(x - i, 0, 1);
        v = sp[i] + (sp[j] - sp[i]) * f;
      } else {
        const lo = clamp(Math.round(x - hw), 0, N - 1), hi = clamp(Math.round(x + hw), lo, N - 1);
        for (let i = lo; i <= hi; i++) v += sp[i];
        v /= hi - lo + 1;
      }
    }
    v *= c.p.gain;
    const s = c.state;
    if (fresh(c)) s.v = v;
    s.v = follow(s.v, v, c.p.attack, c.p.release, c.dt);
    return s.v;
  },
};

const clock: OpDef = {
  type: 'clock', label: 'Clock', category: 'Signal', inputs: [], output: 'sig',
  help: 'Transport time in seconds, beats, bars (4/4) or frames, or the 0..1 phase within the beat.',
  params: [
    { k: 'enum', name: 'output', options: ['Time', 'Beat', 'Bar', 'Frame', 'Beat phase'], def: 0 },
    { k: 'float', name: 'multiplier', def: 1, min: -16, max: 16 },
  ],
  sig(c) {
    const m = c.p.multiplier;
    switch (c.p.output) {
      case 1: return c.beat * m;
      case 2: return (c.beat / 4) * m;
      case 3: return c.frame * m;
      case 4: return fract(c.beat * m);
      default: return c.time * m;
    }
  },
};

const sequencer: OpDef = {
  type: 'sequencer', label: 'Step Seq', category: 'Signal', inputs: [], output: 'sig',
  help: 'Steps through up to eight values in time with the beat, with optional glide.',
  params: [
    ...[1, 0.25, 0.6, 0.1, 0.8, 0.3, 0.5, 0].map((def, i) => ({ k: 'float' as const, name: `s${i + 1}`, label: `Step ${i + 1}`, def, min: 0, max: 1, group: 'Steps' })),
    { k: 'int', name: 'steps', def: 8, min: 1, max: 8 },
    { k: 'float', name: 'division', def: 0.5, min: 0.0625, max: 16, help: 'Step length in beats.' },
    { k: 'float', name: 'glide', def: 0, min: 0, max: 1, help: 'Fraction of each step spent sliding from the previous value.' },
  ],
  sig(c) {
    const n = clamp(c.p.steps, 1, 8);
    const pos = c.beat / Math.max(c.p.division, 1e-3);
    const k = Math.floor(pos), ph = pos - k;
    const at = (i: number) => c.p[`s${(i - n * Math.floor(i / n)) + 1}`] as number;
    const cur = at(k);
    if (c.p.glide <= 0 || ph >= c.p.glide) return cur;
    const prev = at(k - 1);
    return prev + (cur - prev) * smooth(ph / c.p.glide);
  },
};

const logic: OpDef = {
  type: 'logic', label: 'Logic', category: 'Signal', inputs: [sig('a'), sig('b')], output: 'sig',
  help: 'Boolean logic (inputs are true above Threshold) and comparisons. Outputs 0 or 1. Unconnected B compares against Threshold.',
  params: [
    { k: 'enum', name: 'mode', label: 'Operation', options: ['AND', 'OR', 'XOR', 'NOT', 'Greater', 'Less', 'Equal'], def: 0 },
    { k: 'float', name: 'threshold', def: 0.5, min: -10, max: 10 },
    { k: 'float', name: 'tolerance', def: 0.01, min: 0, max: 1, help: 'Equal: maximum difference.' },
  ],
  sig(c) {
    const thr = c.p.threshold;
    const a = c.ins[0], b = c.connected[1] ? c.ins[1] : thr;
    const A = a > thr, B = b > thr;
    let r: boolean;
    switch (c.p.mode) {
      case 1: r = A || B; break;
      case 2: r = A !== B; break;
      case 3: r = !A; break;
      case 4: r = a > b; break;
      case 5: r = a < b; break;
      case 6: r = Math.abs(a - b) <= c.p.tolerance; break;
      default: r = A && B;
    }
    return r ? 1 : 0;
  },
};

const hold: OpDef = {
  type: 'hold', label: 'Sample & Hold', category: 'Signal', inputs: [sig('value'), sig('trig')], output: 'sig',
  help: 'Captures Value on each rising edge of Trig and holds it.',
  params: [{ k: 'float', name: 'threshold', def: 0.5, min: 0, max: 1 }],
  sig(c) {
    const s = c.state, high = c.ins[1] > c.p.threshold;
    if (fresh(c)) { s.v = c.ins[0]; s.high = high; }
    if (high && !s.high) s.v = c.ins[0];
    s.high = high;
    return s.v;
  },
};

export const ops: OpDef[] = [
  lfo, sigconst, sigmath, remap, lag, spring, trigger, counter, signoise, beat, audioband, fftbin, clock, sequencer, logic, hold,
];
