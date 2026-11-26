// NERVE light, glow and lens operators. Linear HDR in, linear HDR out: values above 1 drive the effects.
// Sizes are fractions of image height. Multi-resolution ops pass `res` to `c.run` so `g.res` is the target size.
import type { OpDef, CookCtx } from '../types';

/** Soft-knee highlight extraction (keeps hue, smooth onset over `knee` × threshold). */
const knee = (p: string) => /* wgsl */`
fn ${p}_knee(c: vec3f, thr: f32, kn0: f32) -> vec3f {
  let br = max(c.r, max(c.g, c.b));
  let kn = max(thr * kn0, 1e-4);
  var rq = clamp(br - thr + kn, 0.0, 2.0 * kn);
  rq = rq * rq / (4.0 * kn);
  return max(c, vec3f(0.0)) * max(rq, br - thr) / max(br, 1e-4);
}`;

/** Interleaved gradient noise: per-pixel jitter with a blue-ish spectrum. */
const ign = (p: string) => /* wgsl */`
fn ${p}_ign(q: vec2f) -> f32 { return fract(52.9829189 * fract(dot(floor(q), vec2f(0.06711056, 0.00583715)))); }`;

/** 3×3 tent upsample of `tex` at its own texel size. */
const tent = (p: string, tex: string) => /* wgsl */`
fn ${p}_tent(uv: vec2f) -> vec3f {
  let px = 1.0 / vec2f(textureDimensions(${tex}));
  var s = textureSampleLevel(${tex}, smp, uv, 0.0).rgb * 4.0;
  s += (textureSampleLevel(${tex}, smp, uv + vec2f(-px.x, 0.0), 0.0).rgb + textureSampleLevel(${tex}, smp, uv + vec2f(px.x, 0.0), 0.0).rgb
      + textureSampleLevel(${tex}, smp, uv + vec2f(0.0, -px.y), 0.0).rgb + textureSampleLevel(${tex}, smp, uv + vec2f(0.0, px.y), 0.0).rgb) * 2.0;
  s += textureSampleLevel(${tex}, smp, uv - px, 0.0).rgb + textureSampleLevel(${tex}, smp, uv + px, 0.0).rgb
     + textureSampleLevel(${tex}, smp, uv + vec2f(px.x, -px.y), 0.0).rgb + textureSampleLevel(${tex}, smp, uv + vec2f(-px.x, px.y), 0.0).rgb;
  return s / 16.0;
}`;

/** Composite a glow layer over the source: 0 Add, 1 Screen (HDR-safe), 2 effect only. */
const blendFn = (p: string) => /* wgsl */`
fn ${p}_blend(base: vec4f, fx: vec3f, m: i32) -> vec4f {
  if (m == 2) { return vec4f(fx, 1.0); }
  if (m == 1) { return vec4f(base.rgb + fx * (1.0 - clamp(base.rgb, vec3f(0.0), vec3f(1.0))), max(base.a, sat(luma(fx)))); }
  return vec4f(base.rgb + fx, max(base.a, sat(luma(fx))));
}`;

const COMP3 = ['Add', 'Screen', 'Effect only'];

/** Perceptual dither (±½ code value of an 8-bit display) so smooth, dim gradients never band on screen. */
const dither = (p: string) => /* wgsl */`
fn ${p}_dither(c: vec3f, q: vec2f) -> vec3f {
  let n = fract(52.9829189 * fract(dot(floor(q), vec2f(0.06711056, 0.00583715)))) - 0.5;
  let e = pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.2)) + n / 255.0;
  return pow(max(e, vec3f(0.0)), vec3f(2.2));
}`;

/** Thresholded box downsample to half or quarter size (four bilinear taps). */
const PRE_BODY = (p: string) => /* wgsl */`${knee(p)}
fn op(uv: vec2f) -> vec4f {
  let px = 0.25 / g.res; // half-texel taps: exact 2×2 box at half res, 4×4 at quarter res
  var c = textureSampleLevel(src, smp, uv + vec2f(-px.x, -px.y), 0.0).rgb + textureSampleLevel(src, smp, uv + vec2f(px.x, -px.y), 0.0).rgb
        + textureSampleLevel(src, smp, uv + vec2f(-px.x, px.y), 0.0).rgb + textureSampleLevel(src, smp, uv + vec2f(px.x, px.y), 0.0).rgb;
  c *= 0.25;
  // firefly suppression: tame single hot pixels without dimming broad highlights
  c = c / (1.0 + max(luma(c) - 64.0, 0.0) / 64.0);
  return vec4f(${p}_knee(c, u.threshold, u.knee), 1.0);
}`;

// ---------------------------------------------------------------- deep glow

const DG_DOWN = /* wgsl */`${knee('dg')}
fn dg_t(uv: vec2f, px: vec2f, x: f32, y: f32) -> vec3f { return textureSampleLevel(src, smp, uv + vec2f(x, y) * px, 0.0).rgb; }
// 13-tap downsample, offsets in half-destination texels so anamorphic (non-2×) steps stay alias-free
fn op(uv: vec2f) -> vec4f {
  let px = 0.5 / g.res;
  let s0 = dg_t(uv, px, -2.0, -2.0); let s1 = dg_t(uv, px, 0.0, -2.0); let s2 = dg_t(uv, px, 2.0, -2.0);
  let s3 = dg_t(uv, px, -1.0, -1.0); let s4 = dg_t(uv, px, 1.0, -1.0);
  let s5 = dg_t(uv, px, -2.0, 0.0); let s6 = dg_t(uv, px, 0.0, 0.0); let s7 = dg_t(uv, px, 2.0, 0.0);
  let s8 = dg_t(uv, px, -1.0, 1.0); let s9 = dg_t(uv, px, 1.0, 1.0);
  let s10 = dg_t(uv, px, -2.0, 2.0); let s11 = dg_t(uv, px, 0.0, 2.0); let s12 = dg_t(uv, px, 2.0, 2.0);
  var b0 = (s3 + s4 + s8 + s9) * 0.25;
  var b1 = (s0 + s1 + s5 + s6) * 0.25;
  var b2 = (s1 + s2 + s6 + s7) * 0.25;
  var b3 = (s5 + s6 + s10 + s11) * 0.25;
  var b4 = (s6 + s7 + s11 + s12) * 0.25;
  var w = vec4f(0.125);
  var w0 = 0.5;
  if (u.first == 1) {
    b0 = dg_knee(b0, u.threshold, u.knee); b1 = dg_knee(b1, u.threshold, u.knee); b2 = dg_knee(b2, u.threshold, u.knee);
    b3 = dg_knee(b3, u.threshold, u.knee); b4 = dg_knee(b4, u.threshold, u.knee);
    // partial Karis average: suppresses fireflies but keeps HDR energy in broad highlights
    w0 *= 1.0 / (1.0 + 0.25 * luma(b0));
    w *= 1.0 / (1.0 + 0.25 * vec4f(luma(b1), luma(b2), luma(b3), luma(b4)));
  }
  let sum = b0 * w0 + b1 * w.x + b2 * w.y + b3 * w.z + b4 * w.w;
  return vec4f(sum / (w0 + w.x + w.y + w.z + w.w), 1.0);
}`;

const deepglow: OpDef = {
  type: 'deepglow', label: 'Deep Glow', category: 'Filter', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }],
  help: 'Physically styled multi-scale glow: a 7-level pyramid summed with an inverse-power falloff, so highlights get a tight hot core and a long soft tail. Chromatic spread, tint and anamorphic stretch.',
  params: [
    { k: 'float', name: 'threshold', def: 0.45, min: 0, max: 8, group: 'Source', help: 'Brightness where glow starts (linear).' },
    { k: 'float', name: 'knee', def: 0.6, min: 0, max: 1, group: 'Source', help: 'Soft-knee width as a fraction of the threshold.' },
    { k: 'float', name: 'radius', def: 0.3, min: 0.01, max: 1, step: 0.001, group: 'Glow', help: 'Reach of the tail as a fraction of image height.' },
    { k: 'float', name: 'falloff', def: 1.6, min: 0.5, max: 4, group: 'Glow', help: 'Inverse-power exponent of the glow profile: 2 = inverse square, lower = longer tail, higher = tighter core.' },
    { k: 'float', name: 'exposure', def: 2.5, min: -4, max: 8, unit: 'EV', group: 'Glow' },
    { k: 'float', name: 'aspect', label: 'Anamorphic', def: 1, min: 0.25, max: 4, group: 'Glow', help: '>1 stretches the glow horizontally, <1 vertically.' },
    { k: 'float', name: 'spread', label: 'Chroma spread', def: 0.25, min: 0, max: 1, group: 'Colour', help: 'Red reaches further than blue, like real lens scatter.' },
    { k: 'color', name: 'tint', def: [1, 0.96, 0.9, 1], group: 'Colour' },
    { k: 'float', name: 'glowSat', label: 'Saturation', def: 1.1, min: 0, max: 2, group: 'Colour' },
    { k: 'enum', name: 'mode', label: 'Composite', options: ['Add', 'Screen', 'Glow only'], def: 0, group: 'Output' },
  ],
  passes: {
    down: { inputs: ['src'], fields: [['threshold', 'f32'], ['knee', 'f32'], ['first', 'i32']], body: DG_DOWN },
    up: {
      inputs: ['lo', 'cur'], fields: [['w', 'vec4f']],
      body: /* wgsl */`${tent('dg', 'lo')}
fn op(uv: vec2f) -> vec4f {
  var acc = vec3f(0.0);
  if (u.has_lo > 0.5) { acc = dg_tent(uv); }
  return vec4f(acc + textureSampleLevel(cur, smp, uv, 0.0).rgb * u.w.rgb, 1.0);
}`,
    },
    comp: {
      inputs: ['src', 'glow'], fields: [['gain', 'f32'], ['tint', 'vec4f'], ['glowSat', 'f32'], ['mode', 'i32']],
      body: /* wgsl */`${tent('dg', 'glow')}${blendFn('dg')}
fn op(uv: vec2f) -> vec4f {
  var b = max(dg_tent(uv), vec3f(0.0)) * u.tint.rgb * u.gain;
  let l = luma(b);
  b = max(vec3f(l) + (b - vec3f(l)) * u.glowSat, vec3f(0.0));
  return dg_blend(textureSampleLevel(src, smp, uv, 0.0), b, u.mode);
}`,
    },
  },
  cook(c) {
    const p = c.p;
    const L = Math.max(2, Math.min(7, Math.floor(Math.log2(Math.min(c.w, c.h))) - 2));
    const a = Math.max(0.25, Math.min(4, p.aspect));
    const sx = Math.max(a, 1), sy = Math.max(1 / a, 1);
    const downs: { view: GPUTextureView; w: number; h: number }[] = [];
    let prev = c.ins[0];
    for (let i = 1; i <= L; i++) {
      const f = Math.pow(2, i);
      const w = Math.max(1, Math.round(c.w / (f * Math.pow(sx, i / L))));
      const h = Math.max(1, Math.round(c.h / (f * Math.pow(sy, i / L))));
      const t = c.tex(`d${i}`, w, h);
      c.run('down', t.view, [prev], { threshold: p.threshold, knee: p.knee, first: i === 1 ? 1 : 0 }, [w, h]);
      downs.push({ view: t.view, w, h });
      prev = t.view;
    }
    // per-level, per-channel weights: PSF(r) ∝ r^-falloff  ⇒  level weight ∝ size^(2 - falloff), cut beyond radius
    const r = Math.max(0.005, p.radius);
    const rc = [r * (1 + p.spread * 0.6), r, r * (1 - p.spread * 0.4)];
    const wts: number[][] = [];
    const sum = [0, 0, 0];
    for (let i = 1; i <= L; i++) {
      const s = Math.pow(2, i + 1) / c.h * Math.min(sx, sy) * Math.pow(Math.max(sx, sy), i / L * 0.5);
      const row = rc.map((rr, k) => {
        const v = Math.pow(s, 2 - p.falloff) / (1 + Math.pow(s / rr, 3));
        sum[k] += v; return v;
      });
      wts.push(row);
    }
    let up: GPUTextureView | null = null;
    for (let i = L - 1; i >= 0; i--) {
      const d = downs[i];
      const t = c.tex(`u${i + 1}`, d.w, d.h);
      const w = wts[i].map((v, k) => v / Math.max(sum[k], 1e-9));
      c.run('up', t.view, [up, d.view], { w: [w[0], w[1], w[2], 0] }, [d.w, d.h]);
      up = t.view;
    }
    c.run('comp', c.out, [c.ins[0], up], { gain: Math.pow(2, p.exposure), tint: p.tint, glowSat: p.glowSat, mode: p.mode });
  },
};

