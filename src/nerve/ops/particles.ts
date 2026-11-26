// GPU particle systems: a full emitter/forces/camera particle engine, footage-to-point-cloud, and flow-field trails.
// State lives in rgba16float textures (one texel per particle) updated by fullscreen passes; drawing is a raw
// instanced-quad pipeline in this file that reads those textures in the vertex shader.
import type { CookCtx, Field, OpDef, ParamDef, PassDecl, Vals } from '../types';
import { PRELUDE } from '../wgsl';

// ------------------------------------------------------------------------------------------------
// Matrix helpers (column-major, like WGSL)
// ------------------------------------------------------------------------------------------------
type M4 = Float32Array;
const mul = (a: M4, b: M4): M4 => {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
};
const ident = (): M4 => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const trans = (x: number, y: number, z: number): M4 => { const m = ident(); m[12] = x; m[13] = y; m[14] = z; return m; };
const rotX = (a: number): M4 => { const m = ident(), c = Math.cos(a), s = Math.sin(a); m[5] = c; m[6] = s; m[9] = -s; m[10] = c; return m; };
const rotY = (a: number): M4 => { const m = ident(), c = Math.cos(a), s = Math.sin(a); m[0] = c; m[2] = -s; m[8] = s; m[10] = c; return m; };
const persp = (fovY: number, aspect: number, near: number, far: number): M4 => {
  const f = 1 / Math.tan(fovY / 2), m = new Float32Array(16);
  m[0] = f / aspect; m[5] = f; m[10] = far / (near - far); m[11] = -1; m[14] = (near * far) / (near - far);
  return m;
};
const DEG = Math.PI / 180;

/**
 * Orbit camera around the picture centre. World units: picture spans x ∈ ±aspect, y ∈ ±1 (y up) at z = 0.
 * Distance is relative to the framing distance, so at distance 1 with yaw = pitch = 0 the z = 0 plane fills the
 * frame exactly whatever the field of view (a particle at a footage pixel sits exactly over that pixel).
 */
function camera(yaw: number, pitch: number, dist: number, fov: number, aspect: number) {
  const fv = Math.min(Math.max(fov, 1), 170) * DEG;
  const f = 1 / Math.tan(fv / 2);
  const view = mul(trans(0, 0, -Math.max(dist, 0.01) * f), mul(rotX(pitch * DEG), rotY(-yaw * DEG)));
  return { vp: mul(persp(fv, aspect, 0.01, 200), view), f };
}
const uvToWorld = (uv: number[], aspect: number): [number, number] => [(uv[0] - 0.5) * 2 * aspect, (0.5 - uv[1]) * 2];

// ------------------------------------------------------------------------------------------------
// Shared WGSL
// ------------------------------------------------------------------------------------------------
/** Helpers that need only the prelude (used by the sim passes and the render shader). */
const COMMON = /* wgsl */`
fn pt_pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn pt_rnd(k: ptr<function, u32>) -> f32 { *k = pt_pcg(*k); return f32(*k >> 8u) * (1.0 / 16777216.0); }
fn pt_unit(k: ptr<function, u32>) -> vec3f {
  let z = pt_rnd(k) * 2.0 - 1.0; let a = pt_rnd(k) * TAU; let r = sqrt(max(1.0 - z * z, 0.0));
  return vec3f(r * cos(a), r * sin(a), z);
}
fn pt_spectrum(t: f32) -> vec3f { return max(palette(t, vec3f(0.5), vec3f(0.55), vec3f(1.0), vec3f(0.0, 0.33, 0.67)), vec3f(0.0)); }
// vector potential for divergence-free 3D curl noise; each component drifts differently so the field morphs
fn pt_pot(p: vec3f, t: f32) -> vec3f {
  return vec3f(snoise(p + vec3f(t * 0.7, 0.0, t * 0.3)),
               snoise(p + vec3f(31.4, -47.8 + t * 0.6, 12.8)),
               snoise(p + vec3f(-23.1, 17.1, 39.4 - t * 0.65)));
}
fn pt_curl(p: vec3f, t: f32) -> vec3f {
  let e = 0.1;
  let a = pt_pot(p, t);
  let dx = pt_pot(p + vec3f(e, 0.0, 0.0), t); let dy = pt_pot(p + vec3f(0.0, e, 0.0), t); let dz = pt_pot(p + vec3f(0.0, 0.0, e), t);
  return vec3f((dy.z - a.z) - (dz.y - a.y), (dz.x - a.x) - (dx.z - a.z), (dx.y - a.y) - (dy.x - a.x)) / e;
}
// 2D stream-function curl (divergence-free in the plane), cheaper for flat simulations
fn pt_curl2(p: vec2f, t: f32) -> vec3f {
  let e = 0.05;
  let a = snoise(vec3f(p, t)); let dx = snoise(vec3f(p + vec2f(e, 0.0), t)); let dy = snoise(vec3f(p + vec2f(0.0, e), t));
  return vec3f(dy - a, -(dx - a), 0.0) / e;
}
// stochastic rounding to half precision: dither by one f16 ulp so slow motion is not lost to quantisation
fn pt_round(x: vec4f, k: ptr<function, u32>) -> vec4f {
  let e = exp2(floor(log2(max(abs(x), vec4f(6.2e-5)))) - 10.0);
  return x + (vec4f(pt_rnd(k), pt_rnd(k), pt_rnd(k), pt_rnd(k)) - 0.5) * e;
}
`;

const SIM_FIELDS: Field[] = [
  ['dt', 'f32'], ['tick', 'i32'], ['seed', 'i32'], ['mode', 'i32'], ['aspect', 'f32'],
  ['shape', 'i32'], ['emit', 'vec3f'], ['emitVel', 'vec3f'], ['esize', 'f32'], ['speed', 'f32'], ['spread', 'f32'], ['dir', 'vec2f'],
  ['life', 'f32'], ['lifeRand', 'f32'], ['gravity', 'vec2f'], ['drag', 'f32'], ['turb', 'f32'], ['turbScale', 'f32'], ['turbTime', 'f32'],
  ['audioAmt', 'f32'], ['vortex', 'f32'], ['attract', 'vec2f'], ['attractStr', 'f32'], ['attractFall', 'f32'], ['forceAmt', 'f32'],
  ['depth', 'f32'], ['floorOn', 'i32'], ['floorY', 'f32'], ['bounce', 'f32'], ['bounds', 'i32'], ['follow', 'f32'], ['respawn', 'f32'],
];

