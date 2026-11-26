// Machine vision: monocular depth (Depth Anything V2), person segmentation and pose / hand / object tracking
// (MediaPipe), plus 2.5D effects driven by a depth map. Inference lives in ../ml.ts and runs asynchronously;
// while a model loads, image ops output black or pass their source through.
import type { CookCtx, OpDef, PassDecl } from '../types';
import { ml, toHalf, type TrackResult } from '../ml';

// ------------------------------------------------------------------------------------------------
// shared passes
// ------------------------------------------------------------------------------------------------
const EMA: PassDecl = {
  inputs: ['cur', 'prev'], fields: [['amt', 'f32']],
  body: `fn op(uv: vec2f) -> vec4f {
  let a = textureSampleLevel(cur, smp, uv, 0.0);
  let b = textureSampleLevel(prev, smp, uv, 0.0);
  return mix(a, b, u.amt);
}`,
};

/**
 * Temporal EMA on a low-res map, applied once per new inference result (not per cook). While the transport is
 * paused (dt = 0) the newest result is shown as is, so scrubbing never leaves a ghost of the previous frame.
 */
function smoothMap(c: CookCtx, view: GPUTextureView, w: number, h: number, seq: number, amt: number): GPUTextureView {
  const a = c.tex('emaA', w, h), b = c.tex('emaB', w, h);
  const st = c.state as { flip?: boolean; seq?: number };
  if (st.seq === seq && !a.fresh && !b.fresh && !c.reset) return (st.flip ? b : a).view;
  const [dst, prev] = st.flip ? [a, b] : [b, a];
  const k = prev.fresh || dst.fresh || c.reset || c.dt <= 0 ? 0 : Math.min(0.98, Math.max(0, amt));
  c.run('ema', dst.view, [view, prev.view], { amt: k }, [w, h]);
  st.flip = !st.flip; st.seq = seq;
  return dst.view;
}

/** Joint-bilateral 3x3 upsample of a low-res map against the full-res picture. */
const JBU = /* wgsl */`
fn vis_jbu(uv: vec2f, mres: vec2f, sharp: f32) -> f32 {
  let rl = luma(textureSampleLevel(src, smp, uv, 0.0).rgb);
  let p = uv * mres - 0.5;
  let b = floor(p);
  var acc = 0.0; var wsum = 0.0;
  for (var j = -1; j <= 2; j++) { for (var i = -1; i <= 2; i++) {
    let t = b + vec2f(f32(i), f32(j));
    let tuv = (t + 0.5) / mres;
    let dd = abs(p - t);
    let ws = max(0.0, 1.0 - dd.x * 0.5) * max(0.0, 1.0 - dd.y * 0.5);
    let l = luma(textureSampleLevel(src, smp, tuv, 0.0).rgb);
    let dl = (l - rl) * sharp;
    let w = ws * exp(-dl * dl) + 1e-5 * ws;
    acc += textureSampleLevel(map, smpN, tuv, 0.0).r * w;
    wsum += w;
  } }
  return acc / max(wsum, 1e-6);
}`;

const RES = [252, 364, 518];

// ------------------------------------------------------------------------------------------------
// Depth Estimate
// ------------------------------------------------------------------------------------------------
const depth: OpDef = {
  type: 'depth', label: 'Depth Estimate', category: 'Filter', animated: true,
  inputs: [{ name: 'src', type: 'tex' }], output: 'tex',
  help: 'Estimates depth from a single picture with Depth Anything V2 (runs locally; the model downloads on first use). Near is bright. Feed it into Depth Parallax, Depth Fog, Depth Defocus and friends.',
  params: [
    { k: 'enum', name: 'resolution', options: ['Low', 'Medium', 'High'], def: 1, help: 'Working size of the model. Higher is sharper and slower.' },
    { k: 'float', name: 'temporal', label: 'Smoothing', def: 0.5, min: 0, max: 0.95, help: 'Blends with previous results to reduce flicker.' },
    { k: 'float', name: 'near', def: 1, min: 0, max: 1, group: 'Remap', help: 'Depth value that maps to white.' },
    { k: 'float', name: 'far', def: 0, min: 0, max: 1, group: 'Remap', help: 'Depth value that maps to black.' },
    { k: 'float', name: 'contrast', def: 1, min: 0.2, max: 4, group: 'Remap' },
    { k: 'bool', name: 'invert', def: false, group: 'Remap' },
    { k: 'bool', name: 'edgeAware', label: 'Snap to edges', def: true, group: 'Detail', help: 'Upsamples against the picture so depth edges follow picture edges.' },
    { k: 'float', name: 'edgeSharp', label: 'Edge strength', def: 12, min: 1, max: 40, group: 'Detail' },
    { k: 'float', name: 'delay', label: 'Matte delay', def: 0.35, min: 0, max: 1.5, step: 0.01, unit: 's', group: 'Live look', help: 'Uses the depth map from this long ago, still snapped to the current picture, so mattes and cut-out edges trail the motion as in the live preview. Identical in the final render.' },
    { k: 'float', name: 'refresh', label: 'Matte refresh', def: 2, min: 1, max: 60, step: 0.5, unit: '/s', group: 'Live look', help: 'How many times a second the depth map updates. Low values hold each map for several frames, so edges jump in steps like the preview. Lower is also faster to render: depth only runs when a refresh is due.' },
  ],
  passes: {
    ema: EMA,
    out: {
      inputs: ['map', 'src'],
      fields: [['mres', 'vec2f'], ['near', 'f32'], ['far', 'f32'], ['contrast', 'f32'], ['invert', 'i32'], ['edge', 'i32'], ['sharp', 'f32']],
      body: JBU + /* wgsl */`
fn op(uv: vec2f) -> vec4f {
  var d = textureSampleLevel(map, smp, uv, 0.0).r;
  if (u.edge == 1) { d = vis_jbu(uv, u.mres, u.sharp); }
  let span = u.near - u.far;
  d = (d - u.far) / select(span, 1e-4, abs(span) < 1e-4);
  d = sat((sat(d) - 0.5) * u.contrast + 0.5);
  if (u.invert == 1) { d = 1.0 - d; }
  return vec4f(vec3f(d), 1.0);
}`,
    },
  },
  cook(c) {
    const src = c.ins[0], st = c.inTex[0];
    if (!src || !st) { c.clear(c.out); return; }
    const live = liveLook(c);
    let map: { view: GPUTextureView; w: number; h: number } | null = null;
    if (live.ask) {
      const r = ml.depth(c.gpu, c.nodeId, src, st.width, st.height, RES[c.p.resolution] ?? 364);
      if (r.status === 'error') throw new Error(r.msg);
      if (r.view) map = { view: smoothMap(c, r.view, r.w, r.h, r.seq, c.p.temporal), w: r.w, h: r.h };
    }
    const shown = live.pick(map);
    if (!shown) { c.clear(c.out); return; }
    c.run('out', c.out, [shown.view, src], { mres: [shown.w, shown.h], near: c.p.near, far: c.p.far, contrast: c.p.contrast, invert: c.p.invert, edge: c.p.edgeAware, sharp: c.p.edgeSharp });
  },
};