// ---------------------------------------------------------------- light rays

const shine: OpDef = {
  type: 'shine', label: 'Light Rays', category: 'Filter', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }, { name: 'mask', type: 'tex', optional: true }],
  help: 'Volumetric light rays streaming from highlights away from a source point. Three-stage log-radial march (thousands of effective samples) with jitter, decay, shimmer and colour modes. Mask limits which parts emit.',
  params: [
    { k: 'vec2', name: 'center', label: 'Source', def: [0.5, 0.4], min: -1, max: 2, step: 0.001, gizmo: 'uv', group: 'Rays' },
    { k: 'float', name: 'len', label: 'Ray length', def: 0.6, min: 0, max: 0.98, group: 'Rays', help: 'Fraction of the distance to the source point that each ray reaches back.' },
    { k: 'float', name: 'decay', def: 1.5, min: 0, max: 8, group: 'Rays', help: 'How quickly rays fade along their length.' },
    { k: 'float', name: 'boost', def: 3, min: 0, max: 20, group: 'Rays' },
    { k: 'int', name: 'samples', def: 12, min: 6, max: 16, group: 'Rays', help: 'Taps per stage (cubed overall).' },
    { k: 'float', name: 'threshold', def: 0.55, min: 0, max: 4, group: 'Source' },
    { k: 'float', name: 'knee', def: 0.7, min: 0, max: 1, group: 'Source' },
    { k: 'enum', name: 'colorMode', label: 'Colour', options: ['Source', 'Tint', 'Spectral'], def: 0, group: 'Colour' },
    { k: 'color', name: 'tint', def: [1, 0.85, 0.6, 1], group: 'Colour', help: 'Multiplies Source mode; replaces colour in Tint mode.' },
    { k: 'float', name: 'hueOffset', label: 'Hue offset', def: 0, min: 0, max: 1, group: 'Colour', help: 'Spectral mode.' },
    { k: 'float', name: 'hueRange', label: 'Hue range', def: 0.8, min: 0, max: 3, group: 'Colour', help: 'Spectral mode: hue cycles across the ray length.' },
    { k: 'float', name: 'shimmer', def: 0.35, min: 0, max: 1, group: 'Shimmer' },
    { k: 'float', name: 'detail', def: 14, min: 1, max: 64, group: 'Shimmer', help: 'Number of shimmer streaks around the source.' },
    { k: 'float', name: 'speed', def: 0.4, min: 0, max: 4, group: 'Shimmer' },
    { k: 'enum', name: 'mode', label: 'Composite', options: COMP3, def: 0, group: 'Output' },
  ],
  passes: {
    pre: {
      inputs: ['src', 'mask'],
      fields: [['threshold', 'f32'], ['knee', 'f32'], ['center', 'vec2f'], ['shimmer', 'f32'], ['detail', 'f32'], ['phase', 'f32']],
      body: /* wgsl */`${knee('sh')}
fn op(uv: vec2f) -> vec4f {
  let px = 0.25 / g.res; // half-texel taps: exact 2×2 box at half res, 4×4 at quarter res
  var c = textureSampleLevel(src, smp, uv + vec2f(-px.x, -px.y), 0.0).rgb + textureSampleLevel(src, smp, uv + vec2f(px.x, -px.y), 0.0).rgb
        + textureSampleLevel(src, smp, uv + vec2f(-px.x, px.y), 0.0).rgb + textureSampleLevel(src, smp, uv + vec2f(px.x, px.y), 0.0).rgb;
  c = sh_knee(c * 0.25, u.threshold, u.knee);
  if (u.has_mask > 0.5) { c *= sat(luma(textureSampleLevel(mask, smp, uv, 0.0).rgb)); }
  if (u.shimmer > 0.0) {
    // angular noise around the source: seamless (sampled on the unit circle), evolves with phase
    let d = (uv - u.center) * vec2f(g.aspect, 1.0);
    let a = atan2(d.y, d.x);
    let q = vec3f(cos(a), sin(a), 0.0) * u.detail * 0.35;
    let n = snoise(q + vec3f(0.0, 0.0, u.phase)) * 0.65 + snoise(q * 2.3 + vec3f(5.2, 1.3, u.phase * 1.7)) * 0.35;
    c *= max(1.0 + u.shimmer * 1.6 * n, 0.0);
  }
  return vec4f(c, 1.0);
}`,
    },
    march: {
      inputs: ['src'], fields: [['center', 'vec2f'], ['dt', 'f32'], ['taps', 'i32'], ['decay', 'f32'], ['seed', 'f32']],
      body: /* wgsl */`${ign('sh')}
fn op(uv: vec2f) -> vec4f {
  let n = clamp(u.taps, 2, 16);
  let j = fract(sh_ign(uv * g.res + u.seed * 17.0) + u.seed * 0.618);
  var acc = vec3f(0.0); var ws = 0.0;
  for (var i = 0; i < n; i++) {
    let t = (f32(i) + j) * u.dt;
    let q = u.center + (uv - u.center) * exp(-t);
    let w = exp(-u.decay * t);
    acc += textureSampleLevel(src, smp, q, 0.0).rgb * w;
    ws += w;
  }
  return vec4f(acc / max(ws, 1e-6), 1.0);
}`,
    },
    comp: {
      inputs: ['src', 'rays'],
      fields: [['boost', 'f32'], ['colorMode', 'i32'], ['tint', 'vec4f'], ['center', 'vec2f'], ['hueOffset', 'f32'], ['hueRange', 'f32'], ['len', 'f32'], ['mode', 'i32']],
      body: /* wgsl */`${tent('sh', 'rays')}${blendFn('sh')}
fn op(uv: vec2f) -> vec4f {
  var r = max(sh_tent(uv), vec3f(0.0)) * u.boost;
  if (u.colorMode == 0) { r *= u.tint.rgb; }
  else if (u.colorMode == 1) { r = luma(r) * u.tint.rgb; }
  else {
    let d = length((uv - u.center) * vec2f(g.aspect, 1.0)) / max(u.len, 0.05);
    let s = hsv2rgb(vec3f(fract(u.hueOffset + u.hueRange * d * 0.5), 0.85, 1.0));
    r = luma(r) * s / max(luma(s), 1e-3);
  }
  return sh_blend(textureSampleLevel(src, smp, uv, 0.0), r, u.mode);
}`,
    },
  },
  cook(c) {
    const p = c.p;
    const w = Math.max(1, Math.round(c.w / 2)), h = Math.max(1, Math.round(c.h / 2));
    const pre = c.tex('pre', w, h), a = c.tex('a', w, h), b = c.tex('b', w, h);
    c.run('pre', pre.view, [c.ins[0], c.ins[1]], {
      threshold: p.threshold, knee: p.knee, center: p.center, shimmer: p.shimmer, detail: p.detail, phase: c.time * p.speed,
    }, [w, h]);
    const n = Math.max(6, Math.min(16, Math.round(p.samples)));
    const T = -Math.log(1 - Math.max(0, Math.min(0.98, p.len)));
    const decay = p.decay / Math.max(T, 1e-3);
    const dt1 = T / (n * n * n);
    c.run('march', a.view, [pre.view], { center: p.center, dt: dt1, taps: n, decay, seed: 0.13 }, [w, h]);
    c.run('march', b.view, [a.view], { center: p.center, dt: dt1 * n, taps: n, decay, seed: 0.41 }, [w, h]);
    c.run('march', a.view, [b.view], { center: p.center, dt: dt1 * n * n, taps: n, decay, seed: 0.77 }, [w, h]);
    c.run('comp', c.out, [c.ins[0], a.view], {
      boost: p.boost, colorMode: p.colorMode, tint: p.tint, center: p.center, hueOffset: p.hueOffset, hueRange: p.hueRange, len: p.len, mode: p.mode,
    });
  },
};

// ---------------------------------------------------------------- anamorphic streaks

