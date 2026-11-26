// NERVE signature operators: motion-vector datamosh, codec emulation, frame-history time effects,
// sorting, simulation, databending and the live shader operator.
import type { CookCtx, OpDef, PassDecl } from '../types';

// ------------------------------------------------------------------------------------------------
// Optical flow (shared by Flow and Datamosh): coarse-to-fine Lucas–Kanade on luma.
// Output is motion in uv units per frame: cur(p) ≈ prev(p - flow).
// ------------------------------------------------------------------------------------------------
const FLOW_PASSES: Record<string, PassDecl> = {
  fl_luma: {
    inputs: ['src'],
    body: `fn op(uv: vec2f) -> vec4f {
  let px = 1.0 / g.res;
  var s = 0.0;
  for (var j = -1; j <= 1; j++) { for (var i = -1; i <= 1; i++) {
    s += sqrt(max(luma(textureSampleLevel(src, smp, uv + vec2f(f32(i), f32(j)) * px, 0.0).rgb), 0.0));
  } }
  return vec4f(s / 9.0, 0.0, 0.0, 1.0);
}`,
  },
  fl_lk: {
    inputs: ['cur', 'prev', 'init'], fields: [['useInit', 'f32']],
    body: `fn op(uv: vec2f) -> vec4f {
  let px = 1.0 / g.res;
  var f0 = vec2f(0.0);
  if (u.useInit > 0.5) { f0 = textureSampleLevel(init, smp, uv, 0.0).rg; }
  var a11 = 0.0; var a12 = 0.0; var a22 = 0.0; var b1 = 0.0; var b2 = 0.0;
  for (var j = -2; j <= 2; j++) { for (var i = -2; i <= 2; i++) {
    let p = uv + vec2f(f32(i), f32(j)) * px;
    let ix = (textureSampleLevel(cur, smp, p + vec2f(px.x, 0.0), 0.0).r - textureSampleLevel(cur, smp, p - vec2f(px.x, 0.0), 0.0).r) * 0.5;
    let iy = (textureSampleLevel(cur, smp, p + vec2f(0.0, px.y), 0.0).r - textureSampleLevel(cur, smp, p - vec2f(0.0, px.y), 0.0).r) * 0.5;
    let it = textureSampleLevel(cur, smp, p, 0.0).r - textureSampleLevel(prev, smp, p - f0, 0.0).r;
    a11 += ix * ix; a12 += ix * iy; a22 += iy * iy; b1 += ix * it; b2 += iy * it;
  } }
  // Tikhonov term keeps flat regions at zero instead of exploding
  a11 += 2e-4; a22 += 2e-4;
  let det = a11 * a22 - a12 * a12;
  var d = -vec2f(a22 * b1 - a12 * b2, a11 * b2 - a12 * b1) / det;
  d = clamp(d, vec2f(-3.0), vec2f(3.0));
  return vec4f(f0 + d * px, 0.0, 1.0);
}`,
  },
  fl_out: {
    inputs: ['flow', 'last'], fields: [['gain', 'f32'], ['smth', 'f32'], ['blur', 'f32']],
    body: `fn op(uv: vec2f) -> vec4f {
  let r = u.blur * vec2f(1.0 / g.aspect, 1.0);
  var f = vec2f(0.0);
  if (u.blur > 1e-5) {
    for (var j = -2; j <= 2; j++) { for (var i = -2; i <= 2; i++) { f += textureSampleLevel(flow, smp, uv + vec2f(f32(i), f32(j)) * r * 0.5, 0.0).rg; } }
    f /= 25.0;
  } else { f = textureSampleLevel(flow, smp, uv, 0.0).rg; }
  f *= u.gain;
  let l = textureSampleLevel(last, smp, uv, 0.0).rg;
  return vec4f(mix(f, l, u.smth), 0.0, 1.0);
}`,
  },
  fl_copy: { inputs: ['src'], body: `fn op(uv: vec2f) -> vec4f { return textureSampleLevel(src, smp, uv, 0.0); }` },
};

/** Estimate motion of `src` against the previous call. Returns a view of raw flow (uv units/frame) at 1/4 res. */
function computeFlow(c: CookCtx, src: GPUTextureView | null): GPUTextureView {
  const levels = [16, 8, 4];
  let init: GPUTextureView | null = null;
  for (let i = 0; i < levels.length; i++) {
    const s = levels[i], w = Math.max(8, c.w / s), h = Math.max(8, c.h / s);
    const cur = c.tex(`flc${s}`, w, h), prev = c.tex(`flp${s}`, w, h), fl = c.tex(`flf${s}`, w, h);
    c.run('fl_luma', cur.view, [src], {}, [cur.tex.width, cur.tex.height]);
    if (prev.fresh || c.reset) c.copy(cur.tex, prev.tex);
    c.run('fl_lk', fl.view, [cur.view, prev.view, init], { useInit: init ? 1 : 0 }, [cur.tex.width, cur.tex.height]);
    init = fl.view;
  }
  return init!;
}
/** Call after the flow has been consumed: current luma becomes "previous" for the next frame. */
function commitFlow(c: CookCtx) {
  for (const s of [16, 8, 4]) {
    const w = Math.max(8, c.w / s), h = Math.max(8, c.h / s);
    c.copy(c.tex(`flc${s}`, w, h).tex, c.tex(`flp${s}`, w, h).tex);
  }
}

