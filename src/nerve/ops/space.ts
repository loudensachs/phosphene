// NERVE space operators: raymarched / raycast 3D generators driven by video, and motion-vector effects
// driven by an Optical Flow field.
import type { OpDef, ParamDef } from '../types';

// ------------------------------------------------------------------------------------------------
// Shared 3D camera + lighting. Every 3D op carries the same 'Camera' and 'Light' param groups so the
// helpers below can read them straight from `u`.
// ------------------------------------------------------------------------------------------------
interface CamDefaults { yaw?: number; pitch?: number; dist?: number; fov?: number; orbit?: number }
const camParams = (d: CamDefaults = {}): ParamDef[] => [
  { k: 'float', name: 'camYaw', label: 'Yaw', def: d.yaw ?? 30, min: -180, max: 180, unit: '°', group: 'Camera' },
  { k: 'float', name: 'camPitch', label: 'Pitch', def: d.pitch ?? 20, min: -89, max: 89, unit: '°', group: 'Camera' },
  { k: 'float', name: 'camDist', label: 'Distance', def: d.dist ?? 4, min: 0.2, max: 20, group: 'Camera' },
  { k: 'float', name: 'camFov', label: 'Field of view', def: d.fov ?? 45, min: 10, max: 140, unit: '°', group: 'Camera' },
  { k: 'float', name: 'orbit', label: 'Auto orbit', def: d.orbit ?? 8, min: -90, max: 90, unit: '°/s', group: 'Camera', help: 'Continuous yaw rotation.' },
  { k: 'vec2', name: 'lookAt', label: 'Look-at offset', def: [0, 0], min: -3, max: 3, group: 'Camera' },
];
interface LightDefaults { fog?: number; shadows?: boolean; ao?: number; spec?: number; rim?: number; ambient?: number }
const lightParams = (d: LightDefaults = {}): ParamDef[] => [
  { k: 'float', name: 'lightYaw', label: 'Key yaw', def: 40, min: -180, max: 180, unit: '°', group: 'Light' },
  { k: 'float', name: 'lightPitch', label: 'Key pitch', def: 45, min: -89, max: 89, unit: '°', group: 'Light' },
  { k: 'float', name: 'ambient', def: d.ambient ?? 0.25, min: 0, max: 2, group: 'Light' },
  { k: 'float', name: 'specular', def: d.spec ?? 0.6, min: 0, max: 4, group: 'Light' },
  { k: 'float', name: 'gloss', def: 40, min: 1, max: 256, group: 'Light' },
  { k: 'float', name: 'rim', def: d.rim ?? 0.5, min: 0, max: 4, group: 'Light' },
  { k: 'float', name: 'fogDensity', label: 'Fog density', def: d.fog ?? 0.06, min: 0, max: 1, step: 0.001, group: 'Light' },
  { k: 'color', name: 'fogColor', label: 'Fog colour', def: [0.16, 0.13, 0.27, 1], group: 'Light' },
  { k: 'bool', name: 'shadows', label: 'Soft shadows', def: d.shadows ?? true, group: 'Light' },
  { k: 'float', name: 'ao', label: 'Ambient occlusion', def: d.ao ?? 0.7, min: 0, max: 1, group: 'Light' },
];
const bgParam = (def = 2): ParamDef =>
  ({ k: 'enum', name: 'background', options: ['Transparent', 'Fog colour', 'Gradient'], def, help: 'What shows where no surface is hit.' });

/** Camera ray + light shading + fog/background. Needs camParams + lightParams + bgParam. */
const SP_COMMON = /* wgsl */`
struct SpCam { ro: vec3f, rd: vec3f, fw: vec3f, rt: vec3f, up: vec3f, foc: f32, pix: f32 };
fn sp_basis(ro: vec3f, tg: vec3f) -> SpCam {
  var c: SpCam;
  c.ro = ro;
  c.fw = normalize(tg - ro);
  c.rt = normalize(cross(c.fw, vec3f(0.0, 1.0, 0.0)));
  c.up = cross(c.rt, c.fw);
  c.foc = 1.0 / tan(radians(clamp(u.camFov, 5.0, 170.0)) * 0.5);
  // ray-direction spread of one pixel per unit distance (for cone-based epsilons and line AA)
  c.pix = 2.0 / (g.res.y * c.foc);
  return c;
}
fn sp_screen(uv: vec2f) -> vec2f { let p = centered(uv); return vec2f(p.x, -p.y); }
fn sp_camera(uv: vec2f) -> SpCam {
  let yaw = radians(u.camYaw + g.time * u.orbit);
  let pitch = radians(clamp(u.camPitch, -89.0, 89.0));
  let tg = vec3f(u.lookAt.x, u.lookAt.y, 0.0);
  let ro = tg + max(u.camDist, 0.01) * vec3f(cos(pitch) * sin(yaw), sin(pitch), cos(pitch) * cos(yaw));
  var c = sp_basis(ro, tg);
  let s = sp_screen(uv);
  c.rd = normalize(c.fw * c.foc + c.rt * s.x + c.up * s.y);
  return c;
}
// a non-zero sp_lov overrides the key-light direction (camera-attached lights)
var<private> sp_lov: vec3f = vec3f(0.0);
fn sp_ldir() -> vec3f {
  if (dot(sp_lov, sp_lov) > 0.0) { return sp_lov; }
  let y = radians(u.lightYaw); let p = radians(clamp(u.lightPitch, -89.0, 89.0));
  return normalize(vec3f(cos(p) * sin(y), sin(p), cos(p) * cos(y)));
}
const SP_KEY: vec3f = vec3f(1.0, 0.92, 0.8);
fn sp_bgc(rd: vec3f) -> vec3f {
  let f = u.fogColor.rgb;
  if (u.background != 2) { return f; }
  let y = rd.y;
  let zen = f * 0.25 + vec3f(0.004, 0.006, 0.014);
  var c = mix(f, zen, smoothstep(0.0, 0.7, y));
  c = mix(c, f * 0.35, smoothstep(0.0, -0.5, y));
  // soft glow toward the key light
  c += SP_KEY * f * 3.0 * pow(max(dot(rd, sp_ldir()), 0.0), 8.0);
  return c;
}
fn sp_shade(alb: vec3f, n: vec3f, rd: vec3f, sh: f32, occ: f32) -> vec3f {
  let l = sp_ldir();
  let ndl = max(dot(n, l), 0.0);
  let hv = normalize(l - rd);
  let fre = pow(1.0 - sat(dot(n, -rd)), 3.0);
  let sky = mix(vec3f(0.3, 0.26, 0.24), vec3f(0.55, 0.7, 1.0), n.y * 0.5 + 0.5);
  var c = alb * (SP_KEY * 1.6 * ndl * sh + u.ambient * sky * occ * 1.5);
  c += SP_KEY * u.specular * pow(max(dot(n, hv), 0.0), max(u.gloss, 1.0)) * ndl * sh * (0.4 + 0.6 * fre + u.gloss / 128.0);
  c += u.rim * fre * occ * mix(vec3f(0.6, 0.75, 1.0), alb, 0.4) * 0.6;
  return c;
}
fn sp_fog(c: vec3f, t: f32, rd: vec3f) -> vec3f {
  return mix(sp_bgc(rd), c, exp(-max(t, 0.0) * u.fogDensity));
}
fn sp_miss(rd: vec3f) -> vec4f {
  if (u.background == 0) { return vec4f(0.0); }
  return vec4f(sp_bgc(rd), 1.0);
}
`;

/** SDF utilities. The op must define `fn sp_map(p: vec3f) -> f32`. */
const SP_MARCH = /* wgsl */`
fn sp_normal(p: vec3f, e: f32) -> vec3f {
  let k = vec2f(1.0, -1.0);
  return normalize(k.xyy * sp_map(p + k.xyy * e) + k.yyx * sp_map(p + k.yyx * e) +
                   k.yxy * sp_map(p + k.yxy * e) + k.xxx * sp_map(p + k.xxx * e));
}
fn sp_shadow(ro: vec3f, rd: vec3f, tmax: f32) -> f32 {
  if (u.shadows != 1) { return 1.0; }
  var res = 1.0; var t = 0.02;
  for (var i = 0; i < 40; i++) {
    let h = sp_map(ro + rd * t);
    res = min(res, 10.0 * h / t);
    t += clamp(h, 0.01, 0.3);
    if (res < 0.002 || t > tmax) { break; }
  }
  let r = sat(res);
  return r * r * (3.0 - 2.0 * r);
}
fn sp_occ(p: vec3f, n: vec3f) -> f32 {
  if (u.ao <= 0.0) { return 1.0; }
  var o = 0.0; var s = 1.0;
  for (var i = 0; i < 5; i++) {
    let h = 0.02 + 0.13 * f32(i) / 4.0;
    o += (h - sp_map(p + n * h)) * s;
    s *= 0.85;
  }
  return mix(1.0, sat(1.0 - 2.5 * o), u.ao);
}
// sphere-trace; returns (t, hit). k = relaxation (<1 for non-Lipschitz fields)
fn sp_march(ro: vec3f, rd: vec3f, tmax: f32, n: i32, k: f32, pix: f32) -> vec2f {
  var t = 0.0; var h = 1.0;
  let nn = clamp(n, 8, 256);
  for (var i = 0; i < 256; i++) {
    if (i >= nn) { break; }
    h = sp_map(ro + rd * t);
    if (abs(h) < max(pix * t * 0.6, 1e-4)) { return vec2f(t, 1.0); }
    t += h * k;
    if (t > tmax) { return vec2f(tmax, 0.0); }
  }
  // out of steps: accept a near miss rather than punching holes in detailed surfaces
  return vec2f(t, select(0.0, 1.0, h < 0.02 + pix * t * 6.0));
}
`;

// ------------------------------------------------------------------------------------------------
// 3D Forms
// ------------------------------------------------------------------------------------------------
const PAL_PARAMS: ParamDef[] = [
  { k: 'enum', name: 'colorMode', label: 'Surface colour', options: ['Palette by position', 'Palette by normal', 'Palette by iteration', 'Solid colour', 'Tri-planar texture'], def: 2, group: 'Surface' },
  { k: 'float', name: 'phase', def: 0, min: 0, max: 1, group: 'Surface' },
  { k: 'float', name: 'frequency', def: 1, min: 0, max: 6, group: 'Surface' },
  { k: 'color', name: 'baseColor', label: 'Solid colour', def: [0.85, 0.82, 0.78, 1], group: 'Surface' },
  { k: 'float', name: 'texScale', label: 'Texture scale', def: 1, min: 0.05, max: 10, group: 'Surface', help: 'Tri-planar mapping scale for the Tex input.' },
  { k: 'float', name: 'emission', def: 0.15, min: 0, max: 4, group: 'Surface' },
];

