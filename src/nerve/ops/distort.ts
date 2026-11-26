// NERVE distortion operators: coordinate remaps, warps and vector-field tools.
import type { OpDef, ParamDef } from '../types';

// ---------- shared WGSL ----------

/** Edge handling for every remap that can leave 0..1. `mode`: 0 Clamp, 1 Repeat, 2 Mirror, 3 Transparent. */
const DST_EDGE = /* wgsl */`
fn dst_mod(x: f32, y: f32) -> f32 { return x - y * floor(x / y); }
fn dst_edge(q: vec2f, mode: i32) -> vec4f {
  if (mode == 1) { return textureSampleLevel(src, smpR, q, 0.0); }
  if (mode == 2) { return textureSampleLevel(src, smp, 1.0 - abs(fract(q * 0.5) * 2.0 - 1.0), 0.0); }
  if (mode == 3 && (any(q < vec2f(0.0)) || any(q > vec2f(1.0)))) { return vec4f(0.0); }
  return textureSampleLevel(src, smp, q, 0.0);
}`;

/** Effect amount from the optional `mask` input (luma); 1 when unconnected. */
const DST_MASK = /* wgsl */`
fn dst_mask(uv: vec2f) -> f32 {
  if (u.has_mask < 0.5) { return 1.0; }
  return sat(luma(textureSampleLevel(mask, smp, uv, 0.0).rgb));
}`;

const edge = (def = 2): ParamDef => ({
  k: 'enum', name: 'edge', options: ['Clamp', 'Repeat', 'Mirror', 'Transparent'], def,
  help: 'What to sample when the warp reaches past the image border.',
});
const SRC = { name: 'src', type: 'tex' as const };
const MASK = { name: 'mask', type: 'tex' as const, optional: true };
const CENTER: ParamDef = { k: 'vec2', name: 'center', def: [0, 0], min: -2, max: 2, step: 0.001, help: 'Centred coordinates; y spans -1..1.' };

// ---------- ops ----------

const displace: OpDef = {
  type: 'displace', label: 'Displace', category: 'Distort', output: 'tex',
  inputs: [SRC, { name: 'map', type: 'tex', optional: true }, MASK],
  help: 'Offsets pixels by a displacement map (or by the source itself when Map is unconnected).',
  params: [
    { k: 'enum', name: 'mode', options: ['RG Vector', 'RG Signed', 'Luma Direction', 'Luma Gradient'], def: 0,
      help: 'RG Vector: 0.5 is rest. RG Signed: raw vectors (fields). Luma Direction: push along Angle. Luma Gradient: push along slope.' },
    { k: 'float', name: 'amount', def: 0.05, min: 0, max: 0.5, step: 0.001, help: 'Fraction of image height.' },
    { k: 'float', name: 'angle', def: 0, min: -180, max: 180, unit: '°', help: 'Rotates the displacement direction.' },
    { k: 'vec2', name: 'scale', label: 'X / Y', def: [1, 1], min: -4, max: 4 },
    { k: 'float', name: 'chroma', label: 'Chromatic split', def: 0.15, min: 0, max: 1 },
    edge(2),
  ],
  body: /* wgsl */`${DST_EDGE}${DST_MASK}
fn dsp_map(q: vec2f) -> vec4f {
  if (u.has_map > 0.5) { return textureSampleLevel(map, smp, q, 0.0); }
  return textureSampleLevel(src, smp, q, 0.0);
}
fn dsp_l(q: vec2f) -> f32 { return luma(dsp_map(q).rgb); }
fn op(uv: vec2f) -> vec4f {
  let m = dsp_map(uv);
  var d: vec2f;
  if (u.mode == 0) { d = (m.rg - 0.5) * 2.0; }
  else if (u.mode == 1) { d = m.rg; }
  else if (u.mode == 2) { d = vec2f((luma(m.rgb) - 0.5) * 2.0, 0.0); }
  else {
    let e = vec2f(0.01 / g.aspect, 0.01);
    d = vec2f(dsp_l(uv + vec2f(e.x, 0.0)) - dsp_l(uv - vec2f(e.x, 0.0)),
              dsp_l(uv + vec2f(0.0, e.y)) - dsp_l(uv - vec2f(0.0, e.y))) * 2.0;
  }
  d = (rot(radians(u.angle)) * d) * u.scale;
  let off = d * u.amount * dst_mask(uv) / vec2f(g.aspect, 1.0);
  let c = dst_edge(uv + off, u.edge);
  if (u.chroma <= 0.0) { return c; }
  let r = dst_edge(uv + off * (1.0 + u.chroma), u.edge).r;
  let b = dst_edge(uv + off * (1.0 - u.chroma), u.edge).b;
  return vec4f(r, c.g, b, c.a);
}`,
};

