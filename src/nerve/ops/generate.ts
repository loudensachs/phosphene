// NERVE generators: solid colour, gradients, SDF shapes, patterns, procedural noise, fields and audio visualisers.
import type { Field, OpDef } from '../types';

// Shared cosine-palette params (phase / frequency / spread) used by Warp Noise and Plasma.
const PALETTE_PARAMS = [
  { k: 'float', name: 'phase', def: 0.0, min: 0, max: 1, group: 'Palette', help: 'Shifts the palette hue.' },
  { k: 'float', name: 'freq', label: 'Frequency', def: 1.0, min: 0, max: 4, group: 'Palette', help: 'How many times the palette cycles across the value range.' },
  { k: 'float', name: 'spread', def: 0.33, min: 0, max: 1, group: 'Palette', help: 'RGB phase separation; 0 is monochrome.' },
] as const;
const PALETTE_WGSL = /* wgsl */`
fn pal(t: f32) -> vec3f {
  return palette(t * u.freq + u.phase, vec3f(0.5), vec3f(0.5), vec3f(1.0), vec3f(0.0, u.spread, 2.0 * u.spread));
}`;

const constant: OpDef = {
  type: 'constant', label: 'Constant', category: 'Generate', inputs: [], output: 'tex',
  help: 'Solid colour.',
  params: [{ k: 'color', name: 'color', def: [0.1, 0.45, 0.9, 1] }],
  body: /* wgsl */`fn op(uv: vec2f) -> vec4f { return u.color; }`,
};

const ramp: OpDef = {
  type: 'ramp', label: 'Ramp', category: 'Generate', inputs: [], output: 'tex',
  help: 'Three-stop gradient: linear, radial, angular or diamond, with repeat and mirror.',
  params: [
    { k: 'enum', name: 'mode', label: 'Type', options: ['Linear', 'Radial', 'Angular', 'Diamond'], def: 0 },
    { k: 'color', name: 'colorA', label: 'Color A', def: [0.05, 0.08, 0.35, 1], group: 'Colors' },
    { k: 'color', name: 'colorB', label: 'Color B', def: [0.85, 0.15, 0.55, 1], group: 'Colors' },
    { k: 'color', name: 'colorC', label: 'Color C', def: [1.0, 0.75, 0.3, 1], group: 'Colors' },
    { k: 'float', name: 'mid', label: 'B position', def: 0.5, min: 0, max: 1, group: 'Colors' },
    { k: 'float', name: 'angle', def: 0, min: -360, max: 360, unit: '°' },
    { k: 'vec2', name: 'center', def: [0, 0], min: -2, max: 2, step: 0.001 },
    { k: 'float', name: 'offset', def: 0, min: -2, max: 2, help: 'Slides the gradient; animate for scrolling ramps.' },
    { k: 'float', name: 'repeats', label: 'Repeat', def: 1, min: 0.1, max: 32 },
    { k: 'bool', name: 'mirror', def: false, help: 'Ping-pong instead of wrapping when repeated.' },
  ],
  body: /* wgsl */`
fn ramp_col(s: f32) -> vec4f {
  let m = clamp(u.mid, 1e-4, 1.0 - 1e-4);
  if (s < m) { return mix(u.colorA, u.colorB, s / m); }
  return mix(u.colorB, u.colorC, (s - m) / (1.0 - m));
}
fn op(uv: vec2f) -> vec4f {
  let px = 2.0 / g.res.y;
  let p = centered(uv) - u.center;
  let a = radians(u.angle);
  let q = rot(-a) * p;
  let ext = vec2f(g.aspect, 1.0);
  var t: f32;
  var dt: f32; // gradient units per pixel, for the anti-aliased wrap seam
  switch (u.mode) {
    case 1 { let n = length(ext); t = length(p) / n; dt = px / n; }
    case 2 { t = atan2(q.y, q.x) / TAU + 0.5; dt = px / (TAU * max(length(p), px)); }
    case 3 { let n = ext.x + ext.y; t = (abs(q.x) + abs(q.y)) / n; dt = px * 1.41421 / n; }
    default {
      let d = vec2f(cos(a), sin(a));
      let e = abs(d.x) * ext.x + abs(d.y) * ext.y; // half-extent of the frame along d
      t = dot(p, d) / e * 0.5 + 0.5; dt = px * 0.5 / e;
    }
  }
  t = t * u.repeats + u.offset;
  dt = dt * abs(u.repeats);
  if (u.mirror == 1) { return ramp_col(1.0 - abs(fract(t * 0.5) * 2.0 - 1.0)); }
  let s = fract(t);
  let k = sat(min(s, 1.0 - s) / max(dt, 1e-6) * 2.0);
  return mix(0.5 * (ramp_col(0.0) + ramp_col(1.0)), ramp_col(s), k);
}`,
};

