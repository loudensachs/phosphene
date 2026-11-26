// NERVE colour operators. Pipeline is linear-light HDR; perceptual decisions (hue, contrast pivots,
// thresholds, quantisation) are made on a gamma-2.2 encoded value and decoded back to linear.
import type { OpDef, ParamDef } from '../types';

/** Perceptual encode/decode helpers, prefixed per op. */
const perc = (p: string) => /* wgsl */`
fn ${p}_enc(x: vec3f) -> vec3f { return pow(max(x, vec3f(0.0)), vec3f(1.0 / 2.2)); }
fn ${p}_dec(x: vec3f) -> vec3f { return pow(max(x, vec3f(0.0)), vec3f(2.2)); }
fn ${p}_enc1(x: f32) -> f32 { return pow(max(x, 0.0), 1.0 / 2.2); }
fn ${p}_dec1(x: f32) -> f32 { return pow(max(x, 0.0), 2.2); }`;

/** Exact sRGB transfer, used to recover authored palette coefficients from linear colour params. */
const srgb = (p: string) => /* wgsl */`
fn ${p}_l2s(c: vec3f) -> vec3f {
  let x = max(c, vec3f(0.0));
  return select(1.055 * pow(x, vec3f(1.0 / 2.4)) - 0.055, x * 12.92, x <= vec3f(0.0031308));
}
fn ${p}_s2l(c: vec3f) -> vec3f {
  let x = max(c, vec3f(0.0));
  return select(pow((x + 0.055) / 1.055, vec3f(2.4)), x / 12.92, x <= vec3f(0.04045));
}
fn ${p}_pal(t: f32) -> vec3f {
  return ${p}_s2l(palette(t, ${p}_l2s(u.pa.rgb), ${p}_l2s(u.pb.rgb), ${p}_l2s(u.pc.rgb), ${p}_l2s(u.pd.rgb)));
}`;

const PALETTE_PARAMS: ParamDef[] = [
  { k: 'color', name: 'pa', label: 'A (bias)', group: 'Palette', def: [0.5, 0.5, 0.5, 1] },
  { k: 'color', name: 'pb', label: 'B (amplitude)', group: 'Palette', def: [0.5, 0.5, 0.5, 1] },
  { k: 'color', name: 'pc', label: 'C (frequency)', group: 'Palette', def: [1, 1, 1, 1] },
  { k: 'color', name: 'pd', label: 'D (phase)', group: 'Palette', def: [0, 0.33, 0.67, 1] },
];

const hsv: OpDef = {
  type: 'hsv', label: 'HSV Adjust', category: 'Color', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }, { name: 'mask', type: 'tex', optional: true }],
  help: 'Hue rotation (optionally cycling), saturation, vibrance and value. Saturation is luma-preserving; the optional mask (luma) limits the effect.',
  params: [
    { k: 'float', name: 'hue', label: 'Hue shift', def: 0, min: -180, max: 180, unit: '°' },
    { k: 'float', name: 'speed', label: 'Hue cycle', def: 0, min: -2, max: 2, unit: 'rev/s' },
    { k: 'float', name: 'saturation', def: 1.15, min: 0, max: 3 },
    { k: 'float', name: 'vibrance', def: 0.2, min: -1, max: 1, help: 'Saturates muted colours more than vivid ones.' },
    { k: 'float', name: 'value', def: 1, min: 0, max: 4 },
  ],
  body: /* wgsl */`
fn op(uv: vec2f) -> vec4f {
  let c = textureSampleLevel(src, smp, uv, 0.0);
  var h = rgb2hsv(max(c.rgb, vec3f(0.0)));
  let s0 = h.y;
  h.x = fract(h.x + u.hue / 360.0 + g.time * u.speed);
  var rgb = hsv2rgb(h);
  let l = luma(rgb);
  let s = max(u.saturation * (1.0 + u.vibrance * (1.0 - s0)), 0.0);
  rgb = max(mix(vec3f(l), rgb, s), vec3f(0.0)) * u.value;
  var k = 1.0;
  if (u.has_mask > 0.5) { k = sat(luma(textureSampleLevel(mask, smp, uv, 0.0).rgb)); }
  return vec4f(mix(c.rgb, rgb, k), c.a);
}`,
};