const sdf3d: OpDef = {
  type: 'sdf3d', label: '3D Forms', category: 'Generate', output: 'tex', animated: true,
  inputs: [{ name: 'tex', type: 'tex', optional: true }],
  help: 'Raymarched 3D forms: knots, lattices, fractals, metaballs and infinite structures, lit with soft shadows, AO and fog. Connect Tex and pick Tri-planar to wrap footage over the surface.',
  params: [
    { k: 'enum', name: 'form', options: ['Torus Knot', 'Gyroid Lattice', 'Menger Sponge', 'Mandelbulb', 'Kaleidoscopic IFS', 'Metaballs', 'Infinite Columns', 'Twisted Ribbon', 'Sphere Field', 'Octahedral Crystal'], def: 0 },
    { k: 'float', name: 'morph', def: 0.5, min: 0, max: 1, help: 'Form-specific shape variation.' },
    { k: 'float', name: 'twist', def: 0, min: -3, max: 3, help: 'Twist around the vertical axis, radians per unit.' },
    { k: 'int', name: 'repeat', def: 1, min: 1, max: 12, help: 'Kaleidoscopic fold count around the vertical axis; cell density for Columns and Sphere Field.' },
    { k: 'float', name: 'blend', label: 'Smooth blend', def: 0.35, min: 0, max: 1, help: 'Smooth-union / rounding radius between parts.' },
    { k: 'int', name: 'detail', label: 'Detail', def: 5, min: 1, max: 12, help: 'Fractal iterations; ribs, flutes, bumps or shard count on the other forms.' },
    { k: 'int', name: 'steps', label: 'March steps', def: 80, min: 16, max: 256 },
    { k: 'float', name: 'speed', def: 0.5, min: 0, max: 4 },
    ...PAL_PARAMS,
    bgParam(),
    ...camParams({ dist: 4.2, pitch: 18 }),
    ...lightParams(),
  ],
  body: SP_COMMON + /* wgsl */`
var<private> sd_ro: vec3f;
fn sd_smin(a: f32, b: f32, k: f32) -> f32 {
  let kk = max(k, 1e-4);
  let h = max(kk - abs(a - b), 0.0) / kk;
  return min(a, b) - h * h * kk * 0.25;
}
fn sd_smax(a: f32, b: f32, k: f32) -> f32 { return -sd_smin(-a, -b, k); }
fn sd_box(p: vec3f, b: vec3f) -> f32 {
  let q = abs(p) - b;
  return length(max(q, vec3f(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0);
}
fn sd_box2(p: vec2f, b: vec2f) -> f32 {
  let q = abs(p) - b;
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0);
}
fn sd_oct(p: vec3f, s: f32) -> f32 { let q = abs(p); return (q.x + q.y + q.z - s) * 0.57735027; }
fn sd_cell() -> f32 { return 2.4 / (0.5 + 0.5 * f32(clamp(u.repeat, 1, 12))); }

// (distance, colour trap 0..1)
fn sd_form(p: vec3f) -> vec2f {
  let t = g.time * u.speed;
  let m = u.morph;
  let det = clamp(u.detail, 1, 12);
  let bl = max(u.blend, 0.0);
  switch (u.form) {
    case 1 { // gyroid / Schwarz-P lattice carved into a ball
      let s = p * 3.5 + vec3f(0.0, t, 0.0);
      var fld = mix(dot(sin(s), cos(s.zxy)), cos(s.x) + cos(s.y) + cos(s.z), m);
      var s2 = s; var amp = 1.0;
      for (var i = 1; i < 5; i++) {
        if (i >= det) { break; }
        s2 = s2 * 2.03 + vec3f(t * 0.3, 0.0, 1.7); amp *= 0.5;
        fld += amp * 0.35 * dot(sin(s2), cos(s2.zxy));
      }
      let shell = abs(fld) / 3.5 * 0.55 - 0.035;
      let d = sd_smax(shell, length(p) - 1.45, bl * 0.4);
      return vec2f(d * 0.8, sat(fld * 0.35 + 0.5));
    }
    case 2 { // Menger sponge with sliding folds
      var d = sd_box(p, vec3f(1.0));
      var s = 1.0; var tr = 0.0;
      let sl = m * 0.3 * vec3f(sin(t), cos(t * 0.7), sin(t * 0.43));
      for (var i = 0; i < 6; i++) {
        if (i >= min(det, 5)) { break; }
        let ps = p * s + sl;
        let a = ps - 2.0 * floor(ps * 0.5) - 1.0;
        s *= 3.0;
        let r = abs(1.0 - 3.0 * abs(a));
        let da = max(r.x, r.y); let db = max(r.y, r.z); let dc = max(r.z, r.x);
        let c = (min(da, min(db, dc)) - 1.0) / s;
        if (c > d) { tr = f32(i + 1) / 5.0; }
        d = sd_smax(d, c, bl * 0.06 / s);
      }
      return vec2f(d, tr);
    }
    case 3 { // Mandelbulb, breathing power
      let pw = 8.0 + m * 2.5 * sin(t * 0.6);
      var w = p; var m2 = dot(w, w); var dz = 1.0; var trap = 1e9;
      for (var i = 0; i < 12; i++) {
        if (i >= max(det, 2)) { break; }
        let r = sqrt(m2);
        dz = pw * pow(r, pw - 1.0) * dz + 1.0;
        let b = pw * acos(clamp(w.y / max(r, 1e-6), -1.0, 1.0));
        let a = pw * atan2(w.x, w.z);
        w = p + pow(r, pw) * vec3f(sin(b) * sin(a), cos(b), sin(b) * cos(a));
        trap = min(trap, m2);
        m2 = dot(w, w);
        if (m2 > 256.0) { break; }
      }
      let d = 0.25 * log(max(m2, 1e-8)) * sqrt(m2) / dz;
      return vec2f(d - bl * 0.03, sat(sqrt(trap)));
    }
    case 4 { // kaleidoscopic IFS: tetrahedral folds with animated rotations
      var w = p * 0.62; var sc = 1.0; var trap = 1e9;
      let r1 = rot(0.18 * sin(t * 0.4) + m * 0.3);
      let r2 = rot(0.12 * cos(t * 0.3) + 0.1);
      for (var i = 0; i < 12; i++) {
        if (i >= max(det, 3)) { break; }
        if (w.x + w.y < 0.0) { w = vec3f(-w.y, -w.x, w.z); }
        if (w.x + w.z < 0.0) { w = vec3f(-w.z, w.y, -w.x); }
        if (w.y + w.z < 0.0) { w = vec3f(w.x, -w.z, -w.y); }
        let xy = r1 * w.xy; w = vec3f(xy, w.z);
        let yz = r2 * w.yz; w = vec3f(w.x, yz);
        w = w * 2.0 - vec3f(1.0);
        sc *= 2.0;
        trap = min(trap, dot(w, w));
      }
      let d = (length(w) - 1.4 - bl) / (sc * 0.62);
      return vec2f(d, sat(sqrt(trap) * 0.3));
    }
    case 5 { // metaballs
      var d = 1e9; var best = 1e9; var id = 0.0;
      let n = clamp(det, 2, 12);
      for (var i = 0; i < 12; i++) {
        if (i >= n) { break; }
        let fi = f32(i);
        let c = vec3f(sin(t * (0.7 + 0.13 * fi) + fi * 1.7), sin(t * (0.9 + 0.11 * fi) + fi * 2.3) * 0.8,
                      cos(t * (0.8 + 0.07 * fi) + fi * 0.9)) * (0.4 + 0.5 * m);
        let s = length(p - c) - (0.42 + 0.1 * sin(fi * 3.1));
        if (s < best) { best = s; id = fi / f32(n); }
        d = sd_smin(d, s, 0.05 + bl * 0.8);
      }
      return vec2f(d, id);
    }
    case 6 { // infinite columns on a floor
      let cell = sd_cell();
      let id = round(p.xz / cell);
      let q = p.xz - cell * id;
      let h = hash21(id + 3.7);
      let ang = atan2(q.y, q.x);
      var rad = cell * 0.2 * (1.0 + m * 0.4 * sin(p.y * 2.0 + t * 2.0 + h * TAU));
      rad += cell * 0.012 * cos(ang * f32(det * 2));
      var d = (length(q) - rad) * 0.8;
      d = sd_smin(d, p.y + 1.1, 0.05 + bl);
      d = sd_smin(d, 4.0 - p.y, 0.05 + bl);
      d = max(d, cell * 0.3 - length(p - sd_ro));
      return vec2f(d, select(h, 0.0, p.y < -1.0));
    }
    case 7 { // twisted (Moebius) ribbon
      let a = atan2(p.z, p.x);
      var q = vec2f(length(p.xz) - 1.1, p.y);
      q = rot(a * 1.5 + t) * q;
      let w = 0.45 + 0.15 * m * sin(a * 3.0 + t);
      let ripple = 0.012 * sin(a * f32(det) * 4.0 + t * 3.0);
      let d = sd_box2(q, vec2f(w, 0.025)) - (0.008 + bl * 0.04) + ripple;
      return vec2f(d * 0.6, fract(a / TAU + 0.5));
    }
    case 8 { // sphere field with connecting rods
      let cell = sd_cell();
      let id = round(p / cell);
      let q = p - cell * id;
      let h = hash33(id + 11.3);
      let r = cell * (0.2 + 0.1 * m * sin(t * 2.0 + h.x * TAU));
      var s = length(q) - r;
      s += cell * 0.01 * sin(q.x * f32(det) * 12.0 / cell) * sin(q.y * f32(det) * 12.0 / cell) * sin(q.z * f32(det) * 12.0 / cell);
      let rod = min(length(q.xy), min(length(q.yz), length(q.xz))) - cell * 0.025;
      var d = sd_smin(s, rod, 0.02 + bl * 0.25 * cell);
      d = max(d, cell * 0.45 - length(p - sd_ro));
      return vec2f(d * 0.85, h.y);
    }
    case 9 { // octahedral crystal cluster
      let e = 1.0 + m * 0.8;
      var d = sd_oct(p * vec3f(1.0, 1.0 / e, 1.0), 0.75) * min(1.0, e);
      var tr = 0.0;
      for (var i = 0; i < 12; i++) {
        if (i >= det) { break; }
        let hv = hash33(vec3f(f32(i) * 7.13, 1.31, 2.77));
        let dir = normalize(vec3f(hv.x - 0.5, hv.y * 0.9 - 0.25, hv.z - 0.5) + vec3f(0.0, 1e-3, 0.0));
        let b1 = normalize(cross(dir, select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(dir.y) > 0.9)));
        let b2 = cross(dir, b1);
        let len = 0.35 + 0.25 * hv.x;
        let pp = vec3f(dot(p, b1), dot(p, dir) - 0.55 - len * 0.5 * (1.0 + 0.2 * sin(t + f32(i))), dot(p, b2));
        let s = sd_oct(pp * vec3f(1.0, 0.3, 1.0), 0.22) * 0.3;
        if (s < d) { tr = f32(i + 1) / f32(det + 1); }
        d = sd_smin(d, s, 0.01 + bl * 0.15);
      }
      return vec2f(d, tr);
    }
    default { // (2,3) torus knot, ribbed tube
      let a = atan2(p.z, p.x);
      var q = vec2f(length(p.xz) - 1.0, p.y);
      q = rot(a * 1.5 + t) * q;
      let sep = 0.36 + 0.12 * m * sin(a * 3.0 + t * 2.0);
      q.x = sqrt(q.x * q.x + bl * bl * 0.02) - sep;
      let rib = 0.008 * sin(atan2(q.y, q.x) * f32(det * 2) + a * 20.0);
      let d = length(q) - 0.17 + rib;
      return vec2f(d * 0.7, fract(a / TAU + 0.5));
    }
  }
}
fn sd_scene(p0: vec3f) -> vec2f {
  var p = p0;
  if (u.twist != 0.0) { let xz = rot(p.y * u.twist) * p.xz; p = vec3f(xz.x, p.y, xz.y); }
  if (u.repeat > 1 && u.form != 6 && u.form != 8) {
    let n = f32(u.repeat);
    let sec = TAU / n;
    let a = atan2(p.z, p.x);
    let a2 = abs(a - sec * round(a / sec));
    let r = length(p.xz);
    p = vec3f(r * cos(a2), p.y, r * sin(a2));
  }
  let res = sd_form(p);
  return vec2f(res.x / (1.0 + abs(u.twist) * 0.6), res.y);
}
fn sp_map(p: vec3f) -> f32 { return sd_scene(p).x; }
` + SP_MARCH + /* wgsl */`
fn sd_pal(x: f32) -> vec3f {
  let c = palette(x, vec3f(0.5), vec3f(0.5), vec3f(1.0), vec3f(0.0, 0.33, 0.67));
  return c * c;
}
fn sd_tri(p: vec3f, n: vec3f) -> vec3f {
  var w = pow(abs(n), vec3f(4.0)); w /= (w.x + w.y + w.z);
  let s = p * u.texScale * 0.5;
  return textureSampleLevel(tex, smpR, s.zy, 0.0).rgb * w.x + textureSampleLevel(tex, smpR, s.xz, 0.0).rgb * w.y +
         textureSampleLevel(tex, smpR, s.xy, 0.0).rgb * w.z;
}
fn op(uv: vec2f) -> vec4f {
  let cam = sp_camera(uv);
  sd_ro = cam.ro;
  let infinite = u.form == 6 || u.form == 8;
  let tmax = select(8.0 + u.camDist * 2.0, 40.0, infinite);
  let hit = sp_march(cam.ro, cam.rd, tmax, u.steps, 0.9, cam.pix);
  if (hit.y < 0.5) { return sp_miss(cam.rd); }
  let t = hit.x;
  let p = cam.ro + cam.rd * t;
  let n = sp_normal(p, max(cam.pix * t, 5e-4));
  let trap = sd_scene(p).y;
  var alb: vec3f;
  switch (u.colorMode) {
    case 0 { alb = sd_pal(dot(p, vec3f(0.35, 0.5, 0.25)) * u.frequency + u.phase); }
    case 1 { alb = sd_pal(dot(n, vec3f(0.5, 0.35, 0.6)) * 0.5 * u.frequency + u.phase); }
    case 3 { alb = u.baseColor.rgb; }
    case 4 { alb = select(sd_pal(trap * u.frequency + u.phase), sd_tri(p, n), u.has_tex > 0.5); }
    default { alb = sd_pal(trap * u.frequency + u.phase); }
  }
  let l = sp_ldir();
  let sh = sp_shadow(p + n * 0.01, l, 6.0);
  let occ = sp_occ(p, n);
  var c = sp_shade(alb, n, cam.rd, sh, occ) + alb * u.emission;
  c = sp_fog(c, t, cam.rd);
  return vec4f(c, 1.0);
}`,
};