const fieldwarp: OpDef = {
  type: 'fieldwarp', label: 'Field Warp', category: 'Field', output: 'tex',
  inputs: [SRC, { name: 'field', type: 'field' }, MASK],
  help: 'Advects the image along a vector field in several steps, so displacement follows curved paths. Smear averages along the path for streaks.',
  params: [
    { k: 'float', name: 'amount', def: 0.1, min: 0, max: 1, step: 0.001, help: 'Total travel, fraction of image height.' },
    { k: 'int', name: 'steps', def: 8, min: 1, max: 16 },
    { k: 'float', name: 'smear', def: 0.5, min: 0, max: 1, help: '0 = end point only, 1 = average along the path.' },
    { k: 'vec2', name: 'scroll', def: [0, 0], min: -2, max: 2, step: 0.001, help: 'Scrolls the field over time (image heights per second).' },
    edge(2),
  ],
  body: /* wgsl */`${DST_EDGE}${DST_MASK}
fn fw_vel(q: vec2f) -> vec2f {
  let ar = vec2f(g.aspect, 1.0);
  if (u.scroll.x == 0.0 && u.scroll.y == 0.0) { return textureSampleLevel(field, smp, q, 0.0).xy / ar; }
  return textureSampleLevel(field, smpR, q - g.time * u.scroll / ar, 0.0).xy / ar;
}
fn op(uv: vec2f) -> vec4f {
  let n = clamp(u.steps, 1, 16);
  let h = u.amount * dst_mask(uv) / f32(n);
  var q = uv;
  var acc = vec4f(0.0);
  var last = vec4f(0.0);
  for (var i = 0; i < 16; i++) {
    if (i >= n) { break; }
    let mid = q + fw_vel(q) * h * 0.5;   // midpoint (RK2) step
    q += fw_vel(mid) * h;
    last = dst_edge(q, u.edge);
    acc += last;
  }
  return mix(last, acc / f32(n), u.smear);
}`,
};

const kaleido: OpDef = {
  type: 'kaleido', label: 'Kaleidoscope', category: 'Distort', output: 'tex',
  inputs: [SRC],
  help: 'Radial: classic wedge kaleidoscope. Poly: repeated polygon folds for fractal kaleidoscopes.',
  params: [
    { k: 'enum', name: 'mode', options: ['Radial', 'Poly'], def: 0 },
    { k: 'int', name: 'segments', def: 6, min: 2, max: 32 },
    { k: 'float', name: 'rotation', def: 0, min: -180, max: 180, unit: '°', help: 'Radial: orients the pattern. Poly: rotation per fold.' },
    { k: 'float', name: 'speed', label: 'Spin', def: 6, min: -180, max: 180, unit: '°/s', help: 'Spins the sampled source.' },
    CENTER,
    { k: 'float', name: 'zoom', def: 1, min: 0.1, max: 8 },
    { k: 'bool', name: 'mirror', def: true, help: 'Mirror alternate wedges for seamless joins.' },
    { k: 'float', name: 'offset', def: 0.25, min: -1, max: 1, step: 0.001, help: 'Radial offset of the sampled region (shift per fold in Poly).' },
    { k: 'int', name: 'iterations', def: 4, min: 1, max: 12, help: 'Poly folds.' },
    edge(2),
  ],
  body: /* wgsl */`${DST_EDGE}
fn kal_fold(p: vec2f, n: f32, mir: bool) -> vec2f {
  let seg = TAU / n;
  var a = dst_mod(atan2(p.y, p.x), seg);
  if (mir) { a = abs(a - seg * 0.5); }
  return length(p) * vec2f(cos(a), sin(a));
}
fn op(uv: vec2f) -> vec4f {
  let n = f32(max(u.segments, 1));
  let mir = u.mirror == 1;
  let spin = radians(g.time * u.speed);
  var p = centered(uv) - u.center;
  if (u.mode == 0) {
    p = kal_fold(rot(radians(u.rotation)) * p, n, mir);
    p = rot(spin) * (p + vec2f(u.offset, 0.0));
  } else {
    let r = rot(radians(u.rotation) + spin);
    for (var i = 0; i < 12; i++) {
      if (i >= u.iterations) { break; }
      p = kal_fold(p, n, mir);
      p.x -= u.offset;
      p = r * p;
    }
  }
  return dst_edge(uncentered(p / u.zoom + u.center), u.edge);
}`,
};

const mirror: OpDef = {
  type: 'mirror', label: 'Mirror', category: 'Distort', output: 'tex',
  inputs: [SRC],
  help: 'Reflects one side of the image onto the other about a rotatable axis.',
  params: [
    { k: 'enum', name: 'mode', options: ['Left → Right', 'Right → Left', 'Top → Bottom', 'Bottom → Top', 'Quad', 'Diagonal'], def: 0 },
    { k: 'vec2', name: 'pos', label: 'Axis position', def: [0.5, 0.5], min: 0, max: 1, step: 0.001, help: 'Point the mirror axis passes through (uv).' },
    { k: 'float', name: 'angle', def: 0, min: -180, max: 180, unit: '°' },
    { k: 'float', name: 'soft', label: 'Seam softness', def: 0, min: 0, max: 0.2, step: 0.001, help: 'Rounds the fold crease; fraction of image height.' },
    edge(2),
  ],
  body: /* wgsl */`${DST_EDGE}
// reflect the side where dot(p - o, n) > 0; k rounds the crease (smooth abs)
fn mir_fold(p: vec2f, o: vec2f, n: vec2f, k: f32) -> vec2f {
  let s = dot(p - o, n);
  return p - (s + sqrt(s * s + k * k) - k) * n;
}
fn op(uv: vec2f) -> vec4f {
  let p = centered(uv);
  let o = centered(u.pos);
  let r = rot(radians(u.angle));
  let nx = r * vec2f(1.0, 0.0);
  let ny = r * vec2f(0.0, 1.0);
  let k = u.soft * 2.0;
  var q = p;
  switch (u.mode) {
    case 1 { q = mir_fold(p, o, -nx, k); }
    case 2 { q = mir_fold(p, o, ny, k); }
    case 3 { q = mir_fold(p, o, -ny, k); }
    case 4 { q = mir_fold(mir_fold(p, o, nx, k), o, ny, k); }
    case 5 { q = mir_fold(p, o, r * vec2f(0.70710678, -0.70710678), k); }
    default { q = mir_fold(p, o, nx, k); }
  }
  return dst_edge(uncentered(q), u.edge);
}`,
};