const grade: OpDef = {
  type: 'grade', label: 'Grade', category: 'Color', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }],
  help: 'Primary grade: exposure, white balance, lift/gamma/gain, log-style contrast around a linear pivot, saturation. Gamma and gain are neutral at white, lift at black.',
  params: [
    { k: 'float', name: 'exposure', def: 0, min: -6, max: 6, unit: 'EV' },
    { k: 'float', name: 'contrast', def: 1.1, min: 0, max: 3 },
    { k: 'float', name: 'pivot', def: 0.18, min: 0.01, max: 1, help: 'Linear value left unchanged by contrast (0.18 = mid grey).' },
    { k: 'float', name: 'saturation', def: 1.1, min: 0, max: 3 },
    { k: 'float', name: 'temperature', def: 0.1, min: -1, max: 1, group: 'Balance', help: 'Negative = cooler, positive = warmer.' },
    { k: 'float', name: 'tint', def: 0, min: -1, max: 1, group: 'Balance', help: 'Negative = green, positive = magenta.' },
    { k: 'color', name: 'lift', def: [0, 0, 0, 1], group: 'Wheels', help: 'Added to shadows (black = neutral).' },
    { k: 'color', name: 'gamma', def: [1, 1, 1, 1], group: 'Wheels', help: 'Per-channel midtone power (white = neutral).' },
    { k: 'color', name: 'gain', def: [1, 1, 1, 1], group: 'Wheels', help: 'Per-channel multiplier (white = neutral).' },
  ],
  body: /* wgsl */`
fn op(uv: vec2f) -> vec4f {
  let c = textureSampleLevel(src, smp, uv, 0.0);
  var x = max(c.rgb, vec3f(0.0)) * exp2(u.exposure);
  let wb = vec3f(1.0 + 0.25 * u.temperature, 1.0 - 0.25 * u.tint, 1.0 - 0.25 * u.temperature);
  x *= wb / max(luma(wb), 1e-4);
  x = x * u.gain.rgb;
  x = x + u.lift.rgb * (1.0 - min(x, vec3f(1.0)));
  x = pow(max(x, vec3f(0.0)), 1.0 / max(u.gamma.rgb, vec3f(0.01)));
  x = u.pivot * pow(x / u.pivot, vec3f(u.contrast));
  let l = luma(x);
  x = max(mix(vec3f(l), x, u.saturation), vec3f(0.0));
  return vec4f(x, c.a);
}`,
};

const invert: OpDef = {
  type: 'invert', label: 'Invert', category: 'Color', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }],
  help: 'Inverts selected channels. Perceptual space keeps mid grey at mid grey; values above 1 invert to 0.',
  params: [
    { k: 'float', name: 'amount', def: 1, min: 0, max: 1 },
    { k: 'enum', name: 'space', options: ['Perceptual', 'Linear'], def: 0 },
    { k: 'bool', name: 'red', def: true },
    { k: 'bool', name: 'green', def: true },
    { k: 'bool', name: 'blue', def: true },
    { k: 'bool', name: 'invertAlpha', label: 'Invert alpha', def: false },
  ],
  body: /* wgsl */`${perc('invert')}
fn op(uv: vec2f) -> vec4f {
  let c = textureSampleLevel(src, smp, uv, 0.0);
  var inv: vec3f;
  if (u.space == 0) { inv = invert_dec(1.0 - min(invert_enc(c.rgb), vec3f(1.0))); }
  else { inv = max(1.0 - c.rgb, vec3f(0.0)); }
  let m = vec3f(f32(u.red), f32(u.green), f32(u.blue)) * u.amount;
  let a = select(c.a, mix(c.a, 1.0 - c.a, u.amount), u.invertAlpha == 1);
  return vec4f(mix(c.rgb, inv, m), a);
}`,
};

