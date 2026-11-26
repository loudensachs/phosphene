// NERVE spectral operators: a real 2D FFT on the GPU (radix-2 Stockham, one fullscreen pass per stage)
// and a family of frequency-domain effects built on it.
//
// Layout of a spectrum texture (N×N rgba16float, N a power of two):
//   .xy = complex FFT of (R + iG), .zw = complex FFT of (B + i·0).
// Two real channels packed into one complex signal are separated with Hermitian symmetry
// (X_R(k) = (Z(k) + conj Z(-k)) / 2, X_G(k) = (Z(k) - conj Z(-k)) / 2i), so one texture carries the
// full RGB spectrum and every transform stage is a single pass. Every edit keeps each channel's
// spectrum Hermitian (real-symmetric gains, odd-symmetric phase offsets), which keeps the inverse real
// and stops R/G crosstalk.
//
// Each 1D stage is scaled by 1/√2, so the 2D transform is unitary (1/N overall): forward∘inverse is the
// identity and the DC term is N·mean, which stays well inside half-float range at N ≤ 1024.
//
// The picture is squeezed into the inner (1 - 2·pad) of the grid; the margin is filled with a mirrored
// cross-fade between opposite edges so the periodic signal has no hard seam (kills the "+" artefact and
// edge ringing). Frequencies are measured in physical units (cycles per picture height) so radial and
// angular masks stay round at any aspect: ν = k · asp / (N/2), with 1 = Nyquist of the finer axis.
import type { CookCtx, OpDef, PassDecl, ParamDef } from '../types';

const SP_FN = /* wgsl */`
struct sp3 { r: vec2f, g: vec2f, b: vec2f };
fn sp_n() -> i32 { return i32(g.res.x + 0.5); }
fn sp_px(uv: vec2f) -> vec2i { return vec2i(floor(uv * g.res)); }
fn sp_wrap(p: vec2i, n: i32) -> vec2i { return ((p % n) + n) % n; }
fn sp_neg(p: vec2i, n: i32) -> vec2i { return (vec2i(n) - p) % n; }
// signed frequency index in [-N/2, N/2)
fn sp_sfreq(p: vec2i, n: i32) -> vec2f { return vec2f(select(p, p - n, p >= vec2i(n / 2))); }
fn sp_cmul(a: vec2f, b: vec2f) -> vec2f { return vec2f(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
fn sp_arg(z: vec2f) -> f32 { if (dot(z, z) < 1e-30) { return 0.0; } return atan2(z.y, z.x); }
fn sp_polar(m: f32, ph: f32) -> vec2f { return m * vec2f(cos(ph), sin(ph)); }
fn sp_wrapang(x: f32) -> f32 { return x - TAU * round(x / TAU); }
// z = packed spectrum at k, zm = packed spectrum at -k
fn sp_unpack(z: vec4f, zm: vec4f) -> sp3 {
  let c1 = vec2f(zm.x, -zm.y);
  let d = 0.5 * (z.xy - c1);
  return sp3(0.5 * (z.xy + c1), vec2f(d.y, -d.x), 0.5 * (z.zw + vec2f(zm.z, -zm.w)));
}
fn sp_pack(s: sp3) -> vec4f { return vec4f(s.r.x - s.g.y, s.r.y + s.g.x, s.b); }
// Round to the nearest half float before storing. Some GPUs truncate on f32→f16 render-target writes, which
// over ~40 passes shrinks the picture by ~1%; an exactly representable value is stored unchanged.
fn sp_q(v: vec4f) -> vec4f { let f = frexp(v); return ldexp(round(f.fract * 2048.0) / 2048.0, f.exp); }
`;