// ------------------------------------------------------------------------------------------------
// Relief: a picture as a raymarched height field.
// ------------------------------------------------------------------------------------------------
const terrain: OpDef = {
  type: 'terrain', label: 'Relief', category: 'Generate', output: 'tex', animated: true,
  inputs: [{ name: 'src', type: 'tex' }],
  help: 'Turns any picture into a landscape: brightness becomes height, colour becomes the ground. Fly over it, or draw it as ridge lines or points.',
  params: [
    { k: 'float', name: 'heightScale', label: 'Height', def: 0.6, min: 0, max: 3 },
    { k: 'float', name: 'size', def: 4, min: 0.5, max: 20, help: 'World size of one picture tile (it mirror-repeats).' },
    { k: 'float', name: 'smoothing', def: 0.002, min: 0, max: 0.02, step: 0.0005, help: 'Height blur, fraction of picture height.' },
    { k: 'float', name: 'flySpeed', label: 'Fly speed', def: 0.04, min: -1, max: 1, help: 'Scrolls the landscape toward the camera, tiles per second.' },
    { k: 'enum', name: 'mode', options: ['Surface', 'Ridge lines', 'Points'], def: 0 },
    { k: 'int', name: 'lineCount', label: 'Line count', def: 70, min: 4, max: 400, help: 'Ridge lines per tile.' },
    { k: 'float', name: 'gridAmount', label: 'Grid', def: 0.35, min: 0, max: 2, help: 'Grid-line overlay in Surface mode; line tint in the other modes.' },
    { k: 'float', name: 'gridSpacing', label: 'Grid spacing', def: 0.2, min: 0.01, max: 2, help: 'Also the dot spacing in Points mode.' },
    { k: 'color', name: 'gridColor', label: 'Grid colour', def: [0.35, 0.85, 1, 1] },
    { k: 'int', name: 'steps', label: 'March steps', def: 96, min: 16, max: 256 },
    bgParam(),
    ...camParams({ dist: 3.2, pitch: 32, yaw: 0, orbit: 4 }),
    ...lightParams({ fog: 0.12, ao: 0.5 }),
  ],
  body: SP_COMMON + /* wgsl */`
var<private> tr_ar: f32 = 1.0;
fn tr_uv(xz: vec2f) -> vec2f {
  var q = vec2f(xz.x / (u.size * tr_ar), xz.y / u.size) + 0.5 - vec2f(0.0, g.time * u.flySpeed);
  return 1.0 - abs(fract(q * 0.5) * 2.0 - 1.0);
}
fn tr_h(xz: vec2f) -> f32 {
  let q = tr_uv(xz);
  var l = luma(textureSampleLevel(src, smp, q, 0.0).rgb);
  if (u.smoothing > 0.0) {
    let r = vec2f(u.smoothing / tr_ar, u.smoothing) * 0.7;
    l = l * 0.2 + 0.2 * (luma(textureSampleLevel(src, smp, q + r, 0.0).rgb) + luma(textureSampleLevel(src, smp, q - r, 0.0).rgb) +
        luma(textureSampleLevel(src, smp, q + vec2f(r.x, -r.y), 0.0).rgb) + luma(textureSampleLevel(src, smp, q - vec2f(r.x, -r.y), 0.0).rgb));
  }
  return clamp(l, 0.0, 1.5) * u.heightScale;
}
fn sp_map(p: vec3f) -> f32 { return (p.y - tr_h(p.xz)) * 0.4; }
` + SP_MARCH + /* wgsl */`
fn tr_line(d: f32, w: f32, foot: f32) -> f32 {
  // anti-aliased line of half-width w, footprint-aware
  let aa = max(foot, 1e-5);
  return (1.0 - smoothstep(w - aa, w + aa, d)) * sat(w / aa);
}
fn op(uv: vec2f) -> vec4f {
  let dims = vec2f(textureDimensions(src));
  tr_ar = select(1.0, dims.x / max(dims.y, 1.0), dims.y > 1.0);
  let cam = sp_camera(uv);
  let ro = cam.ro; let rd = cam.rd;
  let top = u.heightScale * 1.5 + 1e-3;
  var t = 0.0;
  let tfar = 3.0 / max(u.fogDensity, 0.02) + u.camDist;
  var tmax = tfar;
  if (ro.y > top) {
    if (rd.y >= 0.0) { return sp_miss(rd); }
    t = (top - ro.y) / rd.y;
  }
  if (rd.y < 0.0) { tmax = min(tmax, (-0.001 - ro.y) / rd.y); }
  var hit = false; var tp = t;
  let n = clamp(u.steps, 16, 256);
  for (var i = 0; i < 256; i++) {
    if (i >= n || t > tmax) { break; }
    let p = ro + rd * t;
    let h = p.y - tr_h(p.xz);
    if (h < cam.pix * t * 0.5) { hit = true; break; }
    tp = t;
    t += clamp(h * 0.45, 0.002 + t * 0.002, 0.4);
  }
  if (!hit && t >= tmax && rd.y < 0.0 && tmax < tfar) { hit = true; t = tmax; }
  if (!hit) { return sp_miss(rd); }
  // bisection refine between last outside and first inside sample
  var a = tp; var b = t;
  for (var i = 0; i < 6; i++) {
    let m = 0.5 * (a + b);
    let p = ro + rd * m;
    if (p.y - tr_h(p.xz) > 0.0) { a = m; } else { b = m; }
  }
  t = b;
  let p = ro + rd * t;
  let foot = cam.pix * t;
  let e = max(foot, 0.004);
  let nrm = normalize(vec3f(tr_h(p.xz - vec2f(e, 0.0)) - tr_h(p.xz + vec2f(e, 0.0)), 2.0 * e,
                            tr_h(p.xz - vec2f(0.0, e)) - tr_h(p.xz + vec2f(0.0, e))));
  let alb = max(textureSampleLevel(src, smp, tr_uv(p.xz), 0.0).rgb, vec3f(0.0));
  var c: vec3f;
  if (u.mode == 1) {
    let sp = u.size / f32(clamp(u.lineCount, 1, 1000));
    let dz = abs(fract(p.z / sp + 0.5) - 0.5) * sp;
    // project footprint onto the slope so lines stay one pixel thick on steep faces
    let ln = tr_line(dz, sp * 0.06, foot / max(abs(nrm.y), 0.25));
    let lc = mix(alb * 1.6 + 0.05, u.gridColor.rgb * 2.0, sat(u.gridAmount * 0.5));
    c = u.fogColor.rgb * 0.15 + lc * ln;
  } else if (u.mode == 2) {
    let s = u.gridSpacing;
    let cell = p.xz - s * round(p.xz / s);
    let dd = length(cell);
    let dot_ = tr_line(dd, s * 0.22, foot);
    let lc = sp_shade(alb, nrm, rd, 1.0, 1.0) * 1.4 + u.gridColor.rgb * u.gridAmount * 0.3;
    c = u.fogColor.rgb * 0.15 + lc * dot_;
  } else {
    let l = sp_ldir();
    let sh = sp_shadow(p + nrm * 0.01, l, 3.0);
    let occ = sp_occ(p, nrm);
    c = sp_shade(alb, nrm, rd, sh, occ);
    let s = u.gridSpacing;
    let gq = abs(p.xz - s * round(p.xz / s));
    let gl = max(tr_line(gq.x, s * 0.015, foot), tr_line(gq.y, s * 0.015, foot));
    c += u.gridColor.rgb * gl * u.gridAmount;
  }
  return vec4f(sp_fog(c, t, rd), 1.0);
}`,
};