const shape: OpDef = {
  type: 'shape', label: 'Shape', category: 'Generate', inputs: [], output: 'tex',
  help: 'Anti-aliased SDF shape. Alpha is coverage (colour is premultiplied).',
  params: [
    { k: 'enum', name: 'mode', label: 'Shape', options: ['Circle', 'Polygon', 'Star', 'Rectangle', 'Ring', 'Cross'], def: 2 },
    { k: 'float', name: 'size', def: 0.5, min: 0, max: 2, help: 'Outer radius as a fraction of half the image height.' },
    { k: 'int', name: 'sides', def: 5, min: 3, max: 24, help: 'Polygon sides / star points.' },
    { k: 'float', name: 'inner', def: 0.45, min: 0, max: 1, help: 'Star inner radius, ring inner radius, cross arm width (fraction of size).' },
    { k: 'float', name: 'roundness', def: 0.05, min: 0, max: 1, help: 'Corner rounding as a fraction of size.' },
    { k: 'float', name: 'ratio', label: 'Aspect', def: 1, min: 0.1, max: 10, help: 'Horizontal stretch.' },
    { k: 'float', name: 'rotation', def: 0, min: -360, max: 360, unit: '°' },
    { k: 'vec2', name: 'pos', label: 'Position', def: [0, 0], min: -2, max: 2, step: 0.001 },
    { k: 'float', name: 'softness', def: 0, min: 0, max: 1, help: 'Edge feather width.' },
    { k: 'bool', name: 'stroke', def: false, group: 'Style' },
    { k: 'float', name: 'strokeWidth', label: 'Stroke width', def: 0.03, min: 0, max: 0.5, group: 'Style' },
    { k: 'color', name: 'fill', def: [1, 0.72, 0.3, 1], group: 'Style' },
  ],
  body: /* wgsl */`
// n-pointed star / regular polygon (inner = cos(PI/n)); vertex points along +y
fn shape_star(p: vec2f, r: f32, n: f32, inner: f32) -> f32 {
  let an = PI / n;
  let a = atan2(p.x, p.y);
  let bn = a - 2.0 * an * floor(a / (2.0 * an) + 0.5);
  let q = length(p) * vec2f(cos(bn), abs(sin(bn)));
  let va = vec2f(r, 0.0);
  let ba = inner * r * vec2f(cos(an), sin(an)) - va;
  let pa = q - va;
  let h = sat(dot(pa, ba) / max(dot(ba, ba), 1e-12));
  return length(pa - ba * h) * -sign(ba.x * pa.y - ba.y * pa.x);
}
fn shape_box(p: vec2f, b: vec2f) -> f32 {
  let d = abs(p) - b;
  return length(max(d, vec2f(0.0))) + min(max(d.x, d.y), 0.0);
}
fn shape_cross(p0: vec2f, b: vec2f) -> f32 {
  var p = abs(p0);
  if (p.y > p.x) { p = p.yx; }
  let q = p - b;
  let k = max(q.y, q.x);
  let w = select(vec2f(b.y - p.x, -k), q, k > 0.0);
  return sign(k) * length(max(w, vec2f(0.0)));
}
fn op(uv: vec2f) -> vec4f {
  let px = 2.0 / g.res.y;
  var p = centered(uv) - u.pos;
  p.y = -p.y;
  p = rot(-radians(u.rotation)) * p;
  p.x /= max(u.ratio, 1e-3);
  let s = max(u.size, 0.0);
  let rr = sat(u.roundness) * s;
  let n = f32(clamp(u.sides, 3, 64));
  var d: f32;
  switch (u.mode) {
    case 0 { d = length(p) - s; }
    case 1 { d = shape_star(p, s - rr, n, cos(PI / n)) - rr; }
    case 2 { d = shape_star(p, s - rr, n, u.inner) - rr; }
    case 3 { d = shape_box(p, vec2f(s - rr)) - rr; }
    case 4 { d = abs(length(p) - s * (1.0 + u.inner) * 0.5) - s * (1.0 - u.inner) * 0.5; }
    default { d = shape_cross(p, max(vec2f(s, s * u.inner * 0.5) - rr, vec2f(0.0))) - rr; }
  }
  d *= min(u.ratio, 1.0);
  if (u.stroke == 1) { d = abs(d) - u.strokeWidth * 0.5; }
  let w = px + u.softness;
  let cov = 1.0 - smoothstep(-0.5 * w, 0.5 * w, d);
  let a = cov * u.fill.a;
  return vec4f(u.fill.rgb * a, a);
}`,
};