const SP_PASSES: Record<string, PassDecl> = {
  // Resample a picture into the N×N grid (mirror-blended margin), or a kernel centred on index 0 (zero margin).
  sp_load: {
    inputs: ['src'], fields: [['pad', 'f32'], ['kern', 'i32'], ['taps', 'i32']],
    body: /* wgsl */`${SP_FN}
fn sp_edge(t: f32, gap: f32) -> vec3f {
  let T = 1.0 + gap;
  let x = t - T * floor(t / T);
  if (x <= 1.0 || gap <= 0.0) { return vec3f(x, x, 0.0); }
  let d = x - 1.0;
  return vec3f(1.0 - d, gap - d, smoothstep(0.0, 1.0, d / gap));
}
fn sp_tap(a: f32, b: f32) -> vec3f { return textureSampleLevel(src, smp, vec2f(a, b), 0.0).rgb; }
fn sp_padded(t: vec2f, gap: f32) -> vec3f {
  let ex = sp_edge(t.x, gap); let ey = sp_edge(t.y, gap);
  var c = sp_tap(ex.x, ey.x) * (1.0 - ex.z) * (1.0 - ey.z);
  if (ex.z > 0.0) { c += sp_tap(ex.y, ey.x) * ex.z * (1.0 - ey.z); }
  if (ey.z > 0.0) {
    c += sp_tap(ex.x, ey.y) * (1.0 - ex.z) * ey.z;
    if (ex.z > 0.0) { c += sp_tap(ex.y, ey.y) * ex.z * ey.z; }
  }
  return c;
}
fn op(uv: vec2f) -> vec4f {
  let n = sp_n();
  let p = sp_px(uv);
  let sc = 1.0 / (1.0 - 2.0 * u.pad);
  let gap = 2.0 * u.pad * sc;
  var q = vec2f(p) + 0.5;
  // kernels: grid index 0 is the kernel picture's centre
  if (u.kern == 1) { q = vec2f(sp_wrap(p + vec2i(n / 2), n)); }
  let t0 = (q / f32(n) - u.pad) * sc;
  let dt = sc / f32(n);
  let nt = clamp(u.taps, 1, 4);
  var acc = vec3f(0.0);
  for (var j = 0; j < nt; j++) { for (var i = 0; i < nt; i++) {
    // box prefilter over one grid cell so downsampling does not alias
    let t = t0 + ((vec2f(f32(i), f32(j)) + 0.5) / f32(nt) - 0.5) * dt;
    if (u.kern == 1) {
      if (all(t >= vec2f(0.0)) && all(t <= vec2f(1.0))) { acc += textureSampleLevel(src, smp, t, 0.0).rgb; }
    } else {
      acc += sp_padded(t, gap);
    }
  } }
  return sp_q(vec4f(acc / f32(nt * nt), 0.0));
}`,
  },
  // One radix-2 Stockham stage along an axis (gather form). ns = 1, 2, 4 … N/2. dir = -1 forward, +1 inverse.
  sp_fft: {
    inputs: ['src'], fields: [['ns', 'i32'], ['dir', 'f32'], ['axis', 'i32']],
    body: /* wgsl */`${SP_FN}
fn op(uv: vec2f) -> vec4f {
  let n = sp_n();
  let p = sp_px(uv);
  let o = select(p.x, p.y, u.axis == 1);
  let ns = u.ns;
  let k = o % ns;
  let j = (o / (2 * ns)) * ns + k;
  var ia = p; var ib = p;
  if (u.axis == 0) { ia.x = j; ib.x = j + n / 2; } else { ia.y = j; ib.y = j + n / 2; }
  let a = textureLoad(src, ia, 0);
  let b = textureLoad(src, ib, 0);
  let ang = u.dir * PI * f32(k) / f32(ns);
  let tw = vec2f(cos(ang), sin(ang));
  let s = select(1.0, -1.0, (o % (2 * ns)) >= ns);
  return sp_q(vec4f(a.xy + s * sp_cmul(b.xy, tw), a.zw + s * sp_cmul(b.zw, tw)) * 0.70710678118);
}`,
  },
  // Back to working resolution (Catmull-Rom), optional restore of detail finer than the grid, mix, alpha from src.
  sp_out: {
    inputs: ['spec', 'src', 'orig'], fields: [['pad', 'f32'], ['amt', 'f32'], ['detail', 'f32'], ['pos', 'i32']],
    body: /* wgsl */`${SP_FN}
fn sp_cr(t: texture_2d<f32>, q: vec2f, n: i32) -> vec3f {
  let f0 = q - 0.5;
  let i0 = vec2i(floor(f0));
  let f = f0 - floor(f0);
  let wx = vec4f(f.x * (-0.5 + f.x * (1.0 - 0.5 * f.x)), 1.0 + f.x * f.x * (-2.5 + 1.5 * f.x),
                 f.x * (0.5 + f.x * (2.0 - 1.5 * f.x)), f.x * f.x * (-0.5 + 0.5 * f.x));
  let wy = vec4f(f.y * (-0.5 + f.y * (1.0 - 0.5 * f.y)), 1.0 + f.y * f.y * (-2.5 + 1.5 * f.y),
                 f.y * (0.5 + f.y * (2.0 - 1.5 * f.y)), f.y * f.y * (-0.5 + 0.5 * f.y));
  var c = vec3f(0.0);
  for (var b = 0; b < 4; b++) { for (var a = 0; a < 4; a++) {
    c += textureLoad(t, sp_wrap(i0 + vec2i(a - 1, b - 1), n), 0).xyz * (wx[a] * wy[b]);
  } }
  return c;
}
fn op(uv: vec2f) -> vec4f {
  let n = i32(textureDimensions(spec).x);
  let q = (u.pad + uv * (1.0 - 2.0 * u.pad)) * f32(n);
  var rgb = sp_cr(spec, q, n);
  let o = textureSampleLevel(src, smp, uv, 0.0);
  if (u.detail != 0.0) { rgb += u.detail * (o.rgb - sp_cr(orig, q, n)); }
  if (u.pos == 1) { rgb = max(rgb, vec3f(0.0)); }
  return vec4f(mix(o.rgb, rgb, u.amt), o.a);
}`,
  },
};

// ------------------------------------------------------------------------------------------------
// CPU side
// ------------------------------------------------------------------------------------------------
const PAD = 0.03;
type T = { tex: GPUTexture; view: GPUTextureView };

function gridN(c: CookCtx) { return 256 << Math.max(0, Math.min(2, Math.round(c.p.size ?? 1))); }
/** Physical frequency scale: ν = k · asp / (N/2). */
function aspOf(c: CookCtx): [number, number] { const a = c.w / c.h; return a >= 1 ? [1 / a, 1] : [1, a]; }

function load(c: CookCtx, key: string, view: GPUTextureView | null, N: number, pad: number, kern = false) {
  const t = c.tex(key, N, N);
  const ratio = Math.max(c.w, c.h) / (N * (1 - 2 * pad));
  c.run('sp_load', t.view, [view], { pad, kern: kern ? 1 : 0, taps: ratio > 2.5 ? 4 : ratio > 1.2 ? 2 : 1 }, [N, N]);
  return t;
}