// ------------------------------------------------------------------------------------------------
// Sphere Map: footage wrapped on a lit, rotating globe (or seen from inside it).
// ------------------------------------------------------------------------------------------------
const globe: OpDef = {
  type: 'globe', label: 'Sphere Map', category: 'Generate', output: 'tex', animated: true,
  inputs: [{ name: 'src', type: 'tex' }],
  help: 'Wraps a picture around a rotating lit sphere with an atmosphere glow. Equirectangular footage maps 1:1; Inside view turns it into a 360° viewer.',
  params: [
    { k: 'enum', name: 'projection', options: ['Equirectangular', 'Planar repeated'], def: 0 },
    { k: 'vec2', name: 'tiles', label: 'Repeat N × M', def: [4, 2], min: 1, max: 16, step: 1 },
    { k: 'float', name: 'radius', def: 1, min: 0.1, max: 4 },
    { k: 'float', name: 'spin', def: 15, min: -180, max: 180, unit: '°/s' },
    { k: 'float', name: 'tilt', def: 18, min: -90, max: 90, unit: '°' },
    { k: 'float', name: 'displace', label: 'Luma displace', def: 0, min: 0, max: 0.5, step: 0.001 },
    { k: 'color', name: 'atmosColor', label: 'Atmosphere', def: [0.35, 0.6, 1, 1] },
    { k: 'float', name: 'atmos', label: 'Atmosphere amount', def: 0.8, min: 0, max: 4 },
    { k: 'float', name: 'emission', def: 0.1, min: 0, max: 2, help: 'Unlit share of the picture (keeps the night side readable).' },
    { k: 'bool', name: 'inside', label: 'Inside view', def: false },
    { k: 'int', name: 'steps', label: 'March steps', def: 64, min: 16, max: 256 },
    bgParam(),
    ...camParams({ dist: 3.4, pitch: 10, orbit: 0 }),
    ...lightParams({ fog: 0.02, ao: 0.4, spec: 0.35 }),
  ],
  body: SP_COMMON + /* wgsl */`
var<private> gl_inv: mat3x3f;
var<private> gl_sign: f32 = 1.0;
fn gl_uv(p: vec3f) -> vec2f {
  let q = gl_inv * p;
  let r = max(length(q), 1e-6);
  var uv = vec2f(0.5 + atan2(q.x, q.z) / TAU, 0.5 - asin(clamp(q.y / r, -1.0, 1.0)) / PI);
  if (u.projection == 1) { uv = fract(uv * max(round(u.tiles), vec2f(1.0))); }
  return uv;
}
fn gl_h(p: vec3f) -> f32 {
  if (u.displace <= 0.0) { return 0.0; }
  return sat(luma(textureSampleLevel(src, smp, gl_uv(p), 0.0).rgb)) * u.displace;
}
fn sp_map(p: vec3f) -> f32 {
  let d = length(p) - u.radius - gl_h(p);
  return gl_sign * d * select(1.0, 0.5, u.displace > 0.0);
}
` + SP_MARCH + /* wgsl */`
fn op(uv: vec2f) -> vec4f {
  let a = radians(g.time * u.spin); let b = radians(u.tilt);
  let ry = mat3x3f(cos(a), 0.0, -sin(a), 0.0, 1.0, 0.0, sin(a), 0.0, cos(a));
  let rz = mat3x3f(cos(b), sin(b), 0.0, -sin(b), cos(b), 0.0, 0.0, 0.0, 1.0);
  // object = tilt * spin; world → object is the transpose
  gl_inv = transpose(rz * ry);
  var cam = sp_camera(uv);
  if (u.inside == 1) {
    // stand at the centre (offset by Look-at) and look outward along the orbit direction
    gl_sign = -1.0;
    let yaw = radians(u.camYaw + g.time * u.orbit);
    let pitch = radians(clamp(u.camPitch, -89.0, 89.0));
    let ro = vec3f(u.lookAt * 0.5 * u.radius, 0.0);
    cam = sp_basis(ro, ro - vec3f(cos(pitch) * sin(yaw), sin(pitch), cos(pitch) * cos(yaw)));
    let s = sp_screen(uv);
    cam.rd = normalize(cam.fw * cam.foc + cam.rt * s.x + cam.up * s.y);
  }
  let ro = cam.ro; let rd = cam.rd;
  let R = u.radius; let Rb = R + u.displace + 1e-3;
  // bounding sphere
  let bq = dot(ro, rd); let cq = dot(ro, ro) - Rb * Rb;
  let disc = bq * bq - cq;
  // atmosphere: closest approach of the ray to the centre
  let tc = max(-bq, 0.0);
  let bdist = length(ro + rd * tc);
  let halo = u.atmos * exp(-max(bdist - R, 0.0) / (0.12 * R)) * select(0.0, 1.0, u.inside == 0);
  if (disc < 0.0 && u.inside == 0) {
    let m = sp_miss(rd);
    let gcol = u.atmosColor.rgb * halo * 0.6;
    return vec4f(m.rgb + gcol, max(m.a, sat(luma(gcol) * 2.0)));
  }
  var t0 = 0.0; var t1 = 0.0;
  if (u.inside == 1) { t0 = 0.0; t1 = -bq + sqrt(max(disc, 0.0)) + 0.1; }
  else { t0 = max(-bq - sqrt(disc), 0.0); t1 = -bq + sqrt(disc); }
  var t = t0; var hit = false;
  let n = clamp(u.steps, 16, 256);
  for (var i = 0; i < 256; i++) {
    if (i >= n) { break; }
    let h = sp_map(ro + rd * t);
    if (abs(h) < max(cam.pix * t * 0.5, 1e-4)) { hit = true; break; }
    t += h;
    if (t > t1) { break; }
  }
  if (!hit && u.displace <= 0.0 && u.inside == 0 && -bq - sqrt(max(disc, 0.0)) > 0.0) {
    let rr = sqrt(max(bq * bq - (dot(ro, ro) - R * R), -1.0));
    if (bq * bq - (dot(ro, ro) - R * R) >= 0.0) { hit = true; t = -bq - rr; }
  }
  if (!hit) {
    let m = sp_miss(rd);
    let gcol = u.atmosColor.rgb * halo * 0.6;
    return vec4f(m.rgb + gcol, max(m.a, sat(luma(gcol) * 2.0)));
  }
  let p = ro + rd * t;
  let alb = max(textureSampleLevel(src, smp, gl_uv(p), 0.0).rgb, vec3f(0.0));
  var c: vec3f;
  if (u.inside == 1) {
    c = alb * (1.0 + u.emission);
  } else {
    var nrm = normalize(p);
    var sh = 1.0; var occ = 1.0;
    if (u.displace > 0.0) {
      nrm = sp_normal(p, max(cam.pix * t, 1e-3));
      sh = sp_shadow(p + nrm * 0.01, sp_ldir(), 2.0 * R);
      occ = sp_occ(p, nrm);
    }
    c = sp_shade(alb, nrm, rd, sh, occ) + alb * u.emission;
    let fre = pow(1.0 - sat(dot(normalize(p), -rd)), 2.5);
    c += u.atmosColor.rgb * u.atmos * fre * (0.35 + 0.65 * sat(dot(normalize(p), sp_ldir()) + 0.5));
  }
  return vec4f(sp_fog(c, t, rd), 1.0);
}`,
};