/** One stage of a tiled multi-scale line blur: 2N+1 taps at `dir` spacing, exponential weights. */
const LINE_BODY = (p: string) => /* wgsl */`${ign(p)}
fn op(uv: vec2f) -> vec4f {
  let n = clamp(u.taps, 1, 12);
  let j = ${p}_ign(uv * g.res + u.seed * 23.0) - 0.5;
  var acc = vec3f(0.0); var ws = 0.0;
  for (var i = -n; i <= n; i++) {
    let x = f32(i) + j * u.jit;
    // the last stage also tapers to zero so the streak never ends in a hard cut
    let e = sat(abs(x) / (f32(n) + 1.0));
    let w = exp(-u.kw * abs(x)) * mix(1.0, (1.0 - e * e) * (1.0 - e * e), u.win);
    acc += textureSampleLevel(src, smp, uv + u.dir * x, 0.0).rgb * w;
    ws += w;
  }
  return vec4f(acc / max(ws, 1e-6), 1.0);
}`;

/** Runs the three tiled stages along one direction; returns the stage views (core, mid, long). */
function lineStages(c: CookCtx, src: GPUTextureView, key: string, ang: number, len: number, falloff: number, w: number, h: number): GPUTextureView[] {
  const N = 7, span = 2 * N + 1;
  const total = N * (1 + span + span * span); // half-extent in base steps
  const stepPx = Math.max(len * h, 1) / total;   // base step in pixels (h = scratch height, len in heights)
  const dx = Math.cos(ang) / w, dy = -Math.sin(ang) / h;
  const out: GPUTextureView[] = [];
  let prev = src;
  for (let k = 0; k < 3; k++) {
    const s = stepPx * Math.pow(span, k);
    const t = c.tex(`${key}${k}`, w, h);
    // weight per tap so the composite falls by e^-falloff over the full length
    const kw = falloff * s / (len * h);
    c.run('line', t.view, [prev], { dir: [dx * s, dy * s], taps: N, kw, jit: k === 0 ? 0 : 1, seed: k + 1, win: k === 2 ? 1 : 0 }, [w, h]);
    out.push(t.view);
    prev = t.view;
  }
  return out;
}

const streaks: OpDef = {
  type: 'streaks', label: 'Anamorphic Streaks', category: 'Filter', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }],
  help: 'Long, thin anamorphic lens streaks from highlights: a tiled three-stage directional blur gives a hot core and a tail that can cross the frame. Up to three evenly spaced directions.',
  params: [
    { k: 'float', name: 'threshold', def: 0.6, min: 0, max: 8, group: 'Source' },
    { k: 'float', name: 'knee', def: 0.2, min: 0, max: 1, group: 'Source' },
    { k: 'float', name: 'len', label: 'Length', def: 0.9, min: 0.02, max: 2, step: 0.001, group: 'Streak', help: 'Half-length as a fraction of image height.' },
    { k: 'float', name: 'angle', def: 0, min: -180, max: 180, unit: '°', group: 'Streak' },
    { k: 'int', name: 'directions', def: 1, min: 1, max: 3, group: 'Streak' },
    { k: 'float', name: 'falloff', def: 2.5, min: 0, max: 8, group: 'Streak', help: 'Exponential fade along the streak.' },
    { k: 'float', name: 'core', def: 0.5, min: 0, max: 2, group: 'Streak', help: 'Brightness of the short inner streak relative to the long tail.' },
    { k: 'float', name: 'intensity', def: 1, min: 0, max: 10, group: 'Streak' },
    { k: 'color', name: 'color', def: [0.3, 0.55, 1, 1], group: 'Colour' },
    { k: 'float', name: 'srcColor', label: 'Source colour', def: 0.15, min: 0, max: 1, group: 'Colour', help: 'Blend between the streak colour and the highlight colour.' },
    { k: 'enum', name: 'mode', label: 'Composite', options: COMP3, def: 0, group: 'Output' },
  ],
  passes: {
    pre: { inputs: ['src'], fields: [['threshold', 'f32'], ['knee', 'f32']], body: PRE_BODY('st') },
    line: { inputs: ['src'], fields: [['dir', 'vec2f'], ['taps', 'i32'], ['kw', 'f32'], ['jit', 'f32'], ['seed', 'f32'], ['win', 'f32']], body: LINE_BODY('st') },
    acc: {
      inputs: ['prev', 's1', 's2'], fields: [['wts', 'vec4f']],
      body: /* wgsl */`
fn op(uv: vec2f) -> vec4f {
  let a = textureSampleLevel(prev, smp, uv, 0.0).rgb;
  let b = textureSampleLevel(s1, smp, uv, 0.0).rgb * u.wts.x + textureSampleLevel(s2, smp, uv, 0.0).rgb * u.wts.y;
  return vec4f(a + b, 1.0);
}`,
    },
    comp: {
      inputs: ['src', 'fx'], fields: [['color', 'vec4f'], ['srcColor', 'f32'], ['mode', 'i32']],
      body: /* wgsl */`${blendFn('st')}
fn op(uv: vec2f) -> vec4f {
  let s = max(textureSampleLevel(fx, smp, uv, 0.0).rgb, vec3f(0.0));
  let l = luma(s);
  let tinted = l * u.color.rgb / max(luma(u.color.rgb), 1e-3);
  return st_blend(textureSampleLevel(src, smp, uv, 0.0), mix(tinted, s, u.srcColor), u.mode);
}`,
    },
  },
  cook(c) {
    const p = c.p;
    const w = Math.max(1, Math.round(c.w / 2)), h = Math.max(1, Math.round(c.h / 2));
    const pre = c.tex('pre', w, h);
    c.run('pre', pre.view, [c.ins[0]], { threshold: p.threshold, knee: p.knee }, [w, h]);
    const nd = Math.max(1, Math.min(3, Math.round(p.directions)));
    let acc: GPUTextureView | null = null;
    // stage gains: the long stage is spread over ~15× the width of the mid one, so it needs a matching gain
    const gMid = 1.5 * p.core * p.intensity, gLong = 4 * p.intensity;
    for (let d = 0; d < nd; d++) {
      const ang = (p.angle + d * 180 / nd) * Math.PI / 180;
      const st = lineStages(c, pre.view, `l${d}_`, ang, p.len, p.falloff, w, h);
      const t = c.tex(`acc${d % 2}`, w, h);
      c.run('acc', t.view, [acc, st[1], st[2]], { wts: [gMid, gLong, 0, 0] }, [w, h]);
      acc = t.view;
    }
    c.run('comp', c.out, [c.ins[0], acc], { color: p.color, srcColor: p.srcColor, mode: p.mode });
  },
};

// ---------------------------------------------------------------- star glow

const starglow: OpDef = {
  type: 'starglow', label: 'Star Glow', category: 'Filter', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }],
  help: 'Star-shaped streaks from highlights in 4, 6 or 8 directions, with colour that cycles along each ray.',
  params: [
    { k: 'float', name: 'threshold', def: 0.55, min: 0, max: 8, group: 'Source' },
    { k: 'float', name: 'knee', def: 0.3, min: 0, max: 1, group: 'Source' },
    { k: 'enum', name: 'points', options: ['4', '6', '8'], def: 2, group: 'Star' },
    { k: 'float', name: 'len', label: 'Length', def: 0.12, min: 0.005, max: 0.6, step: 0.001, group: 'Star', help: 'Ray length as a fraction of image height.' },
    { k: 'float', name: 'diagonal', label: 'Diagonal length', def: 0.6, min: 0, max: 1.5, group: 'Star', help: '8-point mode: length of the in-between rays relative to the main ones.' },
    { k: 'float', name: 'rotation', def: 0, min: -180, max: 180, unit: '°', group: 'Star' },
    { k: 'float', name: 'falloff', def: 2.5, min: 0, max: 8, group: 'Star' },
    { k: 'int', name: 'samples', def: 40, min: 8, max: 64, group: 'Star' },
    { k: 'float', name: 'intensity', def: 1.5, min: 0, max: 10, group: 'Star' },
    { k: 'enum', name: 'colorMode', label: 'Colour', options: ['Gradient', 'Spectrum', 'Source'], def: 0, group: 'Colour' },
    { k: 'color', name: 'colorA', label: 'Core', def: [1, 0.95, 0.85, 1], group: 'Colour' },
    { k: 'color', name: 'colorB', label: 'Tip', def: [0.35, 0.55, 1, 1], group: 'Colour' },
    { k: 'float', name: 'cycles', def: 1, min: 0, max: 6, group: 'Colour', help: 'Colour repeats along each ray (Gradient and Spectrum).' },
    { k: 'float', name: 'srcColor', label: 'Source colour', def: 0.3, min: 0, max: 1, group: 'Colour' },
    { k: 'enum', name: 'mode', label: 'Composite', options: COMP3, def: 0, group: 'Output' },
  ],
  passes: {
    pre: { inputs: ['src'], fields: [['threshold', 'f32'], ['knee', 'f32']], body: PRE_BODY('sg') },
    star: {
      inputs: ['src'],
      fields: [['points', 'i32'], ['len', 'f32'], ['diagonal', 'f32'], ['rotation', 'f32'], ['falloff', 'f32'], ['samples', 'i32'],
        ['colorMode', 'i32'], ['colorA', 'vec4f'], ['colorB', 'vec4f'], ['cycles', 'f32'], ['srcColor', 'f32']],
      body: /* wgsl */`${ign('sg')}
fn sg_col(t: f32) -> vec3f {
  // colour along the ray, t = 0 at the highlight, 1 at the tip
  let x = t * max(u.cycles, 0.0);
  if (u.colorMode == 1) {
    let c = hsv2rgb(vec3f(fract(x), 0.75, 1.0));
    return c / max(luma(c), 1e-3);
  }
  if (u.colorMode == 2) { return vec3f(1.0); }
  let f = 0.5 - 0.5 * cos(PI * fract(x * 0.5) * 2.0); // ping-pong A→B→A
  let c = mix(u.colorA.rgb, u.colorB.rgb, select(f, t, u.cycles <= 1.0));
  return c / max(luma(c), 1e-3);
}
fn op(uv: vec2f) -> vec4f {
  let n = clamp(u.samples, 4, 64);
  var nd = 4;
  if (u.points == 1) { nd = 6; } else if (u.points == 2) { nd = 8; }
  let jit = sg_ign(uv * g.res);
  var acc = vec3f(0.0);
  for (var d = 0; d < nd; d++) {
    let a = radians(u.rotation) + TAU * f32(d) / f32(nd);
    var L = u.len;
    if (nd == 8 && (d & 1) == 1) { L *= u.diagonal; }
    if (L <= 1e-4) { continue; }
    // gather: a highlight at uv - dir·t lights this pixel with weight w(t)
    let dir = vec2f(cos(a), -sin(a)) * vec2f(1.0 / g.aspect, 1.0) * L;
    var ray = vec3f(0.0);
    for (var i = 0; i < n; i++) {
      let t = (f32(i) + jit) / f32(n);
      let c = textureSampleLevel(src, smp, uv - dir * t, 0.0).rgb;
      let w = exp(-u.falloff * t) * (1.0 - t) * (1.0 - t);
      ray += mix(luma(c) * sg_col(t), c, u.srcColor) * w;
    }
    acc += ray / f32(n);
  }
  return vec4f(acc, 1.0);
}`,
    },
    comp: {
      inputs: ['src', 'fx'], fields: [['gain', 'f32'], ['mode', 'i32']],
      body: /* wgsl */`${tent('sg', 'fx')}${blendFn('sg')}
fn op(uv: vec2f) -> vec4f {
  return sg_blend(textureSampleLevel(src, smp, uv, 0.0), max(sg_tent(uv), vec3f(0.0)) * u.gain, u.mode);
}`,
    },
  },
  cook(c) {
    const p = c.p;
    const qw = Math.max(1, Math.round(c.w / 4)), qh = Math.max(1, Math.round(c.h / 4));
    const hw = Math.max(1, Math.round(c.w / 2)), hh = Math.max(1, Math.round(c.h / 2));
    const pre = c.tex('pre', qw, qh), st = c.tex('star', hw, hh);
    c.run('pre', pre.view, [c.ins[0]], { threshold: p.threshold, knee: p.knee }, [qw, qh]);
    c.run('star', st.view, [pre.view], {
      points: p.points, len: p.len, diagonal: p.diagonal, rotation: p.rotation, falloff: p.falloff, samples: p.samples,
      colorMode: p.colorMode, colorA: p.colorA, colorB: p.colorB, cycles: p.cycles, srcColor: p.srcColor,
    }, [hw, hh]);
    // a ray integrates highlight energy over its length: scale so brightness does not depend on length
    c.run('comp', c.out, [c.ins[0], st.view], { gain: p.intensity * 1.5 * Math.sqrt(0.12 / Math.max(p.len, 0.005)), mode: p.mode });
  },
};