/** Simulation library. Requires a `src` texture input in the pass. mode: 0 step, 1 respawn all (burst), 2 seed. */
const SIM_LIB = COMMON + /* wgsl */`
fn pt_index(uv: vec2f) -> vec2i { return vec2i(floor(uv * g.res)); }
fn pt_id(ij: vec2i) -> u32 { return u32(ij.y) * u32(g.res.x) + u32(ij.x); }
fn pt_key(id: u32, salt: u32) -> u32 { return pt_pcg(id ^ pt_pcg(u32(u.tick) * 2654435769u + pt_pcg(u32(u.seed) * 7919u + salt))); }
fn pt_world(q: vec2f) -> vec2f { return vec2f((q.x - 0.5) * 2.0 * u.aspect, (0.5 - q.y) * 2.0); }
fn pt_uvOf(p: vec3f) -> vec2f { return vec2f(p.x / (2.0 * u.aspect) + 0.5, 0.5 - p.y * 0.5); }
fn pt_zb() -> f32 { return max(u.depth, 0.1) * 1.5; }
fn pt_out(p: vec3f) -> bool { return abs(p.x) > u.aspect * 1.05 || abs(p.y) > 1.05 || abs(p.z) > pt_zb(); }
fn pt_wrap(x: f32, b: f32) -> f32 { return x - 2.0 * b * floor((x + b) / (2.0 * b)); }

struct PtBirth { p: vec3f, v: vec3f, life: f32, col: vec4f, age: f32 };

fn pt_birth(id: u32) -> PtBirth {
  var k = pt_key(id, 17u);
  var b: PtBirth;
  b.col = vec4f(1.0);
  var p = u.emit;
  let r = u.esize;
  var shape = u.shape;
  if (shape == 0 && u.has_src < 0.5) { shape = 8; }
  var fromSrc = false;
  if (shape == 0) {
    // pick a pixel with probability proportional to its brightness (rejection sampling, keep the best try)
    var best = vec2f(0.5); var bestL = -1.0; var bc = vec4f(0.0);
    for (var i = 0; i < 10; i++) {
      let q = vec2f(pt_rnd(&k), pt_rnd(&k));
      let s = textureSampleLevel(src, smp, q, 0.0);
      let l = sat(luma(s.rgb)) * sat(s.a);
      if (pt_rnd(&k) < l * 1.25) { best = q; bc = s; break; }
      if (l > bestL) { bestL = l; best = q; bc = s; }
    }
    p = vec3f(pt_world(best), 0.0);
    b.col = bc; fromSrc = true;
  } else if (shape == 2) {
    p += vec3f(vec2f(-u.dir.y, u.dir.x) * (pt_rnd(&k) * 2.0 - 1.0) * r, 0.0);
  } else if (shape == 3) {
    let a = pt_rnd(&k) * TAU; let rr = r * (1.0 + (pt_rnd(&k) - 0.5) * 0.05);
    p += vec3f(cos(a) * rr, sin(a) * rr, (pt_rnd(&k) - 0.5) * r * 0.05);
  } else if (shape == 4) {
    let a = pt_rnd(&k) * TAU; let rr = r * sqrt(pt_rnd(&k));
    p += vec3f(cos(a) * rr, sin(a) * rr, 0.0);
  } else if (shape == 5) {
    p += pt_unit(&k) * r * (0.97 + 0.03 * pt_rnd(&k));
  } else if (shape == 6) {
    p += (vec3f(pt_rnd(&k), pt_rnd(&k), pt_rnd(&k)) * 2.0 - 1.0) * r;
  } else if (shape == 7) {
    let n = u32(g.res.x);
    let gp = (vec2f(f32(id % n), f32(id / n)) + 0.5) / g.res.x;
    p += vec3f((gp.x * 2.0 - 1.0) * r * u.aspect, (1.0 - gp.y * 2.0) * r, 0.0);
  } else if (shape == 8) {
    p = vec3f(pt_world(vec2f(pt_rnd(&k), pt_rnd(&k))), 0.0);
  }
  p.z *= u.depth;
  if (!fromSrc && u.has_src > 0.5) { b.col = textureSampleLevel(src, smp, clamp(pt_uvOf(p), vec2f(0.0), vec2f(1.0)), 0.0); }
  let q = pt_unit(&k);
  var d = mix(vec3f(u.dir, 0.0), q, u.spread);
  if (length(d) < 1e-3) { d = q; }
  var v = normalize(d) * u.speed * (0.7 + 0.6 * pt_rnd(&k));
  v.z *= u.depth;
  b.v = v + u.emitVel;
  b.life = max(u.life * (1.0 - u.lifeRand * pt_rnd(&k)), 0.05);
  b.age = select(0.0, pt_rnd(&k) * b.life, u.mode == 2);
  b.p = p;
  return b;
}

fn pt_dies(p0: vec4f, life: f32, id: u32) -> bool {
  if (u.mode == 1) { return true; }
  if (!all(abs(p0) < vec4f(1e4))) { return true; }
  if (p0.w + u.dt >= life) { return true; }
  if (u.bounds == 2 && pt_out(p0.xyz)) { return true; }
  if (u.respawn > 0.0) { var k = pt_key(id, 91u); if (pt_rnd(&k) < u.respawn * u.dt) { return true; } }
  return false;
}
`;