// ------------------------------------------------------------------------------------------------
// Video Solid: footage on a rotating primitive with bevels and environment reflections.
// ------------------------------------------------------------------------------------------------
const solid: OpDef = {
  type: 'solid', label: 'Video Solid', category: 'Generate', output: 'tex', animated: true,
  inputs: [{ name: 'src', type: 'tex' }, { name: 'tex2', type: 'tex', optional: true }],
  help: 'Maps a picture onto a rotating cube, rounded box, cylinder, torus, pyramid or prism, with bevels and glossy reflections. Tex2 goes on alternate faces.',
  params: [
    { k: 'enum', name: 'shape', options: ['Cube', 'Rounded Box', 'Cylinder', 'Torus', 'Pyramid', 'Prism'], def: 0 },
    { k: 'float', name: 'size', def: 1, min: 0.1, max: 4 },
    { k: 'vec2', name: 'spin', label: 'Spin X / Y', def: [17, 29], min: -180, max: 180, help: 'Degrees per second around X and Y.' },
    { k: 'float', name: 'roll', def: 0, min: -180, max: 180, unit: '°/s' },
    { k: 'float', name: 'bevel', def: 0.04, min: 0, max: 0.4, step: 0.001 },
    { k: 'bool', name: 'perFace', label: 'Per-face UV', def: true, help: 'Fit the whole picture on every face; off = continuous box projection.' },
    { k: 'float', name: 'reflect', label: 'Reflection', def: 0.35, min: 0, max: 2 },
    { k: 'float', name: 'emission', def: 0.15, min: 0, max: 2 },
    { k: 'int', name: 'steps', label: 'March steps', def: 72, min: 16, max: 256 },
    bgParam(),
    ...camParams({ dist: 4, pitch: 12, orbit: 0 }),
    ...lightParams({ fog: 0.02 }),
  ],
  body: SP_COMMON + /* wgsl */`
var<private> vs_inv: mat3x3f;
fn vs_box(p: vec3f, b: vec3f) -> f32 {
  let q = abs(p) - b;
  return length(max(q, vec3f(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0);
}
fn vs_round() -> f32 { return select(u.bevel, 0.22 + u.bevel, u.shape == 1) * u.size; }
fn vs_sdf(p0: vec3f) -> f32 {
  let s = max(u.size, 1e-3);
  let p = p0 / s;
  let r = vs_round() / s;
  var d: f32;
  switch (u.shape) {
    case 2 {
      let q = vec2f(length(p.xz) - (0.65 - r), abs(p.y) - (0.7 - r));
      d = length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
    }
    case 3 {
      let q = vec2f(length(p.xz) - 0.72, p.y);
      d = length(q) - 0.3;
    }
    case 4 {
      let k = 1.0 / length(vec2f(1.4, 0.8));
      let dx = (1.4 * abs(p.x) + 0.8 * p.y - 0.64) * k;
      let dz = (1.4 * abs(p.z) + 0.8 * p.y - 0.64) * k;
      d = max(max(dx, dz) + r, -p.y - 0.6 + r) - r;
    }
    case 5 {
      let q = abs(p);
      d = max(q.z - (0.75 - r), max(q.x * 0.866025 + p.y * 0.5, -p.y) - (0.5 - r)) - r;
    }
    default { d = vs_box(p, vec3f(0.7 - r)) - r; }
  }
  return d * s;
}
fn sp_map(p: vec3f) -> f32 { return vs_sdf(vs_inv * p); }
` + SP_MARCH + /* wgsl */`
// returns (uv, face id)
fn vs_face(p0: vec3f, n: vec3f) -> vec3f {
  let p = p0 / max(u.size, 1e-3);
  let an = abs(n);
  if (u.perFace == 0) {
    // continuous box projection in object space
    if (an.x > an.y && an.x > an.z) { return vec3f(p.zy * vec2f(-sign(n.x), -1.0) * 0.7 + 0.5, select(0.0, 1.0, n.x > 0.0)); }
    if (an.y > an.z) { return vec3f(p.xz * vec2f(1.0, sign(n.y)) * 0.7 + 0.5, select(2.0, 3.0, n.y > 0.0)); }
    return vec3f(p.xy * vec2f(sign(n.z), -1.0) * 0.7 + 0.5, select(4.0, 5.0, n.z > 0.0));
  }
  switch (u.shape) {
    case 2 {
      if (an.y > 0.7) { return vec3f(p.xz / 1.3 + 0.5, select(0.0, 1.0, n.y > 0.0)); }
      let a = atan2(p.z, p.x) / TAU + 0.5;
      return vec3f(fract(a * 2.0), -p.y / 1.4 + 0.5, 2.0 + floor(a * 2.0));
    }
    case 3 {
      let a = atan2(p.z, p.x) / TAU + 0.5;
      let b = atan2(p.y, length(p.xz) - 0.72) / TAU + 0.5;
      return vec3f(fract(a * 4.0), b, floor(a * 4.0));
    }
    case 4 {
      if (n.y < -0.7) { return vec3f(p.xz / 1.6 + 0.5, 0.0); }
      if (abs(p.x) > abs(p.z)) { return vec3f(p.z * sign(p.x) / 1.6 + 0.5, (0.8 - p.y) / 1.4, select(1.0, 2.0, p.x > 0.0)); }
      return vec3f(-p.x * sign(p.z) / 1.6 + 0.5, (0.8 - p.y) / 1.4, select(3.0, 4.0, p.z > 0.0));
    }
    case 5 {
      if (an.z > 0.7) { return vec3f(vec2f(p.x, -p.y) / 1.2 + 0.5, select(0.0, 1.0, n.z > 0.0)); }
      if (n.y < -0.7) { return vec3f(vec2f(p.z / 1.5, p.x / 1.2) + 0.5, 4.0); }
      return vec3f(p.z / 1.5 + 0.5, (1.0 - p.y) / 1.5, select(2.0, 3.0, n.x > 0.0));
    }
    default {
      if (an.x > an.y && an.x > an.z) { return vec3f(vec2f(-p.z * sign(n.x), -p.y) / 1.4 + 0.5, select(0.0, 1.0, n.x > 0.0)); }
      if (an.y > an.z) { return vec3f(vec2f(p.x, p.z * sign(n.y)) / 1.4 + 0.5, select(2.0, 3.0, n.y > 0.0)); }
      return vec3f(vec2f(p.x * sign(n.z), -p.y) / 1.4 + 0.5, select(4.0, 5.0, n.z > 0.0));
    }
  }
}
fn vs_env(r: vec3f) -> vec3f {
  let l = sp_ldir();
  var c = mix(vec3f(0.05, 0.045, 0.06), vec3f(0.35, 0.45, 0.7), smoothstep(-0.2, 0.8, r.y));
  c += SP_KEY * 6.0 * pow(max(dot(r, l), 0.0), 60.0);
  // two soft-box strips give glossy edges something to catch
  c += vec3f(1.0) * 1.2 * smoothstep(0.92, 0.97, 1.0 - abs(r.y - 0.35)) * smoothstep(-0.2, 0.4, r.z);
  c += u.fogColor.rgb * 2.0 * smoothstep(0.1, -0.3, r.y);
  return c;
}
fn op(uv: vec2f) -> vec4f {
  let a = radians(vec3f(u.spin.x, u.spin.y, u.roll) * g.time);
  let cx = cos(a.x); let sx = sin(a.x); let cy = cos(a.y); let sy = sin(a.y); let cz = cos(a.z); let sz = sin(a.z);
  let rx = mat3x3f(1.0, 0.0, 0.0, 0.0, cx, sx, 0.0, -sx, cx);
  let ry = mat3x3f(cy, 0.0, -sy, 0.0, 1.0, 0.0, sy, 0.0, cy);
  let rz = mat3x3f(cz, sz, 0.0, -sz, cz, 0.0, 0.0, 0.0, 1.0);
  vs_inv = transpose(rz * ry * rx);
  let cam = sp_camera(uv);
  let hit = sp_march(cam.ro, cam.rd, u.camDist + 4.0 * u.size, u.steps, 0.9, cam.pix);
  if (hit.y < 0.5) { return sp_miss(cam.rd); }
  let t = hit.x;
  let p = cam.ro + cam.rd * t;
  let n = sp_normal(p, max(cam.pix * t, 5e-4));
  let lp = vs_inv * p; let ln = vs_inv * n;
  let f = vs_face(lp, ln);
  let alt = u.has_tex2 > 0.5 && (i32(f.z) % 2) == 1;
  let fuv = clamp(f.xy, vec2f(0.0), vec2f(1.0));
  var alb = max(textureSampleLevel(src, smp, fuv, 0.0).rgb, vec3f(0.0));
  if (alt) { alb = max(textureSampleLevel(tex2, smp, fuv, 0.0).rgb, vec3f(0.0)); }
  let sh = sp_shadow(p + n * 0.01, sp_ldir(), 4.0);
  let occ = sp_occ(p, n);
  var c = sp_shade(alb, n, cam.rd, sh, occ) + alb * u.emission;
  let fre = 0.04 + 0.96 * pow(1.0 - sat(dot(n, -cam.rd)), 5.0);
  c += vs_env(reflect(cam.rd, n)) * u.reflect * (0.15 + 0.85 * fre) * occ;
  return vec4f(sp_fog(c, t, cam.rd), 1.0);
}`,
};

// ------------------------------------------------------------------------------------------------
// Luma Extrude: a grid of boxes whose heights follow the picture, raycast with an exact DDA.
// ------------------------------------------------------------------------------------------------
const extrude: OpDef = {
  type: 'extrude', label: 'Luma Extrude', category: 'Generate', output: 'tex', animated: true,
  inputs: [{ name: 'src', type: 'tex' }],
  help: 'Cuts the picture into blocks and raises each one by its brightness. Raycast exactly, so every edge is crisp; isometric or perspective.',
  params: [
    { k: 'int', name: 'blocks', label: 'Block count', def: 36, min: 2, max: 160, help: 'Blocks across the picture height.' },
    { k: 'float', name: 'height', def: 0.5, min: 0, max: 3 },
    { k: 'float', name: 'gap', def: 0.12, min: 0, max: 0.9, help: 'Gap between blocks, fraction of a block.' },
    { k: 'bool', name: 'ortho', label: 'Isometric', def: true },
    { k: 'bool', name: 'useColor', label: 'Colour from source', def: true },
    { k: 'float', name: 'sideDark', label: 'Side darkening', def: 0.45, min: 0, max: 1 },
    bgParam(),
    ...camParams({ dist: 3.6, pitch: 35.26, yaw: 45, orbit: 6 }),
    ...lightParams({ fog: 0.03, ao: 0.6, spec: 0.3 }),
  ],
  body: SP_COMMON + /* wgsl */`
var<private> ex_n: vec2i;
var<private> ex_cs: vec2f;
var<private> ex_min: vec2f;
fn ex_h(c: vec2i) -> f32 {
  let q = (vec2f(c) + 0.5) / vec2f(ex_n);
  return 0.003 + sat(luma(textureSampleLevel(src, smp, q, 0.0).rgb)) * u.height;
}
// slab test; returns (tnear, tfar)
fn ex_slab(ro: vec3f, ird: vec3f, bmin: vec3f, bmax: vec3f) -> vec2f {
  let t0 = (bmin - ro) * ird; let t1 = (bmax - ro) * ird;
  let tn = min(t0, t1); let tf = max(t0, t1);
  return vec2f(max(max(tn.x, tn.y), tn.z), min(min(tf.x, tf.y), tf.z));
}
// DDA through the block grid. Returns (t, cell.x, cell.y, face: 0 top, 1 x side, 2 z side, 3 floor) or t < 0 on miss.
fn ex_trace(ro: vec3f, rd: vec3f) -> vec4f {
  let ird = 1.0 / select(rd, vec3f(1e-8), abs(rd) < vec3f(1e-8));
  let bmin = vec3f(ex_min.x, 0.0, ex_min.y);
  let bmax = vec3f(-ex_min.x, u.height + 0.01, -ex_min.y);
  let span = ex_slab(ro, ird, bmin, bmax);
  if (span.x > span.y || span.y < 0.0) { return vec4f(-1.0); }
  let t0 = max(span.x, 0.0);
  let p0 = ro + rd * (t0 + 1e-5);
  var cell = clamp(vec2i(floor((p0.xz - ex_min) / ex_cs)), vec2i(0), ex_n - 1);
  let stp = vec2i(sign(rd.xz));
  let tdel = abs(ex_cs * ird.xz);
  let nb = ex_min + (vec2f(cell) + select(vec2f(0.0), vec2f(1.0), rd.xz > vec2f(0.0))) * ex_cs;
  var tmx = (nb - ro.xz) * ird.xz;
  let half = ex_cs * 0.5 * (1.0 - clamp(u.gap, 0.0, 0.95));
  let lim = ex_n.x + ex_n.y + 2;
  for (var i = 0; i < 640; i++) {
    if (i >= lim) { break; }
    let ctr = ex_min + (vec2f(cell) + 0.5) * ex_cs;
    let h = ex_h(cell);
    let bt = ex_slab(ro, ird, vec3f(ctr.x - half.x, 0.0, ctr.y - half.y), vec3f(ctr.x + half.x, h, ctr.y + half.y));
    if (bt.x <= bt.y && bt.y > 0.0) {
      let th = max(bt.x, 0.0);
      let ph = ro + rd * th;
      let rel = abs(ph - vec3f(ctr.x, h * 0.5, ctr.y)) / vec3f(half.x, h * 0.5, half.y);
      var face = 0.0;
      if (rel.x > rel.y && rel.x > rel.z) { face = 1.0; } else if (rel.z > rel.y) { face = 2.0; }
      return vec4f(th, f32(cell.x), f32(cell.y), face);
    }
    // floor in the gap between blocks
    let tcell = min(tmx.x, tmx.y);
    if (rd.y < 0.0) {
      let tf = -ro.y / rd.y;
      if (tf < tcell && tf >= t0) { return vec4f(tf, f32(cell.x), f32(cell.y), 3.0); }
    }
    if (tmx.x < tmx.y) { cell.x += stp.x; tmx.x += tdel.x; } else { cell.y += stp.y; tmx.y += tdel.y; }
    if (cell.x < 0 || cell.y < 0 || cell.x >= ex_n.x || cell.y >= ex_n.y) { break; }
  }
  return vec4f(-1.0);
}
fn op(uv: vec2f) -> vec4f {
  let dims = vec2f(textureDimensions(src));
  let ar = select(1.0, dims.x / max(dims.y, 1.0), dims.y > 1.0);
  let rows = clamp(u.blocks, 2, 160);
  ex_n = vec2i(clamp(i32(round(f32(rows) * ar)), 1, 400), rows);
  ex_min = vec2f(-ar, -1.0);
  ex_cs = vec2f(2.0 * ar, 2.0) / vec2f(ex_n);
  var cam = sp_camera(uv);
  if (u.ortho == 1) {
    let s = sp_screen(uv);
    let k = u.camDist / cam.foc;
    cam.ro = cam.ro + (cam.rt * s.x + cam.up * s.y) * k - cam.fw * 10.0;
    cam.rd = cam.fw;
  }
  let hit = ex_trace(cam.ro, cam.rd);
  if (hit.x < 0.0) { return sp_miss(cam.rd); }
  let t = hit.x;
  let p = cam.ro + cam.rd * t;
  let cell = vec2i(hit.yz);
  let ctr = ex_min + (vec2f(cell) + 0.5) * ex_cs;
  var n = vec3f(0.0, 1.0, 0.0);
  if (hit.w == 1.0) { n = vec3f(sign(p.x - ctr.x), 0.0, 0.0); }
  if (hit.w == 2.0) { n = vec3f(0.0, 0.0, sign(p.z - ctr.y)); }
  let src_c = max(textureSampleLevel(src, smp, (vec2f(cell) + 0.5) / vec2f(ex_n), 0.0).rgb, vec3f(0.0));
  let hh = ex_h(cell);
  var alb = select(palette(hh / max(u.height, 1e-3) * 0.8 + 0.1, vec3f(0.5), vec3f(0.5), vec3f(1.0), vec3f(0.0, 0.1, 0.2)), src_c, u.useColor == 1);
  if (hit.w == 3.0) { alb = alb * 0.15; }
  var sh = 1.0;
  if (u.shadows == 1) {
    let l = sp_ldir();
    let s = ex_trace(p + n * 1e-3 + l * 1e-3, l);
    sh = select(1.0, 0.0, s.x > 0.0);
  }
  let ref_h = max(ex_cs.y, 1e-3) * 1.5;
  var occ = mix(1.0, sat(0.35 + 0.65 * p.y / ref_h), u.ao);
  if (hit.w == 3.0) { occ = 1.0 - u.ao * 0.7; }
  var c = sp_shade(alb, n, cam.rd, sh, occ);
  if (hit.w == 1.0) { c *= 1.0 - u.sideDark; }
  if (hit.w == 2.0) { c *= 1.0 - u.sideDark * 0.6; }
  return vec4f(sp_fog(c, select(t, t - 10.0 + u.camDist, u.ortho == 1), cam.rd), 1.0);
}`,
};