const threshold: OpDef = {
  type: 'threshold', label: 'Threshold', category: 'Color', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }, { name: 'map', type: 'tex', optional: true }],
  help: 'Two-colour threshold. Level is perceptual (0.5 = mid grey). A connected Map supplies a per-pixel level (its luma), offset by Level − 0.5.',
  params: [
    { k: 'float', name: 'level', def: 0.5, min: 0, max: 1 },
    { k: 'float', name: 'softness', def: 0.04, min: 0, max: 1 },
    { k: 'enum', name: 'channel', options: ['Luma', 'R', 'G', 'B', 'A'], def: 0 },
    { k: 'color', name: 'low', def: [0, 0, 0, 1] },
    { k: 'color', name: 'high', def: [1, 1, 1, 1] },
  ],
  body: /* wgsl */`${perc('threshold')}
fn threshold_pick(c: vec4f) -> f32 {
  switch (u.channel) {
    case 1 { return threshold_enc1(c.r); }
    case 2 { return threshold_enc1(c.g); }
    case 3 { return threshold_enc1(c.b); }
    case 4 { return c.a; }
    default { return threshold_enc1(luma(c.rgb)); }
  }
}
fn op(uv: vec2f) -> vec4f {
  let c = textureSampleLevel(src, smp, uv, 0.0);
  var lv = u.level;
  if (u.has_map > 0.5) { lv = threshold_enc1(luma(textureSampleLevel(map, smp, uv, 0.0).rgb)) + u.level - 0.5; }
  let s = max(u.softness, 1e-4) * 0.5;
  let k = smoothstep(lv - s, lv + s, threshold_pick(c));
  let o = mix(u.low, u.high, k);
  return vec4f(o.rgb, o.a * c.a);
}`,
};

const posterize: OpDef = {
  type: 'posterize', label: 'Posterize', category: 'Color', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }],
  help: 'Quantises to N steps in a gamma-encoded space (so steps are perceptually even), with optional noise dither. Per-channel off quantises luma only and keeps hue.',
  params: [
    { k: 'int', name: 'steps', def: 6, min: 2, max: 64 },
    { k: 'float', name: 'gamma', def: 2.2, min: 0.5, max: 4, help: 'Encoding gamma used for quantisation (1 = linear steps).' },
    { k: 'float', name: 'dither', def: 0, min: 0, max: 1 },
    { k: 'bool', name: 'perChannel', label: 'Per channel', def: true },
  ],
  body: /* wgsl */`
fn posterize_ign(p: vec2f) -> f32 { return fract(52.9829189 * fract(dot(floor(p), vec2f(0.06711056, 0.00583715)))); }
fn op(uv: vec2f) -> vec4f {
  let c = textureSampleLevel(src, smp, uv, 0.0);
  let n = f32(max(u.steps, 2) - 1);
  let gm = max(u.gamma, 0.1);
  let d = (posterize_ign(uv * g.res) - 0.5) * u.dither;
  var rgb: vec3f;
  if (u.perChannel == 1) {
    let e = pow(max(c.rgb, vec3f(0.0)), vec3f(1.0 / gm));
    rgb = pow(max(floor(e * n + 0.5 + d) / n, vec3f(0.0)), vec3f(gm));
  } else {
    let l = max(luma(c.rgb), 0.0);
    let q = pow(max(floor(pow(l, 1.0 / gm) * n + 0.5 + d) / n, 0.0), gm);
    rgb = max(c.rgb, vec3f(0.0)) * (q / max(l, 1e-5));
  }
  return vec4f(rgb, c.a);
}`,
};

const gradmap: OpDef = {
  type: 'gradmap', label: 'Gradient Map', category: 'Color', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }],
  help: 'Maps perceptual luma through a cosine palette (a + b·cos(2π(c·t + d))) or a 3-stop gradient. Frequency, phase and cycle apply to both; the gradient ping-pongs when cycled.',
  params: [
    { k: 'enum', name: 'mode', options: ['Cosine', '3-Stop'], def: 0 },
    { k: 'float', name: 'frequency', def: 1, min: 0, max: 8 },
    { k: 'float', name: 'phase', def: 0, min: 0, max: 1 },
    { k: 'float', name: 'speed', label: 'Cycle', def: 0, min: -2, max: 2, unit: '/s' },
    { k: 'float', name: 'amount', label: 'Mix', def: 1, min: 0, max: 1 },
    ...PALETTE_PARAMS,
    { k: 'color', name: 'stop1', label: 'Shadows', group: 'Gradient', def: [0.08, 0.02, 0.2, 1] },
    { k: 'color', name: 'stop2', label: 'Mids', group: 'Gradient', def: [0.85, 0.25, 0.35, 1] },
    { k: 'color', name: 'stop3', label: 'Highlights', group: 'Gradient', def: [1, 0.9, 0.6, 1] },
    { k: 'float', name: 'midPos', label: 'Mid position', group: 'Gradient', def: 0.5, min: 0.01, max: 0.99 },
  ],
  body: /* wgsl */`${srgb('gradmap')}
fn op(uv: vec2f) -> vec4f {
  let c = textureSampleLevel(src, smp, uv, 0.0);
  let t = pow(max(luma(c.rgb), 0.0), 1.0 / 2.2) * u.frequency + u.phase + g.time * u.speed;
  var col: vec3f;
  if (u.mode == 0) {
    col = gradmap_pal(t);
  } else {
    let x = 1.0 - abs(fract(t * 0.5) * 2.0 - 1.0);
    col = select(mix(u.stop2.rgb, u.stop3.rgb, (x - u.midPos) / (1.0 - u.midPos)),
                 mix(u.stop1.rgb, u.stop2.rgb, x / u.midPos), x < u.midPos);
  }
  return vec4f(mix(c.rgb, col, u.amount), c.a);
}`,
};