const pattern: OpDef = {
  type: 'pattern', label: 'Pattern', category: 'Generate', inputs: [], output: 'tex',
  help: 'Anti-aliased tiling patterns. Scale is cells per image height.',
  params: [
    { k: 'enum', name: 'mode', label: 'Pattern', options: ['Stripes', 'Checker', 'Dots', 'Grid', 'Hex', 'Triangles', 'Waves'], def: 4 },
    { k: 'float', name: 'scale', def: 8, min: 0.5, max: 100 },
    { k: 'float', name: 'rotation', def: 0, min: -360, max: 360, unit: '°' },
    { k: 'float', name: 'thickness', def: 0.5, min: 0, max: 1, help: 'Line / stripe width or dot size.' },
    { k: 'float', name: 'softness', def: 0, min: 0, max: 1, help: 'Edge feather, in cells.' },
    { k: 'vec2', name: 'scroll', def: [0, 0], min: -4, max: 4, help: 'Scroll speed in cells per second.' },
    { k: 'color', name: 'colorA', label: 'Ink', def: [0.95, 0.9, 0.8, 1] },
    { k: 'color', name: 'colorB', label: 'Background', def: [0.05, 0.06, 0.1, 1] },
  ],
  body: /* wgsl */`
fn pattern_wrap(x: vec2f, m: vec2f) -> vec2f { return x - m * floor(x / m); }
fn pattern_line(x: f32) -> f32 { return abs(fract(x + 0.5) - 0.5); } // distance to nearest integer
// ink coverage at p (cell units); w = filter width in cells
fn pattern_ink(p: vec2f, w: f32) -> f32 {
  let th = u.thickness;
  var d: f32;
  switch (u.mode) {
    case 1 {
      // signed distance to the checker edges per axis; the product of signs gives parity
      let t = abs(fract(p * 0.5) - 0.5) * 2.0 - 0.5;
      let s = clamp(t / (0.5 * w), vec2f(-1.0), vec2f(1.0));
      return 0.5 - 0.5 * s.x * s.y;
    }
    case 2 { d = length(fract(p) - 0.5) - th * 0.5; }
    case 3 { let c = abs(fract(p) - 0.5); d = 0.5 - max(c.x, c.y) - th * 0.25; }
    case 4 {
      let r = vec2f(1.0, 1.7320508); let h = r * 0.5;
      let a = pattern_wrap(p, r) - h; let b = pattern_wrap(p - h, r) - h;
      let q = abs(select(b, a, dot(a, a) < dot(b, b)));
      d = 0.5 - max(dot(q, vec2f(0.5, 0.8660254)), q.x) - th * 0.25;
    }
    case 5 {
      let e = min(pattern_line(p.y), min(pattern_line(dot(p, vec2f(0.8660254, 0.5))), pattern_line(dot(p, vec2f(0.8660254, -0.5)))));
      d = e - th * 0.25;
    }
    case 6 {
      let amp = 0.3;
      let y = p.y + amp * sin(p.x * PI);
      let slope = amp * PI * cos(p.x * PI);
      d = (abs(fract(y) - 0.5) - th * 0.5) / sqrt(1.0 + slope * slope);
    }
    default { d = abs(fract(p.x) - 0.5) - th * 0.5; }
  }
  return 1.0 - smoothstep(-0.5 * w, 0.5 * w, d);
}
fn op(uv: vec2f) -> vec4f {
  let w = u.scale / g.res.y + u.softness;
  let p = rot(radians(u.rotation)) * (centered(uv) * u.scale * 0.5) + u.scroll * g.time;
  return mix(u.colorB, u.colorA, pattern_ink(p, w));
}`,
};