// ------------------------------------------------------------------------------------------------
// 3D Tunnel: endless bending tube fly-through with light rings.
// ------------------------------------------------------------------------------------------------
const tunnel3d: OpDef = {
  type: 'tunnel3d', label: '3D Tunnel', category: 'Generate', output: 'tex', animated: true,
  inputs: [{ name: 'src', type: 'tex', optional: true }],
  help: 'Flies through an endless bending tube, optionally tiled with footage, lit by a headlight and glowing rings. Camera: Yaw/Pitch look around, Distance is the look-ahead, Auto orbit rolls, Look-at offsets you from the centre line.',
  params: [
    { k: 'enum', name: 'shape', options: ['Round', 'Square', 'Hex', 'Triangle'], def: 0 },
    { k: 'float', name: 'radius', def: 1, min: 0.2, max: 4 },
    { k: 'float', name: 'speed', def: 2, min: -20, max: 20, help: 'Flight speed, units per second.' },
    { k: 'float', name: 'twist', def: 0.08, min: -1, max: 1, help: 'Radians per unit of depth.' },
    { k: 'float', name: 'bend', def: 0.8, min: 0, max: 3 },
    { k: 'float', name: 'bendSpeed', label: 'Bend speed', def: 0.25, min: -4, max: 4 },
    { k: 'vec2', name: 'wallRepeat', label: 'Wall repeat', def: [8, 0.5], min: 0.05, max: 32, help: 'Tiles around the tube / tiles per unit of depth.' },
    { k: 'float', name: 'ringSpacing', label: 'Ring spacing', def: 5, min: 0.5, max: 40, group: 'Rings' },
    { k: 'color', name: 'ringColor', label: 'Ring colour', def: [1, 0.35, 0.75, 1], group: 'Rings' },
    { k: 'float', name: 'ringIntensity', label: 'Ring intensity', def: 2, min: 0, max: 10, group: 'Rings' },
    { k: 'int', name: 'steps', label: 'March steps', def: 72, min: 16, max: 256 },
    bgParam(1),
    ...camParams({ dist: 3, pitch: 0, yaw: 0, orbit: 0, fov: 70 }),
    ...lightParams({ fog: 0.07, ao: 0.5, rim: 0.2, ambient: 0.15 }),
  ],
  body: SP_COMMON + /* wgsl */`
var<private> tn_T: f32;
fn tn_path(z: f32) -> vec2f {
  return u.bend * vec2f(sin(z * 0.19 + tn_T) * 1.2 + sin(z * 0.071 + tn_T * 0.6) * 0.7, cos(z * 0.15 + tn_T * 0.8) * 0.9);
}
fn tn_shape(q: vec2f) -> f32 {
  switch (u.shape) {
    case 1 { return max(abs(q.x), abs(q.y)); }
    case 2 { let a = abs(q); return max(a.x * 0.866025 + a.y * 0.5, a.y); }
    case 3 { return max(-q.y, abs(q.x) * 0.866025 + q.y * 0.5); }
    default { return length(q); }
  }
}
fn tn_local(p: vec3f) -> vec2f { return rot(p.z * u.twist) * (p.xy - tn_path(p.z)); }
fn sp_map(p: vec3f) -> f32 { return (u.radius - tn_shape(tn_local(p))) * 0.7; }
` + SP_MARCH + /* wgsl */`
fn tn_wall(wuv: vec2f, foot: f32) -> vec3f {
  if (u.has_src > 0.5) { return max(textureSampleLevel(src, smpR, vec2f(wuv.x, 1.0 - fract(wuv.y)), 0.0).rgb, vec3f(0.0)); }
  // procedural panels with anti-aliased grooves
  let id = floor(wuv); let f = fract(wuv);
  let e = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y));
  let groove = smoothstep(0.03, 0.03 + max(foot, 0.01), e);
  let h = hash21(id + 0.5);
  let base = palette(h * 0.35 + 0.55, vec3f(0.5), vec3f(0.5), vec3f(1.0), vec3f(0.0, 0.1, 0.2));
  return base * base * (0.25 + 0.5 * h) * groove + vec3f(0.01);
}
fn op(uv: vec2f) -> vec4f {
  tn_T = g.time * u.bendSpeed;
  let z0 = g.time * u.speed;
  let ro = vec3f(tn_path(z0) + u.lookAt * u.radius * 0.5, z0);
  let la = max(u.camDist, 0.1);
  let base = sp_basis(ro, vec3f(tn_path(z0 + la), z0 + la));
  let yaw = radians(u.camYaw); let pitch = radians(clamp(u.camPitch, -89.0, 89.0));
  let look = base.rt * sin(yaw) * cos(pitch) + base.up * sin(pitch) + base.fw * cos(yaw) * cos(pitch);
  var cam = sp_basis(ro, ro + look);
  let s = rot(radians(g.time * u.orbit)) * sp_screen(uv);
  cam.rd = normalize(cam.fw * cam.foc + cam.rt * s.x + cam.up * s.y);
  let rd = cam.rd;
  let tmax = 4.0 / max(u.fogDensity, 0.04) + 10.0;
  let hit = sp_march(ro, rd, tmax, u.steps, 0.9, cam.pix);
  let spc = max(u.ringSpacing, 0.1);
  // volumetric halo where each ring plane meets the wall, for the next few rings ahead
  var halo = vec3f(0.0);
  if (abs(rd.z) > 1e-3) {
    let k0 = select(floor(z0 / spc), ceil(z0 / spc), rd.z > 0.0);
    for (var k = 0; k < 6; k++) {
      let zr = (k0 + f32(k) * sign(rd.z)) * spc;
      let tz = (zr - ro.z) / rd.z;
      if (tz <= 0.0 || (hit.y > 0.5 && tz > hit.x)) { continue; }
      let pr = ro + rd * tz;
      let wall = u.radius - tn_shape(tn_local(pr));
      halo += u.ringColor.rgb * u.ringIntensity * 0.12 * exp(-max(wall, 0.0) * 8.0 / u.radius) * exp(-tz * u.fogDensity);
    }
  }
  if (hit.y < 0.5) { return vec4f(sp_bgc(rd) + halo, 1.0); }
  let t = hit.x;
  let p = ro + rd * t;
  let n = sp_normal(p, max(cam.pix * t, 1e-3));
  let q = tn_local(p);
  let ang = atan2(q.y, q.x) / TAU + 0.5;
  let rep = vec2f(max(round(u.wallRepeat.x), 1.0), u.wallRepeat.y);
  let wuv = vec2f(ang * rep.x, p.z * rep.y);
  let alb = tn_wall(wuv, cam.pix * t * rep.x * 2.0);
  // headlight just above the camera
  let lp = ro + cam.up * 0.15 * u.radius;
  let ld = lp - p; let dist = length(ld);
  sp_lov = ld / max(dist, 1e-4);
  let sh = sp_shadow(p + n * 0.01, sp_lov, dist);
  let atten = 1.1 / (1.0 + 0.12 * dist * dist);
  let occ = sp_occ(p, n);
  var c = sp_shade(alb, n, rd, sh * atten, occ);
  let dz = p.z - round(p.z / spc) * spc;
  let band = exp(-pow(dz / (0.04 * spc + cam.pix * t), 2.0));
  c += u.ringColor.rgb * u.ringIntensity * (band * 1.5 + alb * 0.6 / (1.0 + dz * dz * 1.5));
  return vec4f(sp_fog(c, t, rd) + halo, 1.0);
}`,
};

