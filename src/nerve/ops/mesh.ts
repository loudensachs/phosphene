// Real mesh rendering for projection mapping onto three-dimensional objects.
// A virtual projector is placed where the physical one sits; what it "sees" is what the projector should throw.
import type { CookCtx, OpDef } from '../types';

type M4 = Float32Array;
const mul = (a: M4, b: M4): M4 => {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
};
const ident = (): M4 => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const trans = (x: number, y: number, z: number): M4 => { const m = ident(); m[12] = x; m[13] = y; m[14] = z; return m; };
const scale = (x: number, y: number, z: number): M4 => { const m = ident(); m[0] = x; m[5] = y; m[10] = z; return m; };
const rotX = (a: number): M4 => { const m = ident(), c = Math.cos(a), s = Math.sin(a); m[5] = c; m[6] = s; m[9] = -s; m[10] = c; return m; };
const rotY = (a: number): M4 => { const m = ident(), c = Math.cos(a), s = Math.sin(a); m[0] = c; m[2] = -s; m[8] = s; m[10] = c; return m; };
const rotZ = (a: number): M4 => { const m = ident(), c = Math.cos(a), s = Math.sin(a); m[0] = c; m[1] = s; m[4] = -s; m[5] = c; return m; };
/** Right-handed perspective, depth 0..1, with lens shift in clip units. */
const persp = (fovY: number, aspect: number, near: number, far: number, sx: number, sy: number): M4 => {
  const f = 1 / Math.tan(fovY / 2), m = new Float32Array(16);
  m[0] = f / aspect; m[5] = f; m[8] = -sx; m[9] = -sy; m[10] = far / (near - far); m[11] = -1; m[14] = (near * far) / (near - far);
  return m;
};
const D = Math.PI / 180;

// ---- geometry: non-indexed triangles, 11 floats per vertex (pos3, normal3, uv2, barycentric3) ----
type V3 = [number, number, number];
class Builder {
  d: number[] = [];
  tri(p: V3[], n: V3[] | null, t: [number, number][]) {
    let nn = n;
    if (!nn) {
      const a = p[0], b = p[1], c = p[2];
      const u: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v: V3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const f: V3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const l = Math.hypot(...f) || 1;
      nn = [0, 1, 2].map(() => [f[0] / l, f[1] / l, f[2] / l] as V3);
    }
    for (let i = 0; i < 3; i++) this.d.push(...p[i], ...nn[i], ...t[i], i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0);
  }
  /** Quad a-b-c-d (counter-clockwise seen from outside) with uv corners 00,10,11,01. The shared diagonal is hidden from the wireframe. */
  quad(a: V3, b: V3, c: V3, d: V3, n: V3[] | null = null, t: [number, number][] = [[0, 1], [1, 1], [1, 0], [0, 0]]) {
    const s = this.d.length;
    this.tri([a, b, c], n ? [n[0], n[1], n[2]] : null, [t[0], t[1], t[2]]);
    this.tri([a, c, d], n ? [n[0], n[2], n[3]] : null, [t[0], t[2], t[3]]);
    // hide the shared diagonal from the wireframe: make the barycentric component that vanishes along it constant
    for (let k = 0; k < 3; k++) { this.d[s + k * 11 + 9] = 1; this.d[s + 33 + k * 11 + 10] = 1; }
    return this;
  }
  done() { return new Float32Array(this.d); }
}