/**
 * The live preview's look, made repeatable: the low-res depth map only refreshes `refresh` times a second (held in
 * between, so edges move in steps) and the map shown is the one from `delay` seconds ago. Upsampling still snaps it to
 * the current picture, exactly what happens when realtime inference falls behind. Depth is only asked for when a
 * refresh is due, which also makes slow refresh rates cheaper to render.
 */
type MapRef = { view: GPUTextureView; w: number; h: number };
function liveLook(c: CookCtx): { ask: boolean; pick(m: MapRef | null): MapRef | null } {
  const delay = Math.max(0, c.p.delay ?? 0), rate = Math.min(c.fps, Math.max(0.5, c.p.refresh ?? 60));
  const st = (c.state.live ??= { ring: [] as { t: number; slot: number; w: number; h: number }[], last: -1e9, sample: -1 }) as
    { ring: { t: number; slot: number; w: number; h: number }[]; last: number; sample: number };
  const plain = delay < 0.001 && rate >= c.fps - 0.01;
  if (plain) { st.ring = []; st.sample = -1; return { ask: true, pick: m => m }; }
  const t = c.time;
  // a seek backwards (or a long jump ahead) starts the history over
  if (c.reset || t < st.last - 1e-4 || t > st.last + delay + 2) { st.ring = []; st.sample = -1; }
  st.last = t;
  const idx = Math.floor(t * rate + 1e-6), nextIdx = Math.floor((t + 1 / c.fps) * rate + 1e-6);
  const due = idx !== st.sample;
  // depth results come back one request late, so ask on the frame before a refresh and on the refresh itself
  const ask = due || nextIdx !== idx || !st.ring.length;
  const MAX = Math.min(90, Math.ceil(delay * rate) + 3);
  return {
    ask,
    pick(m) {
      if (m && due) {
        // keep this refresh: overwrite the oldest slot once the history is full
        let slot = st.ring.length < MAX ? st.ring.length : st.ring.reduce((o, e, i, a) => (e.t < a[o].t ? i : o), 0);
        if (st.ring.length >= MAX) st.ring[slot] = { t, slot: st.ring[slot].slot, w: m.w, h: m.h }; else st.ring.push({ t, slot, w: m.w, h: m.h });
        slot = st.ring.find(e => e.t === t)!.slot;
        const dst = c.tex('live' + slot, m.w, m.h);
        c.run('ema', dst.view, [m.view, m.view], { amt: 0 }, [m.w, m.h]);   // plain copy through the blend pass
        st.sample = idx;
      }
      if (!st.ring.length) return m;
      // the newest refresh at least `delay` old, else the oldest one there is
      let best: { t: number; slot: number; w: number; h: number } | null = null, oldest = st.ring[0];
      for (const e of st.ring) { if (e.t <= t - delay + 1e-6 && (!best || e.t > best.t)) best = e; if (e.t < oldest.t) oldest = e; }
      const e = best ?? oldest;
      return { view: c.tex('live' + e.slot, e.w, e.h).view, w: e.w, h: e.h };
    },
  };
}


// ------------------------------------------------------------------------------------------------
// Person Matte
// ------------------------------------------------------------------------------------------------
const matte: OpDef = {
  type: 'matte', label: 'Person Matte', category: 'Filter', animated: true,
  inputs: [{ name: 'src', type: 'tex' }], output: 'tex',
  help: 'Separates people from the background with MediaPipe multiclass segmentation (runs locally; the model downloads on first use). White = selected class.',
  params: [
    { k: 'enum', name: 'cls', label: 'Class', options: ['Person', 'Hair', 'Body skin', 'Face skin', 'Clothes', 'Background'], def: 0 },
    { k: 'enum', name: 'mode', label: 'Output', options: ['Matte', 'Cut out', 'Background only'], def: 0, help: 'Cut out is premultiplied: the person over transparency.' },
    { k: 'float', name: 'feather', def: 0.004, min: 0, max: 0.05, help: 'Edge softness as a fraction of picture height.' },
    { k: 'float', name: 'choke', def: 0, min: -0.5, max: 0.5, help: 'Positive shrinks the matte, negative expands it.' },
    { k: 'float', name: 'temporal', label: 'Smoothing', def: 0.4, min: 0, max: 0.95 },
    { k: 'bool', name: 'edgeAware', label: 'Snap to edges', def: true },
  ],
  passes: {
    ema: EMA,
    feather: {
      inputs: ['map'], fields: [['radius', 'f32']],
      body: /* wgsl */`
fn op(uv: vec2f) -> vec4f {
  if (u.radius <= 1e-5) { return textureSampleLevel(map, smp, uv, 0.0); }
  let r = u.radius * vec2f(1.0 / g.aspect, 1.0);
  var s = textureSampleLevel(map, smp, uv, 0.0).r;
  var n = 1.0;
  for (var i = 0; i < 24; i++) {
    let fi = f32(i);
    let rr = sqrt((fi + 0.5) / 24.0);
    let a = fi * 2.39996323;
    s += textureSampleLevel(map, smp, uv + vec2f(cos(a), sin(a)) * rr * r, 0.0).r;
    n += 1.0;
  }
  return vec4f(s / n, 0.0, 0.0, 1.0);
}`,
    },
    out: {
      inputs: ['map', 'src'], fields: [['mres', 'vec2f'], ['choke', 'f32'], ['mode', 'i32'], ['edge', 'i32'], ['ready', 'f32']],
      body: JBU + /* wgsl */`
fn op(uv: vec2f) -> vec4f {
  let c = textureSampleLevel(src, smp, uv, 0.0);
  var m = 0.0;
  if (u.ready > 0.5) {
    m = textureSampleLevel(map, smp, uv, 0.0).r;
    if (u.edge == 1) { m = vis_jbu(uv, u.mres, 10.0); }
    let e = 0.5 + u.choke * 0.9;
    m = smoothstep(e - 0.3, e + 0.3, m);
  }
  if (u.mode == 1) { return c * m; }
  if (u.mode == 2) { return c * (1.0 - m); }
  return vec4f(vec3f(m), 1.0);
}`,
    },
  },
  cook(c) {
    const src = c.ins[0], st = c.inTex[0];
    if (!src || !st) { c.clear(c.out); return; }
    const r = ml.segment(c.gpu, c.nodeId, src, st.width, st.height, c.p.cls, 256);
    if (r.status === 'error') throw new Error(r.msg);
    let mv: GPUTextureView | null = null;
    if (r.view) {
      const sm = smoothMap(c, r.view, r.w, r.h, r.seq, c.p.temporal);
      const f = c.tex('fth', r.w, r.h);
      c.run('feather', f.view, [sm], { radius: c.p.feather }, [r.w, r.h]);
      mv = f.view;
    }
    c.run('out', c.out, [mv, src], { mres: [r.w || 1, r.h || 1], choke: c.p.choke, mode: c.p.mode, edge: c.p.edgeAware, ready: mv ? 1 : 0 });
  },
};