// ---------------------------------------------------------------- lens flare

const lensflare: OpDef = {
  type: 'lensflare', label: 'Lens Flare', category: 'Filter', output: 'tex',
  inputs: [{ name: 'src', type: 'tex', optional: true }],
  help: 'Procedural lens flare from a light position: hot core, anamorphic streak, starburst, halo, chromatic ring and aperture-shaped ghosts mirrored through the frame centre. Auto intensity follows the picture brightness under the light. Adds over Src, or renders on black.',
  params: [
    { k: 'vec2', name: 'pos', label: 'Light', def: [0.3, 0.3], min: -1, max: 2, step: 0.001, gizmo: 'uv', group: 'Light' },
    { k: 'float', name: 'intensity', def: 1, min: 0, max: 10, group: 'Light' },
    { k: 'float', name: 'scale', def: 1, min: 0.1, max: 4, group: 'Light' },
    { k: 'color', name: 'tint', def: [1, 0.92, 0.8, 1], group: 'Light' },
    { k: 'float', name: 'autoAmt', label: 'Auto intensity', def: 0, min: 0, max: 1, group: 'Light', help: 'Scale the flare by the source brightness under the light.' },
    { k: 'float', name: 'autoLevel', label: 'Auto level', def: 1, min: 0.05, max: 8, group: 'Light', help: 'Brightness that gives a full flare in auto mode.' },
    { k: 'float', name: 'glow', def: 1, min: 0, max: 4, group: 'Core' },
    { k: 'float', name: 'streak', def: 0.7, min: 0, max: 4, group: 'Core' },
    { k: 'float', name: 'streakLen', label: 'Streak length', def: 0.8, min: 0.05, max: 3, group: 'Core' },
    { k: 'float', name: 'rays', def: 0.5, min: 0, max: 4, group: 'Core', help: 'Starburst spikes from the aperture blades.' },
    { k: 'float', name: 'halo', def: 0.35, min: 0, max: 4, group: 'Rings' },
    { k: 'float', name: 'ring', label: 'Chromatic ring', def: 0.3, min: 0, max: 4, group: 'Rings' },
    { k: 'float', name: 'ghosts', def: 0.6, min: 0, max: 4, group: 'Ghosts' },
    { k: 'int', name: 'ghostCount', label: 'Count', def: 9, min: 0, max: 20, group: 'Ghosts' },
    { k: 'float', name: 'dispersion', def: 0.4, min: 0, max: 2, group: 'Ghosts', help: 'Chromatic fringing of the ghosts.' },
    { k: 'int', name: 'blades', def: 6, min: 3, max: 12, group: 'Aperture' },
    { k: 'float', name: 'bladeRot', label: 'Blade rotation', def: 15, min: -180, max: 180, unit: '°', group: 'Aperture' },
    { k: 'float', name: 'roundness', def: 0.15, min: 0, max: 1, group: 'Aperture' },
    { k: 'int', name: 'seed', def: 1, min: 0, max: 999, group: 'Ghosts' },
  ],
  body: /* wgsl */`${dither('lf')}
fn lf_poly(d: vec2f, n: f32, rot0: f32) -> f32 {
  // polygon "radius": equals the circumradius on the polygon outline
  let a = atan2(d.y, d.x) + rot0;
  let seg = TAU / n;
  let k = a - seg * floor(a / seg) - seg * 0.5;
  let r = length(d);
  return mix(r * cos(k) / cos(seg * 0.5), r, u.roundness);
}
fn lf_ghost(p: vec2f, c: vec2f, size: f32, soft: f32, rim: f32) -> f32 {
  let r = lf_poly(p - c, f32(clamp(u.blades, 3, 12)), radians(u.bladeRot)) / size;
  let body = 1.0 - smoothstep(1.0 - soft, 1.0, r);
  let edge = exp(-pow((r - 0.97) / 0.035, 2.0)) * rim;
  return body * (0.55 + 0.45 * r * r) + edge;
}
fn op(uv: vec2f) -> vec4f {
  let p = centered(uv);
  let L = centered(u.pos);
  let s = u.scale;
  var amp = u.intensity;
  var base = vec4f(0.0, 0.0, 0.0, 1.0);
  if (u.has_src > 0.5) {
    base = textureSampleLevel(src, smp, uv, 0.0);
    if (u.autoAmt > 0.0) {
      var lum = 0.0;
      for (var i = 0; i < 9; i++) {
        let o = vec2f(f32(i % 3) - 1.0, f32(i / 3) - 1.0) * 0.012 * vec2f(1.0 / g.aspect, 1.0);
        lum += luma(textureSampleLevel(src, smp, clamp(u.pos + o, vec2f(0.0), vec2f(1.0)), 0.0).rgb);
      }
      lum /= 9.0;
      let inside = sat(1.0 - max(max(-u.pos.x, u.pos.x - 1.0), max(-u.pos.y, u.pos.y - 1.0)) * 10.0);
      amp *= mix(1.0, smoothstep(0.0, u.autoLevel, lum) * inside, u.autoAmt);
    }
  }
  let d = p - L;
  let r = length(d);
  let blades = f32(clamp(u.blades, 3, 12));
  var col = vec3f(0.0);
  // hot core and inverse-square glow
  let g0 = 0.03 * s;
  col += u.glow * (pow(g0 / (r + g0), 2.0) * 1.5 + exp(-r * r / (0.0004 * s * s)) * 4.0) * vec3f(1.0, 0.95, 0.9);
  col += u.glow * 0.12 * exp(-r / (0.25 * s)) * vec3f(1.0, 0.7, 0.45);
  // anamorphic streak
  let sh = exp(-abs(d.y) / (0.006 * s)) * (exp(-abs(d.x) / (0.25 * s * u.streakLen)) * 0.7 + exp(-abs(d.x) / (0.9 * s * u.streakLen)) * 0.3);
  col += u.streak * sh * vec3f(0.55, 0.75, 1.0);
  // starburst: blade spikes plus fine angular noise
  let ang = atan2(d.y, d.x) + radians(u.bladeRot);
  let spikes = pow(abs(cos(ang * blades * 0.5)), 60.0);
  let fine = sat(snoise(vec3f(cos(ang), sin(ang), 0.0) * 9.0 + f32(u.seed)) * 0.5 + 0.5);
  col += u.rays * (spikes * 0.8 + pow(fine, 4.0) * 0.6) * exp(-r / (0.22 * s)) * (1.0 - exp(-r / (0.01 * s))) * vec3f(1.0, 0.9, 0.8);
  // halo ring around the light
  let hr = 0.5 * s;
  let hal = exp(-pow((r - hr) / (0.06 * s), 2.0)) * (0.6 + 0.4 * snoise(vec3f(normalize(d + 1e-5) * 3.0, f32(u.seed) * 0.37)));
  col += u.halo * 0.35 * hal * vec3f(1.0, 0.75, 0.5);
  // thin rainbow arc centred opposite the light
  let rc = -L * 0.5;
  let dr = p - rc;
  let rr = length(dr);
  let R = 0.85 * s;
  let face = sat(dot(dr / max(rr, 1e-4), normalize(L - rc + 1e-5)) * 1.5 - 0.2);
  let rgbR = vec3f(exp(-pow((rr - R * 1.02) / (0.012 * s), 2.0)), exp(-pow((rr - R) / (0.012 * s), 2.0)), exp(-pow((rr - R * 0.98) / (0.012 * s), 2.0)));
  col += u.ring * 0.25 * rgbR * face;
  // ghosts along the axis through the centre, each with its own size, tint and softness
  let ng = clamp(u.ghostCount, 0, 20);
  let sd = f32(u.seed) * 17.13;
  for (var k = 0; k < ng; k++) {
    let fk = f32(k);
    let h = hash33(vec3f(fk * 3.17 + sd, fk * 1.31 + 7.0, sd * 0.37));
    let h2 = hash33(vec3f(fk * 5.71 + 2.0, sd + 11.0, fk * 0.73));
    let f = mix(-1.5, 0.75, fract(h.x + fk * 0.618));
    let size = s * mix(0.025, 0.2, h.y * h.y);
    let soft = mix(0.04, 0.7, h.z);
    let rim = select(0.0, 0.5, h2.x > 0.55);
    let tint = hsv2rgb(vec3f(fract(0.05 + h2.y * 0.65), mix(0.25, 0.7, h2.z), 1.0));
    let disp = u.dispersion * 0.04;
    let gr = lf_ghost(p, L * f * (1.0 + disp), size, soft, rim);
    let gg = lf_ghost(p, L * f, size, soft, rim);
    let gb = lf_ghost(p, L * f * (1.0 - disp), size, soft, rim);
    let amp_k = 0.12 * mix(0.35, 1.0, h2.x) / (0.4 + size * 6.0);
    col += u.ghosts * amp_k * vec3f(gr, gg, gb) * tint;
  }
  col = lf_dither(col * amp * u.tint.rgb, uv * g.res);
  return vec4f(base.rgb + col, base.a);
}`,
};