function primitive(kind: number): Float32Array {
  const b = new Builder();
  const seg = 48;
  if (kind === 0) { // cube
    const f = (ax: number, s: number) => {
      const p = (u: number, v: number): V3 => { const q: V3 = [0, 0, 0]; q[ax] = s * 0.5; q[(ax + 1) % 3] = u * 0.5 * (s > 0 ? 1 : -1); q[(ax + 2) % 3] = v * 0.5; return q; };
      b.quad(p(-1, -1), p(1, -1), p(1, 1), p(-1, 1));
    };
    for (let ax = 0; ax < 3; ax++) { f(ax, 1); f(ax, -1); }
  } else if (kind === 1) { // sphere
    const P = (i: number, j: number): V3 => { const th = (i / seg) * Math.PI * 2, ph = (j / (seg / 2)) * Math.PI; return [Math.sin(ph) * Math.sin(th) * 0.5, Math.cos(ph) * 0.5, Math.sin(ph) * Math.cos(th) * 0.5]; };
    const N = (p: V3): V3 => [p[0] * 2, p[1] * 2, p[2] * 2];
    for (let j = 0; j < seg / 2; j++) for (let i = 0; i < seg; i++) {
      const a = P(i, j + 1), c = P(i + 1, j + 1), d = P(i + 1, j), e = P(i, j);
      b.quad(a, c, d, e, [N(a), N(c), N(d), N(e)], [[i / seg, (j + 1) / (seg / 2)], [(i + 1) / seg, (j + 1) / (seg / 2)], [(i + 1) / seg, j / (seg / 2)], [i / seg, j / (seg / 2)]]);
    }
  } else if (kind === 2 || kind === 3) { // cylinder, cone
    const top = kind === 3 ? 0 : 0.5;
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      const p = (a: number, r: number, y: number): V3 => [Math.sin(a) * r, y, Math.cos(a) * r];
      const n = (a: number): V3 => [Math.sin(a), kind === 3 ? 0.5 : 0, Math.cos(a)];
      b.quad(p(a0, 0.5, -0.5), p(a1, 0.5, -0.5), p(a1, top, 0.5), p(a0, top, 0.5), [n(a0), n(a1), n(a1), n(a0)], [[i / seg, 1], [(i + 1) / seg, 1], [(i + 1) / seg, 0], [i / seg, 0]]);
      b.tri([[0, -0.5, 0], p(a1, 0.5, -0.5), p(a0, 0.5, -0.5)], null, [[0.5, 0.5], [0.5 + Math.sin(a1) * 0.5, 0.5 + Math.cos(a1) * 0.5], [0.5 + Math.sin(a0) * 0.5, 0.5 + Math.cos(a0) * 0.5]]);
      if (kind === 2) b.tri([[0, 0.5, 0], p(a0, 0.5, 0.5), p(a1, 0.5, 0.5)], null, [[0.5, 0.5], [0.5 + Math.sin(a0) * 0.5, 0.5 - Math.cos(a0) * 0.5], [0.5 + Math.sin(a1) * 0.5, 0.5 - Math.cos(a1) * 0.5]]);
    }
  } else if (kind === 4) { // pyramid
    const c: V3[] = [[-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, -0.5, -0.5], [-0.5, -0.5, -0.5]], apex: V3 = [0, 0.5, 0];
    for (let i = 0; i < 4; i++) b.tri([c[i], c[(i + 1) % 4], apex], null, [[0, 1], [1, 1], [0.5, 0]]);
    b.quad(c[3], c[2], c[1], c[0]);
  } else if (kind === 5) { // torus
    const R = 0.36, r = 0.14, ts = 24;
    const P = (i: number, j: number): [V3, V3] => {
      const a = (i / seg) * Math.PI * 2, t = (j / ts) * Math.PI * 2;
      const n: V3 = [Math.cos(t) * Math.sin(a), Math.sin(t), Math.cos(t) * Math.cos(a)];
      return [[(R + r * Math.cos(t)) * Math.sin(a), r * Math.sin(t), (R + r * Math.cos(t)) * Math.cos(a)], n];
    };
    for (let i = 0; i < seg; i++) for (let j = 0; j < ts; j++) {
      const [a, na] = P(i, j), [c, nc] = P(i + 1, j), [d, nd] = P(i + 1, j + 1), [e, ne] = P(i, j + 1);
      b.quad(a, c, d, e, [na, nc, nd, ne], [[i / seg, 1 - j / ts], [(i + 1) / seg, 1 - j / ts], [(i + 1) / seg, 1 - (j + 1) / ts], [i / seg, 1 - (j + 1) / ts]]);
    }
  } else if (kind === 6) { // plane
    b.quad([-0.5, -0.5, 0], [0.5, -0.5, 0], [0.5, 0.5, 0], [-0.5, 0.5, 0]);
  } else { // stairs / stepped plinth
    const n = 5;
    for (let i = 0; i < n; i++) {
      const y0 = -0.5 + i / n, y1 = -0.5 + (i + 1) / n, z0 = 0.5 - i / n, z1 = 0.5 - (i + 1) / n;
      b.quad([-0.5, y0, z0], [0.5, y0, z0], [0.5, y1, z0], [-0.5, y1, z0]);
      b.quad([-0.5, y1, z0], [0.5, y1, z0], [0.5, y1, z1], [-0.5, y1, z1]);
      b.quad([0.5, y0, z0], [0.5, y0, -0.5], [0.5, y1, -0.5], [0.5, y1, z0]);
      b.quad([-0.5, y0, -0.5], [-0.5, y0, z0], [-0.5, y1, z0], [-0.5, y1, -0.5]);
    }
    b.quad([0.5, -0.5, -0.5], [-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5]);
  }
  return b.done();
}