const voronoi: OpDef = {
  type: 'voronoi', label: 'Voronoi', category: 'Generate', inputs: [], output: 'tex',
  help: 'Animated cellular noise: distance features, flat cell colours or anti-aliased cell edges.',
  params: [
    { k: 'enum', name: 'outMode', label: 'Output', options: ['F1', 'F2', 'F2 - F1', 'Cell colour', 'Edges'], def: 3 },
    { k: 'float', name: 'scale', def: 6, min: 0.5, max: 60, help: 'Cells per image height.' },
    { k: 'float', name: 'jitter', def: 1, min: 0, max: 1 },
    { k: 'float', name: 'speed', def: 0.5, min: 0, max: 4 },
    { k: 'enum', name: 'metric', options: ['Euclidean', 'Manhattan', 'Chebyshev'], def: 0 },
    { k: 'float', name: 'width', label: 'Edge width', def: 0.04, min: 0, max: 0.5, help: 'Edge line width in cells (Edges output).' },
    { k: 'float', name: 'contrast', def: 1, min: 0, max: 4 },
  ],
  body: /* wgsl */`
fn vor_dist(v: vec2f) -> f32 {
  switch (u.metric) {
    case 1 { return abs(v.x) + abs(v.y); }
    case 2 { return max(abs(v.x), abs(v.y)); }
    default { return length(v); }
  }
}
fn vor_pt(c: vec2f, t: f32) -> vec2f { return c + 0.5 + 0.5 * u.jitter * sin(t + TAU * hash22(c)); }
fn vor_col(c: vec2f) -> vec3f { let h = hash22(c + 17.3); return hsv2rgb(vec3f(h.x, 0.5 + 0.35 * h.y, 1.0)); }
fn op(uv: vec2f) -> vec4f {
  let p = centered(uv) * u.scale * 0.5;
  let t = g.time * u.speed;
  let n = floor(p);
  var f1 = 1e9; var f2 = 1e9;
  var c1 = n; var c2 = n; var r1 = vec2f(0.0);
  for (var j = -2; j <= 2; j++) {
    for (var i = -2; i <= 2; i++) {
      let c = n + vec2f(f32(i), f32(j));
      let r = vor_pt(c, t) - p;
      let d = vor_dist(r);
      if (d < f1) { f2 = f1; c2 = c1; f1 = d; c1 = c; r1 = r; }
      else if (d < f2) { f2 = d; c2 = c; }
    }
  }
  var v: vec3f;
  if (u.outMode >= 3) {
    // distance to the nearest cell border: exact for Euclidean (IQ), approximate otherwise
    var e = 0.5 * (f2 - f1);
    if (u.metric == 0) {
      e = 1e9;
      for (var j = -2; j <= 2; j++) {
        for (var i = -2; i <= 2; i++) {
          let r = vor_pt(c1 + vec2f(f32(i), f32(j)), t) - p;
          let dr = r - r1;
          if (dot(dr, dr) > 1e-8) { e = min(e, dot(0.5 * (r1 + r), normalize(dr))); }
        }
      }
    }
    let px = u.scale / g.res.y;
    if (u.outMode == 3) {
      v = mix(vor_col(c2), vor_col(c1), 0.5 + 0.5 * sat(2.0 * e / px));
    } else {
      v = vec3f(1.0 - smoothstep(0.5 * (u.width - px), 0.5 * (u.width + px), e));
    }
  } else {
    v = vec3f(select(select(f2 - f1, f2, u.outMode == 1), f1, u.outMode == 0));
  }
  return vec4f(max((v - 0.5) * u.contrast + 0.5, vec3f(0.0)), 1.0);
}`,
};

const warpnoise: OpDef = {
  type: 'warpnoise', label: 'Warp Noise', category: 'Generate', inputs: [], output: 'tex',
  help: 'Domain-warped fractal noise (two warp layers), coloured with a cosine palette.',
  params: [
    { k: 'float', name: 'scale', def: 2, min: 0.1, max: 20 },
    { k: 'float', name: 'warp', label: 'Warp amount', def: 3, min: 0, max: 8 },
    { k: 'float', name: 'speed', def: 0.08, min: 0, max: 2 },
    { k: 'int', name: 'octaves', def: 5, min: 1, max: 8 },
    ...PALETTE_PARAMS,
  ],
  body: /* wgsl */`${PALETTE_WGSL}
fn op(uv: vec2f) -> vec4f {
  let oct = clamp(u.octaves, 1, 8);
  let z = g.time * u.speed;
  let p = centered(uv) * u.scale * 0.5;
  let q = vec2f(fbm(vec3f(p, z), oct, 2.0, 0.5), fbm(vec3f(p + vec2f(5.2, 1.3), z), oct, 2.0, 0.5));
  let pq = p + u.warp * q;
  let r = vec2f(fbm(vec3f(pq + vec2f(1.7, 9.2), z * 1.3), oct, 2.0, 0.5), fbm(vec3f(pq + vec2f(8.3, 2.8), z * 1.3), oct, 2.0, 0.5));
  let f = fbm(vec3f(p + u.warp * r, z * 0.7), oct, 2.0, 0.5);
  let col = pal(f * 0.5 + 0.5 + 0.35 * length(q) + 0.15 * r.x);
  return vec4f(col * (0.25 + 0.95 * smoothstep(-0.7, 0.7, f + 0.3 * length(r))), 1.0);
}`,
};

const plasma: OpDef = {
  type: 'plasma', label: 'Plasma', category: 'Generate', inputs: [], output: 'tex',
  help: 'Classic layered sine plasma with cosine palette colouring.',
  params: [
    { k: 'float', name: 'scale', def: 3, min: 0.1, max: 20 },
    { k: 'float', name: 'speed', def: 0.5, min: 0, max: 4 },
    { k: 'int', name: 'complexity', def: 3, min: 1, max: 8, help: 'Number of interfering layers.' },
    ...PALETTE_PARAMS,
  ],
  body: /* wgsl */`${PALETTE_WGSL}
fn op(uv: vec2f) -> vec4f {
  let p = centered(uv) * u.scale;
  let t = g.time * u.speed;
  let n = clamp(u.complexity, 1, 8);
  var v = 0.0;
  for (var i = 0; i < n; i++) {
    let fi = f32(i);
    let a = fi * 2.3999632 + 0.4;          // golden-angle directions
    let k = 1.0 + 0.45 * fi;
    v += sin(dot(p, vec2f(cos(a), sin(a))) * k + t * (1.0 + 0.3 * fi) + fi);
    let c = vec2f(sin(t * 0.37 + fi * 1.7), cos(t * 0.29 + fi * 2.3)) * 1.5;
    v += sin(length(p - c) * k * 1.3 - t);
  }
  v /= 2.0 * f32(n);
  return vec4f(pal(v * 0.5 + 0.5), 1.0);
}`,
};