const flow: OpDef = {
  type: 'flow', label: 'Optical Flow', category: 'Field', output: 'field', animated: true,
  inputs: [{ name: 'src', type: 'tex' }],
  help: 'Measures how every part of the picture moved since the last frame and outputs it as a vector field. Feed it to Datamosh, Field Warp, Displace or Pixel Sort.',
  params: [
    { k: 'float', name: 'gain', def: 40, min: 0, max: 200, help: 'Scales motion (uv per frame) into a usable field strength.' },
    { k: 'float', name: 'smooth', label: 'Temporal smooth', def: 0.3, min: 0, max: 0.98 },
    { k: 'float', name: 'blur', label: 'Spatial blur', def: 0.01, min: 0, max: 0.1, step: 0.001 },
  ],
  passes: FLOW_PASSES,
  cook(c) {
    const raw = computeFlow(c, c.ins[0]);
    const last = c.tex('last');
    c.run('fl_out', c.out, [raw, last.view], { gain: c.p.gain, smth: last.fresh || c.reset ? 0 : c.p.smooth, blur: c.p.blur });
    c.copy(c.outTex, last.tex);
    commitFlow(c);
  },
};

// ------------------------------------------------------------------------------------------------
// Datamosh: push the previous output along the current motion (what a P-frame does), and only let
// real picture back in where and when you choose (what an I-frame does).
// ------------------------------------------------------------------------------------------------
const datamosh: OpDef = {
  type: 'datamosh', label: 'Datamosh', category: 'Glitch', output: 'tex', animated: true,
  inputs: [{ name: 'src', type: 'tex' }, { name: 'motion', type: 'tex', optional: true }, { name: 'flow', type: 'field', optional: true }],
  help: 'True motion-vector datamosh in float precision. The picture is carried by motion instead of being redrawn; raise Refresh or fire Keyframe to let the real image back in. Connect Motion to mosh this picture with another clip\'s movement.',
  params: [
    { k: 'float', name: 'amount', label: 'Motion', def: 1, min: 0, max: 4, help: 'How far pixels are carried by the detected motion.' },
    { k: 'float', name: 'refresh', def: 0.02, min: 0, max: 1, step: 0.001, help: 'How much of the real frame leaks back in each frame. 0 = never heal.' },
    { k: 'float', name: 'threshold', def: 0.35, min: 0, max: 2, help: 'Refresh only where the mosh has drifted further than this from the real picture.' },
    { k: 'float', name: 'keyframe', def: 0, min: 0, max: 1, help: 'Above 0.5 forces a clean frame. Drive it with kick or a Shaper to mosh between beats.' },
    { k: 'int', name: 'interval', label: 'Key interval', def: 0, min: 0, max: 600, help: 'Automatic clean frame every N frames. 0 = never.' },
    { k: 'float', name: 'block', label: 'Block size', def: 0.03, min: 0, max: 0.2, step: 0.001, help: 'Macroblock size as a fraction of height. 0 = per-pixel (smooth, liquid).' },
    { k: 'float', name: 'smear', def: 0, min: 0, max: 1, help: 'Motion persistence: vectors keep pushing after movement stops.' },
    { k: 'float', name: 'chroma', label: 'Chroma drift', def: 0, min: 0, max: 1, help: 'Carry colour further than brightness, like subsampled chroma planes.' },
    { k: 'float', name: 'freeze', label: 'Vector freeze', def: 0, min: 0, max: 1, group: 'Kinds', help: 'Hold the motion vectors instead of updating them, like duplicated P-frames: the picture keeps streaming the way it was last moving (bloom mosh).' },
    { k: 'float', name: 'residual', def: 0, min: 0, max: 3, group: 'Kinds', help: 'Add each frame\'s change on top of the carried picture, as a decoder does without a keyframe: moving edges burn ghost outlines into the old image.' },
    { k: 'float', name: 'drift', label: 'Global drift', def: 0, min: -1, max: 1, group: 'Kinds', help: 'Push everything sideways a little every frame while moshing, so held pictures slide and tear.' },
    { k: 'float', name: 'driftAngle', label: 'Drift angle', def: 90, min: -180, max: 180, unit: '°', group: 'Kinds' },
  ],
  passes: {
    ...FLOW_PASSES,
    dm_vec: {
      inputs: ['flow', 'last'], fields: [['amount', 'f32'], ['smear', 'f32'], ['block', 'f32'], ['ext', 'f32'], ['freeze', 'f32'], ['drift', 'vec2f']],
      body: `fn op(uv: vec2f) -> vec4f {
  var q = uv;
  if (u.block > 1e-4) { let bs = vec2f(u.block / g.aspect, u.block); q = (floor(uv / bs) + 0.5) * bs; }
  var f = textureSampleLevel(flow, smp, q, 0.0).rg;
  if (u.ext > 0.5) { f = f / 40.0; }   // external fields arrive with Optical Flow's default gain
  f *= u.amount;
  let l = textureSampleLevel(last, smp, q, 0.0).rg;
  let live = mix(f, select(l, f, length(f) > length(l)), u.smear) + u.drift;
  return vec4f(mix(live, l, u.freeze), 0.0, 1.0);
}`,
    },
    dm_mosh: {
      inputs: ['acc', 'src', 'vec', 'lsrc'], fields: [['refresh', 'f32'], ['threshold', 'f32'], ['key', 'f32'], ['chroma', 'f32'], ['residual', 'f32']],
      body: `fn op(uv: vec2f) -> vec4f {
  let cur = textureSampleLevel(src, smp, uv, 0.0);
  if (u.key > 0.5) { return cur; }
  let f = textureSampleLevel(vec, smpN, uv, 0.0).rg;
  var prev = textureSampleLevel(acc, smp, uv - f, 0.0);
  if (u.chroma > 0.0) {
    let far = textureSampleLevel(acc, smp, uv - f * (1.0 + u.chroma * 3.0), 0.0);
    let y = luma(prev.rgb);
    prev = vec4f(far.rgb - luma(far.rgb) + y, prev.a);
  }
  if (u.residual > 0.0) { prev = vec4f(max(prev.rgb + (cur.rgb - textureSampleLevel(lsrc, smp, uv, 0.0).rgb) * u.residual, vec3f(0.0)), prev.a); }
  // nothing to carry where the history is emptier than the picture (start of a clip, after a seek)
  if (prev.a < cur.a * 0.5) { return cur; }
  let d = length(cur.rgb - prev.rgb);
  let k = u.refresh * smoothstep(u.threshold, u.threshold * 1.5 + 1e-3, d + (1.0 - step(1e-4, u.threshold)));
  return mix(prev, cur, sat(k));
}`,
    },
  },
  cook(c) {
    const ext = !!c.ins[2];
    const raw = ext ? c.ins[2] : computeFlow(c, c.ins[1] ?? c.ins[0]);
    const vec = c.tex('vec', c.w / 2, c.h / 2), vlast = c.tex('vlast', c.w / 2, c.h / 2);
    c.run('dm_vec', vec.view, [raw, vlast.view], { amount: c.p.amount, smear: vlast.fresh || c.reset ? 0 : c.p.smear * 0.97, block: c.p.block, ext: ext ? 1 : 0, freeze: vlast.fresh || c.reset ? 0 : c.p.freeze, drift: [Math.cos((c.p.driftAngle * Math.PI) / 180) * c.p.drift * 0.004, -Math.sin((c.p.driftAngle * Math.PI) / 180) * c.p.drift * 0.004] }, [vec.tex.width, vec.tex.height]);
    c.copy(vec.tex, vlast.tex);
    const acc = c.tex('acc');
    const st = c.state as { n?: number };
    st.n = c.reset || acc.fresh ? 0 : (st.n ?? 0) + 1;
    const key = acc.fresh || c.reset || c.p.keyframe > 0.5 || (c.p.interval > 0 && st.n % c.p.interval === 0) ? 1 : 0;
    const ls = c.tex('lsrc');
    c.run('dm_mosh', c.out, [acc.view, c.ins[0], vec.view, ls.view], { refresh: c.p.refresh, threshold: c.p.threshold, key, chroma: c.p.chroma, residual: ls.fresh || c.reset ? 0 : c.p.residual });
    c.copy(c.outTex, acc.tex);
    if (c.inTex[0] && c.inTex[0].width === ls.tex.width && c.inTex[0].height === ls.tex.height) c.copy(c.inTex[0], ls.tex);
    if (!ext) commitFlow(c);
  },
};