const SIM_PASSES: Record<string, PassDecl> = {
  pt_vel: {
    inputs: ['pos', 'vel', 'src', 'force'], fields: SIM_FIELDS,
    body: SIM_LIB + /* wgsl */`
fn op(uv: vec2f) -> vec4f {
  let ij = pt_index(uv); let id = pt_id(ij);
  let p0 = textureLoad(pos, ij, 0); let v0 = textureLoad(vel, ij, 0);
  if (u.mode == 2 || pt_dies(p0, v0.w, id)) { let b = pt_birth(id); return vec4f(b.v, b.life); }
  let p = p0.xyz;
  var acc = vec3f(u.gravity, 0.0);
  var flow = vec3f(0.0);
  if (u.turb != 0.0) {
    let amt = u.turb * (1.0 + g.audio.x * u.audioAmt);
    if (u.depth <= 0.001) { flow += pt_curl2(p.xy * u.turbScale, u.turbTime) * amt; }
    else { var cv = pt_curl(p * u.turbScale, u.turbTime); cv.z *= u.depth; flow += cv * amt; }
  }
  if (u.has_force > 0.5) {
    let q = pt_uvOf(p);
    if (all(q >= vec2f(0.0)) && all(q <= vec2f(1.0))) {
      // Optical-Flow convention: rg / 40 = uv per frame; convert to world units per second
      let f = textureSampleLevel(force, smp, q, 0.0).rg / 40.0 * 60.0;
      flow += vec3f(f.x * 2.0 * u.aspect, -f.y * 2.0, 0.0) * u.forceAmt * mix(3.0, 1.0, u.follow);
    }
  }
  if (u.vortex != 0.0) { let d = p.xy - u.emit.xy; let l = length(d); acc += vec3f(-d.y, d.x, 0.0) / (l * l + 0.05) * u.vortex; }
  if (u.attractStr != 0.0) {
    let d = vec3f(u.attract, 0.0) - p; let l = length(d) + 1e-4; let fl = l / max(u.attractFall, 1e-3);
    acc += d / l * u.attractStr / (1.0 + fl * fl);
  }
  var v = (v0.xyz + (acc + flow) * u.dt) * exp(-u.drag * u.dt);
  v = mix(v, flow, u.follow);
  if (u.floorOn == 1 && p.y + v.y * u.dt < u.floorY && v.y < 0.0) { v = vec3f(v.x * 0.9, -v.y * u.bounce, v.z * 0.9); }
  let sp = length(v);
  if (sp > 20.0) { v *= 20.0 / sp; }
  return vec4f(v, v0.w);
}`,
  },
  pt_pos: {
    inputs: ['pos', 'vel', 'nvel', 'src'], fields: SIM_FIELDS,
    body: SIM_LIB + /* wgsl */`
fn op(uv: vec2f) -> vec4f {
  let ij = pt_index(uv); let id = pt_id(ij);
  let p0 = textureLoad(pos, ij, 0); let v0 = textureLoad(vel, ij, 0);
  if (u.mode == 2) {
    let b = pt_birth(id);
    var p = b.p + b.v * b.age * 0.5;
    if (u.floorOn == 1) { p.y = max(p.y, u.floorY); }
    return vec4f(p, b.age);
  }
  if (pt_dies(p0, v0.w, id)) { let b = pt_birth(id); return vec4f(b.p, 0.0); }
  var p = p0.xyz + textureLoad(nvel, ij, 0).xyz * u.dt;
  if (u.floorOn == 1) { p.y = max(p.y, u.floorY); }
  if (u.bounds == 1) { p = vec3f(pt_wrap(p.x, u.aspect), pt_wrap(p.y, 1.0), pt_wrap(p.z, pt_zb())); }
  var k = pt_key(id, 53u);
  return pt_round(vec4f(p, p0.w + u.dt), &k);
}`,
  },
  pt_col: {
    inputs: ['pos', 'vel', 'col', 'src'], fields: SIM_FIELDS,
    body: SIM_LIB + /* wgsl */`
fn op(uv: vec2f) -> vec4f {
  let ij = pt_index(uv); let id = pt_id(ij);
  let p0 = textureLoad(pos, ij, 0); let v0 = textureLoad(vel, ij, 0);
  if (u.mode == 2 || pt_dies(p0, v0.w, id)) { return pt_birth(id).col; }
  return textureLoad(col, ij, 0);
}`,
  },
};

// ------------------------------------------------------------------------------------------------
// Render pipeline: instanced camera-facing quads (triangle strip, 4 verts per particle)
// ------------------------------------------------------------------------------------------------
const RENDER = PRELUDE + COMMON + /* wgsl */`
struct PU {
  vp: mat4x4f,
  a: vec4f,     // resX, resY, texW, kind (0 = simulated particles, 1 = image grid)
  b: vec4f,     // world radius, size-by-age, size randomness, streak seconds
  c: vec4f,     // colour mode, opacity, soft edge, exposure gain
  colA: vec4f,
  colB: vec4f,
  d: vec4f,     // hue (turns), fade fraction, footage colour texture bound, time
  e: vec4f,     // aspect, depth amount, jitter, grid columns
  f: vec4f,     // grid rows, has src, has depth, focal
};
@group(0) @binding(1) var<uniform> pu: PU;
@group(0) @binding(5) var t0: texture_2d<f32>;
@group(0) @binding(6) var t1: texture_2d<f32>;
@group(0) @binding(7) var t2: texture_2d<f32>;
@group(0) @binding(8) var t3: texture_2d<f32>;

struct VOut { @builtin(position) pos: vec4f, @location(0) q: vec4f, @location(1) col: vec4f };

fn pt_h(i: u32, salt: u32) -> f32 { return f32(pt_pcg(i * 3u + salt) >> 8u) * (1.0 / 16777216.0); }

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  var o: VOut;
  o.pos = vec4f(2.0, 2.0, 2.0, 1.0); o.q = vec4f(0.0, 0.0, 0.0, 1.0); o.col = vec4f(0.0);
  let corner = vec2f(f32(vi & 1u), f32((vi >> 1u) & 1u)) * 2.0 - 1.0;
  var P = vec3f(0.0); var vel = vec3f(0.0); var rgb = vec3f(1.0);
  var radius = pu.b.x; var alpha = pu.c.y;
  let hr = pt_h(ii, 7u);
  if (pu.a.w < 0.5) {
    let W = u32(pu.a.z);
    let ij = vec2i(i32(ii % W), i32(ii / W));
    let P4 = textureLoad(t0, ij, 0); let V4 = textureLoad(t1, ij, 0);
    let life = V4.w;
    if (life <= 0.0 || P4.w >= life) { return o; }
    let a = sat(P4.w / life);
    P = P4.xyz; vel = V4.xyz;
    let fd = max(pu.d.y, 1e-3);
    alpha *= sat(a / fd) * sat((1.0 - a) / fd);
    radius *= max(1.0 + pu.b.y * (a - 0.5) * 2.0, 0.0) * mix(1.0, 0.3 + 1.4 * hr, pu.b.z);
    let m = i32(pu.c.x);
    let st = 1.0 - exp(-length(vel) * 1.4);
    if (m == 0) {
      if (pu.d.z > 0.5) { rgb = textureLoad(t2, ij, 0).rgb; } else { rgb = mix(pu.colA.rgb, pu.colB.rgb, st); }
    } else if (m == 1) { rgb = mix(pu.colA.rgb, pu.colB.rgb, a); }
    else if (m == 2) { rgb = mix(pu.colA.rgb, pu.colB.rgb, st); }
    else if (m == 3) { rgb = pt_spectrum(hr + a * 0.15 + pu.d.x); }
    else if (m == 4) { rgb = pt_spectrum(atan2(vel.y, vel.x) / TAU + pu.d.x); }
    else if (m == 5) { rgb = pt_spectrum(st * 0.85 + pu.d.x); }
    else { rgb = pu.colA.rgb; }
  } else {
    let cols = u32(pu.e.w); let rows = u32(pu.f.x);
    if (ii >= cols * rows) { return o; }
    let ij = vec2i(i32(ii % cols), i32(ii / cols));
    let jit = (vec2f(hr, pt_h(ii, 11u)) - 0.5) * pu.e.z;
    let huv = (vec2f(ij) + 0.5 + jit) / vec2f(f32(cols), f32(rows));
    var s = vec4f(0.0, 0.0, 0.0, 1.0);
    if (pu.f.y > 0.5) { s = textureSampleLevel(t2, smp, huv, 0.0); }
    else {
      let t = pu.d.w;
      let cp = (huv - 0.5) * vec2f(pu.e.x, 1.0) * 2.0;
      let n = snoise(vec3f(cp * 1.6, t * 0.15));
      let rings = 0.5 + 0.5 * sin(length(cp) * 9.0 - t * 1.2 + n * 3.0);
      s = vec4f(pt_spectrum(length(cp) * 0.35 - t * 0.05 + n * 0.25) * (0.15 + 0.85 * rings * rings), 1.0);
    }
    var z = luma(s.rgb);
    if (pu.f.z > 0.5) { z = luma(textureSampleLevel(t3, smp, huv, 0.0).rgb); }
    let disp = textureLoad(t0, ij, 0).xyz;
    vel = textureLoad(t1, ij, 0).xyz;
    P = vec3f((huv.x - 0.5) * 2.0 * pu.e.x, (0.5 - huv.y) * 2.0, z * pu.e.y) + disp;
    rgb = s.rgb; alpha *= sat(s.a);
  }
  let cp = pu.vp * vec4f(P, 1.0);
  if (cp.w < 0.02 || alpha <= 0.0 || radius <= 0.0) { return o; }
  let res = pu.a.xy;
  var rpx = radius * pu.f.w / cp.w * res.y * 0.5;
  var gain = 1.0;
  // sub-pixel sprites: keep them one pixel wide and dim them instead, so dense clouds do not shimmer
  if (rpx < 0.75) { gain = rpx * rpx / 0.5625; rpx = 0.75; }
  var dirS = vec2f(1.0, 0.0); var L = 0.0;
  if (pu.b.w > 0.0) {
    let cq = pu.vp * vec4f(P - vel * pu.b.w, 1.0);
    if (cq.w > 0.02) {
      let dd = (cp.xy / cp.w - cq.xy / cq.w) * res * 0.5;
      let len = length(dd);
      if (len > 1e-3) { dirS = dd / len; L = min(len, res.y * 0.25) * 0.5; }
    }
  }
  gain /= 1.0 + 4.0 * L / (PI * rpx);
  let local = vec2f(corner.x * (L + rpx + 0.5), corner.y * (rpx + 0.5));
  let off = dirS * (local.x - L) + vec2f(-dirS.y, dirS.x) * local.y;
  o.pos = vec4f(cp.xy + off / (res * 0.5) * cp.w, cp.zw);
  o.q = vec4f(local, L, rpx);
  let k = alpha * gain;
  o.col = vec4f(max(rgb, vec3f(0.0)) * pu.c.w * k, k);
  return o;
}

@fragment fn fs(i: VOut) -> @location(0) vec4f {
  let L = i.q.z; let r = i.q.w;
  let d = length(vec2f(max(abs(i.q.x) - L, 0.0), i.q.y)) / r;
  if (d >= 1.0 + 0.5 / r) { discard; }
  let hard = sat((1.0 - d) * r + 0.5);
  let s1 = sat(1.0 - d * d);
  return i.col * mix(hard, s1 * s1, pu.c.z);
}
`;