// ------------------------------------------------------------------------------------------------
// Depth Parallax: occlusion-aware backward search ("3D photo")
// ------------------------------------------------------------------------------------------------
const parallax: OpDef = {
  type: 'parallax', label: 'Depth Parallax', category: 'Distort',
  inputs: [{ name: 'src', type: 'tex' }, { name: 'depth', type: 'tex' }], output: 'tex',
  help: 'Moves a virtual camera through a picture using its depth map (near = bright): near things slide over far things. Auto-orbit gives the animated "3D photo" look.',
  params: [
    { k: 'vec2', name: 'offset', label: 'Camera offset', def: [0, 0], min: -1, max: 1 },
    { k: 'float', name: 'amount', label: 'Depth amount', def: 0.06, min: 0, max: 0.3, help: 'Strength of the parallax as a fraction of picture height.' },
    { k: 'float', name: 'focus', label: 'Focus plane', def: 0.5, min: 0, max: 1, help: 'Depth that stays still (0 = far, 1 = near).' },
    { k: 'float', name: 'zoom', def: 1.05, min: 0.5, max: 2 },
    { k: 'float', name: 'dolly', def: 0, min: -1, max: 1, help: 'Pushes the camera in: near things grow faster than far things.' },
    { k: 'float', name: 'orbit', label: 'Auto-orbit', def: 1, min: 0, max: 2, group: 'Motion' },
    { k: 'float', name: 'speed', def: 0.25, min: 0, max: 4, group: 'Motion' },
    { k: 'int', name: 'steps', def: 32, min: 4, max: 96, group: 'Quality', help: 'Search steps; raise for large amounts.' },
    { k: 'enum', name: 'edges', options: ['Stretch', 'Mirror', 'Transparent'], def: 0, group: 'Quality' },
  ],
  body: /* wgsl */`
fn parallax_dep(p: vec2f) -> f32 {
  if (u.has_depth < 0.5) { return 0.5; }
  return textureSampleLevel(depth, smp, clamp(p, vec2f(0.0), vec2f(1.0)), 0.0).r;
}
// where a surface at depth h that appears at screen position q comes from
fn parallax_src(q: vec2f, h: f32, s: vec2f) -> vec2f {
  let k = h - u.focus;
  return (q - s * k - 0.5) / max(1.0 + u.dolly * k, 0.05) + 0.5;
}
fn op(uv: vec2f) -> vec4f {
  let t = g.time * u.speed * TAU;
  let orb = vec2f(sin(t), 0.5 * sin(t * 2.0 + 0.7)) * u.orbit;
  let s = (u.offset + orb) * u.amount * vec2f(1.0 / g.aspect, 1.0);
  let q = (uv - 0.5) / max(u.zoom, 0.01) + 0.5;
  let n = clamp(u.steps, 4, 96);
  // march from the nearest layer to the farthest; the first surface that reaches the layer wins
  var prevH = 1.0;
  var prevDiff = parallax_dep(parallax_src(q, 1.0, s)) - 1.0;
  var hit = parallax_src(q, 0.0, s);
  if (prevDiff >= 0.0) { hit = parallax_src(q, 1.0, s); }
  else {
    for (var i = 1; i <= n; i++) {
      let h = 1.0 - f32(i) / f32(n);
      let p = parallax_src(q, h, s);
      let diff = parallax_dep(p) - h;
      if (diff >= 0.0) {
        // refine between the two layers by linear interpolation
        let w = prevDiff / (prevDiff - diff);
        let hh = mix(prevH, h, sat(w));
        hit = parallax_src(q, hh, s);
        break;
      }
      prevH = h; prevDiff = diff;
    }
  }
  var p = hit;
  if (u.edges == 1) { let mm = p - 2.0 * floor(p * 0.5); p = 1.0 - abs(1.0 - mm); }
  if (u.edges == 2 && (p.x < 0.0 || p.y < 0.0 || p.x > 1.0 || p.y > 1.0)) { return vec4f(0.0); }
  return textureSampleLevel(src, smp, clamp(p, vec2f(0.0), vec2f(1.0)), 0.0);
}`,
};