/** 2·log2(N) passes. The first reads `src` (must not be d0), then ping-pongs; the result always lands in d1. */
function fft(c: CookCtx, src: GPUTextureView, d0: T, d1: T, N: number, dir: -1 | 1): T {
  const d = [d0, d1];
  let from = src, i = 0;
  for (let axis = 0; axis < 2; axis++) {
    for (let ns = 1; ns < N; ns *= 2, i++) {
      c.run('sp_fft', d[i & 1].view, [from], { ns, dir, axis }, [N, N]);
      from = d[i & 1].view;
    }
  }
  return d1;
}

function finish(c: CookCtx, spec: T, orig: T | null, pad: number, detail: number, pos: boolean) {
  c.run('sp_out', c.out, [spec.view, c.ins[0], orig?.view ?? null], { pad, amt: c.p.wet, detail: orig ? detail : 0, pos: pos ? 1 : 0 });
}

function passThrough(c: CookCtx) {
  if (c.inTex[0] && c.inTex[0].width === c.outTex.width && c.inTex[0].height === c.outTex.height) c.copy(c.inTex[0], c.outTex);
  else c.clear(c.out);
}

const P_SIZE: ParamDef = { k: 'enum', name: 'size', label: 'FFT size', options: ['256', '512', '1024'], def: 1, group: 'Quality', help: 'Square transform grid. Larger keeps more detail and costs more.' };
const P_WET: ParamDef = { k: 'float', name: 'wet', label: 'Mix', def: 1, min: 0, max: 1, help: 'Blend with the original picture.' };

const smoothstep = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ------------------------------------------------------------------------------------------------
// Spectrum View
// ------------------------------------------------------------------------------------------------
const fftview: OpDef = {
  type: 'fftview', label: 'Spectrum View', category: 'Spectral', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }],
  help: 'Shows the picture\'s 2D frequency spectrum, centred: the middle is flat colour, the edges are the finest detail, and repeating structures show up as bright dots. Paint over this view to make a mask for Spectral Filter.',
  params: [
    { k: 'float', name: 'gain', def: 1, min: 0, max: 4, help: 'Brightness of the log-magnitude display.' },
    { k: 'enum', name: 'mode', options: ['Magnitude', 'Phase', 'Both'], def: 0, help: 'Magnitude per RGB channel, phase of the luma spectrum as hue, or both (hue = phase, brightness = magnitude).' },
    P_WET, P_SIZE,
  ],
  passes: {
    ...SP_PASSES,
    fv_show: {
      inputs: ['spec', 'src'], fields: [['gain', 'f32'], ['mode', 'i32'], ['amt', 'f32']],
      body: /* wgsl */`${SP_FN}
fn op(uv: vec2f) -> vec4f {
  let n = i32(textureDimensions(spec).x);
  let p = sp_wrap(vec2i(floor(uv * f32(n))) + vec2i(n / 2), n);
  let s = sp_unpack(textureLoad(spec, p, 0), textureLoad(spec, sp_neg(p, n), 0));
  let norm = u.gain / log2(1.0 + f32(n));
  let lm = log2(1.0 + vec3f(length(s.r), length(s.g), length(s.b))) * norm;
  let lz = 0.2126 * s.r + 0.7152 * s.g + 0.0722 * s.b;
  let hue = fract(sp_arg(lz) / TAU + 1.0);
  var c = lm;
  if (u.mode == 1) { c = hsv2rgb(vec3f(hue, 0.8, 1.0)); }
  else if (u.mode == 2) { c = hsv2rgb(vec3f(hue, 0.8, log2(1.0 + length(lz)) * norm)); }
  let o = textureSampleLevel(src, smp, uv, 0.0);
  return vec4f(mix(o.rgb, c, u.amt), o.a);
}`,
    },
  },
  cook(c) {
    if (!c.ins[0]) { c.clear(c.out); return; }
    const N = gridN(c);
    const x = load(c, 'in', c.ins[0], N, PAD);
    const s = fft(c, x.view, c.tex('a', N, N), c.tex('b', N, N), N, -1);
    c.run('fv_show', c.out, [s.view, c.ins[0]], { gain: c.p.gain, mode: c.p.mode, amt: c.p.wet });
  },
};