// ------------------------------------------------------------------------------------------------
// Codec Crush: real 8×8 block DCT, quantised in YCbCr — authentic compression breakup, dialled in.
// ------------------------------------------------------------------------------------------------
const DCT_FN = `
fn cc_c(k: i32) -> f32 { return select(0.5, 0.35355339, k == 0); }
fn cc_basis(n: i32, k: i32) -> f32 { return cos(PI / 8.0 * (f32(n) + 0.5) * f32(k)); }
`;
const codec: OpDef = {
  type: 'codec', label: 'Codec Crush', category: 'Glitch', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }],
  help: 'Runs the picture through a real block-transform codec stage: 8×8 DCT, quantisation, optional coefficient corruption. Compression artefacts as a controllable effect instead of a side effect.',
  params: [
    { k: 'float', name: 'quant', label: 'Quantise', def: 0.12, min: 0, max: 1, step: 0.001, help: 'Coefficient step size. Higher = blockier, more ringing.' },
    { k: 'float', name: 'detail', label: 'Detail loss', def: 0.6, min: 0, max: 3, help: 'Extra quantisation for high frequencies.' },
    { k: 'float', name: 'chromaQ', label: 'Chroma loss', def: 2, min: 0.2, max: 12, help: 'How much harder colour is quantised than brightness.' },
    { k: 'float', name: 'size', label: 'Block scale', def: 2, min: 1, max: 16, step: 1, help: 'Codec pixel size. 1 = true 8×8 pixel blocks at working resolution.' },
    { k: 'float', name: 'corrupt', def: 0, min: 0, max: 1, help: 'Probability that a block\'s data is damaged.' },
    { k: 'float', name: 'rate', label: 'Corrupt rate', def: 8, min: 0, max: 60, unit: 'Hz' },
    { k: 'float', name: 'dcDrift', label: 'DC drift', def: 0, min: 0, max: 1, help: 'Shifts whole-block brightness and colour on damaged blocks.' },
    { k: 'int', name: 'keep', label: 'Keep coeffs', def: 8, min: 1, max: 8, help: 'Zero every coefficient past this index on each axis (low-pass per block).' },
  ],
  passes: {
    cc_fh: {
      inputs: ['src'],
      body: `${DCT_FN}
fn op(uv: vec2f) -> vec4f {
  let pc = vec2i(uv * g.res);
  let b0 = (pc.x / 8) * 8; let k = pc.x - b0;
  var s = vec3f(0.0);
  for (var n = 0; n < 8; n++) {
    let c = textureSampleLevel(src, smp, (vec2f(f32(b0 + n), f32(pc.y)) + 0.5) / g.res, 0.0).rgb;
    // gamma-encode so quantisation steps are perceptually even, then RGB → YCbCr
    let e = sqrt(max(c, vec3f(0.0)));
    let y = dot(e, vec3f(0.299, 0.587, 0.114));
    s += vec3f(y, (e.b - y) * 0.564, (e.r - y) * 0.713) * cc_basis(n, k);
  }
  return vec4f(s * cc_c(k), 1.0);
}`,
    },
    cc_fv: {
      inputs: ['src'], fields: [['quant', 'f32'], ['detail', 'f32'], ['chromaQ', 'f32'], ['corrupt', 'f32'], ['rate', 'f32'], ['dcDrift', 'f32'], ['keep', 'i32']],
      body: `${DCT_FN}
fn op(uv: vec2f) -> vec4f {
  let pc = vec2i(uv * g.res);
  let b0 = (pc / 8) * 8; let k = pc - b0;
  var s = vec3f(0.0);
  for (var n = 0; n < 8; n++) { s += textureLoad(src, vec2i(pc.x, min(b0.y + n, i32(g.res.y) - 1)), 0).rgb * cc_basis(n, k.y); }
  s *= cc_c(k.y);
  if (k.x >= u.keep || k.y >= u.keep) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  let q = max(u.quant * u.quant, 1e-5) * (1.0 + f32(k.x + k.y) * u.detail) * vec3f(1.0, u.chromaQ, u.chromaQ);
  s = round(s / q) * q;
  if (u.corrupt > 0.0) {
    let tq = floor(g.time * u.rate);
    let h = hash33(vec3f(vec2f(b0 / 8), tq));
    if (h.x < u.corrupt * 0.5) {
      // damaged block: scramble AC data, drift DC
      let r = hash33(vec3f(vec2f(pc), tq + 3.0)) - 0.5;
      if (k.x + k.y == 0) { s += (h.yzx - 0.5) * u.dcDrift * 4.0; }
      else { s = s * (1.0 + r * 6.0 * h.z) + r * u.quant * h.y; }
    }
  }
  return vec4f(s, 1.0);
}`,
    },
    cc_iv: {
      inputs: ['src'],
      body: `${DCT_FN}
fn op(uv: vec2f) -> vec4f {
  let pc = vec2i(uv * g.res);
  let b0 = (pc.y / 8) * 8; let n = pc.y - b0;
  var s = vec3f(0.0);
  for (var k = 0; k < 8; k++) { s += textureLoad(src, vec2i(pc.x, min(b0 + k, i32(g.res.y) - 1)), 0).rgb * cc_basis(n, k) * cc_c(k); }
  return vec4f(s, 1.0);
}`,
    },
    cc_ih: {
      inputs: ['src', 'orig'],
      body: `${DCT_FN}
fn op(uv: vec2f) -> vec4f {
  let pc = vec2i(uv * g.res);
  let b0 = (pc.x / 8) * 8; let n = pc.x - b0;
  var s = vec3f(0.0);
  for (var k = 0; k < 8; k++) { s += textureLoad(src, vec2i(min(b0 + k, i32(g.res.x) - 1), pc.y), 0).rgb * cc_basis(n, k) * cc_c(k); }
  let e = vec3f(s.x + 1.402 * s.z, s.x - 0.344 * s.y - 0.714 * s.z, s.x + 1.772 * s.y);
  let m = max(e, vec3f(0.0));
  return vec4f(m * m, textureSampleLevel(orig, smp, uv, 0.0).a);
}`,
    },
    cc_up: { inputs: ['src'], body: `fn op(uv: vec2f) -> vec4f { return textureSampleLevel(src, smpN, uv, 0.0); }` },
  },
  cook(c) {
    const s = Math.max(1, Math.round(c.p.size));
    const w = Math.ceil(c.w / s / 8) * 8, h = Math.ceil(c.h / s / 8) * 8;
    const a = c.tex('a', w, h), b = c.tex('b', w, h);
    const res: [number, number] = [w, h];
    c.run('cc_fh', a.view, [c.ins[0]], {}, res);
    c.run('cc_fv', b.view, [a.view], { quant: c.p.quant, detail: c.p.detail, chromaQ: c.p.chromaQ, corrupt: c.p.corrupt, rate: c.p.rate, dcDrift: c.p.dcDrift, keep: c.p.keep }, res);
    c.run('cc_iv', a.view, [b.view], {}, res);
    c.run('cc_ih', b.view, [a.view, c.ins[0]], {}, res);
    c.run('cc_up', c.out, [b.view]);
  },
};