const polar: OpDef = {
  type: 'polar', label: 'Polar', category: 'Distort', output: 'tex',
  inputs: [SRC],
  help: 'Rect → Polar wraps the image around a centre (x → angle, y → radius). Polar → Rect unwraps it.',
  params: [
    { k: 'enum', name: 'mode', options: ['Rect → Polar', 'Polar → Rect'], def: 0 },
    CENTER,
    { k: 'float', name: 'scale', label: 'Radial scale', def: 1, min: 0.05, max: 8 },
    { k: 'int', name: 'repeat', label: 'Angular repeat', def: 1, min: 1, max: 16 },
    { k: 'float', name: 'twist', def: 0, min: -4, max: 4, help: 'Turns per unit radius.' },
    { k: 'float', name: 'offset', label: 'Radius offset', def: 0, min: -2, max: 2, step: 0.001 },
    { k: 'float', name: 'speed', def: 0.1, min: -4, max: 4, help: 'Animates the radius offset.' },
    edge(1),
  ],
  body: /* wgsl */`${DST_EDGE}
fn op(uv: vec2f) -> vec4f {
  let rep = f32(max(u.repeat, 1));
  let shift = u.offset + g.time * u.speed;
  if (u.mode == 0) {
    let p = centered(uv) - u.center;
    let r = length(p);
    let x = (atan2(p.y, p.x) / TAU + 0.5) * rep + u.twist * r;
    return dst_edge(vec2f(x, r * u.scale + shift), u.edge);
  }
  let r = (uv.y - shift) / u.scale;
  let a = ((uv.x - u.twist * r) / rep - 0.5) * TAU;
  return dst_edge(uncentered(u.center + r * vec2f(cos(a), sin(a))), u.edge);
}`,
};

const twirl: OpDef = {
  type: 'twirl', label: 'Twirl', category: 'Distort', output: 'tex',
  inputs: [SRC, MASK],
  help: 'Rotates the image around a centre, strongest in the middle and fading to zero at Radius.',
  params: [
    { k: 'float', name: 'angle', def: 180, min: -1440, max: 1440, unit: '°' },
    { k: 'float', name: 'radius', def: 0.5, min: 0.01, max: 2, step: 0.001, help: 'Fraction of image height.' },
    { k: 'float', name: 'falloff', def: 2, min: 0.25, max: 8, help: 'Curve exponent; higher keeps the twist near the centre.' },
    CENTER,
    { k: 'float', name: 'speed', def: 0, min: -360, max: 360, unit: '°/s', help: 'Adds to Angle over time.' },
    edge(2),
  ],
  body: /* wgsl */`${DST_EDGE}${DST_MASK}
fn op(uv: vec2f) -> vec4f {
  let p = centered(uv) - u.center;
  let t = sat(1.0 - length(p) / max(u.radius * 2.0, 1e-4));
  let a = radians(u.angle + g.time * u.speed) * pow(t, u.falloff) * dst_mask(uv);
  return dst_edge(uncentered(rot(a) * p + u.center), u.edge);
}`,
};

const bulge: OpDef = {
  type: 'bulge', label: 'Lens / Bulge', category: 'Distort', output: 'tex',
  inputs: [SRC, MASK],
  help: 'Global barrel/pincushion lens plus a local bulge or pinch, with per-channel dispersion.',
  params: [
    { k: 'float', name: 'amount', label: 'Bulge', def: 0.5, min: -1, max: 1, help: 'Positive bulges, negative pinches.' },
    { k: 'float', name: 'radius', def: 0.35, min: 0.01, max: 2, step: 0.001, help: 'Bulge radius, fraction of image height.' },
    { k: 'float', name: 'lens', def: 0, min: -0.5, max: 1, help: 'Positive = barrel, negative = pincushion.' },
    CENTER,
    { k: 'float', name: 'dispersion', def: 0.08, min: 0, max: 0.5, help: 'Splits R/G/B by scaling the distortion per channel.' },
    edge(0),
  ],
  body: /* wgsl */`${DST_EDGE}${DST_MASK}
fn op(uv: vec2f) -> vec4f {
  let p = centered(uv) - u.center;
  // lens: radius normalised to 1 at the frame corner
  var q = p * (1.0 + u.lens * dot(p, p) / (g.aspect * g.aspect + 1.0));
  // local bulge: monotonic for |amount| <= 1, C1 at the rim
  let t = sat(length(p) / max(u.radius * 2.0, 1e-4));
  q *= 1.0 - u.amount * (1.0 - t) * (1.0 - t);
  let d = (q - p) * dst_mask(uv);
  let base = p + u.center;
  let c = dst_edge(uncentered(base + d), u.edge);
  if (u.dispersion <= 0.0) { return c; }
  let r = dst_edge(uncentered(base + d * (1.0 + u.dispersion)), u.edge).r;
  let b = dst_edge(uncentered(base + d * (1.0 - u.dispersion)), u.edge).b;
  return vec4f(r, c.g, b, c.a);
}`,
};