interface Shared { add: GPURenderPipeline; normal: GPURenderPipeline; bgl: GPUBindGroupLayout }
const shared = new WeakMap<GPUDevice, Shared>();
function getShared(dev: GPUDevice): Shared {
  let s = shared.get(dev);
  if (!s) {
    const V = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    const bgl = dev.createBindGroupLayout({
      label: 'particles', entries: [
        { binding: 0, visibility: V, buffer: {} },
        { binding: 1, visibility: V, buffer: {} },
        { binding: 2, visibility: V, sampler: {} },
        { binding: 3, visibility: V, sampler: {} },
        { binding: 4, visibility: V, sampler: { type: 'non-filtering' } },
        ...[5, 6, 7, 8].map(binding => ({ binding, visibility: V, texture: { sampleType: 'float' as const } })),
      ],
    });
    const module = dev.createShaderModule({ code: RENDER, label: 'particles' });
    const layout = dev.createPipelineLayout({ bindGroupLayouts: [bgl] });
    const make = (blend: GPUBlendState) => dev.createRenderPipeline({
      label: 'particles', layout,
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba16float', blend }] },
      primitive: { topology: 'triangle-strip', cullMode: 'none' },
    });
    const over = { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } as const;
    s = {
      bgl,
      add: make({ color: { srcFactor: 'one', dstFactor: 'one' }, alpha: over }),
      normal: make({ color: over, alpha: over }),
    };
    shared.set(dev, s);
  }
  return s;
}

interface Draw {
  kind: 0 | 1; texW: number; count: number;
  radius: number; sizeAge?: number; sizeRand?: number; stretch: number;
  colorMode?: number; opacity: number; soft: number; exposure: number;
  colA?: number[]; colB?: number[]; hue?: number; fade?: number; hasCol?: boolean;
  zAmt?: number; jitter?: number; cols?: number; rows?: number; hasSrc?: boolean; hasDepth?: boolean;
  blend: number; cam: { yaw: number; pitch: number; dist: number; fov: number };
  texs: (GPUTextureView | null)[];
  /** 'under' = copy this texture first; 'load' = draw over what is already in c.out; otherwise clear to black. */
  under?: GPUTexture | null; load?: boolean;
}