const tunnel: OpDef = {
  type: 'tunnel', label: 'Tunnel', category: 'Generate', output: 'tex',
  inputs: [{ name: 'src', type: 'tex', optional: true }],
  help: 'Infinite tunnel. Textures the walls with Source when connected, otherwise draws procedural rings and stripes.',
  params: [
    { k: 'float', name: 'speed', def: 0.5, min: -4, max: 4 },
    { k: 'float', name: 'twist', def: 0.1, min: -2, max: 2 },
    { k: 'int', name: 'repeats', label: 'Repeat', def: 8, min: 1, max: 64, help: 'Texture repeats around the wall.' },
    { k: 'float', name: 'rings', def: 1, min: 0.05, max: 8, help: 'Texture repeats along the depth.' },
    { k: 'float', name: 'fog', label: 'Falloff', def: 1.5, min: 0, max: 6 },
    { k: 'enum', name: 'shape', options: ['Round', 'Square'], def: 0 },
    { k: 'vec2', name: 'center', def: [0, 0], min: -1, max: 1, step: 0.001 },
    { k: 'color', name: 'colorA', label: 'Lines', def: [0.3, 0.85, 1, 1], group: 'Procedural' },
    { k: 'color', name: 'colorB', label: 'Walls', def: [0.08, 0.03, 0.18, 1], group: 'Procedural' },
  ],
  body: /* wgsl */`
// anti-aliased line at every integer of x; w = filter width; fades to its mean when unresolvable
fn tunnel_line(x: f32, w: f32) -> f32 {
  let hw = 0.06;
  let d = abs(fract(x + 0.5) - 0.5);
  return mix(1.0 - smoothstep(hw - w, hw + w, d), 2.0 * hw, sat(w * 4.0 - 1.0));
}
fn op(uv: vec2f) -> vec4f {
  let px = 2.0 / g.res.y;
  let p = centered(uv) - u.center;
  let r = max(select(length(p), max(abs(p.x), abs(p.y)), u.shape == 1), 1e-4);
  let depth = 1.0 / r;
  let rep = f32(max(u.repeats, 1));
  let tu = atan2(p.y, p.x) / TAU * rep + u.twist * depth;
  let tv = depth * u.rings + g.time * u.speed;
  var col: vec3f;
  if (u.has_src > 0.5) {
    col = textureSampleLevel(src, smpR, vec2f(tu, tv), 0.0).rgb;
  } else {
    let wu = px * (rep / (TAU * r) + abs(u.twist) / (r * r));
    let wv = px * u.rings / (r * r);
    let lu = tunnel_line(tu, wu); let lv = tunnel_line(tv, wv);
    col = mix(u.colorB.rgb, u.colorA.rgb, 1.0 - (1.0 - lu) * (1.0 - lv));
  }
  return vec4f(col * pow(min(r, 1.0), u.fog), 1.0);
}`,
};

const rays: OpDef = {
  type: 'rays', label: 'Light Rays', category: 'Generate', inputs: [], output: 'tex',
  help: 'Radial god-ray / starburst with per-ray flicker.',
  params: [
    { k: 'int', name: 'count', def: 12, min: 1, max: 128 },
    { k: 'float', name: 'sharpness', def: 6, min: 0, max: 64 },
    { k: 'float', name: 'spin', label: 'Rotation speed', def: 8, min: -360, max: 360, unit: '°/s' },
    { k: 'vec2', name: 'center', def: [0, 0], min: -2, max: 2, step: 0.001 },
    { k: 'float', name: 'falloff', def: 1.2, min: 0, max: 10 },
    { k: 'float', name: 'core', def: 0.6, min: 0, max: 4, help: 'Central glow.' },
    { k: 'color', name: 'color', def: [1, 0.85, 0.6, 1] },
    { k: 'float', name: 'flicker', def: 0.5, min: 0, max: 1, group: 'Flicker' },
    { k: 'float', name: 'flickerRate', label: 'Rate', def: 2, min: 0, max: 20, group: 'Flicker' },
  ],
  body: /* wgsl */`
fn rays_gain(k: f32, n: f32, t: f32) -> f32 {
  let kk = k - n * floor(k / n);
  return mix(1.0, 0.2 + 1.6 * vnoise(vec2f(kk * 7.31, t)), u.flicker);
}
fn op(uv: vec2f) -> vec4f {
  let p = centered(uv) - u.center;
  let r = length(p);
  let n = f32(max(u.count, 1));
  let x = (atan2(p.y, p.x) / TAU + g.time * u.spin / 360.0) * n; // rays sit at integers
  var ray = pow(0.5 + 0.5 * cos(TAU * x), u.sharpness);
  // where the rays get finer than a pixel (near the centre), fade to their mean
  let cyclesPerPx = n * (2.0 / g.res.y) / (TAU * max(r, 1e-6));
  ray = mix(ray, 1.0 / sqrt(1.0 + PI * u.sharpness), smoothstep(0.2, 0.5, cyclesPerPx));
  let k0 = floor(x);
  let tf = g.time * u.flickerRate;
  let amp = mix(rays_gain(k0, n, tf), rays_gain(k0 + 1.0, n, tf), x - k0);
  let i = ray * amp * exp(-r * u.falloff) + u.core / (1.0 + r * r * 100.0);
  return vec4f(u.color.rgb * i, 1.0);
}`,
};

