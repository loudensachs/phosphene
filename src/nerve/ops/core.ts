// NERVE core operators — also the reference implementations for the operator guide (docs/OPS_GUIDE.md).
import type { OpDef } from '../types';

const noise: OpDef = {
  type: 'noise', label: 'Noise', category: 'Generate', inputs: [], output: 'tex',
  help: 'Animated fractal simplex noise. Mono, or decorrelated RGB.',
  params: [
    { k: 'float', name: 'scale', def: 3, min: 0.1, max: 40 },
    { k: 'int', name: 'octaves', def: 4, min: 1, max: 8 },
    { k: 'float', name: 'lacunarity', def: 2, min: 1, max: 4 },
    { k: 'float', name: 'gain', def: 0.5, min: 0, max: 1 },
    { k: 'float', name: 'speed', def: 0.2, min: 0, max: 4 },
    { k: 'vec2', name: 'offset', def: [0, 0], min: -10, max: 10 },
    { k: 'float', name: 'contrast', def: 1, min: 0, max: 4 },
    { k: 'bool', name: 'color', def: false },
  ],
  body: /* wgsl */`
fn op(uv: vec2f) -> vec4f {
  let p = vec3f(centered(uv) * u.scale * 0.5 + u.offset, g.time * u.speed);
  var c: vec3f;
  if (u.color == 1) {
    c = vec3f(fbm(p, u.octaves, u.lacunarity, u.gain),
              fbm(p + vec3f(31.7, 11.3, 5.1), u.octaves, u.lacunarity, u.gain),
              fbm(p + vec3f(-17.2, 47.9, 9.4), u.octaves, u.lacunarity, u.gain));
  } else {
    c = vec3f(fbm(p, u.octaves, u.lacunarity, u.gain));
  }
  c = (c * u.contrast) * 0.5 + 0.5;
  return vec4f(max(c, vec3f(0.0)), 1.0);
}`,
};

const BLUR_BODY = /* wgsl */`
fn op(uv: vec2f) -> vec4f {
  // radius is a fraction of image height, so the look is resolution independent
  let rpx = u.radius * g.res.y;
  if (rpx < 0.25) { return textureSampleLevel(src, smp, uv, 0.0); }
  let taps = 24.0;
  let stride = max(1.0, rpx / taps);
  let sigma = rpx * 0.5;
  let px = u.dir / g.res;
  var acc = vec4f(0.0); var wsum = 0.0;
  for (var i = -taps; i <= taps; i += 1.0) {
    let d = i * stride;
    let w = exp(-0.5 * d * d / (sigma * sigma));
    acc += textureSampleLevel(src, smp, uv + px * d, 0.0) * w;
    wsum += w;
  }
  return acc / wsum;
}`;

const blur: OpDef = {
  type: 'blur', label: 'Blur', category: 'Filter', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }],
  help: 'Separable gaussian blur. Radius is a fraction of image height.',
  params: [
    { k: 'float', name: 'radius', def: 0.02, min: 0, max: 0.5, step: 0.001 },
    { k: 'vec2', name: 'aspect', label: 'X / Y', def: [1, 1], min: 0, max: 4 },
    { k: 'int', name: 'passes', def: 1, min: 1, max: 4 },
  ],
  passes: {
    blur: { inputs: ['src'], fields: [['radius', 'f32'], ['dir', 'vec2f']], body: BLUR_BODY },
  },
  cook(c) {
    const tmp = c.tex('tmp');
    let src = c.ins[0];
    const n = Math.max(1, c.p.passes);
    const r = c.p.radius / Math.sqrt(n);
    for (let i = 0; i < n; i++) {
      c.run('blur', tmp.view, [src], { radius: r * c.p.aspect[0], dir: [1, 0] });
      // intermediate iterations ping-pong through a second scratch texture
      const dst = i === n - 1 ? c.out : c.tex('tmp2').view;
      c.run('blur', dst, [tmp.view], { radius: r * c.p.aspect[1], dir: [0, 1] });
      src = dst;
    }
  },
};

const BLEND_MODES = ['Over', 'Add', 'Screen', 'Multiply', 'Overlay', 'Soft Light', 'Hard Light', 'Difference', 'Exclusion',
  'Lighten', 'Darken', 'Color Dodge', 'Color Burn', 'Subtract', 'Divide', 'Hue', 'Saturation', 'Color', 'Luminosity', 'Stencil', 'Silhouette'];