// ------------------------------------------------------------------------------------------------
// Time Warp: a ring buffer of past frames, read per pixel. Delay, echo, slit-scan, time displacement.
// ------------------------------------------------------------------------------------------------
const timewarp: OpDef = {
  type: 'timewarp', label: 'Time Warp', category: 'Time', output: 'tex', animated: true,
  inputs: [{ name: 'src', type: 'tex' }, { name: 'map', type: 'tex', optional: true }],
  help: 'Keeps a history of past frames and lets every pixel look back a different distance in time. Slit-scan bends motion through space; Displace uses the Map input\'s brightness as the time offset.',
  params: [
    { k: 'enum', name: 'mode', options: ['Delay', 'Echo', 'Slit-scan', 'Displace by map', 'Radial scan'], def: 2 },
    { k: 'int', name: 'frames', label: 'History', def: 48, min: 4, max: 120, help: 'How many past frames are stored.' },
    { k: 'enum', name: 'quality', label: 'History size', options: ['Quarter', 'Half', 'Full'], def: 1, help: 'Resolution of stored frames. Full uses a lot of GPU memory.' },
    { k: 'float', name: 'amount', def: 1, min: 0, max: 1, help: 'Fraction of the history the effect reaches back into.' },
    { k: 'float', name: 'angle', def: 0, min: -180, max: 180, unit: '°', help: 'Slit-scan direction.' },
    { k: 'int', name: 'echoes', def: 6, min: 1, max: 16 },
    { k: 'float', name: 'decay', def: 0.75, min: 0, max: 1 },
    { k: 'enum', name: 'blend', label: 'Echo blend', options: ['Average', 'Add', 'Max', 'Difference'], def: 0 },
    { k: 'bool', name: 'smooth', label: 'Interpolate', def: true, help: 'Blend between neighbouring frames instead of stepping.' },
    { k: 'bool', name: 'freeze', def: false, help: 'Stop recording; keep scrubbing the stored history.' },
  ],
  passes: {
    tw_store: { inputs: ['src'], body: `fn op(uv: vec2f) -> vec4f { return textureSampleLevel(src, smp, uv, 0.0); }` },
    tw_read: {
      inputs: ['atlas', 'src', 'map'],
      fields: [['mode', 'i32'], ['cols', 'f32'], ['rows', 'f32'], ['count', 'f32'], ['head', 'f32'], ['filled', 'f32'], ['amount', 'f32'], ['angle', 'f32'],
        ['echoes', 'i32'], ['decay', 'f32'], ['blend', 'i32'], ['lerp', 'i32'], ['tile', 'vec2f']],
      body: `// fetch the frame recorded \`age\` frames ago (0 = newest)
fn tw_frame(uv: vec2f, age: f32) -> vec4f {
  let idx = u.head - clamp(age, 0.0, u.filled - 1.0);
  let i = idx - floor(idx / u.count) * u.count;
  let cell = vec2f(i - floor(i / u.cols) * u.cols, floor(i / u.cols));
  let half = 0.5 / u.tile;
  let q = clamp(uv, half, 1.0 - half);
  return textureSampleLevel(atlas, smp, (cell + q) / vec2f(u.cols, u.rows), 0.0);
}
fn tw_at(uv: vec2f, age: f32) -> vec4f {
  if (u.lerp == 1) { let a = floor(age); return mix(tw_frame(uv, a), tw_frame(uv, a + 1.0), age - a); }
  return tw_frame(uv, round(age));
}
fn op(uv: vec2f) -> vec4f {
  let reach = (u.filled - 1.0) * u.amount;
  if (u.mode == 0) { return tw_at(uv, reach); }
  if (u.mode == 1) {
    var acc = vec4f(0.0); var wsum = 0.0; var w = 1.0;
    for (var i = 0; i < u.echoes; i++) {
      let s = tw_at(uv, reach * f32(i) / f32(max(u.echoes - 1, 1)));
      if (u.blend == 0) { acc += s * w; wsum += w; }
      else if (u.blend == 1) { acc += s * w; wsum = 1.0; }
      else if (u.blend == 2) { acc = max(acc, s * w); wsum = 1.0; }
      else { acc = abs(acc - s * w); wsum = 1.0; }
      w *= u.decay;
    }
    return acc / max(wsum, 1e-5);
  }
  var t = 0.0;
  if (u.mode == 2) { let d = vec2f(cos(radians(u.angle)), sin(radians(u.angle))); t = dot(uv - 0.5, d) / (abs(d.x) + abs(d.y)) + 0.5; }
  else if (u.mode == 3) { t = luma(textureSampleLevel(map, smp, uv, 0.0).rgb); if (u.has_map < 0.5) { t = luma(textureSampleLevel(src, smp, uv, 0.0).rgb); } }
  else { t = length(centered(uv)) / length(vec2f(g.aspect, 1.0)); }
  return tw_at(uv, sat(t) * reach);
}`,
    },
  },
  cook(c) {
    const n = Math.max(4, c.p.frames | 0);
    const sc = [0.25, 0.5, 1][c.p.quality] ?? 0.5;
    let tw = Math.round(c.w * sc), th = Math.round(c.h * sc);
    const cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols);
    const lim = 8192; // keep the atlas within conservative texture limits
    const f = Math.min(1, lim / (tw * cols), lim / (th * rows));
    tw = Math.max(8, Math.floor(tw * f)); th = Math.max(8, Math.floor(th * f));
    const atlas = c.tex('atlas', tw * cols, th * rows);
    const st = c.state as { head?: number; filled?: number; n?: number };
    if (atlas.fresh || c.reset || st.n !== n) { st.head = -1; st.filled = 0; st.n = n; }
    if (!c.p.freeze || st.filled === 0) {
      st.head = (st.head! + 1) % n; st.filled = Math.min(n, st.filled! + 1);
      c.run('tw_store', atlas.view, [c.ins[0]], {}, [tw, th], { viewport: [(st.head % cols) * tw, Math.floor(st.head / cols) * th, tw, th], load: true });
    }
    c.run('tw_read', c.out, [atlas.view, c.ins[0], c.ins[1]], {
      mode: c.p.mode, cols, rows, count: n, head: st.head!, filled: st.filled!, amount: c.p.amount, angle: c.p.angle,
      echoes: Math.min(16, c.p.echoes), decay: c.p.decay, blend: c.p.blend, lerp: c.p.smooth, tile: [tw, th],
    });
  },
};