const CHAN_SRC = ['R', 'G', 'B', 'A', 'Luma', 'Zero', 'One', 'B: R', 'B: G', 'B: B', 'B: A', 'B: Luma'];
const chanmix: OpDef = {
  type: 'chanmix', label: 'Channel Mix', category: 'Color', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }, { name: 'b', type: 'tex', optional: true }],
  help: 'Rebuilds each output channel from a chosen source channel times a gain. "B:" sources read the optional second input.',
  params: [
    { k: 'enum', name: 'srcR', label: 'Red from', options: CHAN_SRC, def: 0, group: 'Red' },
    { k: 'float', name: 'gainR', label: 'Red gain', def: 1, min: -2, max: 4, group: 'Red' },
    { k: 'enum', name: 'srcG', label: 'Green from', options: CHAN_SRC, def: 1, group: 'Green' },
    { k: 'float', name: 'gainG', label: 'Green gain', def: 1, min: -2, max: 4, group: 'Green' },
    { k: 'enum', name: 'srcB', label: 'Blue from', options: CHAN_SRC, def: 2, group: 'Blue' },
    { k: 'float', name: 'gainB', label: 'Blue gain', def: 1, min: -2, max: 4, group: 'Blue' },
    { k: 'enum', name: 'srcA', label: 'Alpha from', options: CHAN_SRC, def: 3, group: 'Alpha' },
    { k: 'float', name: 'gainA', label: 'Alpha gain', def: 1, min: -2, max: 4, group: 'Alpha' },
  ],
  body: /* wgsl */`
fn chanmix_pick(s: i32, ca: vec4f, cb: vec4f) -> f32 {
  switch (s) {
    case 0 { return ca.r; }
    case 1 { return ca.g; }
    case 2 { return ca.b; }
    case 3 { return ca.a; }
    case 4 { return luma(ca.rgb); }
    case 6 { return 1.0; }
    case 7 { return cb.r; }
    case 8 { return cb.g; }
    case 9 { return cb.b; }
    case 10 { return cb.a; }
    case 11 { return luma(cb.rgb); }
    default { return 0.0; }
  }
}
fn op(uv: vec2f) -> vec4f {
  let ca = textureSampleLevel(src, smp, uv, 0.0);
  let cb = textureSampleLevel(b, smp, uv, 0.0);
  return vec4f(chanmix_pick(u.srcR, ca, cb) * u.gainR, chanmix_pick(u.srcG, ca, cb) * u.gainG,
               chanmix_pick(u.srcB, ca, cb) * u.gainB, chanmix_pick(u.srcA, ca, cb) * u.gainA);
}`,
};

const lumakey: OpDef = {
  type: 'lumakey', label: 'Luma Key', category: 'Color', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }],
  help: 'Keeps pixels whose perceptual luma lies between Low and High, writing the result to alpha.',
  params: [
    { k: 'float', name: 'low', def: 0.15, min: 0, max: 1 },
    { k: 'float', name: 'high', def: 1.2, min: 0, max: 2, help: 'Above 1 keeps HDR highlights.' },
    { k: 'float', name: 'softness', def: 0.08, min: 0, max: 0.5 },
    { k: 'bool', name: 'invert', def: false },
    { k: 'bool', name: 'premult', label: 'Premultiply', def: false },
  ],
  body: /* wgsl */`
fn op(uv: vec2f) -> vec4f {
  let c = textureSampleLevel(src, smp, uv, 0.0);
  let l = pow(max(luma(c.rgb), 0.0), 1.0 / 2.2);
  let s = max(u.softness, 1e-4);
  var k = smoothstep(u.low - s, u.low + s, l) * (1.0 - smoothstep(u.high - s, u.high + s, l));
  if (u.invert == 1) { k = 1.0 - k; }
  let a = c.a * k;
  return vec4f(select(c.rgb, c.rgb * a, u.premult == 1), a);
}`,
};