// ------------------------------------------------------------------------------------------------
// Motion-vector effects. `flow` is an Optical Flow field: flow.rg / 40 = uv displacement per frame.
// ------------------------------------------------------------------------------------------------
const FLOW_IN = { name: 'flow', type: 'field', optional: true } as const;
const dirParam = (def: [number, number]): ParamDef => ({
  k: 'vec2', name: 'dir', label: 'Fallback direction', def, min: -0.05, max: 0.05, step: 0.0005,
  help: 'Motion used where no Flow field is connected, fraction of picture height per frame.',
});
const MV_VEC = /* wgsl */`
// uv displacement per frame at uv
fn mv_vec(uv: vec2f) -> vec2f {
  if (u.has_flow > 0.5) { return textureSampleLevel(flow, smp, uv, 0.0).rg / 40.0; }
  return u.dir * vec2f(1.0 / g.aspect, 1.0);
}
`;

const motionblur: OpDef = {
  type: 'motionblur', label: 'Pixel Motion Blur', category: 'Time', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }, FLOW_IN],
  help: 'Blurs every pixel along its own motion vector, like a real camera shutter. Connect an Optical Flow field to Flow.',
  params: [
    { k: 'float', name: 'shutter', def: 1, min: 0, max: 8, help: 'Blur length in frames of motion (1 = 360° shutter).' },
    { k: 'int', name: 'taps', label: 'Samples', def: 24, min: 2, max: 48 },
    { k: 'bool', name: 'trailing', def: false, help: 'Smear only behind the motion instead of centred on it.' },
    { k: 'float', name: 'maxLen', label: 'Max length', def: 0.12, min: 0, max: 1, step: 0.001, help: 'Longest blur, fraction of picture height.' },
    dirParam([0.01, 0]),
  ],
  body: MV_VEC + /* wgsl */`
fn op(uv: vec2f) -> vec4f {
  var vh = mv_vec(uv) * u.shutter * vec2f(g.aspect, 1.0);
  let L = length(vh);
  if (L > u.maxLen) { vh *= u.maxLen / max(L, 1e-6); }
  let v = vh / vec2f(g.aspect, 1.0);
  if (length(vh) * g.res.y < 0.5) { return textureSampleLevel(src, smp, uv, 0.0); }
  let n = clamp(u.taps, 2, 48);
  let j = hash21(floor(uv * g.res));
  var acc = vec4f(0.0);
  for (var i = 0; i < 48; i++) {
    if (i >= n) { break; }
    let s = (f32(i) + j) / f32(n);
    let o = select(s - 0.5, -s, u.trailing == 1);
    acc += textureSampleLevel(src, smp, uv + v * o, 0.0);
  }
  return acc / f32(n);
}`,
};

const flowpaint: OpDef = {
  type: 'flowpaint', label: 'Flow Paint', category: 'Filter', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }, FLOW_IN],
  help: 'Paints the picture with brush strokes that follow the motion (line integral convolution). Where the picture is still, strokes follow its contours instead.',
  params: [
    { k: 'float', name: 'strokeLen', label: 'Stroke length', def: 0.06, min: 0.005, max: 0.3, step: 0.001 },
    { k: 'float', name: 'strokeWidth', label: 'Stroke width', def: 0.004, min: 0.001, max: 0.03, step: 0.0005 },
    { k: 'float', name: 'contrast', def: 2.5, min: 0, max: 8 },
    { k: 'float', name: 'satBoost', label: 'Saturation boost', def: 0.4, min: -1, max: 3 },
    { k: 'float', name: 'motionThreshold', label: 'Motion threshold', def: 0.001, min: 0, max: 0.02, step: 0.0001, help: 'Speed (height per frame) above which strokes follow motion instead of contours.' },
    dirParam([0.01, 0.004]),
  ],
  passes: {
    dirs: {
      inputs: ['src', 'flow'], fields: [['dir', 'vec2f'], ['radius', 'f32'], ['thr', 'f32']],
      body: MV_VEC + /* wgsl */`
fn op(uv: vec2f) -> vec4f {
  let r = vec2f(u.radius / g.aspect, u.radius);
  let gx = luma(textureSampleLevel(src, smp, uv + vec2f(r.x, 0.0), 0.0).rgb) - luma(textureSampleLevel(src, smp, uv - vec2f(r.x, 0.0), 0.0).rgb);
  let gy = luma(textureSampleLevel(src, smp, uv + vec2f(0.0, r.y), 0.0).rgb) - luma(textureSampleLevel(src, smp, uv - vec2f(0.0, r.y), 0.0).rgb);
  let fd = u.dir / max(length(u.dir), 1e-6);
  // contour tangent, oriented to agree with the fallback direction
  var tg = vec2f(-gy, gx);
  let gl = length(tg);
  tg = select(fd, tg / max(gl, 1e-6), gl > 1e-3);
  if (dot(tg, fd) < 0.0) { tg = -tg; }
  var d = tg;
  if (u.has_flow > 0.5) {
    let vh = mv_vec(uv) * vec2f(g.aspect, 1.0);
    let sp = length(vh);
    let w = smoothstep(u.thr * 0.5, u.thr * 1.5 + 1e-6, sp);
    let md = vh / max(sp, 1e-7);
    if (dot(tg, md) < 0.0) { tg = -tg; }
    d = normalize(mix(tg, md, w) + vec2f(1e-6, 0.0));
  }
  return vec4f(d, 0.0, 1.0);
}`,
    },
    lic: {
      inputs: ['src', 'dirs'], fields: [['strokeLen', 'f32'], ['strokeWidth', 'f32'], ['contrast', 'f32'], ['satBoost', 'f32']],
      body: /* wgsl */`
fn fp_noise(uv: vec2f) -> f32 {
  return vnoise(uv * vec2f(g.aspect, 1.0) / max(u.strokeWidth, 1e-4));
}
fn op(uv: vec2f) -> vec4f {
  let N = 16;
  let ds = u.strokeLen / f32(N);
  let asp = vec2f(1.0 / g.aspect, 1.0);
  var nacc = fp_noise(uv); var cacc = textureSampleLevel(src, smp, uv, 0.0); var wsum = 1.0;
  for (var side = 0; side < 2; side++) {
    let sgn = select(1.0, -1.0, side == 1);
    var p = uv;
    var prev = textureSampleLevel(dirs, smp, uv, 0.0).rg * sgn;
    for (var i = 1; i <= N; i++) {
      var d = textureSampleLevel(dirs, smp, p, 0.0).rg;
      if (dot(d, prev) < 0.0) { d = -d; }
      prev = d;
      p += d * ds * asp;
      let w = 1.0 - f32(i) / f32(N + 1);
      nacc += fp_noise(p) * w;
      cacc += textureSampleLevel(src, smp, p, 0.0) * w;
      wsum += w;
    }
  }
  let lic = sat((nacc / wsum - 0.5) * u.contrast + 0.5);
  let c = cacc / wsum;
  let l = luma(c.rgb);
  let col = max(vec3f(l) + (c.rgb - vec3f(l)) * (1.0 + u.satBoost), vec3f(0.0));
  return vec4f(col * (0.3 + 1.4 * lic), c.a);
}`,
    },
  },
  cook(c) {
    const d = c.tex('dirs');
    c.run('dirs', d.view, [c.ins[0], c.ins[1]], { dir: c.p.dir, radius: Math.max(c.p.strokeWidth, 1.5 / c.h), thr: c.p.motionThreshold });
    c.run('lic', c.out, [c.ins[0], d.view], { strokeLen: c.p.strokeLen, strokeWidth: c.p.strokeWidth, contrast: c.p.contrast, satBoost: c.p.satBoost });
  },
};

const echoflow: OpDef = {
  type: 'echoflow', label: 'Motion Trails', category: 'Time', output: 'tex', animated: true,
  inputs: [{ name: 'src', type: 'tex' }, FLOW_IN],
  help: 'Keeps a memory of past frames that drifts along the motion and fades, so moving things leave flowing, colour-shifting trails.',
  params: [
    { k: 'float', name: 'decay', def: 0.93, min: 0, max: 0.999, step: 0.001, help: 'Trail persistence per frame.' },
    { k: 'float', name: 'advect', label: 'Advection', def: 1.5, min: -4, max: 8, help: 'How far trails drift along the motion each frame (1 = with the picture).' },
    { k: 'enum', name: 'mode', options: ['Max', 'Add'], def: 0, help: 'Max keeps the brightest; Add averages into luminous long-exposure streaks.' },
    { k: 'float', name: 'hueShift', label: 'Hue shift', def: 0.01, min: -0.1, max: 0.1, step: 0.001, help: 'Hue rotation per frame.' },
    { k: 'float', name: 'blurAmt', label: 'Blur', def: 0.0015, min: 0, max: 0.01, step: 0.0001, help: 'Blur per frame, fraction of height.' },
    dirParam([0, -0.004]),
  ],
  passes: {
    adv: {
      inputs: ['acc', 'src', 'flow'], fields: [['dir', 'vec2f'], ['decay', 'f32'], ['advect', 'f32'], ['mode', 'i32'], ['hueShift', 'f32'], ['blurAmt', 'f32']],
      body: MV_VEC + /* wgsl */`
fn op(uv: vec2f) -> vec4f {
  let q = uv - mv_vec(uv) * u.advect;
  var a = textureSampleLevel(acc, smp, q, 0.0);
  if (u.blurAmt > 0.0) {
    let r = vec2f(u.blurAmt / g.aspect, u.blurAmt);
    let b = textureSampleLevel(acc, smp, q + vec2f(r.x, 0.0), 0.0) + textureSampleLevel(acc, smp, q - vec2f(r.x, 0.0), 0.0) +
            textureSampleLevel(acc, smp, q + vec2f(0.0, r.y), 0.0) + textureSampleLevel(acc, smp, q - vec2f(0.0, r.y), 0.0);
    a = a * 0.2 + b * 0.2;
  }
  if (u.hueShift != 0.0) {
    var h = rgb2hsv(max(a.rgb, vec3f(0.0)));
    h.x = fract(h.x + u.hueShift);
    a = vec4f(hsv2rgb(h), a.a);
  }
  a *= u.decay;
  let s = textureSampleLevel(src, smp, uv, 0.0);
  if (u.mode == 1) { return a + s * (1.0 - u.decay); }
  return max(a, s);
}`,
    },
    show: {
      inputs: ['acc', 'src'], fields: [['mode', 'i32']],
      body: /* wgsl */`
fn op(uv: vec2f) -> vec4f {
  let a = textureSampleLevel(acc, smp, uv, 0.0);
  if (u.mode == 1) {
    // additive glow: whatever the long exposure holds beyond the present frame lights up on top of it
    let s = textureSampleLevel(src, smp, uv, 0.0);
    return s + max(a - s, vec4f(0.0)) * 2.0;
  }
  return a;
}`,
    },
  },
  cook(c) {
    const acc = c.tex('acc'), tmp = c.tex('tmp');
    if (acc.fresh || c.reset) c.clear(acc.view);
    const p = c.p;
    c.run('adv', tmp.view, [acc.view, c.ins[0], c.ins[1]], { dir: p.dir, decay: p.decay, advect: p.advect, mode: p.mode, hueShift: p.hueShift, blurAmt: p.blurAmt });
    c.copy(tmp.tex, acc.tex);
    c.run('show', c.out, [acc.view, c.ins[0]], { mode: p.mode });
  },
};