// ------------------------------------------------------------------------------------------------
// Depth Fog with a scan plane
// ------------------------------------------------------------------------------------------------
const depthfog: OpDef = {
  type: 'depthfog', label: 'Depth Fog', category: 'Filter',
  inputs: [{ name: 'src', type: 'tex' }, { name: 'depth', type: 'tex' }], output: 'tex',
  help: 'Distance haze from a depth map (near = bright), plus an optional glowing scan plane sweeping through depth — try driving its position with the kick.',
  params: [
    { k: 'color', name: 'color', def: [0.55, 0.62, 0.75, 1] },
    { k: 'float', name: 'density', def: 1.1, min: 0, max: 10 },
    { k: 'float', name: 'start', def: 0.3, min: 0, max: 1, help: 'Distance where the fog begins (0 = nearest).' },
    { k: 'float', name: 'heightFalloff', label: 'Height falloff', def: 0.6, min: 0, max: 4, help: 'Thickens fog toward the bottom of the picture (ground haze).' },
    { k: 'bool', name: 'scan', label: 'Scan plane', def: false, group: 'Scan' },
    { k: 'float', name: 'scanPos', label: 'Position', def: 0.5, min: 0, max: 1, group: 'Scan', help: 'Distance of the plane (0 = nearest).' },
    { k: 'float', name: 'scanSpeed', label: 'Sweep speed', def: 0.2, min: 0, max: 4, group: 'Scan', help: 'Sweeps the plane automatically; 0 holds Position.' },
    { k: 'float', name: 'scanWidth', label: 'Width', def: 0.03, min: 0.002, max: 0.3, group: 'Scan' },
    { k: 'color', name: 'scanColor', label: 'Colour', def: [0.2, 0.9, 1, 1], group: 'Scan' },
    { k: 'float', name: 'scanGain', label: 'Intensity', def: 3, min: 0, max: 20, group: 'Scan' },
  ],
  body: /* wgsl */`
fn op(uv: vec2f) -> vec4f {
  let c = textureSampleLevel(src, smp, uv, 0.0);
  var d = 0.5;
  if (u.has_depth > 0.5) { d = textureSampleLevel(depth, smp, uv, 0.0).r; }
  let dist = 1.0 - sat(d);
  let ht = exp(u.heightFalloff * (uv.y - 1.0));
  let f = 1.0 - exp(-u.density * max(dist - u.start, 0.0) * mix(1.0, ht * 2.0, sat(u.heightFalloff)));
  var rgb = mix(c.rgb, u.color.rgb * c.a, sat(f));
  if (u.scan == 1) {
    var pos = u.scanPos;
    if (u.scanSpeed > 0.0) { pos = fract(u.scanPos + g.time * u.scanSpeed); }
    let x = (dist - pos) / max(u.scanWidth, 1e-4);
    let core = exp(-x * x);
    let halo = exp(-abs(x) * 0.35) * 0.25;
    rgb += u.scanColor.rgb * (core + halo) * u.scanGain * c.a;
  }
  return vec4f(rgb, c.a);
}`,
};

// ------------------------------------------------------------------------------------------------
// Depth Defocus
// ------------------------------------------------------------------------------------------------
const depthdof: OpDef = {
  type: 'depthdof', label: 'Depth Defocus', category: 'Filter',
  inputs: [{ name: 'src', type: 'tex' }, { name: 'depth', type: 'tex' }], output: 'tex',
  help: 'Lens blur from a depth map (near = bright): the blur grows with distance from the focus plane, bright highlights bloom into discs.',
  params: [
    { k: 'float', name: 'focus', label: 'Focus distance', def: 0.75, min: 0, max: 1, help: 'Depth value in focus (1 = nearest).' },
    { k: 'float', name: 'range', label: 'In-focus range', def: 0.06, min: 0, max: 0.5 },
    { k: 'float', name: 'radius', label: 'Max radius', def: 0.018, min: 0, max: 0.06, help: 'Largest blur radius as a fraction of picture height.' },
    { k: 'float', name: 'boost', label: 'Highlight boost', def: 1.5, min: 0, max: 8 },
    { k: 'float', name: 'threshold', label: 'Highlight threshold', def: 0.7, min: 0, max: 4 },
  ],
  body: /* wgsl */`
fn depthdof_coc(d: f32) -> f32 { return sat((abs(d - u.focus) - u.range) / max(1.0 - u.range, 1e-3) * 2.5); }
fn op(uv: vec2f) -> vec4f {
  var d0 = 0.5;
  if (u.has_depth > 0.5) { d0 = textureSampleLevel(depth, smp, uv, 0.0).r; }
  let c0 = depthdof_coc(d0);
  let rmax = u.radius * vec2f(1.0 / g.aspect, 1.0);
  if (u.radius <= 1e-5) { return textureSampleLevel(src, smp, uv, 0.0); }
  let jit = hash21(uv * g.res) * TAU;
  var acc = vec4f(0.0); var wsum = 0.0;
  let N = 44;
  for (var i = 0; i < N; i++) {
    let fi = f32(i);
    let rr = sqrt((fi + 0.5) / f32(N));
    let a = fi * 2.39996323 + jit;
    let o = vec2f(cos(a), sin(a)) * rr;
    let p = uv + o * rmax;
    var d = 0.5;
    if (u.has_depth > 0.5) { d = textureSampleLevel(depth, smp, p, 0.0).r; }
    let ct = depthdof_coc(d);
    // a tap contributes if its own blur disc reaches us; background taps cannot bleed over sharp foreground
    let reach = select(min(ct, c0), ct, d >= d0);
    let w0 = smoothstep(rr - 0.08, rr + 0.02, reach);
    let c = textureSampleLevel(src, smp, p, 0.0);
    let hl = 1.0 + u.boost * smoothstep(u.threshold, u.threshold + 0.6, luma(c.rgb)) * ct;
    let w = w0 * hl;
    acc += c * w; wsum += w;
  }
  let sharp = textureSampleLevel(src, smp, uv, 0.0);
  if (wsum < 1e-4) { return sharp; }
  return mix(sharp, acc / wsum, smoothstep(0.0, 0.15, c0));
}`,
};