const ripple: OpDef = {
  type: 'ripple', label: 'Ripple', category: 'Distort', output: 'tex',
  inputs: [SRC, MASK],
  help: 'Concentric radial ripples from a centre, or Pond: three interfering sources.',
  params: [
    { k: 'enum', name: 'mode', options: ['Single', 'Pond'], def: 0 },
    { k: 'float', name: 'amplitude', def: 0.01, min: 0, max: 0.1, step: 0.0005, help: 'Fraction of image height.' },
    { k: 'float', name: 'wavelength', def: 0.08, min: 0.005, max: 1, step: 0.001, help: 'Fraction of image height.' },
    { k: 'float', name: 'speed', def: 0.5, min: -4, max: 4, help: 'Waves per second.' },
    { k: 'float', name: 'decay', def: 1.5, min: 0, max: 10, help: 'Exponential fade with distance.' },
    { k: 'float', name: 'phase', def: 0, min: -180, max: 180, unit: '°' },
    CENTER,
    { k: 'int', name: 'seed', def: 1, min: 0, max: 999, help: 'Pond source placement.' },
    edge(2),
  ],
  body: /* wgsl */`${DST_EDGE}${DST_MASK}
fn rip_wave(p: vec2f, c: vec2f, wl: f32, ph: f32) -> vec2f {
  let v = p - c;
  let r = length(v) * 0.5;   // image heights
  let s = sin(TAU * (r / wl - g.time * u.speed) + ph) * exp(-u.decay * r) * sat(r / (wl * 0.25));
  return v / max(length(v), 1e-6) * s;
}
fn op(uv: vec2f) -> vec4f {
  let p = centered(uv);
  let wl = max(u.wavelength, 1e-4);
  let ph = radians(u.phase);
  var d = vec2f(0.0);
  if (u.mode == 0) { d = rip_wave(p, u.center, wl, ph); }
  else {
    for (var i = 0; i < 3; i++) {
      let h = hash22(vec2f(f32(i) * 17.31 + 3.7, f32(u.seed) * 7.13 + 1.9));
      let c = u.center + (h - 0.5) * vec2f(g.aspect, 1.0) * 1.4;
      d += rip_wave(p, c, wl * (0.75 + 0.5 * h.y), ph + TAU * h.x) * 0.6;
    }
  }
  return dst_edge(uv + d * u.amplitude * dst_mask(uv) / vec2f(g.aspect, 1.0), u.edge);
}`,
};

const wave: OpDef = {
  type: 'wave', label: 'Wave Warp', category: 'Distort', output: 'tex',
  inputs: [SRC, MASK],
  help: 'Shifts columns/rows by a periodic wave. X shifts horizontally as a function of height; Y vertically as a function of width.',
  params: [
    { k: 'enum', name: 'shape', options: ['Sine', 'Triangle', 'Square', 'Noise'], def: 0 },
    { k: 'float', name: 'ampX', label: 'Amplitude', group: 'X', def: 0.03, min: 0, max: 0.25, step: 0.001, help: 'Fraction of image height.' },
    { k: 'float', name: 'freqX', label: 'Frequency', group: 'X', def: 3, min: 0, max: 50, help: 'Cycles per image height.' },
    { k: 'float', name: 'speedX', label: 'Speed', group: 'X', def: 0.3, min: -4, max: 4 },
    { k: 'float', name: 'phaseX', label: 'Phase', group: 'X', def: 0, min: -180, max: 180, unit: '°' },
    { k: 'float', name: 'ampY', label: 'Amplitude', group: 'Y', def: 0.015, min: 0, max: 0.25, step: 0.001 },
    { k: 'float', name: 'freqY', label: 'Frequency', group: 'Y', def: 2, min: 0, max: 50 },
    { k: 'float', name: 'speedY', label: 'Speed', group: 'Y', def: -0.2, min: -4, max: 4 },
    { k: 'float', name: 'phaseY', label: 'Phase', group: 'Y', def: 0, min: -180, max: 180, unit: '°' },
    edge(2),
  ],
  body: /* wgsl */`${DST_EDGE}${DST_MASK}
fn wav_shape(t: f32, k: f32) -> f32 {
  switch (u.shape) {
    case 1 { return 1.0 - 4.0 * abs(fract(t + 0.25) - 0.5); }
    case 2 { return clamp(sin(TAU * t) * 8.0, -1.0, 1.0); }
    case 3 { return clamp(snoise(vec3f(t, k, 0.0)) * 1.4, -1.0, 1.0); }
    default { return sin(TAU * t); }
  }
}
fn op(uv: vec2f) -> vec4f {
  let p = vec2f((uv.x - 0.5) * g.aspect, uv.y - 0.5);   // image heights
  let dx = u.ampX * wav_shape(p.y * u.freqX + g.time * u.speedX + u.phaseX / 360.0, 3.1);
  let dy = u.ampY * wav_shape(p.x * u.freqY + g.time * u.speedY + u.phaseY / 360.0, 7.7);
  return dst_edge(uv + vec2f(dx / g.aspect, dy) * dst_mask(uv), u.edge);
}`,
};