// ---------------------------------------------------------------- bokeh

const bokeh: OpDef = {
  type: 'bokeh', label: 'Bokeh Blur', category: 'Filter', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }, { name: 'depth', type: 'tex', optional: true }],
  help: 'Lens blur with a disc or bladed aperture. Highlights bloom into bright bokeh shapes. Connect a depth map (bright = far) to blur by distance from the focus plane.',
  params: [
    { k: 'float', name: 'radius', def: 0.015, min: 0, max: 0.15, step: 0.0005, group: 'Lens', help: 'Blur radius as a fraction of image height.' },
    { k: 'int', name: 'blades', def: 6, min: 3, max: 12, group: 'Aperture' },
    { k: 'float', name: 'roundness', def: 0.25, min: 0, max: 1, group: 'Aperture', help: '0 = straight blades, 1 = perfect disc.' },
    { k: 'float', name: 'rotation', def: 0, min: -180, max: 180, unit: '°', group: 'Aperture' },
    { k: 'float', name: 'squeeze', label: 'Anamorphic', def: 1, min: 0.5, max: 2.5, group: 'Aperture', help: '>1 gives tall oval bokeh like an anamorphic lens.' },
    { k: 'float', name: 'rim', def: 0.3, min: 0, max: 2, group: 'Aperture', help: 'Brighter disc edges (onion-ring / soap-bubble bokeh).' },
    { k: 'float', name: 'boost', label: 'Highlight boost', def: 3, min: 0, max: 20, group: 'Highlights' },
    { k: 'float', name: 'threshold', def: 0.85, min: 0, max: 4, group: 'Highlights' },
    { k: 'int', name: 'samples', def: 128, min: 16, max: 256, group: 'Lens' },
    { k: 'float', name: 'focus', label: 'Focus depth', def: 0.3, min: 0, max: 1, group: 'Depth' },
    { k: 'float', name: 'range', label: 'Focus range', def: 0.4, min: 0.01, max: 1, group: 'Depth', help: 'Depth distance over which blur reaches the full radius.' },
  ],
  body: /* wgsl */`${ign('bk')}
fn bk_coc(uv: vec2f) -> f32 {
  if (u.has_depth < 0.5) { return 1.0; }
  let d = textureSampleLevel(depth, smp, uv, 0.0).r;
  return sat(abs(d - u.focus) / max(u.range, 1e-3));
}
fn bk_boost(c: vec3f) -> vec3f {
  return c * (1.0 + u.boost * smoothstep(u.threshold, u.threshold + 0.6, luma(c)));
}
fn op(uv: vec2f) -> vec4f {
  let c0 = textureSampleLevel(src, smp, uv, 0.0);
  let coc0 = bk_coc(uv);
  let R = u.radius * g.res.y * coc0;
  if (R < 0.5) { return c0; }
  let n = clamp(u.samples, 16, 256);
  let nb = f32(clamp(u.blades, 3, 12));
  let seg = TAU / nb;
  let rot0 = radians(u.rotation);
  let jr = bk_ign(uv * g.res) * TAU;
  var acc = vec4f(0.0); var ws = 0.0;
  for (var i = 0; i < n; i++) {
    let fi = f32(i) + 0.5;
    let rr = sqrt(fi / f32(n));
    let th = fi * 2.39996323 + jr;
    // map the disc onto the bladed aperture; k² compensates the changed sample density
    let a = th - rot0;
    let kk = a - seg * floor(a / seg) - seg * 0.5;
    let k = mix(cos(seg * 0.5) / cos(kk), 1.0, u.roundness);
    var o = vec2f(cos(th), sin(th)) * rr * k;
    o.x /= u.squeeze;
    let q = uv + o * R / g.res;
    var w = k * k * (1.0 + u.rim * pow(rr, 6.0) * 3.0);
    if (u.has_depth > 0.5) {
      // a sample only contributes if its own blur reaches this pixel (keeps sharp subjects from smearing out)
      let cs = bk_coc(q) * u.radius * g.res.y;
      w *= smoothstep(rr * R - 1.5, rr * R, cs);
    }
    let c = textureSampleLevel(src, smp, q, 0.0);
    acc += vec4f(bk_boost(c.rgb), c.a) * w;
    ws += w;
  }
  if (ws < 1e-4) { return c0; }
  return acc / ws;
}`,
};

// ---------------------------------------------------------------- tilt shift

const tiltshift: OpDef = {
  type: 'tiltshift', label: 'Tilt Shift', category: 'Filter', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }],
  help: 'Miniature-scene look: a sharp focus band (or circle) with lens blur growing away from it, plus a saturation and contrast lift.',
  params: [
    { k: 'enum', name: 'shape', options: ['Band', 'Radial'], def: 0, group: 'Focus' },
    { k: 'vec2', name: 'center', def: [0.5, 0.55], min: -0.5, max: 1.5, step: 0.001, gizmo: 'uv', group: 'Focus' },
    { k: 'float', name: 'width', def: 0.12, min: 0, max: 1, group: 'Focus', help: 'Half-width of the sharp zone as a fraction of image height.' },
    { k: 'float', name: 'feather', def: 0.35, min: 0.01, max: 1.5, group: 'Focus', help: 'Distance over which blur ramps to full.' },
    { k: 'float', name: 'angle', def: 0, min: -180, max: 180, unit: '°', group: 'Focus' },
    { k: 'float', name: 'radius', label: 'Blur', def: 0.012, min: 0, max: 0.08, step: 0.0005, group: 'Blur', help: 'Maximum blur radius as a fraction of image height.' },
    { k: 'int', name: 'samples', def: 64, min: 16, max: 160, group: 'Blur' },
    { k: 'float', name: 'boost', label: 'Highlight boost', def: 1, min: 0, max: 8, group: 'Blur' },
    { k: 'float', name: 'saturation', def: 1.35, min: 0, max: 3, group: 'Colour' },
    { k: 'float', name: 'contrast', def: 1.12, min: 0.5, max: 2, group: 'Colour' },
  ],
  body: /* wgsl */`${ign('ts')}
fn ts_amt(uv: vec2f) -> f32 {
  let d = (uv - u.center) * vec2f(g.aspect, 1.0);
  var dist = length(d);
  if (u.shape == 0) {
    let a = radians(u.angle);
    dist = abs(dot(d, vec2f(sin(a), cos(a))));
  }
  let x = sat((dist - u.width) / max(u.feather, 1e-3));
  return x * x * (3.0 - 2.0 * x);
}
fn ts_grade(c: vec3f) -> vec3f {
  let l = luma(c);
  var x = max(vec3f(l) + (c - vec3f(l)) * u.saturation, vec3f(0.0));
  // contrast in a perceptual encoding around mid grey, decoded back to linear
  let e = pow(x, vec3f(1.0 / 2.2));
  let ec = max((e - 0.45) * u.contrast + 0.45, vec3f(0.0));
  return pow(ec, vec3f(2.2));
}
fn op(uv: vec2f) -> vec4f {
  let c0 = textureSampleLevel(src, smp, uv, 0.0);
  let R = u.radius * g.res.y * ts_amt(uv);
  if (R < 0.5) { return vec4f(ts_grade(c0.rgb), c0.a); }
  let n = clamp(u.samples, 16, 160);
  let jr = ts_ign(uv * g.res) * TAU;
  var acc = vec4f(0.0); var ws = 0.0;
  for (var i = 0; i < n; i++) {
    let fi = f32(i) + 0.5;
    let rr = sqrt(fi / f32(n));
    let th = fi * 2.39996323 + jr;
    let q = uv + vec2f(cos(th), sin(th)) * rr * R / g.res;
    // samples from sharper areas only contribute as far as their own blur reaches
    let cs = u.radius * g.res.y * ts_amt(q);
    let w = smoothstep(rr * R - 2.0, rr * R, cs + 1.0);
    let c = textureSampleLevel(src, smp, q, 0.0);
    let b = 1.0 + u.boost * smoothstep(0.8, 1.6, luma(c.rgb));
    acc += vec4f(c.rgb * b, c.a) * w;
    ws += w;
  }
  let o = acc / max(ws, 1e-4);
  return vec4f(ts_grade(o.rgb), o.a);
}`,
};

// ---------------------------------------------------------------- halation

const GAUSS_BODY = /* wgsl */`
fn op(uv: vec2f) -> vec4f {
  let rpx = u.radius * g.res.y;
  if (rpx < 0.25) { return textureSampleLevel(src, smp, uv, 0.0); }
  let taps = 16.0;
  let stride = max(1.0, rpx / taps);
  let sigma = rpx * 0.5;
  let px = u.dir / g.res;
  var acc = vec4f(0.0); var ws = 0.0;
  for (var i = -taps * 2.0; i <= taps * 2.0; i += 1.0) {
    let d = i * stride;
    let w = exp(-0.5 * d * d / (sigma * sigma));
    acc += textureSampleLevel(src, smp, uv + px * d, 0.0) * w;
    ws += w;
  }
  return acc / ws;
}`;