// ------------------------------------------------------------------------------------------------
// Pixel Sort: parallel odd–even transposition sort inside thresholded spans.
// ------------------------------------------------------------------------------------------------
const pixelsort: OpDef = {
  type: 'pixelsort', label: 'Pixel Sort', category: 'Glitch', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }, { name: 'mask', type: 'tex', optional: true }],
  help: 'A real sort, not a smear: pixels inside the brightness window are ordered along the chosen axis. Turn on Accumulate to let the sort keep running across frames so the picture melts over time.',
  params: [
    { k: 'enum', name: 'axis', options: ['Horizontal', 'Vertical'], def: 1 },
    { k: 'bool', name: 'reverse', def: false },
    { k: 'enum', name: 'key', label: 'Sort by', options: ['Luma', 'Hue', 'Saturation', 'Red', 'Green', 'Blue'], def: 0 },
    { k: 'float', name: 'low', label: 'Window low', def: 0.25, min: 0, max: 1 },
    { k: 'float', name: 'high', label: 'Window high', def: 0.9, min: 0, max: 2 },
    { k: 'int', name: 'steps', def: 80, min: 1, max: 400, help: 'Sort passes per frame: the longest run that can fully sort in one frame.' },
    { k: 'float', name: 'grain', label: 'Sort scale', def: 2, min: 1, max: 8, step: 1, help: 'Sort at reduced resolution for longer, chunkier streaks.' },
    { k: 'bool', name: 'accumulate', def: false, help: 'Keep sorting the previous result instead of restarting from the source each frame.' },
    { k: 'float', name: 'feed', label: 'Source feed', def: 0.05, min: 0, max: 1, help: 'With Accumulate: how much fresh source is mixed in per frame.' },
  ],
  passes: {
    ps_init: {
      inputs: ['src', 'prev'], fields: [['feed', 'f32'], ['useprev', 'f32']],
      body: `fn op(uv: vec2f) -> vec4f {
  let s = textureSampleLevel(src, smp, uv, 0.0);
  if (u.useprev < 0.5) { return s; }
  return mix(textureSampleLevel(prev, smpN, uv, 0.0), s, u.feed);
}`,
    },
    ps_step: {
      inputs: ['cur', 'mask'], fields: [['axis', 'i32'], ['parity', 'i32'], ['reverse', 'i32'], ['key', 'i32'], ['low', 'f32'], ['high', 'f32']],
      body: `fn ps_key(c: vec3f) -> f32 {
  if (u.key == 1) { return rgb2hsv(c).x; }
  if (u.key == 2) { return rgb2hsv(c).y; }
  if (u.key == 3) { return c.r; }
  if (u.key == 4) { return c.g; }
  if (u.key == 5) { return c.b; }
  return luma(c);
}
fn ps_in(c: vec3f, m: f32) -> bool { let l = luma(c); return l >= u.low && l <= u.high && m > 0.5; }
fn op(uv: vec2f) -> vec4f {
  let pc = vec2i(uv * g.res);
  let size = vec2i(g.res);
  let ax = select(vec2i(1, 0), vec2i(0, 1), u.axis == 1);
  let pos = select(pc.x, pc.y, u.axis == 1);
  // pair up with the neighbour on one side this pass, the other side next pass
  let first = ((pos + u.parity) & 1) == 0;
  let other = pc + select(-ax, ax, first);
  let me = textureLoad(cur, pc, 0);
  if (other.x < 0 || other.y < 0 || other.x >= size.x || other.y >= size.y) { return me; }
  let ot = textureLoad(cur, other, 0);
  var mm = 1.0; var mo = 1.0;
  if (u.has_mask > 0.5) {
    mm = luma(textureSampleLevel(mask, smp, uv, 0.0).rgb);
    mo = luma(textureSampleLevel(mask, smp, (vec2f(other) + 0.5) / g.res, 0.0).rgb);
  }
  if (!ps_in(me.rgb, mm) || !ps_in(ot.rgb, mo)) { return me; }
  let km = ps_key(me.rgb); let ko = ps_key(ot.rgb);
  // the earlier pixel of the pair should hold the smaller key (or larger when reversed)
  var swap = select(ko > km, km > ko, first);
  if (u.reverse == 1) { swap = select(ko < km, km < ko, first); }
  return select(me, ot, swap);
}`,
    },
    ps_up: { inputs: ['src'], body: `fn op(uv: vec2f) -> vec4f { return textureSampleLevel(src, smpN, uv, 0.0); }` },
  },
  cook(c) {
    const s = Math.max(1, Math.round(c.p.grain));
    const w = Math.max(8, Math.round(c.w / s)), h = Math.max(8, Math.round(c.h / s));
    const a = c.tex('a', w, h), b = c.tex('b', w, h), keep = c.tex('keep', w, h);
    const res: [number, number] = [w, h];
    const acc = !!c.p.accumulate && !keep.fresh && !c.reset;
    c.run('ps_init', a.view, [c.ins[0], keep.view], { feed: c.p.feed, useprev: acc ? 1 : 0 }, res);
    let src = a, dst = b;
    const n = Math.min(400, Math.max(1, c.p.steps | 0));
    const v = { axis: c.p.axis, reverse: c.p.reverse, key: c.p.key, low: c.p.low, high: c.p.high };
    for (let i = 0; i < n; i++) { c.run('ps_step', dst.view, [src.view, c.ins[1]], { ...v, parity: i & 1 }, res); [src, dst] = [dst, src]; }
    c.copy(src.tex, keep.tex);
    c.run('ps_up', c.out, [src.view]);
  },
};