// ------------------------------------------------------------------------------------------------
// Depth Relight
// ------------------------------------------------------------------------------------------------
const depthrelight: OpDef = {
  type: 'depthrelight', label: 'Depth Relight', category: 'Filter',
  inputs: [{ name: 'src', type: 'tex' }, { name: 'depth', type: 'tex' }], output: 'tex',
  help: 'Relights a picture with a movable point light, using surface normals derived from its depth map (near = bright).',
  params: [
    { k: 'vec2', name: 'light', label: 'Light position', def: [0.3, 0.3], min: 0, max: 1, gizmo: 'uv' },
    { k: 'float', name: 'height', label: 'Light height', def: 0.35, min: 0.01, max: 2 },
    { k: 'color', name: 'color', def: [1, 0.85, 0.65, 1] },
    { k: 'float', name: 'intensity', def: 1.6, min: 0, max: 8 },
    { k: 'float', name: 'ambient', def: 0.35, min: 0, max: 1.5 },
    { k: 'float', name: 'specular', def: 0.4, min: 0, max: 4 },
    { k: 'float', name: 'gloss', def: 24, min: 2, max: 200 },
    { k: 'float', name: 'relief', def: 6, min: 0, max: 40, help: 'How strongly depth bends the surface.' },
    { k: 'float', name: 'falloff', def: 1.5, min: 0, max: 10 },
    { k: 'float', name: 'rim', def: 0, min: 0, max: 4 },
    { k: 'color', name: 'rimColor', label: 'Rim colour', def: [0.4, 0.7, 1, 1] },
  ],
  body: /* wgsl */`
fn depthrelight_d(p: vec2f) -> f32 {
  if (u.has_depth < 0.5) { return 0.5; }
  return textureSampleLevel(depth, smp, p, 0.0).r;
}
fn op(uv: vec2f) -> vec4f {
  let c = textureSampleLevel(src, smp, uv, 0.0);
  let px = 2.0 / g.res;
  let dx = (depthrelight_d(uv + vec2f(px.x, 0.0)) - depthrelight_d(uv - vec2f(px.x, 0.0))) / (2.0 * px.y);
  let dy = (depthrelight_d(uv + vec2f(0.0, px.y)) - depthrelight_d(uv - vec2f(0.0, px.y))) / (2.0 * px.y);
  let n = normalize(vec3f(-dx * u.relief * 0.02, -dy * u.relief * 0.02, 1.0));
  let d = depthrelight_d(uv);
  let P = vec3f(uv.x * g.aspect, uv.y, d * 0.25);
  let L = vec3f(u.light.x * g.aspect, u.light.y, u.height);
  let lv = L - P;
  let dist = length(lv);
  let l = lv / max(dist, 1e-4);
  let att = 1.0 / (1.0 + u.falloff * dist * dist);
  let diff = max(dot(n, l), 0.0) * att;
  let hv = normalize(l + vec3f(0.0, 0.0, 1.0));
  let spec = pow(max(dot(n, hv), 0.0), u.gloss) * u.specular * att;
  let lc = u.color.rgb * u.intensity;
  var rgb = c.rgb * (u.ambient + diff * lc) + spec * lc * c.a;
  let rimT = pow(1.0 - sat(n.z), 2.0) * u.rim * 4.0;
  rgb += u.rimColor.rgb * rimT * c.a;
  return vec4f(rgb, c.a);
}`,
};

// ------------------------------------------------------------------------------------------------
// Depth Slices: exploded layers
// ------------------------------------------------------------------------------------------------
const depthslice: OpDef = {
  type: 'depthslice', label: 'Depth Slices', category: 'Distort',
  inputs: [{ name: 'src', type: 'tex' }, { name: 'depth', type: 'tex' }], output: 'tex',
  help: 'Cuts the picture into depth bands (near = bright) and pulls them apart: per-band offset, hue shift, gaps and hidden bands — the exploded-layers look.',
  params: [
    { k: 'int', name: 'bands', def: 6, min: 2, max: 16 },
    { k: 'vec2', name: 'dir', label: 'Direction', def: [0.4, -0.25], min: -1, max: 1, help: 'Offset per band (nearer bands move further).' },
    { k: 'float', name: 'spread', def: 0.04, min: 0, max: 0.3 },
    { k: 'float', name: 'wobble', def: 0.3, min: 0, max: 2, help: 'Animated breathing of the spread.' },
    { k: 'float', name: 'speed', def: 0.5, min: 0, max: 4 },
    { k: 'float', name: 'hue', label: 'Hue per band', def: 0.06, min: -0.5, max: 0.5 },
    { k: 'float', name: 'tint', def: 0.5, min: 0, max: 1, help: 'How much of the hue shift is applied.' },
    { k: 'float', name: 'gap', def: 0.12, min: 0, max: 0.9, help: 'Removes the edges of each band.' },
    { k: 'enum', name: 'show', options: ['All', 'Alternate', 'Near half', 'Far half'], def: 0 },
    { k: 'color', name: 'edgeColor', label: 'Edge glow', def: [0.3, 0.8, 1, 1] },
    { k: 'float', name: 'edgeGain', label: 'Edge glow amount', def: 0, min: 0, max: 8 },
  ],
  body: /* wgsl */`
fn depthslice_d(p: vec2f) -> f32 {
  if (u.has_depth < 0.5) { return 0.5; }
  return textureSampleLevel(depth, smp, p, 0.0).r;
}
fn depthslice_on(b: i32, n: i32) -> bool {
  if (u.show == 1) { return (b & 1) == 0; }
  if (u.show == 2) { return b >= n / 2; }
  if (u.show == 3) { return b < n / 2; }
  return true;
}
fn op(uv: vec2f) -> vec4f {
  let n = clamp(u.bands, 2, 16);
  let fn_ = f32(n);
  let dir = u.dir * vec2f(1.0 / g.aspect, 1.0);
  // nearest band first: it occludes the ones behind
  for (var b = n - 1; b >= 0; b--) {
    if (!depthslice_on(b, n)) { continue; }
    let fb = f32(b);
    let k = (fb - (fn_ - 1.0) * 0.5) * u.spread * (1.0 + u.wobble * sin(g.time * u.speed * TAU + fb * 1.3));
    let q = uv - dir * k;
    if (q.x < 0.0 || q.y < 0.0 || q.x > 1.0 || q.y > 1.0) { continue; }
    let d = sat(depthslice_d(q)) * fn_;
    let bi = min(i32(floor(d)), n - 1);
    if (bi != b) { continue; }
    let fr = d - floor(d);
    let hg = u.gap * 0.5;
    // gaps only at boundaries between bands, never at the nearest/farthest extremes
    if ((fr < hg && bi > 0) || (fr > 1.0 - hg && bi < n - 1)) { continue; }
    var c = textureSampleLevel(src, smp, q, 0.0);
    if (abs(u.hue) > 1e-5) {
      var hsv = rgb2hsv(max(c.rgb, vec3f(0.0)));
      hsv.x = fract(hsv.x + u.hue * fb);
      c = vec4f(mix(c.rgb, hsv2rgb(hsv), u.tint), c.a);
    }
    let e = min(select(fr - hg, 1.0, bi == 0), select(1.0 - hg - fr, 1.0, bi == n - 1));
    c = vec4f(c.rgb + u.edgeColor.rgb * u.edgeGain * exp(-e * 60.0) * c.a, c.a);
    return c;
  }
  return vec4f(0.0);
}`,
};