const chromakey: OpDef = {
  type: 'chromakey', label: 'Chroma Key', category: 'Color', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }],
  help: 'Keys by distance from the key colour in the CbCr plane (gamma-encoded BT.709 YCbCr), so brightness changes on the screen do not matter. Spill removes key-coloured chroma while keeping luma. Outputs straight alpha.',
  params: [
    { k: 'color', name: 'key', def: [0, 1, 0, 1] },
    { k: 'float', name: 'tolerance', def: 0.2, min: 0, max: 1 },
    { k: 'float', name: 'softness', def: 0.1, min: 0, max: 0.5 },
    { k: 'float', name: 'spill', def: 0.6, min: 0, max: 1 },
  ],
  body: /* wgsl */`${perc('chromakey')}
fn chromakey_ycc(c: vec3f) -> vec3f {
  let y = luma(c);
  return vec3f(y, (c.b - y) / 1.8556, (c.r - y) / 1.5748);
}
fn chromakey_rgb(y: f32, cc: vec2f) -> vec3f {
  let r = y + 1.5748 * cc.y;
  let bl = y + 1.8556 * cc.x;
  return vec3f(r, (y - 0.2126 * r - 0.0722 * bl) / 0.7152, bl);
}
fn op(uv: vec2f) -> vec4f {
  let c = textureSampleLevel(src, smp, uv, 0.0);
  let p = chromakey_ycc(chromakey_enc(c.rgb));
  let q = chromakey_ycc(chromakey_enc(u.key.rgb));
  let d = distance(p.yz, q.yz);
  let k = smoothstep(u.tolerance, u.tolerance + max(u.softness, 1e-4), d);
  let kl = length(q.yz);
  var cc = p.yz;
  if (kl > 1e-4) {
    let kd = q.yz / kl;
    cc -= kd * max(dot(cc, kd), 0.0) * u.spill;
  }
  return vec4f(chromakey_dec(chromakey_rgb(p.x, cc)), c.a * k);
}`,
};

const tonemap: OpDef = {
  type: 'tonemap', label: 'Tonemap', category: 'Color', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }],
  help: 'Compresses HDR into display range. White point is the scene value mapped to 1 (ignored by None). Output stays linear; Gamut clamp desaturates out-of-range colours into 0..1.',
  params: [
    { k: 'enum', name: 'curve', label: 'Operator', options: ['None', 'Reinhard', 'ACES', 'Filmic (Hable)', 'AgX'], def: 2 },
    { k: 'float', name: 'exposure', def: 0, min: -6, max: 6, unit: 'EV' },
    { k: 'float', name: 'white', label: 'White point', def: 6, min: 1, max: 32 },
    { k: 'bool', name: 'clampGamut', label: 'Gamut clamp', def: true },
  ],
  body: /* wgsl */`
const tonemap_agxIn = mat3x3f(0.842479062253094, 0.0423282422610123, 0.0423756549057051,
  0.0784335999999992, 0.878468636469772, 0.0784336,
  0.0792237451477643, 0.0791661274605434, 0.879142973793104);
const tonemap_agxOut = mat3x3f(1.19687900512017, -0.0528968517574562, -0.0529716355144438,
  -0.0980208811401368, 1.15190312990417, -0.0980434501171241,
  -0.0990297440797205, -0.0989611768448433, 1.15107367264116);
fn tonemap_aces(x: vec3f) -> vec3f {
  let v = x * 0.6;
  return (v * (2.51 * v + 0.03)) / (v * (2.43 * v + 0.59) + 0.14);
}
fn tonemap_hable(x: vec3f) -> vec3f {
  let A = 0.15; let B = 0.5; let C = 0.1; let D = 0.2; let E = 0.02; let F = 0.3;
  return ((x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F)) - E / F;
}
// AgX base curve; returns display-encoded values
fn tonemap_agx(c: vec3f) -> vec3f {
  let lo = -12.47393; let hi = 4.026069;
  var x = tonemap_agxIn * max(c, vec3f(1e-10));
  x = (clamp(log2(x), vec3f(lo), vec3f(hi)) - lo) / (hi - lo);
  let x2 = x * x; let x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
fn op(uv: vec2f) -> vec4f {
  let c = textureSampleLevel(src, smp, uv, 0.0);
  let x = max(c.rgb, vec3f(0.0)) * exp2(u.exposure);
  let w = max(u.white, 1.0);
  var y = x;
  switch (u.curve) {
    case 1 { y = x * (1.0 + x / (w * w)) / (1.0 + x); }
    case 2 { y = tonemap_aces(x) / tonemap_aces(vec3f(w)); }
    case 3 { y = tonemap_hable(x * 2.0) / tonemap_hable(vec3f(w * 2.0)); }
    case 4 {
      let e = tonemap_agxOut * (tonemap_agx(x) / tonemap_agx(vec3f(w)).x);
      y = pow(max(e, vec3f(0.0)), vec3f(2.2));
    }
    default {}
  }
  if (u.clampGamut == 1) {
    let l = clamp(luma(y), 0.0, 1.0);
    let lo = min(y.r, min(y.g, y.b));
    if (lo < 0.0) { y = l + (y - l) * l / (l - lo + 1e-6); }
    let hi = max(y.r, max(y.g, y.b));
    if (hi > 1.0) { y = l + (y - l) * (1.0 - l) / (hi - l + 1e-6); }
    y = clamp(y, vec3f(0.0), vec3f(1.0));
  }
  return vec4f(y, c.a);
}`,
};