const flowviz: OpDef = {
  type: 'flowviz', label: 'Flow Lines', category: 'Generate', output: 'tex', animated: true,
  inputs: [{ name: 'src', type: 'tex', optional: true }, FLOW_IN],
  help: 'Draws a motion field as art: crawling line segments, arrows or an HSV colour map. Without a Flow field it draws a drifting noise field around the fallback direction.',
  params: [
    { k: 'enum', name: 'mode', options: ['Crawling lines', 'Arrows', 'HSV colour'], def: 0 },
    { k: 'float', name: 'density', def: 40, min: 4, max: 160, help: 'Cells across the picture height.' },
    { k: 'float', name: 'segLen', label: 'Length', def: 1, min: 0.1, max: 3, help: 'Segment length in cells at full speed.' },
    { k: 'float', name: 'thickness', def: 0.06, min: 0.005, max: 0.4, step: 0.001, help: 'Fraction of a cell.' },
    { k: 'float', name: 'gain', def: 10, min: 0, max: 60, help: 'Speed that counts as full length / full brightness.' },
    { k: 'float', name: 'crawl', def: 1, min: 0, max: 8, help: 'How fast lines crawl along the field.' },
    { k: 'enum', name: 'colorBy', label: 'Colour by', options: ['Direction', 'Speed', 'Solid'], def: 0 },
    { k: 'color', name: 'lineColor', label: 'Solid colour', def: [0.9, 0.95, 1, 1] },
    { k: 'float', name: 'intensity', def: 1.5, min: 0, max: 8 },
    { k: 'float', name: 'underlay', def: 0.35, min: 0, max: 1, help: 'Brightness of Src under the lines.' },
    dirParam([0.006, 0]),
  ],
  body: MV_VEC + /* wgsl */`
// motion in picture-height units per frame (aspect-correct)
fn fv_vec(uv: vec2f) -> vec2f {
  var v = mv_vec(uv) * vec2f(g.aspect, 1.0);
  if (u.has_flow < 0.5) {
    let p = vec3f(centered(uv) * 1.2, g.time * 0.15);
    let sw = vec2f(snoise(p), snoise(p + vec3f(17.3, 4.1, 0.0)));
    v = (v + sw * max(length(u.dir), 0.002) * 1.2) ;
  }
  return v;
}
fn fv_speed(v: vec2f) -> f32 { return length(v) * 15.0 * u.gain; }
fn fv_color(v: vec2f, s: f32) -> vec3f {
  switch (u.colorBy) {
    case 1 {
      let k = sat(s);
      return mix(mix(vec3f(0.05, 0.2, 1.0), vec3f(1.0, 0.25, 0.1), k), vec3f(1.0, 0.9, 0.6), sat(s - 1.0));
    }
    case 2 { return u.lineColor.rgb; }
    default { return hsv2rgb(vec3f(atan2(v.y, v.x) / TAU + 0.5, 0.75, 1.0)); }
  }
}
fn fv_seg(p: vec2f, a: vec2f, b: vec2f) -> vec2f {
  let pa = p - a; let ba = b - a;
  let h = sat(dot(pa, ba) / max(dot(ba, ba), 1e-10));
  return vec2f(length(pa - ba * h), h);
}
fn op(uv: vec2f) -> vec4f {
  var base = vec3f(0.0);
  if (u.has_src > 0.5) { base = textureSampleLevel(src, smp, uv, 0.0).rgb * u.underlay; }
  if (u.mode == 2) {
    let v = fv_vec(uv);
    let s = fv_speed(v);
    let c = hsv2rgb(vec3f(atan2(v.y, v.x) / TAU + 0.5, 1.0, sat(s))) * u.intensity * 0.5;
    return vec4f(base + c, 1.0);
  }
  let cs = 1.0 / max(u.density, 1.0);
  let p = centered(uv) * 0.5;               // picture-height units
  let px = 1.0 / g.res.y;
  let ci = floor(p / cs);
  var col = vec3f(0.0); var cov = 0.0;
  for (var j = -1; j <= 1; j++) { for (var i = -1; i <= 1; i++) {
    let id = ci + vec2f(f32(i), f32(j));
    let h = hash22(id + 0.37);
    let ctr = (id + 0.5 + (h - 0.5) * 0.6) * cs;
    let v = fv_vec(uncentered(ctr * 2.0));
    let s = fv_speed(v);
    if (s < 0.02) { continue; }
    let dir = v / max(length(v), 1e-9);
    let hl = u.segLen * cs * 0.5 * min(s, 1.5);
    let th = max(u.thickness * cs, px * 0.7);
    var c0 = ctr; var fade = 1.0;
    if (u.mode == 0) {
      let ph = fract(g.time * u.crawl * min(s, 2.0) + h.x);
      c0 = ctr + dir * (ph - 0.5) * cs;
      fade = sin(ph * PI);
    }
    let sg = fv_seg(p, c0 - dir * hl, c0 + dir * hl);
    // comet taper: thin tail, full head
    var w = th * select(1.0, 0.35 + 0.65 * sg.y, u.mode == 0);
    var a = 1.0 - smoothstep(w - px, w + px, sg.x);
    if (u.mode == 1) {
      let tip = c0 + dir * hl;
      let hw = max(hl * 0.45, th * 3.0);
      let l1 = tip - rot(0.5) * dir * hw; let l2 = tip - rot(-0.5) * dir * hw;
      a = max(a, 1.0 - smoothstep(th - px, th + px, fv_seg(p, tip, l1).x));
      a = max(a, 1.0 - smoothstep(th - px, th + px, fv_seg(p, tip, l2).x));
    } else {
      a *= 0.3 + 0.7 * sg.y;
    }
    a *= fade * sat(s * 2.0);
    col += fv_color(v, s) * a; cov = max(cov, a);
  } }
  return vec4f(base * (1.0 - cov) + col * u.intensity, 1.0);
}`,
};

const smearframe: OpDef = {
  type: 'smearframe', label: 'Motion Stretch', category: 'Distort', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }, FLOW_IN],
  help: 'Stretches moving things back along their path with a rubbery lag; still areas stay untouched. Connect an Optical Flow field to Flow.',
  params: [
    { k: 'float', name: 'amount', def: 5, min: 0, max: 30, help: 'Stretch length in frames of motion.' },
    { k: 'int', name: 'taps', def: 16, min: 2, max: 48 },
    { k: 'bool', name: 'lumaWeighted', label: 'Luma weighted', def: false, help: 'Bright parts dominate the smear.' },
    { k: 'float', name: 'maxLen', label: 'Max length', def: 0.25, min: 0, max: 1, step: 0.001, help: 'Longest stretch, fraction of picture height.' },
    dirParam([0.004, 0]),
  ],
  passes: {
    // spread the strongest nearby motion so the area behind a moving thing knows to stretch it
    dil: {
      inputs: ['flow'], fields: [['dir', 'vec2f'], ['radius', 'f32']],
      body: MV_VEC + /* wgsl */`
fn op(uv: vec2f) -> vec4f {
  var best = mv_vec(uv); var bm = dot(best * vec2f(g.aspect, 1.0), best * vec2f(g.aspect, 1.0));
  if (u.has_flow < 0.5) { return vec4f(best, 0.0, 1.0); }
  let r = vec2f(u.radius / g.aspect, u.radius) / 3.0;
  for (var j = -3; j <= 3; j++) { for (var i = -3; i <= 3; i++) {
    let o = vec2f(f32(i), f32(j)) * r;
    let v = mv_vec(uv + o);
    let vh = v * vec2f(g.aspect, 1.0);
    let m = dot(vh, vh);
    // only neighbours lying ahead along their own motion can stretch back over this pixel
    if (m > bm && dot(vh, o * vec2f(g.aspect, 1.0)) >= 0.0) { bm = m; best = v; }
  } }
  return vec4f(best, 0.0, 1.0);
}`,
    },
    smear: {
      inputs: ['src', 'dil'], fields: [['amount', 'f32'], ['taps', 'i32'], ['lumaWeighted', 'i32'], ['maxLen', 'f32']],
      body: /* wgsl */`
fn op(uv: vec2f) -> vec4f {
  var vh = textureSampleLevel(dil, smp, uv, 0.0).rg * u.amount * vec2f(g.aspect, 1.0);
  let L = length(vh);
  if (L > u.maxLen) { vh *= u.maxLen / max(L, 1e-6); }
  let v = vh / vec2f(g.aspect, 1.0);
  let c0 = textureSampleLevel(src, smp, uv, 0.0);
  if (length(vh) * g.res.y < 0.5) { return c0; }
  let n = clamp(u.taps, 2, 48);
  var acc = c0; var ws = 1.0;
  for (var i = 1; i < 48; i++) {
    if (i >= n) { break; }
    let s = f32(i) / f32(n - 1);
    let c = textureSampleLevel(src, smp, uv + v * s, 0.0);
    var w = 1.0 - s * 0.6;
    if (u.lumaWeighted == 1) { w *= 0.05 + luma(max(c.rgb, vec3f(0.0))); }
    acc += c * w; ws += w;
  }
  return acc / ws;
}`,
    },
  },
  cook(c) {
    const d = c.tex('dil', Math.max(8, Math.round(c.w / 4)), Math.max(8, Math.round(c.h / 4)));
    const p = c.p;
    c.run('dil', d.view, [c.ins[1]], { dir: p.dir, radius: Math.min(p.maxLen, 0.15) }, [d.tex.width, d.tex.height]);
    c.run('smear', c.out, [c.ins[0], d.view], { amount: p.amount, taps: p.taps, lumaWeighted: p.lumaWeighted, maxLen: p.maxLen });
  },
};

export const ops: OpDef[] = [sdf3d, terrain, globe, solid, extrude, tunnel3d, motionblur, flowpaint, echoflow, flowviz, smearframe];