const halation: OpDef = {
  type: 'halation', label: 'Film Halation', category: 'Filter', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }],
  help: 'The red-orange glow film gets when bright light scatters back through the emulsion: a tight red fringe plus a softer orange bloom around highlights.',
  params: [
    { k: 'float', name: 'threshold', def: 0.4, min: 0, max: 4, group: 'Source' },
    { k: 'float', name: 'rolloff', label: 'Highlight rolloff', def: 0.6, min: 0, max: 1, group: 'Source', help: 'Softness of the threshold onset.' },
    { k: 'float', name: 'radius', def: 0.016, min: 0.001, max: 0.1, step: 0.0005, group: 'Halo', help: 'Fraction of image height.' },
    { k: 'float', name: 'strength', def: 1.4, min: 0, max: 5, group: 'Halo' },
    { k: 'color', name: 'tint', def: [1, 0.32, 0.12, 1], group: 'Halo' },
    { k: 'float', name: 'spread', label: 'Bloom mix', def: 0.4, min: 0, max: 1, group: 'Halo', help: 'Share of the wide, softer bloom relative to the tight fringe.' },
    { k: 'float', name: 'weave', label: 'Gate weave', def: 0, min: 0, max: 1, group: 'Motion', help: 'Halo jitters slightly against the picture, like film moving through a gate.' },
    { k: 'float', name: 'speed', def: 1, min: 0, max: 4, group: 'Motion' },
  ],
  passes: {
    pre: { inputs: ['src'], fields: [['threshold', 'f32'], ['knee', 'f32']], body: PRE_BODY('ha') },
    blur: { inputs: ['src'], fields: [['radius', 'f32'], ['dir', 'vec2f']], body: GAUSS_BODY },
    comp: {
      inputs: ['src', 'tight', 'wide'], fields: [['strength', 'f32'], ['tint', 'vec4f'], ['spread', 'f32'], ['shift', 'vec2f']],
      body: /* wgsl */`
fn op(uv: vec2f) -> vec4f {
  let c = textureSampleLevel(src, smp, uv, 0.0);
  let q = uv + u.shift;
  let a = luma(textureSampleLevel(tight, smp, q, 0.0).rgb);
  let b = luma(textureSampleLevel(wide, smp, q, 0.0).rgb);
  // tight fringe leans red, wide bloom leans toward orange
  let tA = u.tint.rgb * vec3f(1.0, 0.75, 0.7);
  let tB = mix(u.tint.rgb, vec3f(luma(u.tint.rgb)), 0.15) * vec3f(1.0, 1.25, 1.1);
  let h = (a * (1.0 - u.spread) * tA + b * u.spread * tB) * u.strength;
  return vec4f(c.rgb + h, c.a);
}`,
    },
  },
  cook(c) {
    const p = c.p;
    const w = Math.max(1, Math.round(c.w / 2)), h = Math.max(1, Math.round(c.h / 2));
    const pre = c.tex('pre', w, h), t1 = c.tex('t1', w, h), tight = c.tex('tight', w, h), wide = c.tex('wide', w, h);
    c.run('pre', pre.view, [c.ins[0]], { threshold: p.threshold, knee: p.rolloff }, [w, h]);
    c.run('blur', t1.view, [pre.view], { radius: p.radius * 0.5, dir: [1, 0] }, [w, h]);
    c.run('blur', tight.view, [t1.view], { radius: p.radius * 0.5, dir: [0, 1] }, [w, h]);
    c.run('blur', t1.view, [tight.view], { radius: p.radius * 2.5, dir: [1, 0] }, [w, h]);
    c.run('blur', wide.view, [t1.view], { radius: p.radius * 2.5, dir: [0, 1] }, [w, h]);
    // gate weave: smooth pseudo-random drift, a fraction of the halo radius
    const t = c.time * p.speed * 3;
    const n = (k: number) => Math.sin(t * 1.7 + k) * 0.5 + Math.sin(t * 3.1 + k * 2.3) * 0.3 + Math.sin(t * 7.3 + k * 0.7) * 0.2;
    const amt = p.weave * p.radius * 0.6;
    c.run('comp', c.out, [c.ins[0], tight.view, wide.view], {
      strength: p.strength, tint: p.tint, spread: p.spread, shift: [n(1) * amt * c.h / c.w, n(4) * amt],
    });
  },
};

// ---------------------------------------------------------------- light leaks

const lightleak: OpDef = {
  type: 'lightleak', label: 'Light Leaks', category: 'Generate', output: 'tex',
  inputs: [{ name: 'src', type: 'tex', optional: true }],
  help: 'Organic, drifting film light leaks from layered warped noise, hugging the frame edges. Blends over Src, or renders on black.',
  params: [
    { k: 'float', name: 'intensity', def: 0.8, min: 0, max: 6, group: 'Leak' },
    { k: 'float', name: 'coverage', def: 0.38, min: 0, max: 1, group: 'Leak' },
    { k: 'float', name: 'softness', def: 0.5, min: 0.05, max: 1, group: 'Leak' },
    { k: 'float', name: 'scale', def: 1, min: 0.2, max: 6, group: 'Leak' },
    { k: 'float', name: 'edge', label: 'Edge bias', def: 0.7, min: 0, max: 1, group: 'Leak', help: 'How strongly leaks cling to the frame edges.' },
    { k: 'float', name: 'speed', def: 0.15, min: 0, max: 2, group: 'Leak' },
    { k: 'int', name: 'seed', def: 0, min: 0, max: 999, group: 'Leak' },
    { k: 'float', name: 'hue', def: 0.02, min: 0, max: 1, group: 'Colour', help: 'Base hue (0 = red, 0.08 = orange).' },
    { k: 'float', name: 'hueRange', label: 'Hue range', def: 0.12, min: 0, max: 1, group: 'Colour' },
    { k: 'float', name: 'saturation', def: 0.9, min: 0, max: 1, group: 'Colour' },
    { k: 'float', name: 'flicker', def: 0.2, min: 0, max: 1, group: 'Flicker' },
    { k: 'float', name: 'flickerRate', label: 'Rate', def: 6, min: 0, max: 30, group: 'Flicker' },
    { k: 'enum', name: 'blend', options: ['Screen', 'Add'], def: 0, group: 'Output' },
  ],
  body: /* wgsl */`${dither('ll')}
fn op(uv: vec2f) -> vec4f {
  let t = g.time * u.speed;
  let sd = vec3f(f32(u.seed) * 7.31, f32(u.seed) * 3.17, 0.0);
  let pc = centered(uv);
  let p = pc * 0.6 * u.scale;
  // two-level domain warp gives soft, smoky shapes that drift and evolve
  let w = vec2f(fbm(vec3f(p * 0.8, t * 0.4) + sd, 3, 2.0, 0.5), fbm(vec3f(p * 0.8 + vec2f(5.2, 1.3), t * 0.4) + sd, 3, 2.0, 0.5));
  let q = p + w * 0.9 + vec2f(t * 0.35, -t * 0.12);
  let n = fbm(vec3f(q, t * 0.3) + sd, 4, 2.0, 0.5) * 0.8 + 0.5;
  let hn = fbm(vec3f(q * 0.6 + vec2f(9.1, 4.7), t * 0.2) + sd, 2, 2.0, 0.5) * 0.9 + 0.5;
  let e = max(abs(pc.x) / g.aspect, abs(pc.y));
  let bias = mix(1.0, smoothstep(0.15, 1.05, e) * 1.25, u.edge);
  let v = n * bias;
  let lo = 1.0 - u.coverage;
  let m = smoothstep(lo - u.softness * 0.5, lo + u.softness * 0.5, v);
  let hue = fract(u.hue + u.hueRange * sat(hn));
  // hot centres burn toward white
  let sat0 = u.saturation * (1.0 - 0.4 * m * m * m * m);
  var col = hsv2rgb(vec3f(hue, sat0, 1.0)) * m * m * (1.0 + 0.6 * m * m);
  let fl = 1.0 + u.flicker * (vnoise(vec2f(g.time * u.flickerRate, f32(u.seed) * 1.7)) * 2.0 - 1.0);
  col = ll_dither(col * u.intensity * max(fl, 0.0), uv * g.res);
  if (u.has_src < 0.5) { return vec4f(col, 1.0); }
  let c = textureSampleLevel(src, smp, uv, 0.0);
  if (u.blend == 1) { return vec4f(c.rgb + col, c.a); }
  return vec4f(c.rgb + col * (1.0 - clamp(c.rgb, vec3f(0.0), vec3f(1.0))), c.a);
}`,
};

// ---------------------------------------------------------------- heat haze

const heatwave: OpDef = {
  type: 'heatwave', label: 'Heat Haze', category: 'Distort', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }, { name: 'mask', type: 'tex', optional: true }],
  help: 'Rising refractive shimmer, like air above hot tarmac or a fire. Strongest at the bottom by default; a mask confines it.',
  params: [
    { k: 'float', name: 'strength', def: 0.006, min: 0, max: 0.05, step: 0.0001, group: 'Haze', help: 'Displacement as a fraction of image height.' },
    { k: 'float', name: 'scale', def: 7, min: 0.5, max: 40, group: 'Haze' },
    { k: 'float', name: 'stretch', def: 2, min: 0.25, max: 6, group: 'Haze', help: 'Vertical elongation of the turbulence.' },
    { k: 'float', name: 'rise', label: 'Rise speed', def: 0.6, min: 0, max: 4, group: 'Haze' },
    { k: 'float', name: 'falloff', label: 'Vertical falloff', def: 0.7, min: 0, max: 1, group: 'Haze', help: '0 = even, 1 = fades out completely toward the top.' },
    { k: 'float', name: 'chroma', label: 'Chromatic', def: 0.15, min: 0, max: 1, group: 'Haze' },
    { k: 'bool', name: 'invertMask', label: 'Invert mask', def: false, group: 'Haze' },
  ],
  body: /* wgsl */`
fn op(uv: vec2f) -> vec4f {
  let t = g.time * u.rise;
  let p = centered(uv) * u.scale * 0.5;
  let q = vec2f(p.x, p.y / max(u.stretch, 0.1) + t);
  let dx = fbm(vec3f(q, t * 0.35), 3, 2.1, 0.5);
  let dy = fbm(vec3f(q + vec2f(17.3, 5.9), t * 0.35), 3, 2.1, 0.5);
  var amt = u.strength * mix(1.0, pow(uv.y, 1.5), u.falloff);
  if (u.has_mask > 0.5) {
    var m = luma(textureSampleLevel(mask, smp, uv, 0.0).rgb);
    if (u.invertMask == 1) { m = 1.0 - m; }
    amt *= sat(m);
  }
  let o = vec2f(dx, dy * 0.6) * amt * vec2f(1.0 / g.aspect, 1.0) * 1.6;
  let k = u.chroma * 0.6;
  let cg = textureSampleLevel(src, smp, uv + o, 0.0);
  let r = textureSampleLevel(src, smp, uv + o * (1.0 + k), 0.0).r;
  let b = textureSampleLevel(src, smp, uv + o * (1.0 - k), 0.0).b;
  return vec4f(r, cg.g, b, cg.a);
}`,
};