const tile: OpDef = {
  type: 'tile', label: 'Tile', category: 'Distort', output: 'tex',
  inputs: [SRC],
  help: 'Repeats the image in a grid with brick offset, mirrored alternates, per-tile rotation, gaps and scrolling.',
  params: [
    { k: 'vec2', name: 'count', def: [3, 3], min: 1, max: 32, step: 0.01 },
    { k: 'float', name: 'brick', label: 'Row offset', def: 0, min: 0, max: 1, help: 'Horizontal shift per row (fraction of a tile).' },
    { k: 'bool', name: 'mirror', label: 'Mirror alternate', def: false },
    { k: 'float', name: 'rotation', def: 0, min: -180, max: 180, unit: '°', help: 'Rotates each tile about its centre.' },
    { k: 'float', name: 'gap', def: 0.006, min: 0, max: 0.1, step: 0.0005, help: 'Fraction of image height.' },
    { k: 'color', name: 'gapColor', label: 'Gap colour', def: [0.03, 0.03, 0.03, 1] },
    { k: 'vec2', name: 'scroll', def: [0, 0], min: -4, max: 4, step: 0.001, help: 'Tiles per second.' },
    edge(0),
  ],
  body: /* wgsl */`${DST_EDGE}
fn op(uv: vec2f) -> vec4f {
  let n = max(u.count, vec2f(1e-3));
  var t = uv * n + g.time * u.scroll;
  t.x += u.brick * floor(t.y);
  let cell = floor(t);
  var f = fract(t);
  var cov = 1.0;
  if (u.gap > 0.0) {
    let gp = min(u.gap * vec2f(n.x / g.aspect, n.y), vec2f(0.95));   // gap in tile units
    let aa = n / g.res;                                                // one pixel in tile units
    let e = sat2(f - gp * 0.5, aa) * sat2(1.0 - gp * 0.5 - f, aa);
    cov = e.x * e.y;
    f = (f - gp * 0.5) / (1.0 - gp);
  }
  if (u.mirror == 1) {
    if (dst_mod(cell.x, 2.0) > 0.5) { f.x = 1.0 - f.x; }
    if (dst_mod(cell.y, 2.0) > 0.5) { f.y = 1.0 - f.y; }
  }
  let ta = vec2f(g.aspect / n.x, 1.0 / n.y);   // tile aspect, so rotation stays rigid
  f = (rot(radians(u.rotation)) * ((f - 0.5) * ta)) / ta + 0.5;
  return mix(u.gapColor, dst_edge(f, u.edge), cov);
}
fn sat2(x: vec2f, aa: vec2f) -> vec2f { return clamp(x / aa + 0.5, vec2f(0.0), vec2f(1.0)); }`,
};

const pixelate: OpDef = {
  type: 'pixelate', label: 'Pixelate', category: 'Distort', output: 'tex',
  inputs: [SRC, { name: 'sizeMap', type: 'tex', optional: true }, MASK],
  help: 'Quantises the image into square, hex or triangle cells, or round dots. Size Map luma picks cell size (bright = large, in octave steps).',
  params: [
    { k: 'float', name: 'size', def: 0.025, min: 0.002, max: 0.25, step: 0.0005, help: 'Cell size, fraction of image height.' },
    { k: 'enum', name: 'shape', options: ['Square', 'Hex', 'Triangle', 'Circle Dots'], def: 0 },
    { k: 'float', name: 'jitter', def: 0, min: 0, max: 1, help: 'Random offset of each cell’s sample point.' },
    { k: 'vec2', name: 'aspect', def: [1, 1], min: 0.1, max: 8, help: 'Cell stretch.' },
    edge(0),
  ],
  body: /* wgsl */`${DST_EDGE}${DST_MASK}
fn pix_center(q: vec2f) -> vec2f {
  switch (u.shape) {
    case 1 {
      let r = vec2f(1.0, 1.7320508);
      let h = r * 0.5;
      let a = q - r * floor(q / r) - h;
      let b = (q - h) - r * floor((q - h) / r) - h;
      return select(q - b, q - a, dot(a, a) < dot(b, b));
    }
    case 2 {
      // skew so equilateral triangles become half unit squares, take the centroid, unskew
      let s = vec2f(q.x - q.y * 0.57735027, q.y * 1.15470054);
      let c = floor(s) + select(vec2f(1.0 / 3.0), vec2f(2.0 / 3.0), fract(s.x) + fract(s.y) > 1.0);
      return vec2f(c.x + c.y * 0.5, c.y * 0.8660254);
    }
    default { return floor(q) + 0.5; }
  }
}
fn op(uv: vec2f) -> vec4f {
  var sz = u.size;
  if (u.has_sizeMap > 0.5) {
    let l = sat(luma(textureSampleLevel(sizeMap, smp, uv, 0.0).rgb));
    sz *= exp2(-round((1.0 - l) * 3.0));
  }
  let cs = max(sz, 1e-4) * max(u.aspect, vec2f(0.01));   // cell size in image heights
  let q = centered(uv) * 0.5 / cs;
  let c = pix_center(q);
  let cj = c + (hash22(c * 1.37 + 0.5) - 0.5) * u.jitter;
  var col = dst_edge(uncentered(cj * cs * 2.0), u.edge);
  if (u.shape == 3) {
    let aa = 1.0 / (min(cs.x, cs.y) * g.res.y);
    col *= 1.0 - smoothstep(0.45 - aa, 0.45 + aa, length(q - c));
  }
  return mix(textureSampleLevel(src, smp, uv, 0.0), col, dst_mask(uv));
}`,
};