const composite: OpDef = {
  type: 'comp', label: 'Composite', category: 'Composite', output: 'tex',
  inputs: [{ name: 'a', type: 'tex' }, { name: 'b', type: 'tex' }, { name: 'mask', type: 'tex', optional: true }],
  help: 'Blend B over A. Optional mask (luma) limits where B applies.',
  params: [
    { k: 'enum', name: 'mode', options: BLEND_MODES, def: 0 },
    { k: 'float', name: 'opacity', def: 1, min: 0, max: 1 },
    { k: 'bool', name: 'premult', label: 'B premultiplied', def: false },
    { k: 'bool', name: 'invertMask', label: 'Invert mask', def: false },
  ],
  body: /* wgsl */`
fn setLum(c: vec3f, l: f32) -> vec3f {
  var r = c + (l - luma(c));
  let lo = min(r.x, min(r.y, r.z)); let hi = max(r.x, max(r.y, r.z)); let ll = luma(r);
  if (lo < 0.0) { r = ll + (r - ll) * ll / (ll - lo + 1e-6); }
  if (hi > 1.0) { r = ll + (r - ll) * (1.0 - ll) / (hi - ll + 1e-6); }
  return r;
}
fn setSat(c: vec3f, s: f32) -> vec3f { let h = rgb2hsv(c); return hsv2rgb(vec3f(h.x, s, h.z)); }
fn blend(m: i32, a: vec3f, b: vec3f) -> vec3f {
  switch (m) {
    case 1 { return a + b; }
    case 2 { return a + b - a * b; }
    case 3 { return a * b; }
    case 4 { return select(1.0 - 2.0 * (1.0 - a) * (1.0 - b), 2.0 * a * b, a < vec3f(0.5)); }
    case 5 { return (1.0 - 2.0 * b) * a * a + 2.0 * b * a; }
    case 6 { return select(1.0 - 2.0 * (1.0 - a) * (1.0 - b), 2.0 * a * b, b < vec3f(0.5)); }
    case 7 { return abs(a - b); }
    case 8 { return a + b - 2.0 * a * b; }
    case 9 { return max(a, b); }
    case 10 { return min(a, b); }
    case 11 { return a / max(1.0 - b, vec3f(1e-4)); }
    case 12 { return 1.0 - (1.0 - a) / max(b, vec3f(1e-4)); }
    case 13 { return a - b; }
    case 14 { return a / max(b, vec3f(1e-4)); }
    case 15 { return setLum(setSat(b, rgb2hsv(a).y), luma(a)); }
    case 16 { return setLum(setSat(a, rgb2hsv(b).y), luma(a)); }
    case 17 { return setLum(b, luma(a)); }
    case 18 { return setLum(a, luma(b)); }
    default { return b; }
  }
}
fn op(uv: vec2f) -> vec4f {
  let ca = textureSampleLevel(a, smp, uv, 0.0);
  var cb = textureSampleLevel(b, smp, uv, 0.0);
  if (u.premult == 1 && cb.a > 1e-5) { cb = vec4f(cb.rgb / cb.a, cb.a); }
  var k = u.opacity * sat(cb.a);
  if (u.has_mask > 0.5) {
    var m = luma(textureSampleLevel(mask, smp, uv, 0.0).rgb);
    if (u.invertMask == 1) { m = 1.0 - m; }
    k *= sat(m);
  }
  if (u.mode == 19) { return ca * (1.0 - k); }          // stencil: B cuts A
  if (u.mode == 20) { return ca * k; }                   // silhouette: A inside B
  let c = blend(u.mode, ca.rgb, cb.rgb);
  return vec4f(mix(ca.rgb, c, k), max(ca.a, k));
}`,
};

const transform: OpDef = {
  type: 'transform', label: 'Transform', category: 'Distort', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }],
  params: [
    { k: 'vec2', name: 'translate', def: [0, 0], min: -2, max: 2, step: 0.001 },
    { k: 'float', name: 'rotate', def: 0, min: -360, max: 360, unit: '°' },
    { k: 'float', name: 'scale', def: 1, min: 0.01, max: 10 },
    { k: 'vec2', name: 'stretch', def: [1, 1], min: 0.01, max: 10 },
    { k: 'vec2', name: 'pivot', def: [0, 0], min: -1, max: 1 },
    { k: 'enum', name: 'edge', options: ['Transparent', 'Clamp', 'Repeat', 'Mirror'], def: 0 },
  ],
  body: /* wgsl */`
fn op(uv: vec2f) -> vec4f {
  var p = centered(uv) - u.translate - u.pivot;
  p = rot(-radians(u.rotate)) * p;
  p = p / (u.scale * u.stretch) + u.pivot;
  var q = uncentered(p);
  if (u.edge == 0) {
    if (q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0) { return vec4f(0.0); }
  } else if (u.edge == 2) { q = fract(q); }
  else if (u.edge == 3) { q = 1.0 - abs(fract(q * 0.5) * 2.0 - 1.0); }
  return textureSampleLevel(src, smp, q, 0.0);
}`,
};