// ---------------------------------------------------------------- caustics

const caustics: OpDef = {
  type: 'caustics', label: 'Caustics', category: 'Generate', output: 'tex',
  inputs: [{ name: 'src', type: 'tex', optional: true }],
  help: 'Animated underwater caustic light network with chromatic split. With Src connected it refracts the picture and lights it with the pattern.',
  params: [
    { k: 'float', name: 'scale', def: 5, min: 0.5, max: 30, group: 'Pattern', help: 'Cells per image height.' },
    { k: 'float', name: 'speed', def: 0.5, min: 0, max: 4, group: 'Pattern' },
    { k: 'float', name: 'sharpness', def: 5, min: 0.5, max: 20, group: 'Pattern' },
    { k: 'float', name: 'warp', def: 0.6, min: 0, max: 2, group: 'Pattern', help: 'Bends the network into organic curves.' },
    { k: 'float', name: 'intensity', def: 1, min: 0, max: 6, group: 'Look' },
    { k: 'color', name: 'color', def: [0.55, 0.85, 1, 1], group: 'Look' },
    { k: 'float', name: 'chroma', label: 'Chromatic split', def: 0.3, min: 0, max: 1, group: 'Look' },
    { k: 'float', name: 'amount', label: 'Light amount', def: 1, min: 0, max: 4, group: 'Over source', help: 'How strongly the pattern brightens Src.' },
    { k: 'float', name: 'refract', label: 'Refraction', def: 0.006, min: 0, max: 0.05, step: 0.0001, group: 'Over source', help: 'Displacement of Src as a fraction of image height.' },
  ],
  body: /* wgsl */`${dither('ca')}
fn ca_vor(p: vec2f, t: f32) -> f32 {
  let i = floor(p); let f = fract(p);
  var f1 = 8.0; var f2 = 8.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let c = vec2f(f32(x), f32(y));
      let h = hash22(i + c);
      let o = 0.5 + 0.42 * sin(vec2f(t, t * 1.13) + TAU * h);
      let d = length(c + o - f);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
    }
  }
  return f2 - f1;
}
fn ca_field(p0: vec2f, t: f32) -> f32 {
  let w = vec2f(snoise(vec3f(p0 * 0.35, t * 0.15)), snoise(vec3f(p0 * 0.35 + 7.7, t * 0.15)));
  let p = p0 + w * u.warp;
  let a = ca_vor(p, t);
  let b = ca_vor(rot(0.9) * p * 1.6 + vec2f(3.1, 1.7), t * 1.3);
  let la = exp(-a * u.sharpness * 3.0);
  let lb = exp(-b * u.sharpness * 3.0);
  return la * 0.75 + lb * 0.45 + la * lb * 1.2;
}
fn op(uv: vec2f) -> vec4f {
  let t = g.time * u.speed;
  let p = centered(uv) * 0.5 * u.scale;
  let k = u.chroma * 0.035;
  let cr = ca_field(p * (1.0 - k), t);
  let cg = ca_field(p, t);
  let cb = ca_field(p * (1.0 + k), t);
  let col = vec3f(cr, cg, cb) * u.color.rgb * u.intensity;
  if (u.has_src < 0.5) { return vec4f(ca_dither(col, uv * g.res), 1.0); }
  // refraction follows the gradient of the light pattern (bright lines bend the picture toward them)
  let e = 0.5 / max(u.scale, 0.5) * 0.1;
  let gx = ca_field(p + vec2f(e, 0.0), t) - cg;
  let gy = ca_field(p + vec2f(0.0, e), t) - cg;
  let o = vec2f(gx, gy) / e * u.refract * 0.05 * vec2f(1.0 / g.aspect, 1.0);
  let c = textureSampleLevel(src, smp, uv + o, 0.0);
  // shadowed between the lines, focused light on them
  return vec4f(c.rgb * (1.0 - 0.3 * sat(u.amount) + col * u.amount * 2.5), c.a);
}`,
};

// ---------------------------------------------------------------- prism

const prism: OpDef = {
  type: 'prism', label: 'Prism', category: 'Distort', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }],
  help: 'True spectral dispersion: the picture is resampled at up to 24 wavelengths, each weighted by its CIE colour and energy-normalised so white stays white. Linear, radial or crystal-facet modes.',
  params: [
    { k: 'enum', name: 'shape', options: ['Linear', 'Radial', 'Facets'], def: 1, group: 'Dispersion' },
    { k: 'float', name: 'amount', def: 0.025, min: 0, max: 0.2, step: 0.0005, group: 'Dispersion', help: 'Red-to-violet spread as a fraction of image height (radial: at the frame edge).' },
    { k: 'float', name: 'angle', def: 0, min: -180, max: 180, unit: '°', group: 'Dispersion', help: 'Linear mode direction.' },
    { k: 'vec2', name: 'center', def: [0.5, 0.5], min: -0.5, max: 1.5, step: 0.001, gizmo: 'uv', group: 'Dispersion', help: 'Radial mode centre.' },
    { k: 'int', name: 'samples', label: 'Wavelengths', def: 12, min: 3, max: 24, group: 'Dispersion' },
    { k: 'float', name: 'facets', def: 4, min: 1, max: 30, group: 'Facets', help: 'Crystal cells per image height.' },
    { k: 'float', name: 'shift', label: 'Facet shift', def: 0.03, min: 0, max: 0.2, group: 'Facets', help: 'How far each facet displaces the picture.' },
    { k: 'float', name: 'edges', label: 'Facet edges', def: 0.3, min: 0, max: 2, group: 'Facets', help: 'Brightens the crystal edges.' },
  ],
  body: /* wgsl */`${ign('pr')}
fn pr_g(x: f32, mu: f32, s1: f32, s2: f32) -> f32 {
  let t = (x - mu) / select(s2, s1, x < mu);
  return exp(-0.5 * t * t);
}
// CIE 1931 observer (Wyman–Sloan–Shirley multi-lobe fit) → linear sRGB, negatives clipped
fn pr_rgb(l: f32) -> vec3f {
  let X = 1.056 * pr_g(l, 599.8, 37.9, 31.0) + 0.362 * pr_g(l, 442.0, 16.0, 26.7) - 0.065 * pr_g(l, 501.1, 20.4, 26.2);
  let Y = 0.821 * pr_g(l, 568.8, 46.9, 40.5) + 0.286 * pr_g(l, 530.9, 16.3, 31.1);
  let Z = 1.217 * pr_g(l, 437.0, 11.8, 36.0) + 0.681 * pr_g(l, 459.0, 26.0, 13.8);
  return max(vec3f(3.2406 * X - 1.5372 * Y - 0.4986 * Z, -0.9689 * X + 1.8758 * Y + 0.0415 * Z, 0.0557 * X - 0.2040 * Y + 1.0570 * Z), vec3f(0.0));
}
fn op(uv: vec2f) -> vec4f {
  let n = clamp(u.samples, 3, 24);
  var dir = vec2f(0.0);
  var base = uv;
  var edge = 0.0;
  let asp = vec2f(1.0 / g.aspect, 1.0);
  if (u.shape == 0) {
    let a = radians(u.angle);
    dir = vec2f(cos(a), -sin(a)) * asp * u.amount;
  } else if (u.shape == 1) {
    let d = (uv - u.center) * vec2f(g.aspect, 1.0);
    dir = d / length(vec2f(g.aspect, 1.0)) * 2.0 * asp * u.amount;
  } else {
    // crystal: each Voronoi facet has its own refraction direction and displacement
    let p = centered(uv) * 0.5 * u.facets;
    let i = floor(p); let f = fract(p);
    var f1 = 8.0; var f2 = 8.0; var id = vec2f(0.0);
    for (var y = -1; y <= 1; y++) {
      for (var x = -1; x <= 1; x++) {
        let c = vec2f(f32(x), f32(y));
        let o = hash22(i + c) * 0.8 + 0.1;
        let dd = length(c + o - f);
        if (dd < f1) { f2 = f1; f1 = dd; id = i + c; } else if (dd < f2) { f2 = dd; }
      }
    }
    let h = hash22(id + 19.7) * TAU;
    let fd = vec2f(cos(h.x), sin(h.x));
    base = uv + fd * asp * u.shift * (0.4 + 0.6 * fract(h.y));
    dir = vec2f(-fd.y, fd.x) * asp * u.amount;
    edge = exp(-(f2 - f1) * 40.0) * u.edges;
  }
  let j = pr_ign(uv * g.res);
  var acc = vec3f(0.0); var ws = vec3f(0.0);
  var alpha = 0.0;
  for (var k = 0; k < n; k++) {
    let x = (f32(k) + j) / f32(n);
    let w = pr_rgb(mix(400.0, 700.0, x));
    let c = textureSampleLevel(src, smp, base + dir * (0.5 - x), 0.0);
    acc += c.rgb * w;
    ws += w;
    alpha += c.a;
  }
  let o = acc / max(ws, vec3f(1e-4));
  return vec4f(o * (1.0 + edge), alpha / f32(n));
}`,
};

// ---------------------------------------------------------------- glints