// ------------------------------------------------------------------------------------------------
// Reaction–Diffusion (Gray–Scott), optionally seeded and steered by footage.
// ------------------------------------------------------------------------------------------------
const rd: OpDef = {
  type: 'rd', label: 'Reaction Diffusion', category: 'Simulate', output: 'tex', animated: true,
  inputs: [{ name: 'seed', type: 'tex', optional: true }, { name: 'steer', type: 'tex', optional: true }],
  help: 'Gray–Scott reaction-diffusion. Connect Seed to grow patterns out of footage; Steer\'s brightness shifts the feed rate so different areas grow different structures. Colour it with Gradient Map.',
  params: [
    { k: 'float', name: 'feed', def: 0.037, min: 0, max: 0.1, step: 0.0005 },
    { k: 'float', name: 'kill', def: 0.06, min: 0.03, max: 0.075, step: 0.0005 },
    { k: 'float', name: 'scale', label: 'Feature size', def: 1, min: 0.3, max: 4 },
    { k: 'int', name: 'steps', label: 'Speed', def: 12, min: 1, max: 40, help: 'Simulation steps per frame.' },
    { k: 'float', name: 'seedAmt', label: 'Seed amount', def: 0.05, min: 0, max: 1, help: 'How strongly the Seed input keeps injecting chemical.' },
    { k: 'float', name: 'steerAmt', label: 'Steer amount', def: 0.3, min: 0, max: 1 },
    { k: 'float', name: 'contrast', def: 3, min: 0.5, max: 8 },
    { k: 'bool', name: 'restart', def: false, help: 'Hold on to clear and re-seed.' },
  ],
  passes: {
    rd_init: {
      inputs: [],
      body: `fn op(uv: vec2f) -> vec4f {
  let p = centered(uv);
  var b = 0.0;
  for (var i = 0; i < 24; i++) { let q = (hash22(vec2f(f32(i), 7.0)) - 0.5) * vec2f(g.aspect, 1.0) * 1.8; b = max(b, 1.0 - smoothstep(0.02, 0.045, length(p - q))); }
  return vec4f(1.0, b, 0.0, 1.0);
}`,
    },
    rd_step: {
      inputs: ['cur', 'seed', 'steer'], fields: [['feed', 'f32'], ['kill', 'f32'], ['scale', 'f32'], ['seedAmt', 'f32'], ['steerAmt', 'f32']],
      body: `fn op(uv: vec2f) -> vec4f {
  let px = u.scale / g.res;
  let c = textureSampleLevel(cur, smp, uv, 0.0).rg;
  var lap = -c;
  lap += 0.2 * (textureSampleLevel(cur, smp, uv + vec2f(px.x, 0.0), 0.0).rg + textureSampleLevel(cur, smp, uv - vec2f(px.x, 0.0), 0.0).rg
              + textureSampleLevel(cur, smp, uv + vec2f(0.0, px.y), 0.0).rg + textureSampleLevel(cur, smp, uv - vec2f(0.0, px.y), 0.0).rg);
  lap += 0.05 * (textureSampleLevel(cur, smp, uv + px, 0.0).rg + textureSampleLevel(cur, smp, uv - px, 0.0).rg
               + textureSampleLevel(cur, smp, uv + vec2f(px.x, -px.y), 0.0).rg + textureSampleLevel(cur, smp, uv + vec2f(-px.x, px.y), 0.0).rg);
  var f = u.feed; var k = u.kill;
  if (u.has_steer > 0.5) { let s = luma(textureSampleLevel(steer, smp, uv, 0.0).rgb) - 0.5; f += s * 0.03 * u.steerAmt; k -= s * 0.012 * u.steerAmt; }
  let r = c.x * c.y * c.y;
  var a = c.x + (1.0 * lap.x - r + f * (1.0 - c.x));
  var b = c.y + (0.5 * lap.y + r - (k + f) * c.y);
  if (u.has_seed > 0.5) { b = max(b, sat(luma(textureSampleLevel(seed, smp, uv, 0.0).rgb)) * u.seedAmt); }
  return vec4f(sat(a), sat(b), 0.0, 1.0);
}`,
    },
    rd_out: {
      inputs: ['cur'], fields: [['contrast', 'f32']],
      body: `fn op(uv: vec2f) -> vec4f {
  let c = textureSampleLevel(cur, smp, uv, 0.0).rg;
  let v = sat((c.y * 2.0 - 0.1) * u.contrast * 0.6);
  return vec4f(vec3f(v * v), 1.0);
}`,
    },
  },
  cook(c) {
    // simulate on a fixed-density grid so features keep their size at any output resolution
    const sw = Math.round(540 * (c.w / c.h)), sh = 540;
    let a = c.tex('a', sw, sh), b = c.tex('b', sw, sh);
    const res: [number, number] = [sw, sh];
    if (a.fresh || c.reset || c.p.restart) c.run('rd_init', a.view, [], {}, res);
    const v = { feed: c.p.feed, kill: c.p.kill, scale: c.p.scale, seedAmt: c.p.seedAmt, steerAmt: c.p.steerAmt };
    const n = c.dt > 0 || a.fresh ? Math.min(40, c.p.steps) & ~1 || 2 : 0;
    for (let i = 0; i < n; i++) { c.run('rd_step', b.view, [a.view, c.ins[0], c.ins[1]], v, res); [a, b] = [b, a]; }
    c.run('rd_out', c.out, [a.view], { contrast: c.p.contrast });
  },
};