function draw(c: CookCtx, d: Draw) {
  const dev = c.device, s = getShared(dev);
  const st = c.state as { rbuf?: GPUBuffer };
  st.rbuf ??= dev.createBuffer({ size: 208, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const aspect = c.w / c.h;
  const cam = camera(d.cam.yaw, d.cam.pitch, d.cam.dist, d.cam.fov, aspect);
  const u = new Float32Array(52);
  u.set(cam.vp, 0);
  u.set([c.w, c.h, d.texW, d.kind], 16);
  u.set([d.radius, d.sizeAge ?? 0, d.sizeRand ?? 0, d.stretch], 20);
  u.set([d.colorMode ?? 0, d.opacity, d.soft, Math.pow(2, d.exposure)], 24);
  u.set(d.colA ?? [1, 1, 1, 1], 28);
  u.set(d.colB ?? [1, 1, 1, 1], 32);
  u.set([(d.hue ?? 0) / 360, d.fade ?? 0, d.hasCol ? 1 : 0, c.time], 36);
  u.set([aspect, d.zAmt ?? 0, d.jitter ?? 0, d.cols ?? 1], 40);
  u.set([d.rows ?? 1, d.hasSrc ? 1 : 0, d.hasDepth ? 1 : 0, cam.f], 44);
  dev.queue.writeBuffer(st.rbuf, 0, u as BufferSource);
  let load = !!d.load;
  if (d.under) { c.copy(d.under, c.outTex); load = d.under.width === c.outTex.width && d.under.height === c.outTex.height; }
  const g = c.gpu;
  const bg = dev.createBindGroup({
    layout: s.bgl, entries: [
      { binding: 0, resource: { buffer: g.gbuf } },
      { binding: 1, resource: { buffer: st.rbuf } },
      { binding: 2, resource: g.smp }, { binding: 3, resource: g.smpR }, { binding: 4, resource: g.smpN },
      ...[0, 1, 2, 3].map(i => ({ binding: 5 + i, resource: d.texs[i] ?? g.black })),
    ],
  });
  const enc = dev.createCommandEncoder();
  const rp = enc.beginRenderPass({ colorAttachments: [{ view: c.out, loadOp: load ? 'load' : 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
  rp.setPipeline(d.blend === 1 ? s.normal : s.add);
  rp.setBindGroup(0, bg);
  rp.draw(4, d.count);
  rp.end();
  dev.queue.submit([enc.finish()]);
}

// ------------------------------------------------------------------------------------------------
// Simulation driver shared by Particles and Particle Trails
// ------------------------------------------------------------------------------------------------
interface SimState { cur?: number; tick?: number; burstHigh?: boolean; burstPending?: boolean; prevE?: [number, number]; rbuf?: GPUBuffer }
type View = GPUTextureView;

/** Steps the simulation (or seeds it) and returns the current position/velocity/colour views. */
function simulate(c: CookCtx, S: number, vals: Vals, src: View | null, force: View | null, needCol: boolean, reseed: boolean, burst: boolean) {
  const st = c.state as SimState;
  const t = [0, 1].map(i => ({ p: c.tex(`pp${i}`, S, S), v: c.tex(`pv${i}`, S, S), c: needCol ? c.tex(`pc${i}`, S, S) : null }));
  const fresh = t.some(x => x.p.fresh || x.v.fresh);
  st.cur ??= 0;
  const dt = Math.min(Math.max(c.dt, 0), 1 / 24);
  const seed = reseed || fresh || c.reset;
  const step = (mode: number, d: number) => {
    const a = t[st.cur!], b = t[1 - st.cur!];
    const v: Vals = { ...vals, dt: d, tick: st.tick ?? 0, mode };
    c.run('pt_vel', b.v.view, [a.p.view, a.v.view, src, force], v, [S, S]);
    if (a.c && b.c) c.run('pt_col', b.c.view, [a.p.view, a.v.view, a.c.view, src], v, [S, S]);
    c.run('pt_pos', b.p.view, [a.p.view, a.v.view, b.v.view, src], v, [S, S]);
    st.cur = 1 - st.cur!;
  };
  if (seed) { st.tick = 0; st.burstPending = false; step(2, 0); }
  else if (dt > 0) {
    st.tick = ((st.tick ?? 0) + 1) | 0;
    step(burst ? 1 : 0, dt);
  }
  const r = t[st.cur];
  return { pos: r.p.view, vel: r.v.view, col: r.c?.view ?? null, stepped: seed || dt > 0, dt };
}

const COUNT_OPTS = ['65K', '262K', '1M', '4M'];
const COUNT_S = [256, 512, 1024, 2048];
const SPECTRUM_HELP = 'Spectrum modes cycle through a rainbow palette; Hue rotates it.';

const camParams = (g: string, yaw: number, pitch: number, dist: number, orbit: number): ParamDef[] => [
  { k: 'float', name: 'yaw', label: 'Orbit', def: yaw, min: -180, max: 180, unit: '°', group: g },
  { k: 'float', name: 'pitch', label: 'Tilt', def: pitch, min: -89, max: 89, unit: '°', group: g },
  { k: 'float', name: 'distance', def: dist, min: 0.2, max: 5, group: g, help: 'Relative to the framing distance: at 1, with Orbit and Tilt at 0, the picture plane fills the frame exactly.' },
  { k: 'float', name: 'fov', label: 'Field of view', def: 40, min: 5, max: 120, unit: '°', group: g, help: 'Changes perspective strength while keeping the picture plane framed.' },
  { k: 'float', name: 'autoOrbit', label: 'Auto orbit', def: orbit, min: -90, max: 90, unit: '°/s', group: g, help: 'Continuous camera turn. Set to 0 to keep particles registered over the footage.' },
];
const camOf = (c: CookCtx) => ({ yaw: c.p.yaw + c.p.autoOrbit * c.time, pitch: c.p.pitch, dist: c.p.distance, fov: c.p.fov });

// ------------------------------------------------------------------------------------------------
// Particles
// ------------------------------------------------------------------------------------------------
const particles: OpDef = {
  type: 'particles', label: 'Particles', category: 'Simulate', output: 'tex', animated: true,
  inputs: [{ name: 'src', type: 'tex', optional: true }, { name: 'force', type: 'field', optional: true }, { name: 'under', type: 'tex', optional: true }],
  help: 'A GPU particle system with up to four million particles. Connect footage to Source and set Shape to Source image to turn the picture into particles that take its colours; connect Optical Flow or Curl Noise to Force to push them around; Under is drawn behind.',
  params: [
    { k: 'enum', name: 'count', options: COUNT_OPTS, def: 1, group: 'Emit', help: 'Number of particles. 1M runs comfortably in real time on a recent laptop GPU.' },
    { k: 'enum', name: 'shape', options: ['Source image', 'Point', 'Line', 'Ring', 'Disc', 'Sphere', 'Box', 'Grid plane'], def: 3, group: 'Emit', help: 'Source image births particles on bright pixels of the Source footage (the whole frame when nothing is connected).' },
    { k: 'vec2', name: 'emitPos', label: 'Position', def: [0.5, 0.5], min: -0.5, max: 1.5, step: 0.001, gizmo: 'uv', group: 'Emit' },
    { k: 'float', name: 'emitSize', label: 'Size', def: 0.5, min: 0, max: 2, group: 'Emit', help: 'Emitter radius; 1 is half the picture height.' },
    { k: 'float', name: 'speed', label: 'Initial speed', def: 0.06, min: 0, max: 3, group: 'Emit' },
    { k: 'float', name: 'spread', def: 1, min: 0, max: 1, group: 'Emit', help: '0 fires every particle along Direction; 1 fires in all directions.' },
    { k: 'float', name: 'angle', label: 'Direction', def: 90, min: -180, max: 180, unit: '°', group: 'Emit', help: '90° is straight up.' },
    { k: 'float', name: 'life', label: 'Lifetime', def: 4, min: 0.1, max: 30, unit: 's', group: 'Emit' },
    { k: 'float', name: 'lifeRand', label: 'Lifetime random', def: 0.6, min: 0, max: 1, group: 'Emit' },
    { k: 'float', name: 'burst', def: 0, min: 0, max: 1, group: 'Emit', help: 'Rising past 0.5 respawns every particle at once. Drive it with kick in an expression.' },
    { k: 'float', name: 'inherit', label: 'Inherit motion', def: 0.5, min: 0, max: 2, group: 'Emit', help: 'How much of the emitter\'s own movement new particles carry.' },
    { k: 'int', name: 'seed', def: 1, min: 0, max: 9999, group: 'Emit' },
    { k: 'bool', name: 'restart', def: false, group: 'Emit', help: 'Holds the system at its starting state while on.' },
    { k: 'vec2', name: 'gravity', def: [0, 0], min: -2, max: 2, step: 0.01, group: 'Forces', help: 'Positive Y pulls upward.' },
    { k: 'float', name: 'drag', def: 1, min: 0, max: 8, group: 'Forces' },
    { k: 'float', name: 'turbulence', def: 0.35, min: 0, max: 4, group: 'Forces', help: 'Divergence-free curl noise: swirls without clumping.' },
    { k: 'float', name: 'turbScale', label: 'Turbulence scale', def: 1.4, min: 0.1, max: 10, group: 'Forces' },
    { k: 'float', name: 'turbSpeed', label: 'Turbulence speed', def: 0.15, min: 0, max: 3, group: 'Forces' },
    { k: 'float', name: 'audioTurb', label: 'Bass → turbulence', def: 0, min: 0, max: 8, group: 'Forces', help: 'Multiplies turbulence by 1 + bass × this.' },
    { k: 'float', name: 'vortex', def: 0.2, min: -4, max: 4, group: 'Forces', help: 'Swirl around the emitter.' },
    { k: 'vec2', name: 'attractPos', label: 'Attractor', def: [0.7, 0.5], min: -0.5, max: 1.5, step: 0.001, gizmo: 'uv', group: 'Forces' },
    { k: 'float', name: 'attract', label: 'Attractor strength', def: 0, min: -4, max: 4, group: 'Forces', help: 'Negative values repel.' },
    { k: 'float', name: 'attractFall', label: 'Attractor radius', def: 0.5, min: 0.02, max: 4, group: 'Forces' },
    { k: 'float', name: 'forceAmt', label: 'Force input', def: 1, min: 0, max: 8, group: 'Forces', help: 'How hard the Force field pushes.' },
    { k: 'float', name: 'depth', def: 1, min: 0, max: 3, group: 'Forces', help: 'Depth of the 3D volume. 0 keeps everything flat in the picture plane.' },
    { k: 'bool', name: 'floor', def: false, group: 'Forces' },
    { k: 'float', name: 'floorY', label: 'Floor height', def: -0.85, min: -1.5, max: 1.5, group: 'Forces', help: '-1 is the bottom edge of the picture.' },
    { k: 'float', name: 'bounce', label: 'Bounciness', def: 0.5, min: 0, max: 1, group: 'Forces' },
    { k: 'enum', name: 'bounds', options: ['Free', 'Wrap at frame', 'Kill at frame'], def: 0, group: 'Forces' },
    { k: 'float', name: 'size', label: 'Point size', def: 0.004, min: 0.0005, max: 0.05, step: 0.0001, group: 'Look', help: 'Diameter as a fraction of the picture height, at the picture plane.' },
    { k: 'float', name: 'sizeAge', label: 'Size over life', def: -0.4, min: -1, max: 1, group: 'Look', help: 'Negative shrinks particles as they age, positive grows them.' },
    { k: 'float', name: 'sizeRand', label: 'Size random', def: 0.5, min: 0, max: 1, group: 'Look' },
    { k: 'float', name: 'stretch', label: 'Motion streaks', def: 0, min: 0, max: 0.5, step: 0.001, unit: 's', group: 'Look', help: 'Stretches each particle along its motion over this much time.' },
    { k: 'enum', name: 'colorMode', label: 'Colour', options: ['Footage', 'Gradient by age', 'Gradient by speed', 'Spectrum by index', 'Spectrum by direction', 'Spectrum by speed', 'Solid'], def: 0, group: 'Look', help: 'Footage uses the Source colour where each particle was born (gradient by speed when nothing is connected). ' + SPECTRUM_HELP },
    { k: 'color', name: 'colorA', label: 'Colour A', def: [0.25, 0.5, 1, 1], group: 'Look', help: 'Young / slow end of the gradients, and the Solid colour.' },
    { k: 'color', name: 'colorB', label: 'Colour B', def: [1, 0.5, 0.18, 1], group: 'Look', help: 'Old / fast end of the gradients.' },
    { k: 'float', name: 'hue', def: 0, min: -180, max: 180, unit: '°', group: 'Look' },
    { k: 'float', name: 'opacity', def: 0.5, min: 0, max: 1, group: 'Look', help: 'With Add blending the total light is kept constant as Count changes, so more particles means finer, not brighter.' },
    { k: 'enum', name: 'blend', options: ['Add', 'Normal'], def: 0, group: 'Look' },
    { k: 'float', name: 'soft', label: 'Soft edge', def: 0.7, min: 0, max: 1, group: 'Look' },
    { k: 'float', name: 'fade', label: 'Fade in/out', def: 0.15, min: 0, max: 0.5, group: 'Look', help: 'Fraction of each particle\'s life spent fading in and out.' },
    { k: 'float', name: 'exposure', def: 0.3, min: -4, max: 6, unit: 'EV', group: 'Look', help: 'HDR brightness; push it up so particles bloom downstream.' },
    ...camParams('Camera', 0, 0, 1, 6),
  ],
  passes: SIM_PASSES,
  cook(c) {
    const p = c.p, st = c.state as SimState;
    const S = COUNT_S[p.count] ?? 512;
    const aspect = c.w / c.h;
    const E = uvToWorld(p.emitPos, aspect);
    const dtc = Math.min(Math.max(c.dt, 0), 1 / 24);
    const ev = st.prevE && dtc > 0 ? [(E[0] - st.prevE[0]) / dtc * p.inherit, (E[1] - st.prevE[1]) / dtc * p.inherit, 0] : [0, 0, 0];
    if (dtc > 0 || !st.prevE) st.prevE = E;
    // burst is edge-triggered so a held-high value does not freeze the system at the emitter
    const high = p.burst > 0.5;
    if (high && !st.burstHigh) st.burstPending = true;
    st.burstHigh = high;
    const src = c.ins[0], force = c.ins[1];
    const needCol = p.colorMode === 0 && !!src;
    const a = p.angle * DEG;
    const vals: Vals = {
      seed: p.seed, aspect, shape: p.shape, emit: [E[0], E[1], 0], emitVel: ev, esize: p.emitSize, speed: p.speed, spread: p.spread,
      dir: [Math.cos(a), Math.sin(a)], life: p.life, lifeRand: p.lifeRand, gravity: p.gravity, drag: p.drag,
      turb: p.turbulence, turbScale: p.turbScale, turbTime: c.time * p.turbSpeed, audioAmt: p.audioTurb, vortex: p.vortex,
      attract: uvToWorld(p.attractPos, aspect), attractStr: p.attract, attractFall: p.attractFall, forceAmt: p.forceAmt,
      depth: p.depth, floorOn: p.floor, floorY: p.floorY, bounce: p.bounce, bounds: p.bounds, follow: 0, respawn: 0,
    };
    const burst = !!st.burstPending && dtc > 0;
    const sim = simulate(c, S, vals, src, force, needCol, p.restart, burst);
    if (burst) st.burstPending = false;
    draw(c, {
      kind: 0, texW: S, count: S * S, radius: p.size, sizeAge: p.sizeAge, sizeRand: p.sizeRand, stretch: p.stretch,
      colorMode: p.colorMode, opacity: p.opacity * (p.blend === 1 ? 1 : 262144 / (S * S)), soft: p.soft, exposure: p.exposure, colA: p.colorA, colB: p.colorB, hue: p.hue,
      fade: p.fade, hasCol: needCol, blend: p.blend, cam: camOf(c), texs: [sim.pos, sim.vel, sim.col, null], under: c.inTex[2],
    });
  },
  dispose(state) { state.rbuf?.destroy(); },
};

// ------------------------------------------------------------------------------------------------
// Image to Points: footage as a displaced grid of points with spring physics
// ------------------------------------------------------------------------------------------------
const PI_FIELDS: Field[] = [['dt', 'f32'], ['aspect', 'f32'], ['scatter', 'f32'], ['explode', 'f32'], ['swirlTime', 'f32'], ['stiffness', 'f32'], ['damping', 'f32'], ['forceAmt', 'f32'], ['seed', 'i32']];
const GRID_ROWS = [135, 270, 405, 540, 720];

const pointimage: OpDef = {
  type: 'pointimage', label: 'Image to Points', category: 'Simulate', output: 'tex', animated: true,
  inputs: [{ name: 'src', type: 'tex', optional: true }, { name: 'depth', type: 'tex', optional: true }, { name: 'force', type: 'field', optional: true }, { name: 'under', type: 'tex', optional: true }],
  help: 'Turns footage into a 3D grid of points in its own colours, pushed toward the camera by brightness (or by a Depth map). Animate Scatter to blow the picture apart and let it spring back together; a Force field such as Optical Flow knocks points loose.',
  params: [
    { k: 'enum', name: 'grid', label: 'Density', options: ['135 rows', '270 rows', '405 rows', '540 rows', '720 rows'], def: 1, group: 'Points' },
    { k: 'float', name: 'size', label: 'Point size', def: 0.75, min: 0.1, max: 4, group: 'Points', help: 'Relative to the grid spacing; 1 makes neighbours touch.' },
    { k: 'float', name: 'jitter', def: 0.35, min: 0, max: 1, group: 'Points', help: 'Breaks up the regular grid.' },
    { k: 'float', name: 'depthAmt', label: 'Depth', def: 0.35, min: -2, max: 2, group: 'Points', help: 'How far bright areas (or the Depth input) come toward the camera; 1 is half the picture height.' },
    { k: 'float', name: 'scatter', def: 0, min: 0, max: 1, group: 'Motion', help: '0 is the formed image, 1 is fully exploded. Points spring between the two.' },
    { k: 'float', name: 'explode', label: 'Scatter distance', def: 1, min: 0, max: 4, group: 'Motion' },
    { k: 'float', name: 'swirl', label: 'Swirl speed', def: 0.3, min: 0, max: 3, group: 'Motion', help: 'How fast the scattered cloud churns.' },
    { k: 'float', name: 'stiffness', label: 'Spring', def: 14, min: 0.5, max: 100, group: 'Motion' },
    { k: 'float', name: 'damping', def: 4, min: 0, max: 30, group: 'Motion' },
    { k: 'float', name: 'forceAmt', label: 'Force input', def: 1, min: 0, max: 8, group: 'Motion' },
    { k: 'int', name: 'seed', def: 1, min: 0, max: 9999, group: 'Motion' },
    { k: 'float', name: 'opacity', def: 0.9, min: 0, max: 1, group: 'Look' },
    { k: 'enum', name: 'blend', options: ['Add', 'Normal'], def: 0, group: 'Look' },
    { k: 'float', name: 'soft', label: 'Soft edge', def: 0.5, min: 0, max: 1, group: 'Look' },
    { k: 'float', name: 'stretch', label: 'Motion streaks', def: 0.05, min: 0, max: 0.5, step: 0.001, unit: 's', group: 'Look' },
    { k: 'float', name: 'exposure', def: 0, min: -4, max: 6, unit: 'EV', group: 'Look' },
    ...camParams('Camera', -28, 14, 1.1, 0),
  ],
  passes: {
    pi_vel: {
      inputs: ['disp', 'vel', 'force'], fields: PI_FIELDS,
      body: COMMON + /* wgsl */`
fn op(uv: vec2f) -> vec4f {
  let ij = vec2i(floor(uv * g.res));
  let id = u32(ij.y) * u32(g.res.x) + u32(ij.x);
  let d = textureLoad(disp, ij, 0).xyz; let v = textureLoad(vel, ij, 0).xyz;
  var k = pt_pcg(id ^ pt_pcg(u32(u.seed) * 7919u + 3u));
  let home = vec3f((uv.x - 0.5) * 2.0 * u.aspect, (0.5 - uv.y) * 2.0, 0.0);
  let dir = pt_unit(&k) * (0.4 + 0.8 * pt_rnd(&k));
  let sw = pt_curl(home * 1.3 + d * 0.5, u.swirlTime) * 0.25;
  let goal = u.scatter * u.explode * (dir + sw);
  var acc = (goal - d) * u.stiffness - v * u.damping;
  if (u.has_force > 0.5) {
    let f = textureSampleLevel(force, smp, uv, 0.0).rg / 40.0 * 60.0;
    acc += vec3f(f.x * 2.0 * u.aspect, -f.y * 2.0, 0.0) * u.forceAmt * 6.0;
  }
  var nv = v + acc * u.dt;
  let sp = length(nv);
  if (sp > 20.0) { nv *= 20.0 / sp; }
  return vec4f(nv, 0.0);
}`,
    },
    pi_pos: {
      inputs: ['disp', 'nvel'], fields: PI_FIELDS,
      body: COMMON + /* wgsl */`
fn op(uv: vec2f) -> vec4f {
  let ij = vec2i(floor(uv * g.res));
  let id = u32(ij.y) * u32(g.res.x) + u32(ij.x);
  var k = pt_pcg(id * 9u + u32(g.frame));
  let d = textureLoad(disp, ij, 0).xyz + textureLoad(nvel, ij, 0).xyz * u.dt;
  return pt_round(vec4f(d, 0.0), &k);
}`,
    },
  },
  cook(c) {
    const p = c.p, aspect = c.w / c.h;
    const rows = GRID_ROWS[p.grid] ?? 270, cols = Math.max(1, Math.round(rows * aspect));
    const st = c.state as { cur?: number };
    const t = [0, 1].map(i => ({ d: c.tex(`d${i}`, cols, rows), v: c.tex(`v${i}`, cols, rows) }));
    st.cur ??= 0;
    if (c.reset || t.some(x => x.d.fresh || x.v.fresh)) { for (const x of t) { c.clear(x.d.view); c.clear(x.v.view); } st.cur = 0; }
    const dt = Math.min(Math.max(c.dt, 0), 1 / 24);
    if (dt > 0) {
      // sub-step stiff springs so high Spring values stay stable
      const n = Math.min(4, Math.max(1, Math.ceil(dt * Math.sqrt(p.stiffness) / 0.25)));
      const vals: Vals = { dt: dt / n, aspect, scatter: p.scatter, explode: p.explode, swirlTime: c.time * p.swirl, stiffness: p.stiffness, damping: p.damping, forceAmt: p.forceAmt, seed: p.seed };
      for (let i = 0; i < n; i++) {
        const a = t[st.cur], b = t[1 - st.cur];
        c.run('pi_vel', b.v.view, [a.d.view, a.v.view, c.ins[2]], vals, [cols, rows]);
        c.run('pi_pos', b.d.view, [a.d.view, b.v.view], vals, [cols, rows]);
        st.cur = 1 - st.cur;
      }
    }
    const r = t[st.cur];
    draw(c, {
      kind: 1, texW: cols, count: cols * rows, radius: p.size / rows, stretch: p.stretch, opacity: p.opacity, soft: p.soft,
      exposure: p.exposure, zAmt: p.depthAmt, jitter: p.jitter, cols, rows, hasSrc: !!c.ins[0], hasDepth: !!c.ins[1],
      blend: p.blend, cam: camOf(c), texs: [r.d.view, r.v.view, c.ins[0], c.ins[1]], under: c.inTex[3],
    });
  },
  dispose(state) { state.rbuf?.destroy(); },
};

// ------------------------------------------------------------------------------------------------
// Particle Trails: flow-field particles drawn into a fading accumulation buffer
// ------------------------------------------------------------------------------------------------
const trails: OpDef = {
  type: 'trails', label: 'Particle Trails', category: 'Simulate', output: 'tex', animated: true,
  inputs: [{ name: 'force', type: 'field', optional: true }],
  help: 'Particles ride a curl-noise flow (and any connected Force field, such as Optical Flow) and leave long luminous trails: the flow-field art look.',
  params: [
    { k: 'enum', name: 'count', options: COUNT_OPTS, def: 1, group: 'Flow' },
    { k: 'float', name: 'flow', label: 'Flow strength', def: 0.25, min: 0, max: 3, group: 'Flow' },
    { k: 'float', name: 'flowScale', label: 'Flow scale', def: 1.3, min: 0.1, max: 10, group: 'Flow' },
    { k: 'float', name: 'flowSpeed', label: 'Flow evolution', def: 0.08, min: 0, max: 2, group: 'Flow' },
    { k: 'float', name: 'forceAmt', label: 'Force input', def: 1, min: 0, max: 8, group: 'Flow' },
    { k: 'float', name: 'respawn', label: 'Respawn rate', def: 0.2, min: 0, max: 5, unit: '/s', group: 'Flow', help: 'Fraction of particles reborn at a random spot each second; keeps the picture evenly covered.' },
    { k: 'int', name: 'seed', def: 1, min: 0, max: 9999, group: 'Flow' },
    { k: 'float', name: 'decay', label: 'Trail decay', def: 0.97, min: 0.5, max: 0.999, step: 0.001, group: 'Trails', help: 'Fraction of the trail kept per frame (at 60 fps). Closer to 1 is longer.' },
    { k: 'float', name: 'blur', def: 0.15, min: 0, max: 1, group: 'Trails', help: 'Softens the trails slightly each frame.' },
    { k: 'float', name: 'size', label: 'Point size', def: 0.0015, min: 0.0003, max: 0.02, step: 0.0001, group: 'Trails' },
    { k: 'enum', name: 'colorMode', label: 'Colour', options: ['By direction', 'By speed'], def: 0, group: 'Trails' },
    { k: 'float', name: 'hue', def: 0, min: -180, max: 180, unit: '°', group: 'Trails' },
    { k: 'float', name: 'intensity', def: 0.03, min: 0, max: 1, group: 'Trails' },
  ],
  passes: {
    pt_vel: SIM_PASSES.pt_vel,
    pt_pos: SIM_PASSES.pt_pos,
    tr_fade: {
      inputs: ['acc'], fields: [['keep', 'f32'], ['blur', 'f32']],
      body: /* wgsl */`fn op(uv: vec2f) -> vec4f {
  var c = textureSampleLevel(acc, smp, uv, 0.0).rgb;
  if (u.blur > 0.0) {
    let px = 1.0 / g.res;
    let n = (textureSampleLevel(acc, smp, uv + vec2f(px.x, 0.0), 0.0).rgb + textureSampleLevel(acc, smp, uv - vec2f(px.x, 0.0), 0.0).rgb
           + textureSampleLevel(acc, smp, uv + vec2f(0.0, px.y), 0.0).rgb + textureSampleLevel(acc, smp, uv - vec2f(0.0, px.y), 0.0).rgb) * 0.25;
    c = mix(c, n, u.blur * 0.5);
  }
  return vec4f(c * u.keep, 1.0);
}`,
    },
  },
  cook(c) {
    const p = c.p, aspect = c.w / c.h;
    const S = COUNT_S[p.count] ?? 512;
    const vals: Vals = {
      seed: p.seed, aspect, shape: 8, emit: [0, 0, 0], emitVel: [0, 0, 0], esize: 1, speed: 0, spread: 1, dir: [0, 1],
      life: 12, lifeRand: 0.7, gravity: [0, 0], drag: 0, turb: p.flow, turbScale: p.flowScale, turbTime: c.time * p.flowSpeed,
      audioAmt: 0, vortex: 0, attract: [0, 0], attractStr: 0, attractFall: 1, forceAmt: p.forceAmt, depth: 0,
      floorOn: 0, floorY: 0, bounce: 0, bounds: 2, follow: 1, respawn: p.respawn,
    };
    const acc = c.tex('acc');
    const sim = simulate(c, S, vals, null, c.ins[0], false, false, false);
    if (acc.fresh || c.reset) c.clear(acc.view);
    if (sim.dt > 0 || acc.fresh || c.reset) {
      c.run('tr_fade', c.out, [acc.view], { keep: Math.pow(p.decay, sim.dt * 60), blur: p.blur });
      draw(c, {
        kind: 0, texW: S, count: S * S, radius: p.size, stretch: 0, colorMode: p.colorMode === 1 ? 5 : 4, opacity: p.intensity * 262144 / (S * S),
        soft: 0.3, exposure: 0, hue: p.hue, fade: 0.08, blend: 0, cam: { yaw: 0, pitch: 0, dist: 1, fov: 40 },
        texs: [sim.pos, sim.vel, null, null], load: true,
      });
      c.copy(c.outTex, acc.tex);
    } else c.copy(acc.tex, c.outTex);
  },
  dispose(state) { state.rbuf?.destroy(); },
};

export const ops: OpDef[] = [particles, pointimage, trails];