// ------------------------------------------------------------------------------------------------
// Spectral Filter
// ------------------------------------------------------------------------------------------------
const specfilter: OpDef = {
  type: 'specfilter', label: 'Spectral Filter', category: 'Spectral', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }, { name: 'mask', type: 'tex', optional: true }],
  help: 'Filters the picture by detail size and direction in the frequency domain: cut coarse or fine detail, boost a band of texture, or remove structures at one angle. Connect Mask (e.g. painted over a Spectrum View) to use it directly as the filter shape.',
  params: [
    { k: 'float', name: 'lowCut', label: 'Low cut', def: 0, min: 0, max: 1, step: 0.001, group: 'Band', help: 'Removes detail coarser than this, as a fraction of Nyquist. 0 = off.' },
    { k: 'float', name: 'highCut', label: 'High cut', def: 1, min: 0, max: 1, step: 0.001, group: 'Band', help: 'Removes detail finer than this, as a fraction of Nyquist. 1 = off.' },
    { k: 'float', name: 'softness', def: 0.2, min: 0, max: 1, group: 'Band', help: 'Width of the cut slopes.' },
    { k: 'bool', name: 'keepDC', label: 'Keep average', def: true, group: 'Band', help: 'Never filter the average colour, so a low cut gives detail over the mean instead of over black.' },
    { k: 'float', name: 'center', label: 'Band centre', def: 0.12, min: 0.016, max: 1, step: 0.001, group: 'Boost', help: 'Centre of the boosted band, as a fraction of Nyquist.' },
    { k: 'float', name: 'width', label: 'Band width', def: 0.8, min: 0.1, max: 4, unit: 'oct', group: 'Boost', help: 'Width of the band in octaves.' },
    { k: 'float', name: 'boost', label: 'Band gain', def: 1, min: -1, max: 8, group: 'Boost', help: 'Extra gain inside the band. -1 removes the band.' },
    { k: 'bool', name: 'ring', label: 'Ring only', def: false, group: 'Boost', help: 'Keep only the band (a ring of frequencies), times 1 + gain.' },
    { k: 'float', name: 'speed', label: 'Sweep speed', def: 0, min: -4, max: 4, unit: 'Hz', group: 'Boost', help: 'Sweeps the band centre up and down six octaves; sweeps per second.' },
    { k: 'enum', name: 'dirMode', label: 'Direction', options: ['Off', 'Remove', 'Isolate'], def: 0, group: 'Direction', help: 'Remove or keep only structures running at one angle.' },
    { k: 'float', name: 'angle', def: 0, min: -180, max: 180, unit: '°', group: 'Direction', help: 'Orientation of the structures. 0° = horizontal lines.' },
    { k: 'float', name: 'spread', def: 12, min: 1, max: 90, unit: '°', group: 'Direction', help: 'Angular width of the direction filter.' },
    { k: 'enum', name: 'audio', options: ['None', 'Low cut follows bass', 'Band follows centroid'], def: 0, group: 'Audio', help: 'Bass raises the low cut, or the audio spectral centroid moves the band centre.' },
    { k: 'float', name: 'react', label: 'Audio amount', def: 1, min: 0, max: 2, group: 'Audio' },
    { k: 'bool', name: 'keepDetail', label: 'Keep fine detail', def: true, group: 'Quality', help: 'Adds back detail finer than the FFT grid, weighted by the filter at Nyquist. Not used with a Mask input.' },
    P_WET, P_SIZE,
  ],
  passes: {
    ...SP_PASSES,
    sf_mod: {
      inputs: ['spec', 'mask'],
      fields: [['lo', 'f32'], ['hi', 'f32'], ['soft', 'f32'], ['center', 'f32'], ['bw', 'f32'], ['boost', 'f32'], ['ring', 'i32'],
        ['dmode', 'i32'], ['ang', 'f32'], ['spread', 'f32'], ['keepDC', 'i32'], ['speed', 'f32'], ['audio', 'i32'], ['react', 'f32'], ['asp', 'vec2f']],
      body: /* wgsl */`${SP_FN}
fn sf_tri(x: f32) -> f32 { let t = x - 2.0 * floor(x * 0.5); return select(2.0 - t, t, t <= 1.0); }
fn op(uv: vec2f) -> vec4f {
  let n = sp_n();
  let p = sp_px(uv);
  let z = textureLoad(spec, p, 0);
  if (u.keepDC == 1 && p.x == 0 && p.y == 0) { return z; }
  let k = sp_sfreq(p, n);
  var m = 1.0;
  if (u.has_mask > 0.5) {
    // same centred layout as Spectrum View; symmetrised so the result stays real
    let h = f32(n / 2) + 0.5;
    m = 0.5 * (luma(textureSampleLevel(mask, smpR, (k + h) / f32(n), 0.0).rgb) + luma(textureSampleLevel(mask, smpR, (h - k) / f32(n), 0.0).rgb));
  } else {
    let nu = k * u.asp / (0.5 * f32(n));
    let r = length(nu);
    var lo = u.lo;
    var c = clamp(u.center, 1.0 / 64.0, 1.0);
    if (u.speed != 0.0) { c = exp2(6.0 * sf_tri((log2(c) + 6.0) / 6.0 + g.time * u.speed) - 6.0); }
    if (u.audio == 1) { lo = min(lo + u.react * g.audio.x * 0.4, 0.99); }
    else if (u.audio == 2) {
      let e = g.audio.xyz;
      let cen = dot(e, vec3f(0.1, 0.4, 0.9)) / max(e.x + e.y + e.z, 1e-4);
      c = exp2(mix(log2(c), 6.0 * cen - 6.0, clamp(u.react, 0.0, 1.0)));
    }
    let s = u.soft * 0.1 + 1.0 / f32(n);
    var pb = 1.0;
    if (lo > 0.0) { pb *= smoothstep(lo - s, lo + s, r); }
    if (u.hi < 1.0) { pb *= 1.0 - smoothstep(u.hi - s, u.hi + s, r); }
    let oc = log2(max(r, 1e-6) / c) / max(u.bw, 0.05);
    let bump = exp(-0.5 * oc * oc);
    if (u.ring == 1) { m = pb * bump * max(1.0 + u.boost, 0.0); }
    else { m = pb * max(1.0 + u.boost * bump, 0.0); }
    if (u.dmode > 0 && r > 0.0) {
      // structures at angle a have their energy along the perpendicular frequency direction
      var d = atan2(-nu.y, nu.x) - (u.ang + 0.5 * PI);
      d = d - PI * round(d / PI);
      let ds = d / max(u.spread, 1e-3);
      let a = exp(-0.5 * ds * ds);
      m *= select(a, 1.0 - a, u.dmode == 1);
    }
  }
  // a real, even gain applies to the packed pair directly
  return sp_q(z * m);
}`,
    },
  },
  cook(c) {
    if (!c.ins[0]) { c.clear(c.out); return; }
    const p = c.p, N = gridN(c);
    const x = load(c, 'in', c.ins[0], N, PAD);
    const a = c.tex('a', N, N), b = c.tex('b', N, N);
    const s = fft(c, x.view, a, b, N, -1);
    c.run('sf_mod', a.view, [s.view, c.ins[1]], {
      lo: p.lowCut, hi: p.highCut, soft: p.softness, center: p.center, bw: p.width, boost: p.boost, ring: p.ring,
      dmode: p.dirMode, ang: (p.angle * Math.PI) / 180, spread: (p.spread * Math.PI) / 180, keepDC: p.keepDC,
      speed: p.speed, audio: p.audio, react: p.react, asp: aspOf(c),
    }, [N, N]);
    const r = fft(c, a.view, b, a, N, 1);
    // filter gain at Nyquist (radial part, static band centre) decides how much sub-grid detail to restore
    let detail = 0;
    if (p.keepDetail && !c.ins[1]) {
      const s0 = p.softness * 0.1 + 1 / N;
      let pb = 1;
      if (p.lowCut > 0) pb *= smoothstep(p.lowCut - s0, p.lowCut + s0, 1);
      if (p.highCut < 1) pb *= 1 - smoothstep(p.highCut - s0, p.highCut + s0, 1);
      const oc = Math.log2(1 / Math.min(1, Math.max(1 / 64, p.center))) / Math.max(p.width, 0.05);
      const bump = Math.exp(-0.5 * oc * oc);
      detail = p.ring ? pb * bump * Math.max(1 + p.boost, 0) : pb * Math.max(1 + p.boost * bump, 0);
      if (p.dirMode === 2) detail = 0;
    }
    finish(c, r, x, PAD, detail, false);
  },
};

