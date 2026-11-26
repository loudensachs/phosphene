// NERVE — WGSL source assembly and uniform layout. Pure string/number code so it can run in Node for validation.
import type { Field, FieldT, OpDef, ParamDef, PassDecl } from './types';

const INFO: Record<FieldT, [size: number, align: number, comps: number]> = {
  f32: [4, 4, 1], i32: [4, 4, 1], vec2f: [8, 8, 2], vec3f: [12, 16, 3], vec4f: [16, 16, 4],
};

export interface Layout { fields: Field[]; offsets: number[]; size: number }

export function layoutOf(fields: Field[]): Layout {
  let off = 0;
  const offsets: number[] = [];
  for (const [, t] of fields) {
    const [size, align] = INFO[t];
    off = Math.ceil(off / align) * align;
    offsets.push(off);
    off += size;
  }
  return { fields, offsets, size: Math.max(16, Math.ceil(off / 16) * 16) };
}

export function writeUniforms(lay: Layout, dv: DataView, vals: Record<string, any>) {
  for (let i = 0; i < lay.fields.length; i++) {
    const [name, t] = lay.fields[i];
    const o = lay.offsets[i];
    const v = vals[name];
    if (t === 'f32') dv.setFloat32(o, typeof v === 'boolean' ? +v : (v ?? 0), true);
    else if (t === 'i32') dv.setInt32(o, typeof v === 'boolean' ? +v : Math.round(v ?? 0), true);
    else {
      const n = INFO[t][2];
      for (let k = 0; k < n; k++) dv.setFloat32(o + k * 4, (v && v[k]) ?? 0, true);
    }
  }
}

export function paramField(p: ParamDef): Field | null {
  switch (p.k) {
    case 'float': return [p.name, 'f32'];
    case 'int': case 'bool': case 'enum': return [p.name, 'i32'];
    case 'vec2': return [p.name, 'vec2f'];
    case 'color': return [p.name, 'vec4f'];
    default: return null;
  }
}

/** Expand an OpDef into its concrete pass declarations (single-pass `body` becomes pass "main"). */
export function passesOf(def: OpDef): Record<string, PassDecl> {
  const out: Record<string, PassDecl> = { ...(def.passes ?? {}) };
  if (def.body) {
    out.main = {
      inputs: def.inputs.filter(i => i.type !== 'sig').map(i => i.name),
      fields: def.params.map(paramField).filter((f): f is Field => !!f),
      body: def.body,
    };
  }
  return out;
}

/** All uniform fields of a pass, including the auto `has_<input>` flags. */
export function passFields(decl: PassDecl): Field[] {
  const f: Field[] = [...(decl.fields ?? [])];
  for (const i of decl.inputs) f.push([`has_${i}`, 'f32']);
  if (!f.length) f.push(['_pad', 'f32']);
  return f;
}

export const G_SIZE = 64;