const noisewarp: OpDef = {
  type: 'noisewarp', label: 'Noise Warp', category: 'Distort', output: 'tex',
  inputs: [SRC, MASK],
  help: 'Displaces by animated fractal noise. Turbulent Curl follows the curl of the noise so the image swirls instead of tearing.',
  params: [
    { k: 'float', name: 'scale', def: 3, min: 0.1, max: 30 },
    { k: 'float', name: 'amount', def: 0.04, min: 0, max: 0.5, step: 0.001, help: 'Fraction of image height.' },
    { k: 'float', name: 'speed', def: 0.2, min: 0, max: 4 },
    { k: 'int', name: 'octaves', def: 3, min: 1, max: 8 },
    { k: 'bool', name: 'curl', label: 'Turbulent curl', def: false },
    edge(2),
  ],
  body: /* wgsl */`${DST_EDGE}${DST_MASK}
fn op(uv: vec2f) -> vec4f {
  let oct = clamp(u.octaves, 1, 8);
  let z = g.time * u.speed;
  let m = u.amount * dst_mask(uv) * 2.0;   // centred units
  var p = centered(uv);
  if (u.curl == 0) {
    let n = p * u.scale * 0.5;
    p += vec2f(fbm(vec3f(n, z), oct, 2.0, 0.5), fbm(vec3f(n + vec2f(19.1, 7.3), z), oct, 2.0, 0.5)) * m;
  } else {
    // integrate along the curl of the noise potential: divergence-free, so it swirls
    let e = 0.01;
    for (var i = 0; i < 4; i++) {
      let n = p * u.scale * 0.5;
      let f0 = fbm(vec3f(n, z), oct, 2.0, 0.5);
      let fx = fbm(vec3f(n + vec2f(e, 0.0), z), oct, 2.0, 0.5);
      let fy = fbm(vec3f(n + vec2f(0.0, e), z), oct, 2.0, 0.5);
      p += vec2f(fy - f0, f0 - fx) / e * 0.5 * m * 0.25;
    }
  }
  return dst_edge(uncentered(p), u.edge);
}`,
};

const droste: OpDef = {
  type: 'droste', label: 'Droste', category: 'Distort', output: 'tex',
  inputs: [SRC],
  help: 'Escher-style recursive spiral zoom via the complex logarithm. The annulus between Ratio and the frame repeats endlessly inward.',
  params: [
    { k: 'float', name: 'ratio', label: 'Inner ratio', def: 0.35, min: 0.02, max: 0.9, help: 'Size of each nested copy relative to the last.' },
    { k: 'int', name: 'strands', def: 1, min: -6, max: 6, help: 'Spiral arms; 0 gives straight concentric recursion.' },
    { k: 'float', name: 'zoomSpeed', label: 'Zoom speed', def: 0.15, min: -2, max: 2, help: 'Nested levels per second.' },
    { k: 'float', name: 'spin', label: 'Rotation speed', def: 0, min: -180, max: 180, unit: '°/s' },
    CENTER,
    edge(0),
  ],
  body: /* wgsl */`${DST_EDGE}
fn op(uv: vec2f) -> vec4f {
  let p = centered(uv) - u.center;
  let L = -log(clamp(u.ratio, 0.01, 0.99));   // period in log-radius
  let k = f32(u.strands) * L / TAU;
  let lz = vec2f(log(max(length(p), 1e-6)), atan2(p.y, p.x));
  // multiply by (1 - i k): one turn of the output advances 'strands' periods, so the seam closes
  var z = vec2f(lz.x + k * lz.y, lz.y - k * lz.x);
  z.x = dst_mod(z.x - g.time * u.zoomSpeed * L, L) - L;
  z.y += radians(g.time * u.spin);
  return dst_edge(uncentered(exp(z.x) * vec2f(cos(z.y), sin(z.y)) + u.center), u.edge);
}`,
};