const colorama: OpDef = {
  type: 'colorama', label: 'Colorama', category: 'Color', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }],
  help: 'Psychedelic colour cycling: a phase taken from luma, hue, radius or angle drives a cosine palette that rotates over time.',
  params: [
    { k: 'enum', name: 'source', label: 'Phase from', options: ['Luma', 'Hue', 'Radius', 'Angle'], def: 0 },
    { k: 'float', name: 'frequency', def: 2, min: 0, max: 16 },
    { k: 'float', name: 'phase', def: 0, min: 0, max: 1 },
    { k: 'float', name: 'speed', def: 0.25, min: -4, max: 4, unit: '/s' },
    { k: 'float', name: 'amount', label: 'Mix', def: 1, min: 0, max: 1 },
    ...PALETTE_PARAMS,
  ],
  body: /* wgsl */`${srgb('colorama')}
fn op(uv: vec2f) -> vec4f {
  let c = textureSampleLevel(src, smp, uv, 0.0);
  let p = centered(uv);
  var t: f32;
  switch (u.source) {
    case 1 { t = rgb2hsv(max(c.rgb, vec3f(0.0))).x; }
    case 2 { t = length(p); }
    case 3 { t = atan2(p.y, p.x) / TAU + 0.5; }
    default { t = pow(max(luma(c.rgb), 0.0), 1.0 / 2.2); }
  }
  let col = colorama_pal(t * u.frequency + u.phase + g.time * u.speed);
  return vec4f(mix(c.rgb, col, u.amount), c.a);
}`,
};

const duotone: OpDef = {
  type: 'duotone', label: 'Duotone', category: 'Color', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }],
  help: 'Maps perceptual luma between a shadow and highlight colour, optionally through a midtone. HDR overs scale the highlight.',
  params: [
    { k: 'color', name: 'shadow', def: [0.08, 0.05, 0.3, 1] },
    { k: 'color', name: 'highlight', def: [1, 0.82, 0.55, 1] },
    { k: 'bool', name: 'useMid', label: 'Use midtone', def: false },
    { k: 'color', name: 'midtone', def: [0.85, 0.2, 0.5, 1] },
    { k: 'float', name: 'contrast', def: 1.2, min: 0, max: 4 },
    { k: 'float', name: 'amount', label: 'Mix', def: 1, min: 0, max: 1 },
  ],
  body: /* wgsl */`
fn op(uv: vec2f) -> vec4f {
  let c = textureSampleLevel(src, smp, uv, 0.0);
  let l = max(luma(c.rgb), 0.0);
  let t = sat((pow(l, 1.0 / 2.2) - 0.5) * u.contrast + 0.5);
  var col = mix(u.shadow.rgb, u.highlight.rgb, t);
  if (u.useMid == 1) {
    col = select(mix(u.midtone.rgb, u.highlight.rgb, t * 2.0 - 1.0), mix(u.shadow.rgb, u.midtone.rgb, t * 2.0), t < 0.5);
  }
  col *= max(l, 1.0);
  return vec4f(mix(c.rgb, col, u.amount), c.a);
}`,
};