/** Wavefront OBJ → triangle soup, centred and scaled to fit a unit cube. */
export function parseObj(text: string): Float32Array {
  const v: V3[] = [], vt: [number, number][] = [], vn: V3[] = [];
  const b = new Builder();
  const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
  const faces: [number, number, number][][] = [];
  for (const line of text.split('\n')) {
    const t = line.trim().split(/\s+/);
    if (t[0] === 'v') { const p: V3 = [+t[1], +t[2], +t[3]]; v.push(p); for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], p[i]); hi[i] = Math.max(hi[i], p[i]); } }
    else if (t[0] === 'vt') vt.push([+t[1], 1 - +t[2]]);
    else if (t[0] === 'vn') vn.push([+t[1], +t[2], +t[3]]);
    else if (t[0] === 'f') {
      const idx = t.slice(1).map(s => { const q = s.split('/').map(x => (x ? parseInt(x) : 0)); const fix = (i: number, n: number) => (i < 0 ? n + i : i - 1); return [fix(q[0], v.length), q[1] ? fix(q[1], vt.length) : -1, q[2] ? fix(q[2], vn.length) : -1] as [number, number, number]; });
      for (let i = 1; i + 1 < idx.length; i++) faces.push([idx[0], idx[i], idx[i + 1]]);
    }
  }
  const size = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
  const fit = (p: V3): V3 => [(p[0] - (lo[0] + hi[0]) / 2) / size, (p[1] - (lo[1] + hi[1]) / 2) / size, (p[2] - (lo[2] + hi[2]) / 2) / size];
  for (const f of faces) {
    if (f.some(q => !v[q[0]])) continue;
    const hasN = f.every(q => q[2] >= 0 && vn[q[2]]);
    b.tri(f.map(q => fit(v[q[0]])), hasN ? f.map(q => vn[q[2]]) : null, f.map(q => (q[1] >= 0 && vt[q[1]] ? vt[q[1]] : [0.5, 0.5])) as [number, number][]);
  }
  return b.done();
}

const SHADER = /* wgsl */`
struct U {
  mvp: mat4x4f, model: mat4x4f,
  map: vec4f,      // mode, scaleX, scaleY, hasSrc
  off: vec4f,      // offsetX, offsetY, lit, gain
  wire: vec4f,     // rgb, amount
  misc: vec4f,     // width px, opacity, resX, resY
  light: vec4f,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var smp: sampler;
@group(0) @binding(2) var src: texture_2d<f32>;
struct VO { @builtin(position) pos: vec4f, @location(0) op: vec3f, @location(1) n: vec3f, @location(2) uv: vec2f, @location(3) bary: vec3f, @location(4) on: vec3f };
@vertex fn vs(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) uv: vec2f, @location(3) bary: vec3f) -> VO {
  var o: VO;
  o.pos = u.mvp * vec4f(p, 1.0); o.op = p; o.on = n;
  o.n = (u.model * vec4f(n, 0.0)).xyz; o.uv = uv; o.bary = bary;
  return o;
}
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let fw = fwidth(i.bary);
  let mode = i32(u.map.x);
  var t = i.uv;
  if (mode == 1) { t = vec2f(i.op.x + 0.5, 0.5 - i.op.y); }
  else if (mode == 2) {
    let a = abs(i.on);
    if (a.x > a.y && a.x > a.z) { t = vec2f(0.5 - i.op.z * sign(i.on.x), 0.5 - i.op.y); }
    else if (a.y > a.z) { t = vec2f(i.op.x + 0.5, 0.5 + i.op.z * sign(i.on.y)); }
    else { t = vec2f(0.5 + i.op.x * sign(i.on.z), 0.5 - i.op.y); }
  } else if (mode == 3) { let d = normalize(i.op); t = vec2f(atan2(d.x, d.z) / 6.2831853 + 0.5, acos(clamp(d.y, -1.0, 1.0)) / 3.14159265); }
  else if (mode == 4) { t = i.pos.xy / u.misc.zw; }
  t = (t - 0.5) / u.map.yz + 0.5 - u.off.xy;
  var c = vec3f(0.35);
  if (u.map.w > 0.5) { c = textureSampleLevel(src, smp, t, 0.0).rgb; }
  c *= u.off.w;
  if (u.off.z > 0.5) { let nl = max(dot(normalize(i.n), normalize(u.light.xyz)), 0.0); c *= 0.25 + 0.85 * nl; }
  let e = min(min(i.bary.x / fw.x, i.bary.y / fw.y), i.bary.z / fw.z);
  let w = (1.0 - smoothstep(u.misc.x * 0.5, u.misc.x * 0.5 + 1.0, e)) * u.wire.a;
  return vec4f(mix(c, u.wire.rgb, w), 1.0) * u.misc.y;
}`;