const mobius: OpDef = {
  type: 'mobius', label: 'Möbius', category: 'Distort', output: 'tex',
  inputs: [SRC],
  help: 'Complex Möbius transform with fixed points A and B: the plane rotates around both poles. Power applies z^n first.',
  params: [
    { k: 'vec2', name: 'pointA', label: 'Point A', def: [-0.5, 0], min: -2, max: 2, step: 0.001 },
    { k: 'vec2', name: 'pointB', label: 'Point B', def: [0.5, 0], min: -2, max: 2, step: 0.001 },
    { k: 'float', name: 'rotation', def: 60, min: -360, max: 360, unit: '°' },
    { k: 'float', name: 'speed', def: 0, min: -180, max: 180, unit: '°/s' },
    { k: 'int', name: 'power', def: 1, min: 1, max: 8, help: 'z^n pre-map.' },
    edge(2),
  ],
  body: /* wgsl */`${DST_EDGE}
fn mob_mul(a: vec2f, b: vec2f) -> vec2f { return vec2f(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
fn mob_div(a: vec2f, b: vec2f) -> vec2f { return mob_mul(a, vec2f(b.x, -b.y)) / max(dot(b, b), 1e-8); }
fn op(uv: vec2f) -> vec4f {
  var z = centered(uv);
  if (u.power > 1) {
    let n = f32(u.power);
    let a = atan2(z.y, z.x) * n;
    z = pow(length(z), n) * vec2f(cos(a), sin(a));
  }
  let th = radians(u.rotation + g.time * u.speed);
  // w = e^{i th} (z - A)/(z - B), then back: z' = (B w - A)/(w - 1)
  let w = mob_mul(mob_div(z - u.pointA, z - u.pointB), vec2f(cos(th), sin(th)));
  let q = mob_div(mob_mul(u.pointB, w) - u.pointA, w - vec2f(1.0, 0.0));
  return dst_edge(uncentered(q), u.edge);
}`,
};

const stretch: OpDef = {
  type: 'stretch', label: 'Slit Stretch', category: 'Distort', output: 'tex',
  inputs: [SRC, MASK],
  help: 'Samples a single row or column and smears it across the image (pixel-stretch).',
  params: [
    { k: 'enum', name: 'direction', options: ['Down', 'Up', 'Right', 'Left', 'Up + Down', 'Left + Right'], def: 0 },
    { k: 'float', name: 'position', def: 0.5, min: 0, max: 1, step: 0.001, help: 'Row/column to sample (uv).' },
    { k: 'float', name: 'blend', def: 1, min: 0, max: 1 },
    { k: 'float', name: 'falloff', def: 0, min: 0, max: 20, help: 'Fades the smear with distance from the slit.' },
  ],
  body: /* wgsl */`${DST_MASK}
fn op(uv: vec2f) -> vec4f {
  let c0 = textureSampleLevel(src, smp, uv, 0.0);
  let dv = uv.y - u.position;
  let dh = (uv.x - u.position) * g.aspect;   // image heights
  let horiz = u.direction == 2 || u.direction == 3 || u.direction == 5;
  var dist = select(dv, dh, horiz);
  if (u.direction == 1 || u.direction == 3) { dist = -dist; }
  else if (u.direction >= 4) { dist = abs(dist); }
  if (dist < 0.0) { return c0; }
  let s = select(vec2f(uv.x, u.position), vec2f(u.position, uv.y), horiz);
  let w = u.blend * exp(-u.falloff * dist) * dst_mask(uv);
  return mix(c0, textureSampleLevel(src, smp, s, 0.0), w);
}`,
};

const fisheye: OpDef = {
  type: 'fisheye', label: 'Fisheye', category: 'Distort', output: 'tex',
  inputs: [SRC],
  help: 'Renders the source through a fisheye lens (FOV across the frame diagonal). Treats the source as a flat perspective photo, or as a 360° equirectangular panorama.',
  params: [
    { k: 'enum', name: 'mapping', options: ['Equidistant', 'Stereographic', 'Equisolid'], def: 0 },
    { k: 'float', name: 'fov', label: 'FOV', def: 140, min: 10, max: 359, unit: '°' },
    { k: 'float', name: 'tilt', def: 0, min: -180, max: 180, unit: '°' },
    { k: 'float', name: 'pan', def: 0, min: -180, max: 180, unit: '°' },
    { k: 'bool', name: 'equirect', label: 'Equirectangular source', def: false },
    edge(3),
  ],
  body: /* wgsl */`${DST_EDGE}
fn op(uv: vec2f) -> vec4f {
  let diag = sqrt(g.aspect * g.aspect + 1.0);
  let p = centered(uv);
  let r = length(p) / diag;                       // 1 at the frame corner
  let tm = radians(clamp(u.fov, 1.0, 359.0)) * 0.5;
  var th: f32;
  switch (u.mapping) {
    case 1 { th = 2.0 * atan(r * tan(tm * 0.5)); }
    case 2 {
      let s = r * sin(tm * 0.5);
      if (s > 1.0) { return vec4f(0.0); }
      th = 2.0 * asin(s);
    }
    default { th = r * tm; }
  }
  if (th > PI) { return vec4f(0.0); }
  let ph = atan2(p.y, p.x);
  var d = vec3f(sin(th) * cos(ph), sin(th) * sin(ph), cos(th));
  let t = radians(u.tilt);
  let pn = radians(u.pan);
  d = vec3f(d.x, d.y * cos(t) - d.z * sin(t), d.y * sin(t) + d.z * cos(t));
  d = vec3f(d.x * cos(pn) + d.z * sin(pn), d.y, d.z * cos(pn) - d.x * sin(pn));
  if (u.equirect == 1) {
    let q = vec2f(atan2(d.x, d.z) / TAU + 0.5, asin(clamp(d.y, -1.0, 1.0)) / PI + 0.5);
    return textureSampleLevel(src, smpR, q, 0.0);
  }
  if (d.z <= 1e-4) { return vec4f(0.0); }
  // flat source = pinhole photo whose corners meet the fisheye corners (up to ~150° FOV)
  let c = tan(min(tm, 1.3));
  return dst_edge(uncentered(d.xy / d.z / c * diag), u.edge);
}`,
};