// ------------------------------------------------------------------------------------------------
// Depth Points: picture as a 3D point field, viewed from an orbiting camera (gather in a fragment pass)
// ------------------------------------------------------------------------------------------------
const pointcloud: OpDef = {
  type: 'pointcloud', label: 'Depth Points', category: 'Distort',
  inputs: [{ name: 'src', type: 'tex' }, { name: 'depth', type: 'tex' }], output: 'tex',
  help: 'Turns a picture and its depth map (near = bright) into a field of dots displaced in 3D and seen from an orbiting camera.',
  params: [
    { k: 'int', name: 'density', def: 140, min: 20, max: 400, help: 'Points across the picture height.' },
    { k: 'float', name: 'size', label: 'Point size', def: 0.7, min: 0.1, max: 2, help: 'Relative to the grid spacing.' },
    { k: 'float', name: 'depthScale', label: 'Depth', def: 0.5, min: 0, max: 2 },
    { k: 'float', name: 'yaw', def: 0, min: -60, max: 60, unit: '°' },
    { k: 'float', name: 'pitch', def: 0, min: -60, max: 60, unit: '°' },
    { k: 'float', name: 'orbit', label: 'Auto-orbit', def: 20, min: 0, max: 60, unit: '°', group: 'Motion' },
    { k: 'float', name: 'speed', def: 0.15, min: 0, max: 2, group: 'Motion' },
    { k: 'float', name: 'sizeByDepth', label: 'Size by depth', def: 0.5, min: 0, max: 1 },
    { k: 'bool', name: 'useSrc', label: 'Colour from source', def: true },
    { k: 'color', name: 'color', def: [0.6, 0.9, 1, 1] },
    { k: 'float', name: 'glow', def: 1, min: 0, max: 4 },
    { k: 'int', name: 'steps', def: 28, min: 6, max: 64, group: 'Quality' },
  ],
  body: /* wgsl */`
fn pc_rot(yaw: f32, pitch: f32) -> mat3x3f {
  let cy = cos(yaw); let sy = sin(yaw); let cp = cos(pitch); let sp = sin(pitch);
  let ry = mat3x3f(vec3f(cy, 0.0, -sy), vec3f(0.0, 1.0, 0.0), vec3f(sy, 0.0, cy));
  let rx = mat3x3f(vec3f(1.0, 0.0, 0.0), vec3f(0.0, cp, sp), vec3f(0.0, -sp, cp));
  return rx * ry;
}
fn pc_d(p: vec2f) -> f32 {
  if (u.has_depth < 0.5) { return 0.5; }
  return textureSampleLevel(depth, smpN, p, 0.0).r;
}
fn op(uv: vec2f) -> vec4f {
  let rows = f32(clamp(u.density, 8, 400));
  let cols = max(1.0, round(rows * g.aspect));
  let t = g.time * u.speed * TAU;
  let yaw = radians(u.yaw + u.orbit * sin(t));
  let pitch = radians(u.pitch + u.orbit * 0.4 * sin(t * 0.7 + 1.1));
  let R = pc_rot(yaw, pitch);
  let Rt = transpose(R);
  let camD = 2.5;
  let f = camD;
  let s = vec2f((uv.x - 0.5) * g.aspect, uv.y - 0.5);
  // camera ray in view space, taken to world space
  let o = Rt * vec3f(0.0, 0.0, camD);
  let dir = Rt * vec3f(s.x, s.y, -f);
  let n = clamp(u.steps, 6, 64);
  let zs = u.depthScale;
  var best = -1e9; var bestCol = vec4f(0.0);
  let cell = 1.0 / rows;
  let pxH = 1.0 / g.res.y;
  for (var i = 0; i <= n; i++) {
    let h = (0.5 - f32(i) / f32(n)) * zs;
    if (abs(dir.z) < 1e-5) { break; }
    let tt = (h - o.z) / dir.z;
    let P = o + dir * tt;
    let gc = vec2f((P.x / g.aspect + 0.5) * cols, (P.y + 0.5) * rows);
    let base = floor(gc);
    for (var j = -1; j <= 1; j++) { for (var k = -1; k <= 1; k++) {
      let cid = base + vec2f(f32(k), f32(j));
      if (cid.x < 0.0 || cid.y < 0.0 || cid.x >= cols || cid.y >= rows) { continue; }
      let cuv = (cid + 0.5) / vec2f(cols, rows);
      let d = pc_d(cuv);
      let W = vec3f((cuv.x - 0.5) * g.aspect, cuv.y - 0.5, (d - 0.5) * zs);
      let V = R * W;
      let den = camD - V.z;
      if (den < 0.05) { continue; }
      let sp = V.xy * f / den;
      let rad = 0.5 * cell * u.size * (f / den) * mix(1.0, 0.4 + 1.2 * d, u.sizeByDepth);
      let dist = length(sp - s);
      let cov = sat((rad - dist) / pxH + 0.5);
      if (cov > 0.0 && V.z > best) {
        best = V.z;
        var col = u.color;
        if (u.useSrc == 1) { col = textureSampleLevel(src, smp, cuv, 0.0) * vec4f(u.color.rgb, 1.0) / max(max(u.color.r, max(u.color.g, u.color.b)), 1e-3); }
        let core = 1.0 + u.glow * exp(-dist * dist / max(rad * rad * 0.15, 1e-9)) * 0.5;
        bestCol = vec4f(col.rgb * core, 1.0) * cov;
      }
    } }
  }
  return bestCol;
}`,
};