export const PRELUDE = /* wgsl */`
struct G {
  res: vec2f,      // target resolution in pixels
  time: f32,       // seconds
  dt: f32,         // seconds since previous frame
  beat: f32,       // beats since start (fractional)
  frame: f32,
  bpm: f32,
  aspect: f32,     // res.x / res.y
  audio: vec4f,    // bass, mid, high, level   (0..1)
  audio2: vec4f,   // kick, lowmid, air, onset (0..1)
};
@group(0) @binding(0) var<uniform> g: G;
@group(0) @binding(2) var smp: sampler;   // linear, clamp
@group(0) @binding(3) var smpR: sampler;  // linear, repeat
@group(0) @binding(4) var smpN: sampler;  // nearest, clamp

const PI: f32 = 3.14159265359;
const TAU: f32 = 6.28318530718;

fn sat(x: f32) -> f32 { return clamp(x, 0.0, 1.0); }
fn rot(a: f32) -> mat2x2f { let c = cos(a); let s = sin(a); return mat2x2f(c, s, -s, c); }
fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }

fn hash11(p: f32) -> f32 { var x = fract(p * 0.1031); x *= x + 33.33; x *= x + x; return fract(x); }
fn hash21(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
fn hash22(p: vec2f) -> vec2f {
  var p3 = fract(vec3f(p.x, p.y, p.x) * vec3f(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
fn hash33(p: vec3f) -> vec3f {
  var p3 = fract(p * vec3f(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}
// value noise, 0..1
fn vnoise(p: vec2f) -> f32 {
  let i = floor(p); let f = fract(p);
  let w = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2f(1.0, 0.0)), w.x),
             mix(hash21(i + vec2f(0.0, 1.0)), hash21(i + vec2f(1.0, 1.0)), w.x), w.y);
}
fn _mod289_3(x: vec3f) -> vec3f { return x - floor(x * (1.0 / 289.0)) * 289.0; }
fn _mod289_4(x: vec4f) -> vec4f { return x - floor(x * (1.0 / 289.0)) * 289.0; }
fn _permute4(x: vec4f) -> vec4f { return _mod289_4(((x * 34.0) + 10.0) * x); }
// 3D simplex noise, -1..1 (use z as time for animated 2D noise)
fn snoise(v: vec3f) -> f32 {
  let C = vec2f(1.0 / 6.0, 1.0 / 3.0);
  let D = vec4f(0.0, 0.5, 1.0, 2.0);
  var i = floor(v + dot(v, C.yyy));
  let x0 = v - i + dot(i, C.xxx);
  let gg = step(x0.yzx, x0.xyz);
  let l = 1.0 - gg;
  let i1 = min(gg.xyz, l.zxy);
  let i2 = max(gg.xyz, l.zxy);
  let x1 = x0 - i1 + C.xxx;
  let x2 = x0 - i2 + C.yyy;
  let x3 = x0 - D.yyy;
  i = _mod289_3(i);
  let p = _permute4(_permute4(_permute4(i.z + vec4f(0.0, i1.z, i2.z, 1.0)) + i.y + vec4f(0.0, i1.y, i2.y, 1.0)) + i.x + vec4f(0.0, i1.x, i2.x, 1.0));
  let n_ = 0.142857142857;
  let ns = n_ * D.wyz - D.xzx;
  let j = p - 49.0 * floor(p * ns.z * ns.z);
  let x_ = floor(j * ns.z);
  let y_ = floor(j - 7.0 * x_);
  let x = x_ * ns.x + ns.yyyy;
  let y = y_ * ns.x + ns.yyyy;
  let h = 1.0 - abs(x) - abs(y);
  let b0 = vec4f(x.xy, y.xy);
  let b1 = vec4f(x.zw, y.zw);
  let s0 = floor(b0) * 2.0 + 1.0;
  let s1 = floor(b1) * 2.0 + 1.0;
  let sh = -step(h, vec4f(0.0));
  let a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  let a1 = b1.xzyw + s1.xzyw * sh.zzww;
  var p0 = vec3f(a0.xy, h.x);
  var p1 = vec3f(a0.zw, h.y);
  var p2 = vec3f(a1.xy, h.z);
  var p3 = vec3f(a1.zw, h.w);
  let norm = 1.79284291400159 - 0.85373472095314 * vec4f(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  var m = max(0.5 - vec4f(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), vec4f(0.0));
  m = m * m;
  return 105.0 * dot(m * m, vec4f(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
// fractal simplex, roughly -1..1
fn fbm(p: vec3f, octaves: i32, lacunarity: f32, gain: f32) -> f32 {
  var a = 0.5; var f = 1.0; var s = 0.0; var n = 0.0;
  for (var i = 0; i < octaves; i++) { s += a * snoise(p * f); n += a; f *= lacunarity; a *= gain; }
  return s / max(n, 1e-5);
}
fn rgb2hsv(c: vec3f) -> vec3f {
  let K = vec4f(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  let p = mix(vec4f(c.bg, K.wz), vec4f(c.gb, K.xy), step(c.b, c.g));
  let q = mix(vec4f(p.xyw, c.r), vec4f(c.r, p.yzx), step(p.x, c.r));
  let d = q.x - min(q.w, q.y);
  let e = 1.0e-10;
  return vec3f(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
fn hsv2rgb(c: vec3f) -> vec3f {
  let K = vec4f(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  let p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, vec3f(0.0), vec3f(1.0)), c.y);
}
// IQ cosine palette
fn palette(t: f32, a: vec3f, b: vec3f, c: vec3f, d: vec3f) -> vec3f { return a + b * cos(TAU * (c * t + d)); }
// aspect-corrected centred coords: (0,0) centre, y spans -1..1 (up is negative uv.y)
fn centered(uv: vec2f) -> vec2f { return (uv - 0.5) * vec2f(g.aspect, 1.0) * 2.0; }
fn uncentered(p: vec2f) -> vec2f { return p / (vec2f(g.aspect, 1.0) * 2.0) + 0.5; }
`;

const TAIL = (outType: string, conv: string) => /* wgsl */`
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  var o: VO;
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}
@fragment fn fs(i: VO) -> @location(0) ${outType} { return ${conv}; }
`;

/** Full shader source for a pass. `intOut` targets an rgba16uint attachment (export path). */
export function buildSource(decl: PassDecl, intOut = false): string {
  const fields = passFields(decl);
  const struct = `struct U {\n${fields.map(([n, t]) => `  ${n}: ${t},`).join('\n')}\n};\n@group(0) @binding(1) var<uniform> u: U;\n`;
  const texs = decl.inputs.map((n, i) => `@group(0) @binding(${5 + i}) var ${n}: texture_2d<f32>;`).join('\n');
  const tail = intOut
    ? TAIL('vec4u', 'vec4u(clamp(op(i.uv), vec4f(0.0), vec4f(1.0)) * 65535.0 + 0.5)')
    : TAIL('vec4f', 'op(i.uv)');
  return `${PRELUDE}\n${struct}\n${texs}\n\n// ---- op ----\n${decl.body}\n${tail}`;
}