interface Shared { pipeline: GPURenderPipeline; sampler: GPUSampler; prims: Map<number, { buf: GPUBuffer; n: number }>; objs: Map<string, { buf?: GPUBuffer; n: number; err?: string; loading: boolean }> }
const shared = new WeakMap<GPUDevice, Shared>();
function getShared(dev: GPUDevice): Shared {
  let s = shared.get(dev);
  if (!s) {
    const module = dev.createShaderModule({ code: SHADER, label: 'mesh' });
    const pipeline = dev.createRenderPipeline({
      label: 'mesh', layout: 'auto',
      vertex: { module, entryPoint: 'vs', buffers: [{ arrayStride: 44, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }, { shaderLocation: 2, offset: 24, format: 'float32x2' }, { shaderLocation: 3, offset: 32, format: 'float32x3' }] }] },
      fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba16float', blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
    });
    s = { pipeline, sampler: dev.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat' }), prims: new Map(), objs: new Map() };
    shared.set(dev, s);
  }
  return s;
}
const upload = (dev: GPUDevice, data: Float32Array) => { const buf = dev.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST }); dev.queue.writeBuffer(buf, 0, data as BufferSource); return { buf, n: data.length / 11 }; };

function geometry(c: CookCtx, s: Shared): { buf: GPUBuffer; n: number } | null {
  if (c.p.model < 8) { let g = s.prims.get(c.p.model); if (!g) s.prims.set(c.p.model, (g = upload(c.device, primitive(c.p.model)))); return g; }
  const path = String(c.p.file || '');
  if (!path) throw new Error('Choose an OBJ file for the custom model.');
  let o = s.objs.get(path);
  if (!o) {
    o = { n: 0, loading: true };
    s.objs.set(path, o);
    const cur = o, url = c.media.resolve(path);
    if (!url) { cur.loading = false; cur.err = 'Model file not found.'; }
    else fetch(url).then(r => r.text()).then(t => { const d = parseObj(t); if (!d.length) throw new Error('No faces found in this OBJ.'); Object.assign(cur, upload(c.device, d), { loading: false }); })
      .catch(e => { cur.loading = false; cur.err = `Could not load model: ${e.message ?? e}`; });
  }
  if (o.err) throw new Error(o.err);
  return o.buf ? { buf: o.buf, n: o.n } : null;
}

/**
 * Direct linear transform: find the 3×4 projection that sends eight known 3D corners to eight picked picture positions.
 * Returns a clip-space matrix (column-major) or null when the corners are degenerate.
 */
function solveCalibration(pts3: V3[], pts2: [number, number][]): M4 | null {
  const A: number[][] = [], b: number[] = [];
  for (let i = 0; i < pts3.length; i++) {
    const [X, Y, Z] = pts3[i], [u, v] = pts2[i];
    A.push([X, Y, Z, 1, 0, 0, 0, 0, -u * X, -u * Y, -u * Z]); b.push(u);
    A.push([0, 0, 0, 0, X, Y, Z, 1, -v * X, -v * Y, -v * Z]); b.push(v);
  }
  // least squares through the normal equations
  const n = 11, M = Array.from({ length: n }, () => new Array(n + 1).fill(0));
  for (let r = 0; r < A.length; r++) for (let i = 0; i < n; i++) { M[i][n] += A[r][i] * b[r]; for (let j = 0; j < n; j++) M[i][j] += A[r][i] * A[r][j]; }
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  const p = M.map((row, i) => row[n] / row[i]); p.push(1);
  let r0 = p.slice(0, 4), r1 = p.slice(4, 8), r2 = p.slice(8, 12);
  if (r2[3] < 0) { r0 = r0.map(x => -x); r1 = r1.map(x => -x); r2 = r2.map(x => -x); }   // keep the object in front of the lens
  const near = 0.02 * r2[3];
  const rows = [r0.map((x, i) => 2 * x - r2[i]), r1.map((x, i) => r2[i] - 2 * x), r2.map((x, i) => (i === 3 ? x - near : x)), r2];
  const m = new Float32Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) m[c * 4 + r] = rows[r][c];
  return m;
}
const CORNERS: V3[] = Array.from({ length: 8 }, (_, k) => [(k & 1) - 0.5, ((k >> 1) & 1) - 0.5, ((k >> 2) & 1) - 0.5] as V3);
const CORNER_DEFAULTS: [number, number][] = [[0.36, 0.6], [0.58, 0.6], [0.36, 0.3], [0.58, 0.3], [0.3, 0.75], [0.7, 0.75], [0.3, 0.25], [0.7, 0.25]];
const cornerName = (k: number) => `${k & 4 ? 'Front' : 'Back'} ${k & 2 ? 'top' : 'bottom'} ${k & 1 ? 'right' : 'left'}`;