// ------------------------------------------------------------------------------------------------
// Tracker (pose / hands / objects) + Track Point signal
// ------------------------------------------------------------------------------------------------
const POSE_EDGES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28],
  [27, 29], [29, 31], [27, 31], [28, 30], [30, 32], [28, 32], [15, 17], [15, 19], [17, 19], [16, 18], [16, 20], [18, 20],
  [0, 1], [1, 2], [2, 3], [3, 7], [0, 4], [4, 5], [5, 6], [6, 8], [9, 10]];
const HAND_EDGES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13],
  [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]];
const MAXN = 128;

function classFilter(s: string): string[] { return s.split(',').map(x => x.trim().toLowerCase()).filter(Boolean); }
export function filteredBoxes(r: TrackResult, filter: string, minScore: number) {
  const f = classFilter(filter);
  return r.boxes.filter(b => b.score >= minScore && (!f.length || f.includes(b.label.toLowerCase())));
}

/** Pack overlay geometry: row 0 = segments (x0,y0,x1,y1), row 1 = segment colour (hue,..), row 2 = points (x,y,scale,hue). */
function packOverlay(r: TrackResult | null, filter: string, minScore: number, data: Uint16Array): [number, number] {
  let ns = 0, np = 0;
  const seg = (x0: number, y0: number, x1: number, y1: number, hue: number) => {
    if (ns >= MAXN) return;
    const o = ns * 4;
    data[o] = toHalf(x0); data[o + 1] = toHalf(y0); data[o + 2] = toHalf(x1); data[o + 3] = toHalf(y1);
    const o2 = (MAXN + ns) * 4;
    data[o2] = toHalf(hue); data[o2 + 1] = 0; data[o2 + 2] = 0; data[o2 + 3] = 0;
    ns++;
  };
  const pt = (x: number, y: number, sc: number, hue: number) => {
    if (np >= MAXN) return;
    const o = (2 * MAXN + np) * 4;
    data[o] = toHalf(x); data[o + 1] = toHalf(y); data[o + 2] = toHalf(sc); data[o + 3] = toHalf(hue);
    np++;
  };
  if (!r) return [0, 0];
  if (r.kind === 'objects') {
    for (const b of filteredBoxes(r, filter, minScore)) {
      let hsh = 0;
      for (let i = 0; i < b.label.length; i++) hsh = (hsh * 31 + b.label.charCodeAt(i)) >>> 0;
      const hue = (hsh % 360) / 360;
      seg(b.x, b.y, b.x + b.w, b.y, hue); seg(b.x + b.w, b.y, b.x + b.w, b.y + b.h, hue);
      seg(b.x + b.w, b.y + b.h, b.x, b.y + b.h, hue); seg(b.x, b.y + b.h, b.x, b.y, hue);
      pt(b.x + b.w / 2, b.y + b.h / 2, 1.5, hue);
      // score bar along the top edge, as a row of dots
      const dots = Math.max(1, Math.round(b.score * 8));
      for (let i = 0; i < dots; i++) pt(b.x + (i + 0.5) * 0.012, b.y - 0.012, 0.6, hue);
    }
    return [ns, np];
  }
  const edges = r.kind === 'pose' ? POSE_EDGES : HAND_EDGES;
  r.people.forEach((lm, pi) => {
    const hue = r.kind === 'hands' ? (r.labels[pi] === 'Left' ? 0.55 : 0.08) : 0.33 + pi * 0.4;
    for (const [a, b] of edges) {
      const A = lm[a], B = lm[b];
      if (!A || !B || Math.min(A.v, B.v) < 0.3) continue;
      seg(A.x, A.y, B.x, B.y, hue);
    }
    for (const p of lm) if (p.v >= 0.3) pt(p.x, p.y, 1, hue);
  });
  return [ns, np];
}