const curlfield: OpDef = {
  type: 'curlfield', label: 'Curl Noise', category: 'Field', inputs: [], output: 'field',
  help: 'Divergence-free curl of simplex noise. Vector in RG (about -1..1).',
  params: [
    { k: 'float', name: 'scale', def: 3, min: 0.1, max: 30 },
    { k: 'float', name: 'speed', def: 0.15, min: 0, max: 4 },
    { k: 'float', name: 'strength', def: 1, min: 0, max: 4 },
    { k: 'int', name: 'octaves', def: 2, min: 1, max: 6 },
  ],
  body: /* wgsl */`
fn curl_pot(p: vec2f, z: f32) -> f32 { return fbm(vec3f(p, z), clamp(u.octaves, 1, 6), 2.0, 0.5); }
fn op(uv: vec2f) -> vec4f {
  let p = centered(uv) * u.scale * 0.5;
  let z = g.time * u.speed;
  let e = 0.01;
  let dx = curl_pot(p + vec2f(e, 0.0), z) - curl_pot(p - vec2f(e, 0.0), z);
  let dy = curl_pot(p + vec2f(0.0, e), z) - curl_pot(p - vec2f(0.0, e), z);
  let v = vec2f(dy, -dx) / (2.0 * e) * 0.3 * u.strength;
  return vec4f(v, 0.0, 1.0);
}`,
};

const flowfield: OpDef = {
  type: 'flowfield', label: 'Vector Field', category: 'Field', inputs: [], output: 'field',
  help: 'Analytic vector fields. Angle rotates the vectors (radial/vortex become spirals).',
  params: [
    { k: 'enum', name: 'mode', label: 'Field', options: ['Radial', 'Vortex', 'Directional', 'Sink-Source', 'Sine waves'], def: 1 },
    { k: 'float', name: 'strength', def: 1, min: -4, max: 4 },
    { k: 'float', name: 'angle', def: 0, min: -360, max: 360, unit: '°' },
    { k: 'vec2', name: 'center', def: [0, 0], min: -2, max: 2, step: 0.001 },
    { k: 'float', name: 'falloff', def: 0.5, min: 0, max: 20, help: 'Weakens the field with distance from the centre.' },
    { k: 'float', name: 'scale', def: 1, min: 0.05, max: 10, help: 'Sink-source separation / sine frequency.' },
    { k: 'float', name: 'speed', def: 0.5, min: -4, max: 4, help: 'Sine waves drift speed.' },
  ],
  body: /* wgsl */`
fn op(uv: vec2f) -> vec4f {
  let p = centered(uv) - u.center;
  let r2 = dot(p, p);
  let a = radians(u.angle);
  let R = rot(a);
  let c2 = 0.0025; // softened core so the centre stays finite
  var v: vec2f;
  switch (u.mode) {
    case 1 { v = R * vec2f(-p.y, p.x) / sqrt(r2 + c2); }
    case 2 { v = vec2f(cos(a), sin(a)); }
    case 3 {
      let s = vec2f(cos(a), sin(a)) * u.scale * 0.5;
      let ps = p - s; let pk = p + s;
      v = (ps / (dot(ps, ps) + c2) - pk / (dot(pk, pk) + c2)) * u.scale * 0.25;
    }
    case 4 {
      let q = rot(-a) * p * u.scale * PI;
      let t = g.time * u.speed;
      v = R * vec2f(sin(q.y + t), sin(q.x - 0.7 * t));
    }
    default { v = R * p / sqrt(r2 + c2); }
  }
  return vec4f(v * u.strength / (1.0 + u.falloff * r2), 0.0, 1.0);
}`,
};

// ---------- audio visualisers (bind the shared 512x2 audio texture) ----------