const slope: OpDef = {
  type: 'slope', label: 'Slope', category: 'Field', output: 'field',
  inputs: [SRC],
  help: 'Luma gradient as a vector field (RG, signed, y down; unit = luma change per tenth of image height). Rotate 90° to flow along contours.',
  params: [
    { k: 'float', name: 'strength', def: 1, min: 0, max: 10 },
    { k: 'float', name: 'spread', label: 'Blur radius', def: 0.01, min: 0.0005, max: 0.1, step: 0.0005, help: 'Sample spread, fraction of image height.' },
    { k: 'bool', name: 'rotate', label: 'Rotate 90°', def: false },
  ],
  body: /* wgsl */`
fn sl_l(q: vec2f) -> f32 { return luma(textureSampleLevel(src, smp, q, 0.0).rgb); }
// Sobel at spacing e (uv), returned per image height
fn sl_grad(uv: vec2f, s: f32) -> vec2f {
  let e = vec2f(s / g.aspect, s);
  let tl = sl_l(uv + vec2f(-e.x, -e.y)); let tc = sl_l(uv + vec2f(0.0, -e.y)); let tr = sl_l(uv + vec2f(e.x, -e.y));
  let ml = sl_l(uv + vec2f(-e.x, 0.0));                                       let mr = sl_l(uv + vec2f(e.x, 0.0));
  let bl = sl_l(uv + vec2f(-e.x, e.y));  let bc = sl_l(uv + vec2f(0.0, e.y));  let br = sl_l(uv + vec2f(e.x, e.y));
  return vec2f((tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl), (bl + 2.0 * bc + br) - (tl + 2.0 * tc + tr)) / (8.0 * s);
}
fn op(uv: vec2f) -> vec4f {
  let s = max(u.spread, 1e-4);
  var v = (sl_grad(uv, s) + sl_grad(uv, s * 0.5)) * 0.5 * 0.1 * u.strength;
  if (u.rotate == 1) { v = vec2f(-v.y, v.x); }
  return vec4f(v, 0.0, 1.0);
}`,
};

const fieldmath: OpDef = {
  type: 'fieldmath', label: 'Field Math', category: 'Field', output: 'field',
  inputs: [{ name: 'a', type: 'field' }, { name: 'b', type: 'field', optional: true }],
  help: 'Combines or reshapes vector fields. Scale multiplies the result in every mode.',
  params: [
    { k: 'enum', name: 'mode', options: ['Add', 'Subtract', 'Multiply', 'Rotate', 'Normalize', 'Scale', 'Perpendicular', 'Mix'], def: 3 },
    { k: 'float', name: 'scale', def: 1, min: -10, max: 10 },
    { k: 'float', name: 'angle', def: 90, min: -180, max: 180, unit: '°', help: 'Rotate mode.' },
    { k: 'float', name: 'mixAmt', label: 'Mix', def: 0.5, min: 0, max: 1, help: 'Mix mode: 0 = A, 1 = B.' },
  ],
  body: /* wgsl */`
fn op(uv: vec2f) -> vec4f {
  let va = textureSampleLevel(a, smp, uv, 0.0).xy;
  let vb = textureSampleLevel(b, smp, uv, 0.0).xy;
  var v: vec2f;
  switch (u.mode) {
    case 0 { v = va + vb; }
    case 1 { v = va - vb; }
    case 2 { v = va * vb; }
    case 3 { v = rot(radians(u.angle)) * va; }
    case 4 { v = va / max(length(va), 1e-6); }
    case 6 { v = vec2f(-va.y, va.x); }
    case 7 { v = mix(va, vb, u.mixAmt); }
    default { v = va; }
  }
  return vec4f(v * u.scale, 0.0, 1.0);
}`,
};

export const ops: OpDef[] = [
  displace, fieldwarp, kaleido, mirror, polar, twirl, bulge, ripple, wave, tile,
  pixelate, noisewarp, droste, mobius, stretch, fisheye, slope, fieldmath,
];