// ------------------------------------------------------------------------------------------------
// Phase Scramble
// ------------------------------------------------------------------------------------------------
const phasescramble: OpDef = {
  type: 'phasescramble', label: 'Phase Scramble', category: 'Spectral', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }],
  help: 'Keeps how much of every detail size the picture has but randomises where it sits, dissolving shapes into a texture with the same look; at Amount 1 it becomes pure texture. Drift makes the texture boil smoothly over time.',
  params: [
    { k: 'float', name: 'amount', def: 0.5, min: 0, max: 1, help: '0 = original phase, 1 = fully random phase (texture synthesis).' },
    { k: 'float', name: 'speed', label: 'Drift', def: 0.15, min: 0, max: 4, unit: 'Hz', help: 'Each frequency\'s phase turns at its own steady rate, up to this many cycles per second.' },
    { k: 'float', name: 'lo', label: 'Low bound', def: 0.04, min: 0, max: 1, step: 0.001, help: 'Only frequencies above this fraction of Nyquist are affected. Raise to keep large shapes intact.' },
    { k: 'float', name: 'hi', label: 'High bound', def: 1, min: 0, max: 1, step: 0.001, help: 'Only frequencies below this are affected. 1 = up to the finest detail.' },
    { k: 'float', name: 'seed', def: 0, min: 0, max: 100, step: 1 },
    P_WET, P_SIZE,
  ],
  passes: {
    ...SP_PASSES,
    ps_mod: {
      inputs: ['spec'], fields: [['amount', 'f32'], ['speed', 'f32'], ['lo', 'f32'], ['hi', 'f32'], ['seed', 'f32'], ['asp', 'vec2f']],
      body: /* wgsl */`${SP_FN}
fn ps_h(p: vec2i) -> vec2f { return hash22(vec2f(p) + u.seed * vec2f(17.31, 41.77) + 0.37); }
fn op(uv: vec2f) -> vec4f {
  let n = sp_n();
  let p = sp_px(uv);
  let z = textureLoad(spec, p, 0);
  let r = length(sp_sfreq(p, n) * u.asp / (0.5 * f32(n)));
  let s = 0.03;
  var w = 1.0;
  if (u.lo > 0.0) { w *= smoothstep(u.lo - s, u.lo + s, r); }
  if (u.hi < 1.0) { w *= 1.0 - smoothstep(u.hi - s, u.hi + s, r); }
  // offsets are differences of a hash at k and -k: odd-symmetric, so the picture stays real
  let ha = ps_h(p); let hb = ps_h(sp_neg(p, n));
  let rate = w * u.speed * (ha.y - hb.y);
  let d = w * u.amount * TAU * (ha.x - hb.x) + TAU * fract(g.time * rate);
  let e = vec2f(cos(d), sin(d));
  return sp_q(vec4f(sp_cmul(z.xy, e), sp_cmul(z.zw, e)));
}`,
    },
  },
  cook(c) {
    if (!c.ins[0]) { c.clear(c.out); return; }
    const p = c.p, N = gridN(c);
    const x = load(c, 'in', c.ins[0], N, PAD);
    const a = c.tex('a', N, N), b = c.tex('b', N, N);
    const s = fft(c, x.view, a, b, N, -1);
    c.run('ps_mod', a.view, [s.view], { amount: p.amount, speed: p.speed, lo: p.lo, hi: p.hi, seed: p.seed, asp: aspOf(c) }, [N, N]);
    finish(c, fft(c, a.view, b, a, N, 1), null, PAD, 0, true);
  },
};