const track: OpDef = {
  type: 'track', label: 'Tracker', category: 'Filter', animated: true,
  inputs: [{ name: 'src', type: 'tex' }], output: 'tex',
  help: 'Finds bodies, hands or objects in the picture with MediaPipe (runs locally; models download on first use). Passes the picture through with an optional overlay. Read positions with Track Point nodes.',
  params: [
    { k: 'enum', name: 'model', options: ['Pose', 'Hands', 'Objects'], def: 0 },
    { k: 'string', name: 'classes', def: '', help: 'Objects only: comma-separated class names to keep (e.g. "person, cup"). Empty keeps all.' },
    { k: 'float', name: 'minScore', label: 'Min score', def: 0.4, min: 0, max: 1, help: 'Objects only: detections below this are ignored.' },
    { k: 'bool', name: 'overlay', def: true },
    { k: 'float', name: 'lineWidth', label: 'Line width', def: 0.003, min: 0.0005, max: 0.02, group: 'Overlay' },
    { k: 'float', name: 'dotSize', label: 'Dot size', def: 0.006, min: 0, max: 0.03, group: 'Overlay' },
    { k: 'float', name: 'gain', label: 'Brightness', def: 1.5, min: 0, max: 8, group: 'Overlay' },
  ],
  passes: {
    overlay: {
      inputs: ['src', 'geo'], fields: [['ns', 'i32'], ['np', 'i32'], ['lw', 'f32'], ['ds', 'f32'], ['gain', 'f32'], ['show', 'i32']],
      body: /* wgsl */`
fn op(uv: vec2f) -> vec4f {
  var c = textureSampleLevel(src, smp, uv, 0.0);
  if (u.show == 0) { return c; }
  let a = vec2f(g.aspect, 1.0);
  let px = 1.0 / g.res.y;
  let P = uv * a;
  var cov = 0.0; var col = vec3f(0.0);
  for (var i = 0; i < min(u.ns, ${MAXN}); i++) {
    let s = textureLoad(geo, vec2i(i, 0), 0);
    let A = s.xy * a; let B = s.zw * a;
    let ab = B - A;
    let t = sat(dot(P - A, ab) / max(dot(ab, ab), 1e-9));
    let d = length(P - A - ab * t);
    let k = sat((u.lw * 0.5 - d) / px + 0.5);
    if (k > cov) { cov = k; col = hsv2rgb(vec3f(textureLoad(geo, vec2i(i, 1), 0).x, 0.75, 1.0)); }
  }
  for (var i = 0; i < min(u.np, ${MAXN}); i++) {
    let p = textureLoad(geo, vec2i(i, 2), 0);
    let d = length(P - p.xy * a);
    let k = sat((u.ds * p.z - d) / px + 0.5);
    if (k > 0.0) { cov = max(cov, k); col = mix(col, vec3f(1.0), k); }
  }
  let ov = pow(col, vec3f(2.2)) * u.gain;
  return vec4f(mix(c.rgb, ov, cov), max(c.a, cov));
}`,
    },
  },
  cook(c) {
    const src = c.ins[0], st = c.inTex[0];
    if (!src || !st) { c.clear(c.out); return; }
    const name = c.doc.nodes.find(n => n.id === c.nodeId)?.name ?? c.nodeId;
    const r = ml.track(c.gpu, c.nodeId, name, src, st.width, st.height, c.p.model as 0 | 1 | 2, 512);
    if (r.status === 'error') throw new Error(r.msg);
    const s = c.state as { geo?: GPUTexture; data?: Uint16Array<ArrayBuffer>; view?: GPUTextureView };
    if (!s.geo) {
      s.geo = c.device.createTexture({ size: [MAXN, 3], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      s.view = s.geo.createView();
      s.data = new Uint16Array(MAXN * 3 * 4);
    }
    const [ns, np] = c.p.overlay ? packOverlay(r.result, String(c.p.classes ?? ''), c.p.minScore, s.data!) : [0, 0];
    if (ns || np) c.device.queue.writeTexture({ texture: s.geo }, s.data!, { bytesPerRow: MAXN * 8 }, [MAXN, 3]);
    c.run('overlay', c.out, [src, s.view!], { ns, np, lw: c.p.lineWidth, ds: c.p.dotSize, gain: c.p.gain, show: c.p.overlay && (ns || np) ? 1 : 0 });
  },
  dispose(state: any) { state?.geo?.destroy(); },
};

const POINTS: [string, 'pose' | 'hand' | 'box', number][] = [
  ['Nose', 'pose', 0], ['Left shoulder', 'pose', 11], ['Right shoulder', 'pose', 12], ['Left elbow', 'pose', 13], ['Right elbow', 'pose', 14],
  ['Left wrist', 'pose', 15], ['Right wrist', 'pose', 16], ['Left hip', 'pose', 23], ['Right hip', 'pose', 24], ['Left knee', 'pose', 25],
  ['Right knee', 'pose', 26], ['Left ankle', 'pose', 27], ['Right ankle', 'pose', 28],
  ['Hand wrist', 'hand', 0], ['Index tip', 'hand', 8], ['Thumb tip', 'hand', 4],
  ['Box centre', 'box', 0], ['Box size', 'box', 1],
];

const trackpoint: OpDef = {
  type: 'trackpoint', label: 'Track Point', category: 'Signal', inputs: [], output: 'sig',
  help: 'Reads one tracked point from a Tracker node, in 0..1 picture coordinates (origin top-left). Pose points need a Tracker set to Pose, hand points to Hands, box values to Objects.',
  params: [
    { k: 'string', name: 'source', def: '', help: 'Name of a Tracker node.' },
    { k: 'enum', name: 'point', options: POINTS.map(p => p[0]), def: 6 },
    { k: 'enum', name: 'axis', options: ['X', 'Y', 'Visibility / score', 'Speed'], def: 0, help: 'For Box size, X and Y are width and height.' },
    { k: 'int', name: 'index', label: 'Which', def: 0, min: 0, max: 7, help: 'Person, hand or box number (boxes are sorted by score).' },
    { k: 'float', name: 'lag', label: 'Smoothing', def: 0.08, min: 0, max: 2, unit: 's' },
    { k: 'string', name: 'classes', def: '', help: 'Boxes only: comma-separated classes to consider (empty = the Tracker\'s own filter result).' },
  ],
  sig(c) {
    const st = c.state as { v?: number; x?: number; y?: number; seq?: number; t?: number; speed?: number };
    if (c.reset) { st.v = undefined; st.x = undefined; st.y = undefined; st.seq = undefined; st.speed = 0; }
    if (!c.p.source) throw new Error('Pick a Tracker node in Source');
    const r = ml.tracks.get(c.p.source);
    const [, kind, idx] = POINTS[c.p.point] ?? POINTS[0];
    let x: number | null = null, y: number | null = null, score = 0, bw = 0, bh = 0;
    if (r) {
      if (kind === 'box' && r.kind === 'objects') {
        const boxes = filteredBoxes(r, String(c.p.classes ?? ''), 0).sort((a, b) => b.score - a.score);
        const b = boxes[c.p.index];
        if (b) { x = b.x + b.w / 2; y = b.y + b.h / 2; score = b.score; bw = b.w; bh = b.h; }
      } else if ((kind === 'pose' && r.kind === 'pose') || (kind === 'hand' && r.kind === 'hands')) {
        const p = r.people[c.p.index]?.[idx];
        if (p) { x = p.x; y = p.y; score = p.v; }
      }
    }
    // speed: distance between successive results per second of transport time
    if (r && x !== null && y !== null && r.seq !== st.seq) {
      if (st.x !== undefined && st.t !== undefined && c.time > st.t) st.speed = Math.hypot(x - st.x, y - (st.y ?? y)) / (c.time - st.t);
      else if (st.x === undefined) st.speed = 0;
      st.x = x; st.y = y; st.t = c.time; st.seq = r.seq;
    } else if (x === null) st.speed = 0;
    let raw: number;
    switch (c.p.axis) {
      case 0: raw = kind === 'box' && idx === 1 ? (x !== null ? bw : st.v ?? 0) : x ?? st.x ?? 0.5; break;
      case 1: raw = kind === 'box' && idx === 1 ? (y !== null ? bh : st.v ?? 0) : y ?? st.y ?? 0.5; break;
      case 2: raw = x !== null ? score : 0; break;
      default: raw = st.speed ?? 0;
    }
    if (st.v === undefined) st.v = raw;
    st.v += (raw - st.v) * (c.p.lag > 0 && c.dt > 0 ? 1 - Math.exp(-c.dt / c.p.lag) : 1);
    return st.v;
  },
};

export const ops: OpDef[] = [depth, matte, parallax, depthfog, depthdof, depthrelight, depthslice, pointcloud, track, trackpoint];