const glint: OpDef = {
  type: 'glint', label: 'Glints', category: 'Filter', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }],
  help: 'Twinkling sparkle crosses on the brightest points: the picture is searched cell by cell, and the hottest spot in a random subset of cells gets a star that pulses on its own rhythm.',
  params: [
    { k: 'float', name: 'threshold', def: 0.85, min: 0, max: 8, group: 'Source' },
    { k: 'float', name: 'spacing', def: 0.035, min: 0.01, max: 0.2, step: 0.001, group: 'Source', help: 'Search cell size as a fraction of image height: at most one glint per cell.' },
    { k: 'float', name: 'density', def: 0.5, min: 0, max: 1, group: 'Source', help: 'Share of qualifying cells that sparkle.' },
    { k: 'float', name: 'size', def: 0.06, min: 0.005, max: 0.3, step: 0.001, group: 'Star', help: 'Arm length as a fraction of image height.' },
    { k: 'float', name: 'thickness', def: 0.0016, min: 0.0002, max: 0.01, step: 0.0001, group: 'Star' },
    { k: 'float', name: 'rotation', def: 15, min: -180, max: 180, unit: '°', group: 'Star' },
    { k: 'float', name: 'diagonal', label: 'Diagonal arms', def: 0.35, min: 0, max: 1, group: 'Star' },
    { k: 'float', name: 'intensity', def: 3, min: 0, max: 10, group: 'Star' },
    { k: 'color', name: 'color', def: [1, 0.95, 0.85, 1], group: 'Colour' },
    { k: 'float', name: 'srcColor', label: 'Source colour', def: 0.5, min: 0, max: 1, group: 'Colour' },
    { k: 'float', name: 'speed', label: 'Twinkle speed', def: 1.5, min: 0, max: 10, group: 'Twinkle' },
    { k: 'float', name: 'twinkle', def: 0.8, min: 0, max: 1, group: 'Twinkle', help: 'Depth of the pulsing.' },
  ],
  passes: {
    cells: {
      inputs: ['src'], fields: [],
      body: /* wgsl */`
fn op(uv: vec2f) -> vec4f {
  // one texel per search cell: find the hottest of 8×8 candidates inside it
  let cell = floor(uv * g.res);
  var best = vec3f(0.5, 0.5, -1.0);
  for (var y = 0; y < 8; y++) {
    for (var x = 0; x < 8; x++) {
      let o = (vec2f(f32(x), f32(y)) + 0.5) / 8.0;
      let q = (cell + o) / g.res;
      let l = luma(textureSampleLevel(src, smp, q, 0.0).rgb);
      if (l > best.z) { best = vec3f(q, l); }
    }
  }
  return vec4f(best, 1.0);
}`,
    },
    draw: {
      inputs: ['src', 'cells'],
      fields: [['grid', 'vec2f'], ['threshold', 'f32'], ['size', 'f32'], ['thickness', 'f32'], ['density', 'f32'], ['rotation', 'f32'],
        ['diagonal', 'f32'], ['intensity', 'f32'], ['color', 'vec4f'], ['srcColor', 'f32'], ['phase', 'f32'], ['twinkle', 'f32'], ['reach', 'i32']],
      body: /* wgsl */`
fn gl_arm(x: f32, y: f32, len: f32, th: f32) -> f32 {
  let a = sat(1.0 - abs(x) / len);
  return a * a * a * exp(-abs(y) / th);
}
fn op(uv: vec2f) -> vec4f {
  let c = textureSampleLevel(src, smp, uv, 0.0);
  let c0 = floor(uv * u.grid);
  let R = clamp(u.reach, 1, 4);
  let ra = radians(u.rotation);
  let m = rot(ra);
  let md = rot(ra + PI * 0.25);
  var acc = vec3f(0.0);
  for (var y = -R; y <= R; y++) {
    for (var x = -R; x <= R; x++) {
      let cell = c0 + vec2f(f32(x), f32(y));
      if (cell.x < 0.0 || cell.y < 0.0 || cell.x >= u.grid.x || cell.y >= u.grid.y) { continue; }
      let dat = textureSampleLevel(cells, smpN, (cell + 0.5) / u.grid, 0.0);
      if (dat.z < u.threshold) { continue; }
      let h = hash22(cell + vec2f(0.37, 11.1));
      if (h.x > u.density) { continue; }
      let tw = mix(1.0, pow(0.5 + 0.5 * sin(u.phase * (0.6 + 0.8 * h.y) + TAU * h.x * 7.0), 3.0), u.twinkle);
      let e = sat((dat.z - u.threshold) / max(u.threshold, 0.2) + 0.4);
      let len = u.size * (0.6 + 0.4 * e) * (0.6 + 0.4 * tw);
      let d = (uv - dat.xy) * vec2f(g.aspect, 1.0);
      if (dot(d, d) > len * len * 1.1) { continue; }
      let p = m * d;
      let q = md * d;
      var s = gl_arm(p.x, p.y, len, u.thickness) + gl_arm(p.y, p.x, len, u.thickness);
      s += u.diagonal * (gl_arm(q.x, q.y, len * 0.5, u.thickness * 0.8) + gl_arm(q.y, q.x, len * 0.5, u.thickness * 0.8));
      s += exp(-length(d) / (len * 0.04)) * 0.8;
      let sc = textureSampleLevel(src, smp, dat.xy, 0.0).rgb;
      let col = mix(u.color.rgb, sc / max(luma(sc), 1e-3), u.srcColor);
      acc += s * col * tw * e;
    }
  }
  return vec4f(c.rgb + acc * u.intensity, c.a);
}`,
    },
  },
  cook(c) {
    const p = c.p;
    const sp = Math.max(0.005, p.spacing);
    const gy = Math.max(1, Math.round(1 / sp)), gx = Math.max(1, Math.round(gy * c.w / c.h));
    const cells = c.tex('cells', gx, gy);
    c.run('cells', cells.view, [c.ins[0]], {}, [gx, gy]);
    c.run('draw', c.out, [c.ins[0], cells.view], {
      grid: [gx, gy], threshold: p.threshold, size: p.size, thickness: p.thickness, density: p.density, rotation: p.rotation,
      diagonal: p.diagonal, intensity: p.intensity, color: p.color, srcColor: p.srcColor, phase: c.time * p.speed * 3, twinkle: p.twinkle,
      reach: Math.max(1, Math.min(4, Math.ceil(p.size / sp))),
    });
  },
};

// ---------------------------------------------------------------- lens edge

const lensedge: OpDef = {
  type: 'lensedge', label: 'Lens Edge', category: 'Filter', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }],
  help: 'Everything a real lens does to the frame edges in one op: barrel distortion, lateral chromatic aberration, blur that grows toward the corners with cat-eye shaped bokeh, and natural plus mechanical vignetting.',
  params: [
    { k: 'float', name: 'barrel', def: 0.06, min: -0.5, max: 0.5, group: 'Geometry', help: 'Positive = barrel, negative = pincushion. The frame stays filled.' },
    { k: 'float', name: 'chroma', label: 'Lateral CA', def: 0.4, min: 0, max: 3, group: 'Geometry', help: 'Red/blue magnification difference toward the corners.' },
    { k: 'float', name: 'blur', label: 'Edge blur', def: 0.006, min: 0, max: 0.04, step: 0.0001, group: 'Softness', help: 'Blur radius in the corners as a fraction of image height.' },
    { k: 'float', name: 'start', label: 'Sharp zone', def: 0.35, min: 0, max: 0.95, group: 'Softness', help: 'Fraction of the half-diagonal that stays sharp.' },
    { k: 'int', name: 'samples', def: 32, min: 8, max: 64, group: 'Softness' },
    { k: 'float', name: 'catEye', label: 'Cat eye', def: 0.5, min: 0, max: 1, group: 'Vignette', help: 'Mechanical vignetting: clips the edge bokeh into cat-eye shapes and darkens accordingly.' },
    { k: 'float', name: 'vignette', def: 0.4, min: 0, max: 2, group: 'Vignette', help: 'Natural cos⁴ falloff.' },
  ],
  body: /* wgsl */`${ign('le')}
fn op(uv: vec2f) -> vec4f {
  let diag = length(vec2f(g.aspect, 1.0));
  let p = centered(uv) / diag;              // 0 at centre, 1 in the corners
  let r2 = dot(p, p);
  let r = sqrt(r2);
  let k = u.barrel;
  let pd = p * (1.0 + k * r2) / (1.0 + max(k, 0.0));
  let ca = u.chroma * 0.008 * r2;
  let R = u.blur * g.res.y * pow(smoothstep(u.start, 1.0, r), 1.5);
  let n = clamp(u.samples, 8, 64);
  let rdir = select(vec2f(0.0), p / max(r, 1e-5), r > 1e-5);
  let off = u.catEye * r * 1.1;
  let jr = le_ign(uv * g.res) * TAU;
  var acc = vec3f(0.0); var wa = 0.0; var keep = 0.0;
  for (var i = 0; i < n; i++) {
    let fi = f32(i) + 0.5;
    let rr = sqrt(fi / f32(n));
    let th = fi * 2.39996323 + jr;
    let o = vec2f(cos(th), sin(th)) * rr;
    // second (exit pupil) circle shifted outward: the overlap is the cat-eye aperture
    if (length(o + rdir * off) > 1.0) { continue; }
    keep += 1.0;
    let q = o * R / g.res;
    let s = pd * diag;
    let uR = uncentered(s * (1.0 + ca)) + q;
    let uG = uncentered(s) + q;
    let uB = uncentered(s * (1.0 - ca)) + q;
    acc += vec3f(textureSampleLevel(src, smp, uR, 0.0).r, textureSampleLevel(src, smp, uG, 0.0).g, textureSampleLevel(src, smp, uB, 0.0).b);
    wa += textureSampleLevel(src, smp, uG, 0.0).a;
  }
  let kk = max(keep, 1.0);
  var col = acc / kk;
  var a = wa / kk;
  if (keep < 0.5) {
    let c = textureSampleLevel(src, smp, uncentered(pd * diag), 0.0);
    col = c.rgb; a = c.a;
  }
  let t = r * u.vignette;
  let nat = 1.0 / ((1.0 + t * t) * (1.0 + t * t));
  let mech = mix(1.0, keep / f32(n), 0.85);
  return vec4f(col * nat * mech, a);
}`,
};

export const ops: OpDef[] = [
  deepglow, shine, streaks, starglow, lensflare, bokeh, tiltshift, halation, lightleak, heatwave, caustics, prism, glint, lensedge,
];