// ------------------------------------------------------------------------------------------------
// Cross Synthesis
// ------------------------------------------------------------------------------------------------
const crosssynth: OpDef = {
  type: 'crosssynth', label: 'Cross Synthesis', category: 'Spectral', output: 'tex',
  inputs: [{ name: 'a', type: 'tex' }, { name: 'b', type: 'tex' }],
  help: 'A vocoder for pictures: the shapes and edges of B are rebuilt from the texture and energy of A, by combining A\'s spectral magnitude with B\'s phase.',
  params: [
    { k: 'float', name: 'magAmt', label: 'Magnitude from A', def: 1, min: 0, max: 1, help: '1 = all energy from A, 0 = from B.' },
    { k: 'float', name: 'phaseAmt', label: 'Phase from B', def: 1, min: 0, max: 1, help: '1 = all structure from B, 0 = from A.' },
    { k: 'float', name: 'whiten', label: 'Whiten A', def: 0, min: 0, max: 1, help: 'Flattens A\'s natural 1/f falloff so its fine texture carries as much weight as its large shapes.' },
    P_WET, P_SIZE,
  ],
  passes: {
    ...SP_PASSES,
    cs_mod: {
      inputs: ['sa', 'sb'], fields: [['magAmt', 'f32'], ['phaseAmt', 'f32'], ['whiten', 'f32'], ['asp', 'vec2f']],
      body: /* wgsl */`${SP_FN}
fn cs_one(a: vec2f, b: vec2f, wg: f32) -> vec2f {
  let m = mix(length(b), length(a) * wg, u.magAmt);
  let pa = sp_arg(a);
  return sp_polar(m, pa + u.phaseAmt * sp_wrapang(sp_arg(b) - pa));
}
fn op(uv: vec2f) -> vec4f {
  let n = sp_n();
  let p = sp_px(uv); let pm = sp_neg(p, n);
  let A = sp_unpack(textureLoad(sa, p, 0), textureLoad(sa, pm, 0));
  let B = sp_unpack(textureLoad(sb, p, 0), textureLoad(sb, pm, 0));
  var wg = 1.0;
  if (u.whiten > 0.0 && (p.x != 0 || p.y != 0)) {
    let r = length(sp_sfreq(p, n) * u.asp / (0.5 * f32(n)));
    wg = pow(max(r, 1.0 / f32(n)) / 0.1, u.whiten);
  }
  return sp_q(sp_pack(sp3(cs_one(A.r, B.r, wg), cs_one(A.g, B.g, wg), cs_one(A.b, B.b, wg))));
}`,
    },
  },
  cook(c) {
    if (!c.ins[0]) { c.clear(c.out); return; }
    if (!c.ins[1]) { passThrough(c); return; }
    const p = c.p, N = gridN(c);
    const t = c.tex('t', N, N);
    const ia = load(c, 'ia', c.ins[0], N, PAD), ib = load(c, 'ib', c.ins[1], N, PAD);
    fft(c, ia.view, t, ia, N, -1);
    fft(c, ib.view, t, ib, N, -1);
    c.run('cs_mod', t.view, [ia.view, ib.view], { magAmt: p.magAmt, phaseAmt: p.phaseAmt, whiten: p.whiten, asp: aspOf(c) }, [N, N]);
    finish(c, fft(c, t.view, ia, t, N, 1), null, PAD, 0, true);
  },
};

// ------------------------------------------------------------------------------------------------
// Spectral Freeze
// ------------------------------------------------------------------------------------------------
const specfreeze: OpDef = {
  type: 'specfreeze', label: 'Spectral Freeze', category: 'Spectral', output: 'tex', animated: true,
  inputs: [{ name: 'src', type: 'tex' }],
  help: 'Freeze captures the picture\'s spectrum; while frozen, the live picture is redrawn with the captured texture and energy (or the captured structure), then eases back to live with Decay.',
  params: [
    { k: 'bool', name: 'freeze', def: false, help: 'Captures on switch-on; holds while on.' },
    { k: 'enum', name: 'mode', options: ['Frozen magnitude, live phase', 'Live magnitude, frozen phase'], def: 0, help: 'Frozen magnitude keeps the captured texture under live shapes; frozen phase keeps the captured shapes with live texture.' },
    { k: 'float', name: 'blend', label: 'Amount', def: 1, min: 0, max: 1, help: 'How far the spectrum moves toward the frozen one.' },
    { k: 'float', name: 'decay', def: 0, min: 0, max: 4, unit: '/s', help: 'Rate at which the effect fades back to live after capture. 0 = hold.' },
    P_WET, P_SIZE,
  ],
  passes: {
    ...SP_PASSES,
    fz_mod: {
      inputs: ['live', 'frz'], fields: [['mode', 'i32'], ['eff', 'f32']],
      body: /* wgsl */`${SP_FN}
fn fz_one(l: vec2f, f: vec2f) -> vec2f {
  let pl = sp_arg(l);
  if (u.mode == 0) { return sp_polar(mix(length(l), length(f), u.eff), pl); }
  return sp_polar(length(l), pl + u.eff * sp_wrapang(sp_arg(f) - pl));
}
fn op(uv: vec2f) -> vec4f {
  let n = sp_n();
  let p = sp_px(uv); let pm = sp_neg(p, n);
  let L = sp_unpack(textureLoad(live, p, 0), textureLoad(live, pm, 0));
  let F = sp_unpack(textureLoad(frz, p, 0), textureLoad(frz, pm, 0));
  return sp_q(sp_pack(sp3(fz_one(L.r, F.r), fz_one(L.g, F.g), fz_one(L.b, F.b))));
}`,
    },
  },
  cook(c) {
    const st = c.state, p = c.p, N = gridN(c);
    const frz = c.tex('frz', N, N);
    if (c.reset || frz.fresh) st.has = false;
    if (!c.ins[0] || !p.freeze) { st.has = false; passThrough(c); return; }
    const x = load(c, 'in', c.ins[0], N, PAD);
    const a = c.tex('a', N, N), b = c.tex('b', N, N);
    const s = fft(c, x.view, a, b, N, -1);
    if (!st.has) { c.copy(s.tex, frz.tex); st.has = true; st.t0 = c.time; }
    const eff = p.blend * Math.exp(-p.decay * Math.max(0, c.time - st.t0));
    c.run('fz_mod', a.view, [s.view, frz.view], { mode: p.mode, eff }, [N, N]);
    // restore sub-grid live detail as the effect fades, so a full decay lands exactly on the live picture
    finish(c, fft(c, a.view, b, a, N, 1), x, PAD, 1 - eff, true);
  },
};