const AUDIO_WGSL = /* wgsl */`
fn aud_seg(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let pa = p - a; let ba = b - a;
  return length(pa - ba * sat(dot(pa, ba) / max(dot(ba, ba), 1e-12)));
}
// box SDF in (across, along) coordinates
fn aud_box(dx: f32, dy: f32) -> f32 { return length(max(vec2f(dx, dy), vec2f(0.0))) + min(max(dx, dy), 0.0); }
// straight-alpha colour + coverage with glow -> premultiplied output
fn aud_out(col: vec3f, d: f32, cov: f32) -> vec4f {
  let gl = u.glow * exp(-max(d, 0.0) * 30.0) * (1.0 - cov);
  return vec4f(col * (cov + gl), sat(cov + gl));
}`;

/** Uniform fields for every numeric param, in declaration order. */
function fieldsFor(def: { params: OpDef['params'] }): Field[] {
  const map: Record<string, Field[1]> = { float: 'f32', int: 'i32', bool: 'i32', enum: 'i32', vec2: 'vec2f', color: 'vec4f' };
  return def.params.filter(p => p.k in map).map(p => [p.name, map[p.k]] as Field);
}

const spectrumParams: OpDef['params'] = [
  { k: 'enum', name: 'mode', options: ['Bars', 'Line', 'Filled', 'Radial', 'Mirrored'], def: 0 },
  { k: 'int', name: 'bars', def: 64, min: 4, max: 512, help: 'Bar count (Bars, Radial, Mirrored).' },
  { k: 'float', name: 'gain', def: 1, min: 0, max: 8 },
  { k: 'float', name: 'thickness', def: 0.6, min: 0, max: 1, help: 'Bar width fraction, or line width.' },
  { k: 'float', name: 'glow', def: 0.5, min: 0, max: 4 },
  { k: 'color', name: 'colorLow', label: 'Low', def: [1, 0.25, 0.45, 1] },
  { k: 'color', name: 'colorHigh', label: 'High', def: [0.3, 0.75, 1, 1] },
];

const spectrum: OpDef = {
  type: 'spectrum', label: 'Spectrum', category: 'Audio', inputs: [], output: 'tex', animated: true,
  help: 'Draws the live audio spectrum (log frequency). Alpha is coverage.',
  params: spectrumParams,
  passes: {
    main: {
      inputs: ['audio'],
      fields: fieldsFor({ params: spectrumParams }),
      body: /* wgsl */`${AUDIO_WGSL}
fn spec_at(x: f32) -> f32 { return textureSampleLevel(audio, smp, vec2f(x, 0.25), 0.0).r * u.gain; }
fn spec_bin(i: f32) -> f32 { return spec_at((clamp(i, 0.0, 511.0) + 0.5) / 512.0); }
fn spec_bar(j: f32, n: f32) -> f32 { // average level under bar j
  var s = 0.0;
  for (var k = 0; k < 4; k++) { s += spec_at((j + (f32(k) + 0.5) * 0.25) / n); }
  return s * 0.25;
}
// distance (height units) to the nearest of the bars around x01; unitW = height units per unit of x01
fn spec_bars(x01: f32, unitW: f32, y: f32, mirrored: bool) -> f32 {
  let n = f32(clamp(u.bars, 1, 512));
  let i = floor(x01 * n);
  var d = 1e9;
  for (var k = -1; k <= 1; k++) {
    let j = clamp(i + f32(k), 0.0, n - 1.0);
    let h = spec_bar(j, n);
    let dx = (abs(x01 * n - j - 0.5) - 0.5 * u.thickness) * unitW / n;
    let dy = select(y - 0.9 * h, abs(y - 0.5) - 0.45 * h, mirrored);
    d = min(d, aud_box(dx, dy));
  }
  return d;
}
fn op(uv: vec2f) -> vec4f {
  let px = 1.0 / g.res.y;
  let y = 1.0 - uv.y;
  var x = uv.x;
  var d: f32;
  var cov: f32;
  switch (u.mode) {
    case 1, 2 {
      let P = vec2f(uv.x * g.aspect, y);
      let i0 = floor(uv.x * 512.0 - 0.5);
      d = 1e9;
      for (var k = -4; k <= 4; k++) {
        let ia = i0 + f32(k);
        let a = vec2f((ia + 0.5) / 512.0 * g.aspect, 0.9 * spec_bin(ia));
        let b = vec2f((ia + 1.5) / 512.0 * g.aspect, 0.9 * spec_bin(ia + 1.0));
        d = min(d, aud_seg(P, a, b));
      }
      d -= 0.5 * (u.thickness * 0.015 + px);
      cov = sat(0.5 - d / px);
      if (u.mode == 2) { cov = max(cov, 0.35 * sat(0.5 - (y - 0.9 * spec_at(uv.x)) / px)); }
    }
    case 3 {
      let p = centered(uv) * 0.5;
      let r = length(p);
      x = abs(atan2(p.x, -p.y) / PI); // 0 at top, 1 at bottom, mirrored left/right
      let n = f32(clamp(u.bars, 1, 512));
      let i = floor(x * n);
      d = 1e9;
      for (var k = -1; k <= 1; k++) {
        let j = clamp(i + f32(k), 0.0, n - 1.0);
        let dx = (abs(x * n - j - 0.5) - 0.5 * u.thickness) * PI * r / n;
        let dy = max(r - (0.18 + 0.3 * spec_bar(j, n)), 0.18 - r);
        d = min(d, aud_box(dx, dy));
      }
      cov = sat(0.5 - d / px);
    }
    case 4 {
      x = abs(uv.x * 2.0 - 1.0);
      d = spec_bars(x, g.aspect * 0.5, y, true);
      cov = sat(0.5 - d / px);
    }
    default {
      d = spec_bars(x, g.aspect, y, false);
      cov = sat(0.5 - d / px);
    }
  }
  return aud_out(mix(u.colorLow.rgb, u.colorHigh.rgb, x), d, cov);
}`,
    },
  },
  cook(c) { c.run('main', c.out, [c.audioView], { ...c.p }); },
};