const levels: OpDef = {
  type: 'levels', label: 'Levels', category: 'Color', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }],
  params: [
    { k: 'float', name: 'inBlack', label: 'In black', def: 0, min: 0, max: 1 },
    { k: 'float', name: 'inWhite', label: 'In white', def: 1, min: 0, max: 2 },
    { k: 'float', name: 'gamma', def: 1, min: 0.1, max: 4 },
    { k: 'float', name: 'outBlack', label: 'Out black', def: 0, min: 0, max: 1 },
    { k: 'float', name: 'outWhite', label: 'Out white', def: 1, min: 0, max: 4 },
    { k: 'float', name: 'opacity', label: 'Alpha gain', def: 1, min: 0, max: 1 },
  ],
  body: /* wgsl */`
fn op(uv: vec2f) -> vec4f {
  let c = textureSampleLevel(src, smp, uv, 0.0);
  var x = max((c.rgb - u.inBlack) / max(u.inWhite - u.inBlack, 1e-5), vec3f(0.0));
  x = pow(x, vec3f(1.0 / u.gamma));
  return vec4f(mix(vec3f(u.outBlack), vec3f(u.outWhite), x), c.a * u.opacity);
}`,
};

const feedback: OpDef = {
  type: 'feedback', label: 'Feedback', category: 'Time', output: 'tex', animated: true,
  inputs: [{ name: 'init', type: 'tex', optional: true }],
  help: 'Outputs the previous frame of the node named in Source. Build a loop: Feedback → effects → Composite, then point Source at the end of the chain.',
  params: [
    { k: 'string', name: 'source', def: '', help: 'Name of the node to read back one frame late.' },
    { k: 'bool', name: 'hold', def: false, help: 'Freeze the loop contents.' },
  ],
  cook(c) {
    const prev = c.tex('prev');
    if (prev.fresh || c.reset) {
      if (c.inTex[0]) c.copy(c.inTex[0], prev.tex); else c.clear(prev.view);
    }
    c.copy(prev.tex, c.outTex);
  },
  post(c) {
    if (c.p.hold) return;
    const src = c.ref(c.p.source);
    if (src) c.copy(src.tex, c.tex('prev').tex);
  },
};

const out: OpDef = {
  type: 'out', label: 'Out', category: 'IO', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }],
  help: 'Final picture. This is what the output window shows and what export renders.',
  params: [],
  body: /* wgsl */`fn op(uv: vec2f) -> vec4f { return textureSampleLevel(src, smp, uv, 0.0); }`,
};

const nullOp: OpDef = {
  type: 'null', label: 'Null', category: 'IO', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }],
  help: 'Pass-through. Useful as a named tap for Feedback sources and tidy routing.',
  params: [],
  body: /* wgsl */`fn op(uv: vec2f) -> vec4f { return textureSampleLevel(src, smp, uv, 0.0); }`,
};

const PASS = /* wgsl */`fn op(uv: vec2f) -> vec4f { return textureSampleLevel(src, smp, uv, 0.0); }`;
const globalSet: OpDef = {
  type: 'global', label: 'Global', category: 'IO', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }],
  keywords: 'send variable broadcast share wireless portal bus',
  help: 'Makes a picture available everywhere under this operator\'s name. Read it anywhere with Get Global, without running a wire across the network.',
  params: [],
  body: PASS,
};
const globalGet: OpDef = {
  type: 'getglobal', label: 'Get Global', category: 'IO', output: 'tex', refInput: 'global',
  inputs: [],
  keywords: 'receive variable reference wireless portal bus',
  help: 'Outputs the picture of a Global operator, in the same frame. Pick which one below.',
  params: [{ k: 'string', name: 'global', def: '', help: 'The Global operator to read.' }],
  passes: { main: { inputs: ['src'], fields: [], body: PASS } },
  cook(c) {
    if (!c.ins[0]) { c.clear(c.out); if (c.p.global) throw new Error(`No Global named "${c.p.global}"`); return; }
    c.run('main', c.out, [c.ins[0]], {});
  },
};

export const ops: OpDef[] = [noise, blur, composite, transform, levels, feedback, out, nullOp, globalSet, globalGet];