// ------------------------------------------------------------------------------------------------
// Databend: treat the frame as one long sample stream and run audio effects over it.
// ------------------------------------------------------------------------------------------------
const databend: OpDef = {
  type: 'databend', label: 'Databend', category: 'Glitch', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }],
  help: 'Reads the picture as a raw sample stream, scanline after scanline, and applies audio effects to it — the Audacity databending trick, live and controllable.',
  params: [
    { k: 'enum', name: 'fx', label: 'Effect', options: ['Echo', 'Flanger', 'Reverb', 'Sample & hold', 'Tremolo', 'Wah'], def: 0 },
    { k: 'float', name: 'time', label: 'Delay', def: 0.35, min: 0, max: 4, help: 'Delay length in scanlines.' },
    { k: 'float', name: 'feedback', def: 0.55, min: 0, max: 0.95 },
    { k: 'float', name: 'mixAmt', label: 'Mix', def: 0.6, min: 0, max: 1 },
    { k: 'float', name: 'rate', def: 3, min: 0, max: 60, help: 'Modulation rate in cycles per frame height.' },
    { k: 'float', name: 'depth', def: 0.5, min: 0, max: 1 },
    { k: 'float', name: 'misalign', label: 'Channel offset', def: 0.15, min: 0, max: 1, help: 'Offsets R, G and B in the stream, like reading the file at the wrong byte.' },
    { k: 'float', name: 'speed', def: 0.2, min: 0, max: 4 },
  ],
  body: `// stream index → uv (samples run left to right, top to bottom)
fn db_at(i: f32) -> vec3f {
  let total = g.res.x * g.res.y;
  let k = clamp(i, 0.0, total - 1.0);
  let y = floor(k / g.res.x); let x = k - y * g.res.x;
  return textureSampleLevel(src, smp, (vec2f(x, y) + 0.5) / g.res, 0.0).rgb;
}
fn db_chan(i: f32) -> vec3f {
  let o = u.misalign * g.res.x * 0.02;
  return vec3f(db_at(i).r, db_at(i + o).g, db_at(i + o * 2.0).b);
}
fn op(uv: vec2f) -> vec4f {
  let a = textureSampleLevel(src, smp, uv, 0.0).a;
  let pc = floor(uv * g.res);
  let i = pc.y * g.res.x + pc.x;
  let dry = db_chan(i);
  let ph = uv.y * u.rate + g.time * u.speed;
  var wet = dry;
  if (u.fx == 0) {
    let d = max(1.0, u.time * g.res.x);
    var w = 1.0; var acc = vec3f(0.0); var n = 0.0;
    for (var k = 1; k <= 6; k++) { w *= u.feedback; acc += db_chan(i - d * f32(k)) * w; n += w; }
    wet = (dry + acc) / (1.0 + n * 0.5);
  } else if (u.fx == 1) {
    let d = (0.5 + 0.5 * sin(ph * TAU)) * u.depth * u.time * g.res.x * 0.2 + 1.0;
    wet = (dry + db_chan(i - d) + db_chan(i - d * 2.0) * u.feedback) / (2.0 + u.feedback);
  } else if (u.fx == 2) {
    var acc = vec3f(0.0); var n = 0.0;
    for (var k = 1; k <= 12; k++) {
      let d = u.time * g.res.x * (hash11(f32(k) * 7.3) * 1.7 + 0.1) * f32(k) * 0.35;
      let w = pow(u.feedback, f32(k) * 0.5);
      acc += db_chan(i - d) * w; n += w;
    }
    wet = (dry + acc) / (1.0 + n);
  } else if (u.fx == 3) {
    let hold = max(1.0, u.time * 40.0 * (1.0 + u.depth * sin(ph * TAU)));
    wet = db_chan(floor(i / hold) * hold);
  } else if (u.fx == 4) {
    wet = dry * (1.0 - u.depth * (0.5 + 0.5 * sin((i / g.res.x) * u.rate * 0.37 * TAU + g.time * u.speed * TAU)));
  } else {
    // swept one-pole low/high pair along the stream
    let w = mix(1.0, 48.0, 0.5 + 0.5 * sin(ph * TAU) * u.depth);
    var lp = vec3f(0.0); var n = 0.0;
    for (var k = 0; k < 10; k++) { let ww = exp(-f32(k) / w * 4.0); lp += db_chan(i - f32(k) * w * 0.25) * ww; n += ww; }
    lp /= n;
    wet = lp + (dry - lp) * (1.0 + u.feedback * 3.0) * 0.6;
  }
  return vec4f(mix(db_at(i), wet, u.mixAmt), a);
}`,
};