// ------------------------------------------------------------------------------------------------
// Spectral Smear
// ------------------------------------------------------------------------------------------------
const specblur: OpDef = {
  type: 'specblur', label: 'Spectral Smear', category: 'Spectral', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }],
  help: 'Reshapes how the picture\'s energy is spread over detail sizes and directions while its phase keeps everything in place: rotate the orientation of textures, push detail finer or coarser, smear spectral peaks into haze.',
  params: [
    { k: 'float', name: 'shift', label: 'Radial shift', def: 0.03, min: -0.5, max: 0.5, step: 0.001, help: 'Moves energy to finer (+) or coarser (-) detail, as a fraction of Nyquist.' },
    { k: 'float', name: 'rotate', def: 15, min: -180, max: 180, unit: '°', help: 'Rotates the spectrum: textures and edges change direction, positions stay.' },
    { k: 'float', name: 'rotSpeed', label: 'Rotate speed', def: 0, min: -180, max: 180, unit: '°/s' },
    { k: 'float', name: 'blur', label: 'Spectral blur', def: 0.02, min: 0, max: 0.3, step: 0.001, help: 'Blurs the magnitude spectrum (fraction of Nyquist): smooths repeating patterns into diffuse texture.' },
    { k: 'float', name: 'gamma', label: 'Magnitude gamma', def: 0.9, min: 0.25, max: 2, help: 'Below 1 flattens the falloff (crisper, grainier); above 1 steepens it (softer).' },
    P_WET, P_SIZE,
  ],
  passes: {
    ...SP_PASSES,
    sb_mag: {
      inputs: ['spec'],
      body: /* wgsl */`${SP_FN}
fn op(uv: vec2f) -> vec4f {
  let n = sp_n();
  var p = sp_px(uv);
  // the DC spike would leak into its neighbours when sampled: stand in its neighbour
  if (p.x == 0 && p.y == 0) { p = vec2i(1, 0); }
  let s = sp_unpack(textureLoad(spec, p, 0), textureLoad(spec, sp_neg(p, n), 0));
  return vec4f(log(vec3f(length(s.r), length(s.g), length(s.b)) + 1e-5), 1.0);
}`,
    },
    sb_mod: {
      inputs: ['spec', 'mag'], fields: [['shift', 'f32'], ['ang', 'f32'], ['angSpeed', 'f32'], ['blur', 'f32'], ['gamma', 'f32'], ['asp', 'vec2f']],
      body: /* wgsl */`${SP_FN}
// log magnitude at physical frequency nu (bilinear; nothing outside the grid's band)
fn sb_at(nu: vec2f, n: i32) -> vec3f {
  let h = 0.5 * f32(n);
  let k = nu * h / u.asp;
  if (any(abs(k) > vec2f(h))) { return vec3f(log(1e-5)); }
  return textureSampleLevel(mag, smpR, (k + 0.5) / f32(n), 0.0).rgb;
}
fn op(uv: vec2f) -> vec4f {
  let n = sp_n();
  let p = sp_px(uv);
  let z = textureLoad(spec, p, 0);
  if (p.x == 0 && p.y == 0) { return z; }
  let nu = sp_sfreq(p, n) * u.asp / (0.5 * f32(n));
  var q = rot(-(u.ang + g.time * u.angSpeed)) * nu;
  let rq = length(q);
  let rs = rq - u.shift;
  var lm = vec3f(log(1e-5));
  if (rs > 0.0) {
    q *= rs / rq;
    if (u.blur > 0.0) {
      // symmetric tap pairs keep the magnitude even, so the output stays real
      lm = sb_at(q, n);
      for (var i = 0; i < 6; i++) {
        let a = f32(i) * PI / 6.0;
        let o = u.blur * select(0.5, 1.0, (i & 1) == 1) * vec2f(cos(a), sin(a));
        lm += sb_at(q + o, n) + sb_at(q - o, n);
      }
      lm /= 13.0;
    } else { lm = sb_at(q, n); }
  }
  // reshape the falloff around the DC level, per channel
  let z0 = textureLoad(spec, vec2i(0), 0);
  let dc = log(abs(z0.xyz) + 1e-5);
  lm = dc + u.gamma * (lm - dc);
  let m = exp(lm);
  let s = sp_unpack(z, textureLoad(spec, sp_neg(p, n), 0));
  return sp_q(sp_pack(sp3(sp_polar(m.r, sp_arg(s.r)), sp_polar(m.g, sp_arg(s.g)), sp_polar(m.b, sp_arg(s.b)))));
}`,
    },
  },
  cook(c) {
    if (!c.ins[0]) { c.clear(c.out); return; }
    const p = c.p, N = gridN(c), d2r = Math.PI / 180;
    const x = load(c, 'in', c.ins[0], N, PAD);
    const a = c.tex('a', N, N), b = c.tex('b', N, N), m = c.tex('m', N, N);
    const s = fft(c, x.view, a, b, N, -1);
    c.run('sb_mag', m.view, [s.view], {}, [N, N]);
    c.run('sb_mod', a.view, [s.view, m.view], { shift: p.shift, ang: p.rotate * d2r, angSpeed: p.rotSpeed * d2r, blur: p.blur, gamma: p.gamma, asp: aspOf(c) }, [N, N]);
    finish(c, fft(c, a.view, b, a, N, 1), null, PAD, 0, true);
  },
};