const F = (name: string, label: string, def: number, min: number, max: number, group: string, unit?: string, help?: string) =>
  ({ k: 'float' as const, name, label, def, min, max, group, unit, help });

const object3d: OpDef = {
  type: 'object3d', label: 'Mapped Object', category: 'Stage', output: 'tex', animated: true,
  inputs: [{ name: 'src', type: 'tex', optional: true }, { name: 'under', type: 'tex', optional: true }],
  help: 'Projection mapping onto a three-dimensional object. Match Model and Object to the real thing, set Projector to where the physical projector sits and how wide it throws, and this operator renders exactly the picture that projector must show for the footage to land on the object. Also works as a general 3D layer.',
  params: [
    { k: 'enum', name: 'model', options: ['Cube', 'Sphere', 'Cylinder', 'Cone', 'Pyramid', 'Torus', 'Plane', 'Stairs', 'Custom OBJ'], def: 0, group: 'Model' },
    { k: 'file', name: 'file', def: '', accept: '.obj', group: 'Model' },
    { k: 'enum', name: 'mapping', label: 'Footage mapping', options: ['Model UVs', 'Front planar', 'Box', 'Spherical', 'Projector view'], def: 0, group: 'Model', help: 'How the footage wraps the surface. Box suits buildings and plinths; Projector view pastes it flat as seen from the projector.' },
    { k: 'vec2', name: 'texScale', label: 'Footage scale', def: [1, 1], min: 0.1, max: 8, group: 'Model' },
    { k: 'vec2', name: 'texOffset', label: 'Footage offset', def: [0, 0], min: -1, max: 1, group: 'Model' },
    F('px', 'Position X', 0, -5, 5, 'Object', 'm'), F('py', 'Position Y', 0, -5, 5, 'Object', 'm'), F('pz', 'Position Z', 0, -5, 5, 'Object', 'm'),
    F('rx', 'Rotate X', 15, -180, 180, 'Object', '°'), F('ry', 'Rotate Y', 30, -180, 180, 'Object', '°'), F('rz', 'Rotate Z', 0, -180, 180, 'Object', '°'),
    F('sx', 'Width', 1, 0.01, 10, 'Object', 'm'), F('sy', 'Height', 1, 0.01, 10, 'Object', 'm'), F('sz', 'Depth', 1, 0.01, 10, 'Object', 'm'),
    F('spin', 'Spin', 0, -360, 360, 'Object', '°/s', 'Continuous turn about the vertical axis.'),
    F('dist', 'Distance', 3, 0.2, 30, 'Projector', 'm', 'Distance from the projector lens to the object origin.'),
    F('orbit', 'Around', 0, -180, 180, 'Projector', '°', 'Projector position around the object.'),
    F('elev', 'Height angle', 0, -89, 89, 'Projector', '°'),
    F('roll', 'Roll', 0, -180, 180, 'Projector', '°'),
    F('throwRatio', 'Throw ratio', 1.5, 0.3, 8, 'Projector', undefined, 'Throw distance divided by image width, from the projector\'s spec sheet.'),
    { k: 'vec2', name: 'shift', label: 'Lens shift', def: [0, 0], min: -1, max: 1, step: 0.001, group: 'Projector' },
    { k: 'vec2', name: 'aim', label: 'Aim offset', def: [0, 0], min: -3, max: 3, step: 0.001, group: 'Projector', help: 'Moves the point the projector looks at (metres, right / up).' },
    { k: 'bool', name: 'calibrate', label: 'Use corner calibration', def: false, group: 'Calibration', help: 'Solve the projector from eight picked corners instead of the Projector settings. Set Width / Height / Depth to the real object\'s proportions, then drag each handle in the viewer onto the matching corner of the object\'s bounding box as the projector shows it.' },
    ...CORNERS.map((_, k) => ({ k: 'vec2' as const, name: `k${k}`, label: cornerName(k), def: CORNER_DEFAULTS[k], min: -0.5, max: 1.5, step: 0.001, gizmo: 'uv' as const, group: 'Calibration' })),
    { k: 'bool', name: 'lit', label: 'Shade preview', def: false, group: 'Look', help: 'Adds lighting so the form reads on screen. Turn off for real projection.' },
    F('gain', 'Brightness', 1, 0, 4, 'Look'),
    F('opacity', 'Opacity', 1, 0, 1, 'Look'),
    F('wire', 'Wireframe', 0, 0, 1, 'Look', undefined, 'Overlay the model\'s edges for alignment.'),
    F('wireWidth', 'Wire width', 1.5, 0.5, 8, 'Look', 'px'),
    { k: 'color', name: 'wireColor', label: 'Wire colour', def: [1, 0.8, 0.25, 1], group: 'Look' },
  ],
  cook(c) {
    const dev = c.device, s = getShared(dev);
    const geo = geometry(c, s);
    const st = c.state as { depth?: GPUTexture; ubuf?: GPUBuffer };
    if (!st.depth || st.depth.width !== c.w || st.depth.height !== c.h) { st.depth?.destroy(); st.depth = dev.createTexture({ size: [c.w, c.h], format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT }); }
    st.ubuf ??= dev.createBuffer({ size: 208, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const p = c.p;
    const model = mul(trans(p.px, p.py, p.pz), mul(rotY((p.ry + p.spin * c.time) * D), mul(rotX(p.rx * D), mul(rotZ(p.rz * D), scale(p.sx, p.sy, p.sz)))));
    // projector: orbit the origin, then aim; view = inverse of that placement
    const view = mul(rotZ(-p.roll * D), mul(trans(-p.aim[0], -p.aim[1], -p.dist), mul(rotX(p.elev * D), rotY(-p.orbit * D))));
    const aspect = c.w / c.h;
    const fovY = 2 * Math.atan(1 / (2 * p.throwRatio * aspect));
    const proj = persp(fovY, aspect, 0.05, 200, p.shift[0], p.shift[1]);
    const data = new Float32Array(52);
    let mvp = mul(proj, mul(view, model));
    if (p.calibrate) {
      const S = scale(p.sx, p.sy, p.sz);
      const cal = solveCalibration(CORNERS.map(q => [q[0] * p.sx, q[1] * p.sy, q[2] * p.sz] as V3), CORNERS.map((_, k) => p[`k${k}`] as [number, number]));
      if (!cal) throw new Error('Calibration corners are degenerate — spread them out so they outline a box.');
      mvp = mul(cal, S);
    }
    data.set(mvp, 0); data.set(model, 16);
    data.set([p.mapping, p.texScale[0], p.texScale[1], c.ins[0] ? 1 : 0], 32);
    data.set([p.texOffset[0], p.texOffset[1], p.lit ? 1 : 0, p.gain], 36);
    data.set([p.wireColor[0], p.wireColor[1], p.wireColor[2], p.wire], 40);
    data.set([p.wireWidth, p.opacity, c.w, c.h], 44);
    data.set([0.4, 0.8, 0.6, 0], 48);
    dev.queue.writeBuffer(st.ubuf, 0, data as BufferSource);
    if (c.inTex[1]) c.copy(c.inTex[1], c.outTex);
    const enc = dev.createCommandEncoder();
    const rp = enc.beginRenderPass({
      colorAttachments: [{ view: c.out, loadOp: c.inTex[1] ? 'load' : 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
      depthStencilAttachment: { view: st.depth.createView(), depthLoadOp: 'clear', depthStoreOp: 'discard', depthClearValue: 1 },
    });
    if (geo) {
      rp.setPipeline(s.pipeline);
      rp.setBindGroup(0, dev.createBindGroup({ layout: s.pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: st.ubuf } }, { binding: 1, resource: s.sampler }, { binding: 2, resource: c.ins[0] ?? c.gpu.black }] }));
      rp.setVertexBuffer(0, geo.buf);
      rp.draw(geo.n);
    }
    rp.end();
    dev.queue.submit([enc.finish()]);
  },
  dispose(state) { state.depth?.destroy(); state.ubuf?.destroy(); },
};

export const ops: OpDef[] = [object3d];