const vignette: OpDef = {
  type: 'vignette', label: 'Vignette', category: 'Color', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }],
  help: 'Darkens (or tints) toward the edges. Radius is in half-heights from the centre; roundness 1 = circle, 0 = follows the frame shape.',
  params: [
    { k: 'float', name: 'amount', def: 0.6, min: 0, max: 1 },
    { k: 'float', name: 'radius', def: 0.7, min: 0, max: 2 },
    { k: 'float', name: 'softness', def: 0.8, min: 0.001, max: 2 },
    { k: 'float', name: 'roundness', def: 0.5, min: 0, max: 1 },
    { k: 'vec2', name: 'center', def: [0, 0], min: -1, max: 1 },
    { k: 'color', name: 'color', def: [0, 0, 0, 1] },
  ],
  body: /* wgsl */`
fn op(uv: vec2f) -> vec4f {
  let c = textureSampleLevel(src, smp, uv, 0.0);
  let p = centered(uv) - u.center;
  let d = length(mix(p / vec2f(g.aspect, 1.0), p, u.roundness));
  let k = smoothstep(u.radius, u.radius + u.softness, d) * u.amount * u.color.a;
  return vec4f(mix(c.rgb, u.color.rgb, k), c.a);
}`,
};

const exposure: OpDef = {
  type: 'exposure', label: 'Exposure', category: 'Color', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }],
  help: 'Exposure in stops, then offset, then gamma. Minimal and fast.',
  params: [
    { k: 'float', name: 'stops', label: 'Exposure', def: 0.5, min: -8, max: 8, unit: 'EV' },
    { k: 'float', name: 'offset', def: 0, min: -1, max: 1 },
    { k: 'float', name: 'gamma', def: 1, min: 0.1, max: 4 },
  ],
  body: /* wgsl */`
fn op(uv: vec2f) -> vec4f {
  let c = textureSampleLevel(src, smp, uv, 0.0);
  let x = max(c.rgb * exp2(u.stops) + u.offset, vec3f(0.0));
  return vec4f(pow(x, vec3f(1.0 / max(u.gamma, 0.01))), c.a);
}`,
};

const alpha: OpDef = {
  type: 'alpha', label: 'Alpha Ops', category: 'Color', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }, { name: 'matte', type: 'tex', optional: true }],
  help: 'Alpha utilities. Value is the constant alpha for Set constant and a gain for the luma and matte modes (luma is perceptual).',
  params: [
    { k: 'enum', name: 'mode', options: ['Premultiply', 'Unpremultiply', 'Set from luma', 'Set constant', 'Invert', 'Multiply by matte'], def: 0 },
    { k: 'float', name: 'value', def: 1, min: 0, max: 4 },
  ],
  body: /* wgsl */`
fn op(uv: vec2f) -> vec4f {
  let c = textureSampleLevel(src, smp, uv, 0.0);
  switch (u.mode) {
    case 0 { return vec4f(c.rgb * c.a, c.a); }
    case 1 { return vec4f(select(c.rgb, c.rgb / c.a, c.a > 1e-5), c.a); }
    case 2 { return vec4f(c.rgb, sat(pow(max(luma(c.rgb), 0.0), 1.0 / 2.2) * u.value)); }
    case 3 { return vec4f(c.rgb, u.value); }
    case 4 { return vec4f(c.rgb, 1.0 - c.a); }
    default {
      if (u.has_matte < 0.5) { return c; }
      let m = luma(textureSampleLevel(matte, smp, uv, 0.0).rgb);
      return vec4f(c.rgb, c.a * sat(m * u.value));
    }
  }
}`,
};

export const ops: OpDef[] = [hsv, grade, invert, threshold, posterize, gradmap, chanmix, lumakey, chromakey, tonemap,
  colorama, duotone, vignette, exposure, alpha];