// ------------------------------------------------------------------------------------------------
// Convolution
// ------------------------------------------------------------------------------------------------
const convolve: OpDef = {
  type: 'convolve', label: 'Convolution', category: 'Spectral', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }, { name: 'kernel', type: 'tex' }],
  help: 'Convolves the picture with any image used as the kernel (its centre is the origin): a shape gives that bokeh, a line gives streaks, a few dots give echoes. Deconvolve tries to undo a known blur instead.',
  params: [
    { k: 'float', name: 'gain', def: 1, min: 0, max: 4, help: 'The kernel is normalised by its total brightness; this scales the result.' },
    { k: 'bool', name: 'deconv', label: 'Deconvolve', def: false, help: 'Wiener deconvolution: removes the kernel\'s blur instead of applying it.' },
    { k: 'float', name: 'noise', label: 'Noise floor', def: 0.01, min: 0.0001, max: 0.5, step: 0.0001, help: 'Deconvolution regulariser. Raise it when the result rings or gets noisy.' },
    { k: 'float', name: 'pad', label: 'Edge padding', def: 0.1, min: 0, max: 0.25, step: 0.005, group: 'Quality', help: 'Margin (each side) that stops light from one edge wrapping around to the other. Needs to cover the kernel\'s reach.' },
    P_WET, P_SIZE,
  ],
  passes: {
    ...SP_PASSES,
    cv_mod: {
      inputs: ['sx', 'sk'], fields: [['deconv', 'i32'], ['noise', 'f32'], ['gain', 'f32']],
      body: /* wgsl */`${SP_FN}
fn cv_one(x: vec2f, h: vec2f) -> vec2f {
  if (u.deconv == 1) { return sp_cmul(x, vec2f(h.x, -h.y)) / (dot(h, h) + u.noise); }
  return sp_cmul(x, h);
}
fn op(uv: vec2f) -> vec4f {
  let n = sp_n();
  let p = sp_px(uv); let pm = sp_neg(p, n);
  let k0 = textureLoad(sk, vec2i(0), 0);
  // unitary transforms: FFT(x * k) = N·X·K and sum(k) = N·K(0), so the normalised kernel is K / K_luma(0)
  let ksum = 0.2126 * k0.x + 0.7152 * k0.y + 0.0722 * k0.z;
  if (abs(ksum) < 1e-6) { return textureLoad(sx, p, 0) * u.gain; }
  let X = sp_unpack(textureLoad(sx, p, 0), textureLoad(sx, pm, 0));
  let K = sp_unpack(textureLoad(sk, p, 0), textureLoad(sk, pm, 0));
  let inv = 1.0 / ksum;
  return sp_q(sp_pack(sp3(cv_one(X.r, K.r * inv), cv_one(X.g, K.g * inv), cv_one(X.b, K.b * inv))) * u.gain);
}`,
    },
  },
  cook(c) {
    if (!c.ins[0]) { c.clear(c.out); return; }
    if (!c.ins[1]) { passThrough(c); return; }
    const p = c.p, N = gridN(c), pad = Math.max(0, Math.min(0.25, p.pad));
    const t = c.tex('t', N, N);
    const ix = load(c, 'ix', c.ins[0], N, pad), ik = load(c, 'ik', c.ins[1], N, pad, true);
    fft(c, ix.view, t, ix, N, -1);
    fft(c, ik.view, t, ik, N, -1);
    c.run('cv_mod', t.view, [ix.view, ik.view], { deconv: p.deconv, noise: p.noise, gain: p.gain }, [N, N]);
    finish(c, fft(c, t.view, ix, t, N, 1), null, pad, 0, true);
  },
};

export const ops: OpDef[] = [fftview, specfilter, phasescramble, crosssynth, specfreeze, specblur, convolve];