// ------------------------------------------------------------------------------------------------
// Shader: write WGSL live.
// ------------------------------------------------------------------------------------------------
const WGSL_DEFAULT = `// Write fn op(uv) -> colour. Inputs: a, b (textures). Uniforms: u.p1..u.p4, u.tint.
// Globals: g.time, g.beat, g.res, g.aspect, g.audio (bass, mid, high, level).
fn op(uv: vec2f) -> vec4f {
  let p = centered(uv);
  let r = length(p);
  let w = sin(r * 18.0 * u.p1 - g.time * 3.0 + atan2(p.y, p.x) * floor(u.p2 * 12.0));
  let src = textureSampleLevel(a, smpR, uv + p * w * 0.03 * u.p3, 0.0);
  let glow = u.tint.rgb * smoothstep(0.2, 1.0, w) * (0.3 + g.audio.x);
  return vec4f(src.rgb + glow * (1.0 - u.has_a * 0.5), 1.0);
}`;

const wgsl: OpDef = {
  type: 'wgsl', label: 'Shader', category: 'Generate', output: 'tex', animated: true,
  inputs: [{ name: 'a', type: 'tex', optional: true }, { name: 'b', type: 'tex', optional: true }],
  help: 'Your own fragment shader, compiled as you type. Errors appear here; the last working version keeps running until the code is valid again.',
  params: [
    { k: 'code', name: 'code', def: WGSL_DEFAULT },
    { k: 'float', name: 'p1', def: 0.5, min: 0, max: 1 },
    { k: 'float', name: 'p2', def: 0.5, min: 0, max: 1 },
    { k: 'float', name: 'p3', def: 0.5, min: 0, max: 1 },
    { k: 'float', name: 'p4', def: 0.5, min: 0, max: 1 },
    { k: 'color', name: 'tint', def: [0.9, 0.7, 0.3, 1] },
  ],
  cook(c) {
    const err = c.dynamic('main', {
      inputs: ['a', 'b'], fields: [['p1', 'f32'], ['p2', 'f32'], ['p3', 'f32'], ['p4', 'f32'], ['tint', 'vec4f']], body: String(c.p.code),
    });
    c.runDynamic('main', c.out, [c.ins[0], c.ins[1]], { p1: c.p.p1, p2: c.p.p2, p3: c.p.p3, p4: c.p.p4, tint: c.p.tint });
    if (err) throw new Error(err);
  },
};

export const ops: OpDef[] = [flow, datamosh, codec, timewarp, pixelsort, rd, databend, wgsl];