const scopeParams: OpDef['params'] = [
  { k: 'enum', name: 'mode', options: ['Line', 'Radial', 'Lissajous'], def: 0 },
  { k: 'float', name: 'thickness', def: 0.006, min: 0, max: 0.05 },
  { k: 'float', name: 'gain', def: 1, min: 0, max: 8 },
  { k: 'float', name: 'glow', def: 0.6, min: 0, max: 4 },
  { k: 'color', name: 'color', def: [0.35, 1, 0.6, 1] },
  { k: 'int', name: 'offset', label: 'Lissajous offset', def: 32, min: 1, max: 256, help: 'Sample delay between X and Y.' },
];

const scope: OpDef = {
  type: 'scope', label: 'Scope', category: 'Audio', inputs: [], output: 'tex', animated: true,
  help: 'Oscilloscope of the live waveform. Alpha is coverage.',
  params: scopeParams,
  passes: {
    main: {
      inputs: ['audio'],
      fields: fieldsFor({ params: scopeParams }),
      body: /* wgsl */`${AUDIO_WGSL}
fn scope_w(i: f32) -> f32 { // sample i, wrapped
  let k = i - 512.0 * floor(i / 512.0);
  return textureSampleLevel(audio, smpN, vec2f((k + 0.5) / 512.0, 0.75), 0.0).r * u.gain;
}
fn scope_rad(i: f32) -> vec2f {
  let a = (i + 0.5) / 512.0 * TAU;
  return (0.3 + 0.15 * scope_w(i)) * vec2f(sin(a), -cos(a));
}
fn scope_lis(i: f32) -> vec2f { return 0.4 * vec2f(scope_w(i), -scope_w(i + f32(u.offset))); }
fn op(uv: vec2f) -> vec4f {
  let px = 1.0 / g.res.y;
  var d = 1e9;
  switch (u.mode) {
    case 1 {
      let P = centered(uv) * 0.5;
      let i0 = floor(fract(atan2(P.x, -P.y) / TAU) * 512.0 - 0.5);
      for (var k = -4; k <= 4; k++) {
        let ia = i0 + f32(k);
        d = min(d, aud_seg(P, scope_rad(ia), scope_rad(ia + 1.0)));
      }
    }
    case 2 {
      let P = centered(uv) * 0.5;
      var a = scope_lis(0.0);
      for (var i = 1; i <= 256; i++) {
        let b = scope_lis(f32(i * 2));
        d = min(d, aud_seg(P, a, b));
        a = b;
      }
    }
    default {
      let P = vec2f(uv.x * g.aspect, 1.0 - uv.y);
      let i0 = floor(uv.x * 512.0 - 0.5);
      for (var k = -4; k <= 4; k++) {
        let ia = clamp(i0 + f32(k), 0.0, 510.0);
        let a = vec2f((ia + 0.5) / 512.0 * g.aspect, 0.5 + 0.4 * scope_w(ia));
        let b = vec2f((ia + 1.5) / 512.0 * g.aspect, 0.5 + 0.4 * scope_w(ia + 1.0));
        d = min(d, aud_seg(P, a, b));
      }
    }
  }
  d -= 0.5 * (u.thickness + px);
  return aud_out(u.color.rgb, d, sat(0.5 - d / px));
}`,
    },
  },
  cook(c) { c.run('main', c.out, [c.audioView], { ...c.p }); },
};

export const ops: OpDef[] = [
  constant, ramp, shape, pattern, voronoi, warpnoise, plasma, tunnel, rays, curlfield, flowfield, spectrum, scope,
];
