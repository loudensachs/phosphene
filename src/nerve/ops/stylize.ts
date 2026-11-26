// NERVE stylise / glitch operators. Sizes are fractions of image height; perceptual decisions use a
// gamma-2.2 encoded value and decode back to linear.
import type { OpDef } from '../types';

const perc = (p: string) => /* wgsl */`
fn ${p}_enc(x: vec3f) -> vec3f { return pow(max(x, vec3f(0.0)), vec3f(1.0 / 2.2)); }
fn ${p}_dec(x: vec3f) -> vec3f { return pow(max(x, vec3f(0.0)), vec3f(2.2)); }
fn ${p}_enc1(x: f32) -> f32 { return pow(max(x, 0.0), 1.0 / 2.2); }`;

/** Interleaved gradient noise: cheap, blue-ish per-pixel threshold. */
const ign = (p: string) => /* wgsl */`
fn ${p}_ign(q: vec2f) -> f32 { return fract(52.9829189 * fract(dot(floor(q), vec2f(0.06711056, 0.00583715)))); }`;

// ---------------------------------------------------------------- bloom

const BLOOM_DOWN = /* wgsl */`
fn bloom_pre(c: vec3f) -> vec3f {
  let br = max(c.r, max(c.g, c.b));
  let kn = max(u.threshold * u.knee, 1e-4);
  var rq = clamp(br - u.threshold + kn, 0.0, 2.0 * kn);
  rq = rq * rq / (4.0 * kn);
  return c * max(rq, br - u.threshold) / max(br, 1e-4);
}
fn bloom_t(uv: vec2f, px: vec2f, x: f32, y: f32) -> vec3f {
  return textureSampleLevel(src, smp, uv + vec2f(x, y) * px, 0.0).rgb;
}
// 13-tap (Jimenez / CoD:AW) downsample; Karis-weighted with soft-knee prefilter on the first level
fn op(uv: vec2f) -> vec4f {
  let px = 1.0 / vec2f(textureDimensions(src));
  let s0 = bloom_t(uv, px, -2.0, -2.0); let s1 = bloom_t(uv, px, 0.0, -2.0); let s2 = bloom_t(uv, px, 2.0, -2.0);
  let s3 = bloom_t(uv, px, -1.0, -1.0); let s4 = bloom_t(uv, px, 1.0, -1.0);
  let s5 = bloom_t(uv, px, -2.0, 0.0); let s6 = bloom_t(uv, px, 0.0, 0.0); let s7 = bloom_t(uv, px, 2.0, 0.0);
  let s8 = bloom_t(uv, px, -1.0, 1.0); let s9 = bloom_t(uv, px, 1.0, 1.0);
  let s10 = bloom_t(uv, px, -2.0, 2.0); let s11 = bloom_t(uv, px, 0.0, 2.0); let s12 = bloom_t(uv, px, 2.0, 2.0);
  var b0 = (s3 + s4 + s8 + s9) * 0.25;
  var b1 = (s0 + s1 + s5 + s6) * 0.25;
  var b2 = (s1 + s2 + s6 + s7) * 0.25;
  var b3 = (s5 + s6 + s10 + s11) * 0.25;
  var b4 = (s6 + s7 + s11 + s12) * 0.25;
  var w = vec4f(0.125);
  var w0 = 0.5;
  if (u.first == 1) {
    b0 = bloom_pre(b0); b1 = bloom_pre(b1); b2 = bloom_pre(b2); b3 = bloom_pre(b3); b4 = bloom_pre(b4);
    w0 *= 1.0 / (1.0 + luma(b0));
    w *= 1.0 / (1.0 + vec4f(luma(b1), luma(b2), luma(b3), luma(b4)));
  }
  let sum = b0 * w0 + b1 * w.x + b2 * w.y + b3 * w.z + b4 * w.w;
  return vec4f(sum / (w0 + w.x + w.y + w.z + w.w), 1.0);
}`;

const TENT = (tex: string) => /* wgsl */`
fn bloom_tent(uv: vec2f) -> vec3f {
  let px = 1.0 / vec2f(textureDimensions(${tex}));
  var s = textureSampleLevel(${tex}, smp, uv, 0.0).rgb * 4.0;
  s += (textureSampleLevel(${tex}, smp, uv + vec2f(-px.x, 0.0), 0.0).rgb + textureSampleLevel(${tex}, smp, uv + vec2f(px.x, 0.0), 0.0).rgb
      + textureSampleLevel(${tex}, smp, uv + vec2f(0.0, -px.y), 0.0).rgb + textureSampleLevel(${tex}, smp, uv + vec2f(0.0, px.y), 0.0).rgb) * 2.0;
  s += textureSampleLevel(${tex}, smp, uv - px, 0.0).rgb + textureSampleLevel(${tex}, smp, uv + px, 0.0).rgb
     + textureSampleLevel(${tex}, smp, uv + vec2f(px.x, -px.y), 0.0).rgb + textureSampleLevel(${tex}, smp, uv + vec2f(-px.x, px.y), 0.0).rgb;
  return s / 16.0;
}`;

const bloom: OpDef = {
  type: 'bloom', label: 'Bloom', category: 'Filter', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }],
  help: 'HDR bloom: soft-knee threshold, 13-tap downsample pyramid, tent upsample. Radius shifts energy toward the wider levels.',
  params: [
    { k: 'float', name: 'threshold', def: 0.6, min: 0, max: 8 },
    { k: 'float', name: 'knee', def: 0.5, min: 0, max: 1, help: 'Soft-knee width as a fraction of the threshold.' },
    { k: 'float', name: 'intensity', def: 0.6, min: 0, max: 4 },
    { k: 'float', name: 'radius', def: 0.7, min: 0, max: 0.95 },
    { k: 'color', name: 'tint', def: [1, 1, 1, 1] },
    { k: 'bool', name: 'bloomOnly', label: 'Bloom only', def: false },
  ],
  passes: {
    down: { inputs: ['src'], fields: [['threshold', 'f32'], ['knee', 'f32'], ['first', 'i32']], body: BLOOM_DOWN },
    up: {
      inputs: ['lo', 'hi'], fields: [['scatter', 'f32']],
      body: /* wgsl */`${TENT('lo')}
fn op(uv: vec2f) -> vec4f {
  return vec4f(mix(textureSampleLevel(hi, smp, uv, 0.0).rgb, bloom_tent(uv), u.scatter), 1.0);
}`,
    },
    comp: {
      inputs: ['src', 'bloom'], fields: [['intensity', 'f32'], ['tint', 'vec4f'], ['bloomOnly', 'i32']],
      body: /* wgsl */`${TENT('bloom')}
fn op(uv: vec2f) -> vec4f {
  let b = bloom_tent(uv) * u.tint.rgb * u.intensity;
  if (u.bloomOnly == 1) { return vec4f(b, 1.0); }
  let c = textureSampleLevel(src, smp, uv, 0.0);
  return vec4f(c.rgb + b, max(c.a, sat(luma(b))));
}`,
    },
  },
  cook(c) {
    const levels = Math.max(1, Math.min(6, Math.floor(Math.log2(Math.min(c.w, c.h))) - 2));
    const downs: { view: GPUTextureView; w: number; h: number }[] = [];
    let w = c.w, h = c.h;
    let prev = c.ins[0];
    for (let i = 1; i <= levels; i++) {
      w = Math.max(1, Math.floor(w / 2)); h = Math.max(1, Math.floor(h / 2));
      const t = c.tex(`d${i}`, w, h);
      c.run('down', t.view, [prev], { threshold: c.p.threshold, knee: c.p.knee, first: i === 1 ? 1 : 0 }, [w, h]);
      downs.push({ view: t.view, w, h });
      prev = t.view;
    }
    let up = downs[levels - 1].view;
    for (let i = levels - 2; i >= 0; i--) {
      const d = downs[i];
      const t = c.tex(`u${i + 1}`, d.w, d.h);
      c.run('up', t.view, [up, d.view], { scatter: c.p.radius }, [d.w, d.h]);
      up = t.view;
    }
    c.run('comp', c.out, [c.ins[0], up], { intensity: c.p.intensity, tint: c.p.tint, bloomOnly: c.p.bloomOnly });
  },
};

// ---------------------------------------------------------------- blurs

const dirblur: OpDef = {
  type: 'dirblur', label: 'Directional Blur', category: 'Filter', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }],
  help: 'Motion-style blur along an angle. Length is a fraction of image height; uncentred smears in one direction only.',
  params: [
    { k: 'float', name: 'angle', def: 0, min: -180, max: 180, unit: '°' },
    { k: 'float', name: 'len', label: 'Length', def: 0.05, min: 0, max: 0.5, step: 0.001 },
    { k: 'int', name: 'samples', def: 32, min: 2, max: 64 },
    { k: 'bool', name: 'centred', def: true },
  ],
  body: /* wgsl */`${ign('dirblur')}
fn op(uv: vec2f) -> vec4f {
  let n = clamp(u.samples, 2, 64);
  let a = radians(u.angle);
  let d = vec2f(cos(a), -sin(a)) * u.len * vec2f(g.res.y / g.res.x, 1.0);
  let start = select(0.0, -0.5, u.centred == 1);
  let j = dirblur_ign(uv * g.res);
  var acc = vec4f(0.0);
  for (var i = 0; i < n; i++) {
    acc += textureSampleLevel(src, smp, uv + d * (start + (f32(i) + j) / f32(n)), 0.0);
  }
  return acc / f32(n);
}`,
};

const radialblur: OpDef = {
  type: 'radialblur', label: 'Radial Blur', category: 'Filter', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }],
  help: 'Zoom or spin blur around a centre, with per-pixel jittered taps to hide banding. Spin amount 1 = 90°.',
  params: [
    { k: 'enum', name: 'mode', options: ['Zoom', 'Spin'], def: 0 },
    { k: 'vec2', name: 'center', def: [0, 0], min: -1, max: 1 },
    { k: 'float', name: 'amount', def: 0.15, min: 0, max: 1 },
    { k: 'int', name: 'samples', def: 32, min: 2, max: 64 },
  ],
  body: /* wgsl */`
fn op(uv: vec2f) -> vec4f {
  let n = clamp(u.samples, 2, 64);
  let p = centered(uv) - u.center;
  let j = hash21(uv * g.res);
  var acc = vec4f(0.0);
  for (var i = 0; i < n; i++) {
    let t = (f32(i) + j) / f32(n) - 0.5;
    var q: vec2f;
    if (u.mode == 0) { q = p * (1.0 - u.amount * t); }
    else { q = rot(u.amount * t * PI * 0.5) * p; }
    acc += textureSampleLevel(src, smp, uncentered(q + u.center), 0.0);
  }
  return acc / f32(n);
}`,
};

const chromab: OpDef = {
  type: 'chromab', label: 'Chromatic Aberration', category: 'Filter', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }],
  help: 'Spectral colour fringing. Samples are spread across a smooth spectrum and normalised per channel, so more samples give a continuous rainbow. Offset scales with distance from the centre raised to Falloff (0 = uniform).',
  params: [
    { k: 'enum', name: 'mode', options: ['Radial', 'Directional'], def: 0 },
    { k: 'float', name: 'amount', def: 0.006, min: 0, max: 0.1, step: 0.0005 },
    { k: 'float', name: 'angle', def: 0, min: -180, max: 180, unit: '°', help: 'Directional mode only.' },
    { k: 'vec2', name: 'center', def: [0, 0], min: -1, max: 1 },
    { k: 'int', name: 'samples', def: 9, min: 3, max: 16 },
    { k: 'float', name: 'falloff', def: 1.5, min: 0, max: 4 },
  ],
  body: /* wgsl */`
fn op(uv: vec2f) -> vec4f {
  let n = clamp(u.samples, 3, 16);
  let p = centered(uv) - u.center;
  let r = length(p);
  var dir = vec2f(cos(radians(u.angle)), -sin(radians(u.angle)));
  if (u.mode == 0) { dir = p / max(r, 1e-5); }
  let off = dir * u.amount * pow(max(r, 1e-4), u.falloff) / vec2f(g.aspect, 1.0);
  var acc = vec3f(0.0); var wsum = vec3f(0.0); var a = 0.0;
  for (var i = 0; i < n; i++) {
    let t = (f32(i) + 0.5) / f32(n);
    let x = clamp(t * 3.0 - vec3f(0.5, 1.5, 2.5), vec3f(-1.0), vec3f(1.0));
    let w = 0.5 + 0.5 * cos(PI * x);
    let s = textureSampleLevel(src, smp, uv + off * (t * 2.0 - 1.0), 0.0);
    acc += s.rgb * w; wsum += w; a += s.a;
  }
  return vec4f(acc / max(wsum, vec3f(1e-4)), a / f32(n));
}`,
};

// ---------------------------------------------------------------- edges & relief

const edge: OpDef = {
  type: 'edge', label: 'Edge Detect', category: 'Filter', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }],
  help: 'Edge detection on perceptual luma. Thickness widens the kernel (fraction of height, min 1 px). Tint is used by Tinted and Over Source.',
  params: [
    { k: 'enum', name: 'kernel', options: ['Sobel', 'Scharr', 'Laplacian'], def: 0 },
    { k: 'float', name: 'strength', def: 2, min: 0, max: 10 },
    { k: 'float', name: 'threshold', def: 0.05, min: 0, max: 1 },
    { k: 'enum', name: 'look', label: 'Colour', options: ['White', 'Tinted', 'Over Source', 'Direction'], def: 0 },
    { k: 'color', name: 'tint', def: [0.3, 0.9, 1, 1] },
    { k: 'float', name: 'thickness', def: 0.001, min: 0, max: 0.02, step: 0.0005 },
  ],
  body: /* wgsl */`${perc('edge')}
fn edge_l(uv: vec2f) -> f32 { return edge_enc1(luma(textureSampleLevel(src, smp, uv, 0.0).rgb)); }
fn op(uv: vec2f) -> vec4f {
  let c = textureSampleLevel(src, smp, uv, 0.0);
  let px = max(u.thickness * g.res.y, 1.0) / g.res;
  let tl = edge_l(uv - px); let tc = edge_l(uv + vec2f(0.0, -px.y)); let tr = edge_l(uv + vec2f(px.x, -px.y));
  let ml = edge_l(uv + vec2f(-px.x, 0.0)); let mc = edge_enc1(luma(c.rgb)); let mr = edge_l(uv + vec2f(px.x, 0.0));
  let bl = edge_l(uv + vec2f(-px.x, px.y)); let bc = edge_l(uv + vec2f(0.0, px.y)); let br = edge_l(uv + px);
  var gx = ((tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl)) * 0.25;
  var gy = ((bl + 2.0 * bc + br) - (tl + 2.0 * tc + tr)) * 0.25;
  if (u.kernel == 1) {
    gx = ((3.0 * tr + 10.0 * mr + 3.0 * br) - (3.0 * tl + 10.0 * ml + 3.0 * bl)) / 16.0;
    gy = ((3.0 * bl + 10.0 * bc + 3.0 * br) - (3.0 * tl + 10.0 * tc + 3.0 * tr)) / 16.0;
  }
  var m = length(vec2f(gx, gy));
  if (u.kernel == 2) { m = abs(4.0 * mc - tc - bc - ml - mr); }
  let e = max(m - u.threshold, 0.0) * u.strength / max(1.0 - u.threshold, 0.05);
  switch (u.look) {
    case 1 { return vec4f(u.tint.rgb * e, c.a); }
    case 2 { return vec4f(mix(c.rgb, u.tint.rgb, sat(e)), c.a); }
    case 3 { return vec4f(hsv2rgb(vec3f(fract(atan2(gy, gx) / TAU), 1.0, 1.0)) * e, c.a); }
    default { return vec4f(vec3f(e), c.a); }
  }
}`,
};

const sharpen: OpDef = {
  type: 'sharpen', label: 'Sharpen', category: 'Filter', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }],
  help: 'Unsharp mask. Radius is a fraction of image height; Threshold ignores low-contrast detail (noise).',
  params: [
    { k: 'float', name: 'radius', def: 0.0015, min: 0, max: 0.02, step: 0.0005 },
    { k: 'float', name: 'amount', def: 1, min: 0, max: 5 },
    { k: 'float', name: 'threshold', def: 0, min: 0, max: 0.5 },
  ],
  body: /* wgsl */`
fn op(uv: vec2f) -> vec4f {
  let c = textureSampleLevel(src, smp, uv, 0.0);
  let st = max(u.radius * g.res.y, 0.5) * 0.5 / g.res;
  var acc = vec3f(0.0); var wsum = 0.0;
  for (var j = -2; j <= 2; j++) {
    for (var i = -2; i <= 2; i++) {
      let o = vec2f(f32(i), f32(j));
      let w = exp(-0.5 * dot(o, o));
      acc += textureSampleLevel(src, smp, uv + o * st, 0.0).rgb * w;
      wsum += w;
    }
  }
  let detail = c.rgb - acc / wsum;
  let k = smoothstep(u.threshold, u.threshold * 2.0 + 1e-4, abs(luma(detail)));
  return vec4f(max(c.rgb + detail * u.amount * k, vec3f(0.0)), c.a);
}`,
};

const emboss: OpDef = {
  type: 'emboss', label: 'Emboss', category: 'Filter', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }],
  help: 'Relief lit from Angle. Grey outputs a mid-grey relief map; Colour lights the source.',
  params: [
    { k: 'float', name: 'angle', def: 135, min: -180, max: 180, unit: '°' },
    { k: 'float', name: 'height', def: 3, min: 0, max: 20 },
    { k: 'enum', name: 'mode', options: ['Grey', 'Colour'], def: 0 },
    { k: 'float', name: 'amount', label: 'Mix', def: 1, min: 0, max: 1 },
  ],
  body: /* wgsl */`${perc('emboss')}
fn op(uv: vec2f) -> vec4f {
  let c = textureSampleLevel(src, smp, uv, 0.0);
  let a = radians(u.angle);
  let o = vec2f(cos(a), -sin(a)) * 0.0015 * vec2f(g.res.y / g.res.x, 1.0);
  let d = emboss_enc1(luma(textureSampleLevel(src, smp, uv + o, 0.0).rgb))
        - emboss_enc1(luma(textureSampleLevel(src, smp, uv - o, 0.0).rgb));
  let v = max(0.5 + d * u.height, 0.0);
  var e = vec3f(pow(v, 2.2));
  if (u.mode == 1) { e = c.rgb * v * 2.0; }
  return vec4f(mix(c.rgb, e, u.amount), c.a);
}`,
};

const GLOWEDGE_FN = /* wgsl */`
fn glowedge_l(uv: vec2f) -> f32 { return glowedge_enc1(luma(textureSampleLevel(src, smp, uv, 0.0).rgb)); }
fn glowedge_grad(uv: vec2f, px: vec2f) -> vec2f {
  return vec2f(glowedge_l(uv + vec2f(px.x, 0.0)) - glowedge_l(uv - vec2f(px.x, 0.0)),
               glowedge_l(uv + vec2f(0.0, px.y)) - glowedge_l(uv - vec2f(0.0, px.y)));
}
fn glowedge_col(gr: vec2f) -> vec3f {
  let h = fract(atan2(gr.y, gr.x) / TAU + g.time * u.hueSpeed);
  return hsv2rgb(vec3f(h, u.saturation, 1.0));
}
`;
const glowedge: OpDef = {
  type: 'glowedge', label: 'Neon Edges', category: 'Filter', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }],
  help: 'Edges coloured by their direction with a cycling hue, plus an exponential glow gathered in one pass from jittered sample rings. Mix 0 adds the neon over the source, 1 shows it on black.',
  params: [
    { k: 'float', name: 'thickness', def: 0.0015, min: 0, max: 0.01, step: 0.0005 },
    { k: 'float', name: 'glow', label: 'Glow radius', def: 0.015, min: 0.001, max: 0.08, step: 0.001 },
    { k: 'float', name: 'intensity', def: 1.5, min: 0, max: 8 },
    { k: 'float', name: 'hueSpeed', label: 'Hue speed', def: 0.1, min: -2, max: 2, unit: 'rev/s' },
    { k: 'float', name: 'saturation', def: 0.9, min: 0, max: 1 },
    { k: 'float', name: 'amount', label: 'Mix', def: 1, min: 0, max: 1 },
  ],
  // Two passes: the coloured edge map is computed once at half size, then the glow gathers 40 single taps from it.
  // Evaluating the edge detector inside the gather loop cost 160 picture samples per pixel and could not hold 60 fps at HD.
  passes: {
    ge_pre: {
      inputs: ['src'], fields: [['thickness', 'f32'], ['glow', 'f32'], ['hueSpeed', 'f32'], ['saturation', 'f32']],
      body: /* wgsl */`${perc('glowedge')}${GLOWEDGE_FN}
fn op(uv: vec2f) -> vec4f {
  let tpx = max(u.thickness * g.res.y, 0.5);
  let rad = u.glow * g.res.y;
  let gr = glowedge_grad(uv, vec2f(max(tpx, rad * 0.375)) / g.res);
  return vec4f(glowedge_col(gr) * sat(length(gr) * 4.0), 1.0);
}`,
    },
    ge_main: {
      inputs: ['src', 'edges'], fields: [['thickness', 'f32'], ['glow', 'f32'], ['intensity', 'f32'], ['hueSpeed', 'f32'], ['saturation', 'f32'], ['amount', 'f32']],
      body: /* wgsl */`${perc('glowedge')}${ign('glowedge')}${GLOWEDGE_FN}
fn op(uv: vec2f) -> vec4f {
  let c = textureSampleLevel(src, smp, uv, 0.0);
  let tpx = max(u.thickness * g.res.y, 1.0);
  let g0 = glowedge_grad(uv, tpx / g.res);
  let core = glowedge_col(g0) * sat(length(g0) * 4.0);
  let rad = u.glow * g.res.y;
  let jit = glowedge_ign(uv * g.res) * TAU;
  var glow = vec3f(0.0);
  for (var k = 0; k < 4; k++) {
    let r = rad * (f32(k) + 0.5) * 0.75;
    let w = exp(-r / rad);
    for (var j = 0; j < 10; j++) {
      let a = jit + (f32(j) + f32(k) * 0.5) * TAU / 10.0;
      glow += textureSampleLevel(edges, smp, uv + vec2f(cos(a), sin(a)) * r / g.res, 0.0).rgb * w;
    }
  }
  let neon = (core * 1.5 + glow * 0.2) * u.intensity;
  return vec4f(c.rgb * (1.0 - u.amount) + neon, max(c.a, sat(luma(neon))));
}`,
    },
  },
  cook(c) {
    const p = c.p, e = c.tex('edges', Math.max(8, Math.ceil(c.w / 2)), Math.max(8, Math.ceil(c.h / 2)));
    c.run('ge_pre', e.view, [c.ins[0]], { thickness: p.thickness, glow: p.glow, hueSpeed: p.hueSpeed, saturation: p.saturation }, [e.tex.width, e.tex.height]);
    c.run('ge_main', c.out, [c.ins[0], e.view], { thickness: p.thickness, glow: p.glow, intensity: p.intensity, hueSpeed: p.hueSpeed, saturation: p.saturation, amount: p.amount });
  },
};

// ---------------------------------------------------------------- print & pixel looks

const halftone: OpDef = {
  type: 'halftone', label: 'Halftone', category: 'Filter', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }],
  help: 'Print screen with dot, line or cross cells. CMYK separates into four screens at 15/75/0/45° (rotated by Angle − 45°); Ink is the K / mono ink.',
  params: [
    { k: 'enum', name: 'pattern', options: ['Dot', 'Line', 'Cross'], def: 0 },
    { k: 'enum', name: 'mode', options: ['Mono', 'CMYK'], def: 0 },
    { k: 'float', name: 'cellSize', label: 'Cell size', def: 0.012, min: 0.002, max: 0.1, step: 0.001 },
    { k: 'float', name: 'angle', def: 45, min: -180, max: 180, unit: '°' },
    { k: 'float', name: 'softness', def: 0.05, min: 0, max: 1 },
    { k: 'color', name: 'ink', def: [0.05, 0.05, 0.08, 1] },
    { k: 'color', name: 'paper', def: [0.96, 0.94, 0.88, 1] },
  ],
  body: /* wgsl */`${perc('halftone')}
// xy = position in cell (-0.5..0.5), zw = uv of the cell centre
fn halftone_cell(uv: vec2f, ang: f32, cpx: f32) -> vec4f {
  let p = rot(ang) * (uv * g.res) / cpx;
  let cell = floor(p) + 0.5;
  return vec4f(p - cell, (rot(-ang) * cell * cpx) / g.res);
}
fn halftone_shape(f: vec2f, cov: f32, aa: f32) -> f32 {
  switch (u.pattern) {
    case 1 {
      let hw = cov * 0.5;
      return (1.0 - smoothstep(hw - aa, hw + aa, abs(f.y))) * sat(hw / aa);
    }
    case 2 {
      let hw = (1.0 - sqrt(max(1.0 - cov, 0.0))) * 0.5;
      return (1.0 - smoothstep(hw - aa, hw + aa, min(abs(f.x), abs(f.y)))) * sat(hw / aa);
    }
    default {
      let r = mix(sqrt(cov / PI), sqrt(cov) * 0.7071, cov);
      return (1.0 - smoothstep(r - aa, r + aa, length(f))) * sat(r / aa);
    }
  }
}
fn halftone_ink(uv: vec2f, ang: f32, cpx: f32, aa: f32, ch: i32) -> f32 {
  let h = halftone_cell(uv, ang, cpx);
  let e = halftone_sat3(halftone_enc(textureSampleLevel(src, smp, h.zw, 0.0).rgb));
  let k = 1.0 - max(e.r, max(e.g, e.b));
  var cov = k;
  if (ch < 3) { cov = (1.0 - e[ch] - k) / max(1.0 - k, 1e-4); }
  return halftone_shape(h.xy, sat(cov), aa);
}
fn halftone_sat3(x: vec3f) -> vec3f { return clamp(x, vec3f(0.0), vec3f(1.0)); }
fn op(uv: vec2f) -> vec4f {
  let c = textureSampleLevel(src, smp, uv, 0.0);
  let cpx = max(u.cellSize * g.res.y, 2.0);
  let aa = max(0.75 / cpx, u.softness * 0.5);
  let a0 = radians(u.angle);
  if (u.mode == 0) {
    let h = halftone_cell(uv, a0, cpx);
    let l = halftone_enc1(luma(textureSampleLevel(src, smp, h.zw, 0.0).rgb));
    let k = halftone_shape(h.xy, sat(1.0 - l), aa);
    return vec4f(mix(u.paper.rgb, u.ink.rgb, k), c.a);
  }
  let base = a0 - radians(45.0);
  let ac = halftone_ink(uv, base + radians(15.0), cpx, aa, 0);
  let am = halftone_ink(uv, base + radians(75.0), cpx, aa, 1);
  let ay = halftone_ink(uv, base, cpx, aa, 2);
  let ak = halftone_ink(uv, base + radians(45.0), cpx, aa, 3);
  var rgb = u.paper.rgb * mix(vec3f(1.0), vec3f(0.0, 1.0, 1.0), ac) * mix(vec3f(1.0), vec3f(1.0, 0.0, 1.0), am)
          * mix(vec3f(1.0), vec3f(1.0, 1.0, 0.0), ay);
  rgb = mix(rgb, u.ink.rgb, ak);
  return vec4f(rgb, c.a);
}`,
};

const dither: OpDef = {
  type: 'dither', label: 'Dither', category: 'Filter', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }],
  help: 'Ordered (Bayer) or blue-ish noise dithering to a few perceptual levels, on chunky pixels. 1-bit forces two luma levels; Palette maps the luma result between two colours.',
  params: [
    { k: 'enum', name: 'pattern', options: ['Bayer 2×2', 'Bayer 4×4', 'Bayer 8×8', 'Noise'], def: 2 },
    { k: 'enum', name: 'mode', options: ['Colour', 'Mono', '1-bit'], def: 0 },
    { k: 'int', name: 'levels', def: 4, min: 2, max: 32 },
    { k: 'float', name: 'pixelScale', label: 'Pixel size', def: 0.002, min: 0, max: 0.05, step: 0.0005 },
    { k: 'bool', name: 'usePalette', label: 'Palette', def: false },
    { k: 'color', name: 'dark', def: [0.06, 0.05, 0.12, 1], group: 'Palette' },
    { k: 'color', name: 'light', def: [0.95, 0.9, 0.7, 1], group: 'Palette' },
  ],
  body: /* wgsl */`${perc('dither')}${ign('dither')}
fn dither_bayer(p: vec2u, bits: u32) -> f32 {
  var v = 0u;
  for (var i = 0u; i < bits; i++) {
    let xb = (p.x >> i) & 1u; let yb = (p.y >> i) & 1u;
    v = v | ((((xb ^ yb) << 1u) | yb) << (2u * (bits - 1u - i)));
  }
  return (f32(v) + 0.5) / f32(1u << (2u * bits));
}
fn op(uv: vec2f) -> vec4f {
  let ps = max(u.pixelScale * g.res.y, 1.0);
  let cell = floor(uv * g.res / ps);
  let c = textureSampleLevel(src, smp, (cell + 0.5) * ps / g.res, 0.0);
  var t = dither_ign(cell);
  if (u.pattern < 3) { t = dither_bayer(vec2u(cell), u32(u.pattern + 1)); }
  var n = f32(max(u.levels, 2) - 1);
  if (u.mode == 2) { n = 1.0; }
  var e = vec3f(dither_enc1(luma(c.rgb)));
  if (u.mode == 0 && u.usePalette == 0) { e = dither_enc(c.rgb); }
  let q = floor(e * n + t) / n;
  var rgb = dither_dec(q);
  if (u.usePalette == 1) { rgb = mix(u.dark.rgb, u.light.rgb, clamp(q.x, 0.0, 1.0)); }
  return vec4f(rgb, c.a);
}`,
};

// ---------------------------------------------------------------- glitch

const crt: OpDef = {
  type: 'crt', label: 'CRT', category: 'Glitch', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }],
  help: 'Tube monitor: barrel curvature, brightness-dependent scanlines, aperture mask, phosphor bleed, flicker, rolling bar and noise.',
  params: [
    { k: 'float', name: 'curvature', def: 0.15, min: 0, max: 1 },
    { k: 'float', name: 'scanlines', def: 0.5, min: 0, max: 1, group: 'Scan' },
    { k: 'float', name: 'lines', def: 270, min: 50, max: 1080, group: 'Scan', help: 'Scanlines per frame height.' },
    { k: 'enum', name: 'maskType', label: 'Mask', options: ['Stripe', 'Triad', 'Slot'], def: 0, group: 'Mask' },
    { k: 'float', name: 'maskStrength', label: 'Mask strength', def: 0.35, min: 0, max: 1, group: 'Mask' },
    { k: 'float', name: 'maskSize', label: 'Mask size', def: 0.0025, min: 0.0005, max: 0.02, step: 0.0005, group: 'Mask' },
    { k: 'float', name: 'bleed', def: 0.5, min: 0, max: 1 },
    { k: 'float', name: 'vignette', def: 0.4, min: 0, max: 2 },
    { k: 'float', name: 'flicker', def: 0.03, min: 0, max: 0.5, group: 'Motion' },
    { k: 'float', name: 'roll', label: 'Rolling bar', def: 0.08, min: 0, max: 1, group: 'Motion' },
    { k: 'float', name: 'rollSpeed', label: 'Roll speed', def: 0.15, min: -2, max: 2, group: 'Motion' },
    { k: 'float', name: 'noise', def: 0.04, min: 0, max: 0.5, group: 'Motion' },
    { k: 'float', name: 'brightness', def: 1.4, min: 0, max: 4 },
  ],
  body: /* wgsl */`
fn crt_mask(fc: vec2f) -> vec3f {
  let mp = fc / max(u.maskSize * g.res.y, 1.0);
  var x = mp.x;
  var gap = 1.0;
  if (u.maskType == 1) {
    x += select(0.0, 1.5, (i32(floor(mp.y)) & 1) == 1);
    gap = 1.0 - u.maskStrength * smoothstep(0.3, 0.5, abs(fract(mp.y) - 0.5));
  } else if (u.maskType == 2) {
    let col = floor(mp.x / 3.0);
    let yy = fract(mp.y / 3.0 + select(0.0, 0.5, (i32(col) & 1) == 1));
    gap = 1.0 - u.maskStrength * step(0.85, yy);
  }
  let idx = i32(floor(x)) % 3;
  let on = vec3f(f32(idx == 0), f32(idx == 1), f32(idx == 2));
  let lo = 1.0 - u.maskStrength;
  return mix(vec3f(lo), vec3f(1.0), on) / ((1.0 + 2.0 * lo) / 3.0) * gap;
}
fn op(uv: vec2f) -> vec4f {
  var p = uv * 2.0 - 1.0;
  p = p * (1.0 + u.curvature * 0.3 * p.yx * p.yx);
  let q = p * 0.5 + 0.5;
  if (q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  let c = textureSampleLevel(src, smp, q, 0.0);
  let bx = vec2f(u.bleed * 0.003 * g.res.y / g.res.x, 0.0);
  var col = c.rgb + 0.6 * textureSampleLevel(src, smp, q - bx, 0.0).rgb
          + 0.35 * textureSampleLevel(src, smp, q - bx * 2.0, 0.0).rgb + 0.2 * textureSampleLevel(src, smp, q - bx * 3.0, 0.0).rgb;
  col /= 2.15;
  let l = sat(luma(col));
  let beam = 0.5 + 0.5 * cos(TAU * (fract(q.y * u.lines) - 0.5));
  col *= mix(1.0, pow(beam, mix(1.5, 0.5, l)) * 1.6, u.scanlines);
  col *= crt_mask(uv * g.res);
  col *= pow(max(16.0 * q.x * q.y * (1.0 - q.x) * (1.0 - q.y), 0.0), u.vignette * 0.5);
  col *= 1.0 + u.flicker * (hash11(g.frame * 0.618) - 0.5) * 2.0;
  let ry = fract(q.y - g.time * u.rollSpeed) - 0.5;
  col *= 1.0 + u.roll * exp(-ry * ry / 0.006);
  col = col * u.brightness + (hash33(vec3f(floor(uv * g.res), g.frame)).x - 0.5) * u.noise;
  return vec4f(max(col, vec3f(0.0)), c.a);
}`,
};

const vhs: OpDef = {
  type: 'vhs', label: 'VHS', category: 'Glitch', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }],
  help: 'Worn tape: smeared and shifted chroma (YIQ), luma noise, per-line jitter, a drifting tracking bar, head-switch tearing at the bottom and tape wobble. Intensity scales everything.',
  params: [
    { k: 'float', name: 'intensity', def: 1, min: 0, max: 2 },
    { k: 'float', name: 'speed', def: 1, min: 0, max: 4 },
    { k: 'float', name: 'chromaShift', label: 'Chroma shift', def: 0.005, min: 0, max: 0.05, step: 0.0005, group: 'Chroma' },
    { k: 'float', name: 'chromaBleed', label: 'Chroma bleed', def: 0.012, min: 0, max: 0.05, step: 0.0005, group: 'Chroma' },
    { k: 'float', name: 'noise', label: 'Luma noise', def: 0.06, min: 0, max: 0.5 },
    { k: 'float', name: 'jitter', def: 0.002, min: 0, max: 0.02, step: 0.0005 },
    { k: 'float', name: 'wobble', def: 0.003, min: 0, max: 0.03, step: 0.0005 },
    { k: 'float', name: 'tracking', def: 0.5, min: 0, max: 1 },
    { k: 'float', name: 'headSwitch', label: 'Head switch', def: 0.6, min: 0, max: 1 },
  ],
  body: /* wgsl */`${perc('vhs')}
fn vhs_yiq(c: vec3f) -> vec3f {
  return vec3f(dot(c, vec3f(0.299, 0.587, 0.114)), dot(c, vec3f(0.596, -0.274, -0.322)), dot(c, vec3f(0.211, -0.523, 0.312)));
}
fn vhs_rgb(c: vec3f) -> vec3f {
  return vec3f(c.x + 0.956 * c.y + 0.621 * c.z, c.x - 0.272 * c.y - 0.647 * c.z, c.x - 1.106 * c.y + 1.703 * c.z);
}
fn op(uv: vec2f) -> vec4f {
  let k = u.intensity;
  let t = g.time * u.speed;
  let ax = g.res.y / g.res.x;
  let line = floor(uv.y * 480.0);
  var dx = (hash21(vec2f(line, floor(t * 30.0))) - 0.5) * u.jitter * k;
  dx += (snoise(vec3f(uv.y * 2.0, t * 0.7, 0.0)) * 0.7 + sin(uv.y * 9.0 + t * 2.0) * 0.3) * u.wobble * k;
  let by = fract(t * 0.05) * 1.3 - 0.15;
  let bd = (uv.y - by) / 0.04;
  let band = exp(-bd * bd) * u.tracking * k;
  dx += band * (hash21(vec2f(line, floor(t * 60.0) + 3.0)) - 0.5) * 0.05;
  let hs = smoothstep(0.965, 1.0, uv.y) * u.headSwitch * k;
  dx += hs * (0.03 + 0.03 * hash11(line + floor(t * 30.0)));
  let p = vec2f(uv.x + dx * ax, uv.y);
  let c = textureSampleLevel(src, smp, p, 0.0);
  let y = vhs_yiq(vhs_enc(c.rgb)).x;
  var iq = vec2f(0.0);
  for (var i = 0; i < 6; i++) {
    let o = (u.chromaShift + u.chromaBleed * f32(i) / 5.0) * k * ax;
    iq += vhs_yiq(vhs_enc(textureSampleLevel(src, smp, p - vec2f(o, 0.0), 0.0).rgb)).yz;
  }
  iq /= 6.0;
  let fc = floor(uv * g.res);
  let nz = hash33(vec3f(floor(fc.x * 0.5), fc.y, g.frame));
  let ny = (nz.x - 0.5) * u.noise * k + (nz.y - 0.5) * (band + hs) * 0.8;
  return vec4f(vhs_dec(vhs_rgb(vec3f(y + ny, iq))), c.a);
}`,
};

const glitch: OpDef = {
  type: 'glitch', label: 'Block Glitch', category: 'Glitch', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }, { name: 'mask', type: 'tex', optional: true }],
  help: 'Random rectangular blocks jump sideways with an RGB split, re-rolled Rate times per second (0 = frozen; change Seed for a new layout). Optional mask (luma) scales the probability.',
  params: [
    { k: 'vec2', name: 'blockSize', label: 'Block size', def: [0.12, 0.03], min: 0.005, max: 1, step: 0.005 },
    { k: 'float', name: 'probability', def: 0.25, min: 0, max: 1 },
    { k: 'float', name: 'maxShift', label: 'Max shift', def: 0.15, min: 0, max: 1 },
    { k: 'float', name: 'rgbSplit', label: 'RGB split', def: 0.012, min: 0, max: 0.1, step: 0.001 },
    { k: 'float', name: 'rate', def: 8, min: 0, max: 60, unit: '/s' },
    { k: 'float', name: 'seed', def: 0, min: 0, max: 100, step: 1 },
  ],
  body: /* wgsl */`
fn op(uv: vec2f) -> vec4f {
  let t = floor(g.time * max(u.rate, 0.0)) + u.seed * 17.31;
  let bpx = max(u.blockSize * g.res.y, vec2f(2.0));
  let pix = uv * g.res;
  let row = floor(pix.y / bpx.y);
  let bw = bpx.x * (0.4 + 1.6 * hash21(vec2f(row, t)));
  let cell = vec2f(floor(pix.x / bw), row);
  let r = hash33(vec3f(cell, t));
  var prob = u.probability;
  if (u.has_mask > 0.5) {
    let cuv = (cell + 0.5) * vec2f(bw, bpx.y) / g.res;
    prob *= sat(luma(textureSampleLevel(mask, smp, cuv, 0.0).rgb));
  }
  if (r.x >= prob) { return textureSampleLevel(src, smp, uv, 0.0); }
  let ax = g.res.y / g.res.x;
  let sh = vec2f((r.y - 0.5) * 2.0 * ax, (r.z - 0.5) * 0.2) * u.maxShift;
  let q = vec2f(fract(uv.x + sh.x), uv.y + sh.y);
  let rs = vec2f(u.rgbSplit * (hash11(r.x * 91.7 + t) - 0.5) * 2.0 * ax, 0.0);
  let cg = textureSampleLevel(src, smp, q, 0.0);
  return vec4f(textureSampleLevel(src, smp, q + rs, 0.0).r, cg.g, textureSampleLevel(src, smp, q - rs, 0.0).b, cg.a);
}`,
};

const rgbshift: OpDef = {
  type: 'rgbshift', label: 'RGB Shift', category: 'Glitch', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }],
  help: 'Offsets R, G and B independently (fractions of height, +Y up). Angle/Amount pushes R and B apart; Jitter adds random offsets re-rolled Rate times per second.',
  params: [
    { k: 'float', name: 'angle', def: 0, min: -180, max: 180, unit: '°' },
    { k: 'float', name: 'amount', def: 0.006, min: 0, max: 0.1, step: 0.0005 },
    { k: 'vec2', name: 'offsetR', label: 'Red', def: [0, 0], min: -0.1, max: 0.1, step: 0.0005, group: 'Channels' },
    { k: 'vec2', name: 'offsetG', label: 'Green', def: [0, 0], min: -0.1, max: 0.1, step: 0.0005, group: 'Channels' },
    { k: 'vec2', name: 'offsetB', label: 'Blue', def: [0, 0], min: -0.1, max: 0.1, step: 0.0005, group: 'Channels' },
    { k: 'float', name: 'jitter', def: 0.002, min: 0, max: 0.05, step: 0.0005, group: 'Jitter' },
    { k: 'float', name: 'rate', def: 12, min: 0, max: 60, unit: '/s', group: 'Jitter' },
  ],
  body: /* wgsl */`
fn op(uv: vec2f) -> vec4f {
  let k = vec2f(g.res.y / g.res.x, -1.0);
  let a = radians(u.angle);
  let d = vec2f(cos(a), sin(a)) * u.amount;
  let ts = floor(g.time * u.rate);
  let jr = (hash22(vec2f(ts, 1.3)) - 0.5) * 2.0 * u.jitter;
  let jg = (hash22(vec2f(ts, 7.9)) - 0.5) * 2.0 * u.jitter;
  let jb = (hash22(vec2f(ts, 15.1)) - 0.5) * 2.0 * u.jitter;
  let cr = textureSampleLevel(src, smp, uv + (u.offsetR + d + jr) * k, 0.0);
  let cg = textureSampleLevel(src, smp, uv + (u.offsetG + jg) * k, 0.0);
  let cb = textureSampleLevel(src, smp, uv + (u.offsetB - d + jb) * k, 0.0);
  return vec4f(cr.r, cg.g, cb.b, max(cr.a, max(cg.a, cb.a)));
}`,
};

const scanshift: OpDef = {
  type: 'scanshift', label: 'Scanline Shift', category: 'Glitch', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }],
  help: 'Shifts horizontal bands sideways with smooth noise plus a sine wobble, with occasional large tears. Wraps horizontally.',
  params: [
    { k: 'float', name: 'bandHeight', label: 'Band height', def: 0.01, min: 0.001, max: 0.2, step: 0.001 },
    { k: 'float', name: 'amount', def: 0.02, min: 0, max: 0.5, step: 0.001 },
    { k: 'float', name: 'speed', def: 1, min: 0, max: 8 },
    { k: 'float', name: 'wobble', def: 0.004, min: 0, max: 0.1, step: 0.0005, group: 'Wobble' },
    { k: 'float', name: 'wobbleFreq', label: 'Wobble freq', def: 3, min: 0, max: 40, group: 'Wobble' },
    { k: 'float', name: 'tearProb', label: 'Tear chance', def: 0.06, min: 0, max: 1, group: 'Tears' },
    { k: 'float', name: 'tearAmount', label: 'Tear size', def: 0.2, min: 0, max: 1, group: 'Tears' },
  ],
  body: /* wgsl */`
fn op(uv: vec2f) -> vec4f {
  let t = g.time * u.speed;
  let bh = max(u.bandHeight, 1e-4);
  let band = floor(uv.y / bh);
  var dx = snoise(vec3f(band * 0.31, t, 0.0)) * u.amount;
  dx += sin(uv.y * TAU * u.wobbleFreq + t * 2.0) * u.wobble;
  let tg = floor(uv.y / (bh * 6.0));
  let ts = floor(t * 4.0);
  if (hash21(vec2f(tg, ts)) < u.tearProb) { dx += (hash21(vec2f(tg + 7.1, ts)) - 0.5) * 2.0 * u.tearAmount; }
  return textureSampleLevel(src, smpR, vec2f(uv.x + dx * g.res.y / g.res.x, uv.y), 0.0);
}`,
};

const bitcrush: OpDef = {
  type: 'bitcrush', label: 'Bit Crush', category: 'Glitch', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }],
  help: 'Quantises gamma-encoded colour to N bits per channel (HDR clips at 1), then combines it bitwise with an XOR/AND/OR coordinate pattern on the lowest Pattern bits — classic bit-plane glitch.',
  params: [
    { k: 'int', name: 'bitsR', label: 'Red bits', def: 4, min: 1, max: 8, group: 'Depth' },
    { k: 'int', name: 'bitsG', label: 'Green bits', def: 4, min: 1, max: 8, group: 'Depth' },
    { k: 'int', name: 'bitsB', label: 'Blue bits', def: 3, min: 1, max: 8, group: 'Depth' },
    { k: 'enum', name: 'pattern', options: ['XOR', 'AND', 'OR'], def: 0, group: 'Pattern' },
    { k: 'int', name: 'planes', label: 'Pattern bits', def: 5, min: 0, max: 8, group: 'Pattern' },
    { k: 'float', name: 'patternScale', label: 'Scale', def: 0.004, min: 0.0005, max: 0.05, step: 0.0005, group: 'Pattern' },
    { k: 'float', name: 'speed', def: 4, min: -60, max: 60, group: 'Pattern' },
  ],
  body: /* wgsl */`${perc('bitcrush')}
fn bitcrush_op(a: u32, b2: u32) -> u32 {
  switch (u.pattern) {
    case 1 { return a & b2; }
    case 2 { return a | b2; }
    default { return a ^ b2; }
  }
}
fn bitcrush_apply(v: u32, p: u32, m: u32) -> u32 {
  switch (u.pattern) {
    case 1 { return v & ((p | ~m) & 0xFFu); }
    case 2 { return v | (p & m); }
    default { return v ^ (p & m); }
  }
}
fn bitcrush_q(v: u32, bits: i32) -> f32 {
  let drop = u32(8 - clamp(bits, 1, 8));
  let kept = (v >> drop) << drop;
  return (f32(kept) + select(0.0, f32(1u << drop) * 0.5, drop > 0u)) / 255.0;
}
fn op(uv: vec2f) -> vec4f {
  let c = textureSampleLevel(src, smp, uv, 0.0);
  let e = clamp(bitcrush_enc(c.rgb), vec3f(0.0), vec3f(1.0));
  var v = vec3u(e * 255.0 + 0.5);
  let q = vec2u(floor(uv * g.res / max(u.patternScale * g.res.y, 1.0)));
  let off = bitcast<u32>(i32(floor(g.time * u.speed)));
  let m = 0xFFu >> u32(8 - clamp(u.planes, 0, 8));
  v.x = bitcrush_apply(v.x, bitcrush_op(q.x + off, q.y), m);
  v.y = bitcrush_apply(v.y, bitcrush_op(q.x, q.y + off), m);
  v.z = bitcrush_apply(v.z, bitcrush_op(q.x + off, q.y + off), m);
  let o = vec3f(bitcrush_q(v.x, u.bitsR), bitcrush_q(v.y, u.bitsG), bitcrush_q(v.z, u.bitsB));
  return vec4f(bitcrush_dec(o), c.a);
}`,
};

// ---------------------------------------------------------------- texture & paint

const grain: OpDef = {
  type: 'grain', label: 'Film Grain', category: 'Filter', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }],
  help: 'Film grain added in perceptual space, re-rolled every frame. Size is a fraction of height; Luma response concentrates grain in the midtones.',
  params: [
    { k: 'float', name: 'amount', def: 0.08, min: 0, max: 0.5 },
    { k: 'float', name: 'size', def: 0.0012, min: 0.0002, max: 0.01, step: 0.0001 },
    { k: 'float', name: 'response', label: 'Luma response', def: 0.7, min: 0, max: 1 },
    { k: 'bool', name: 'color', label: 'Colour', def: false },
  ],
  body: /* wgsl */`${perc('grain')}
fn grain_n(p: vec2f) -> f32 { return vnoise(p) + vnoise(p * 1.73 + 13.1) - 1.0; }
fn op(uv: vec2f) -> vec4f {
  let c = textureSampleLevel(src, smp, uv, 0.0);
  let p = uv * g.res / max(u.size * g.res.y, 0.3) + hash22(vec2f(g.frame, 3.7)) * 997.0;
  var n = vec3f(grain_n(p));
  if (u.color == 1) { n = vec3f(n.x, grain_n(p + 71.3), grain_n(p + 137.9)); }
  var e = grain_enc(c.rgb);
  let l = sat(luma(e));
  e += n * u.amount * mix(1.0, 4.0 * l * (1.0 - l), u.response);
  return vec4f(grain_dec(e), c.a);
}`,
};

const scatter: OpDef = {
  type: 'scatter', label: 'Scatter', category: 'Filter', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }],
  help: 'Frosted-glass: each pixel samples a random point within Radius (fraction of height). Speed re-rolls the pattern per second; 0 = static.',
  params: [
    { k: 'float', name: 'radius', def: 0.006, min: 0, max: 0.1, step: 0.0005 },
    { k: 'float', name: 'speed', def: 0, min: 0, max: 60, unit: '/s' },
  ],
  body: /* wgsl */`
fn op(uv: vec2f) -> vec4f {
  let s = fract(floor(g.time * u.speed) * 0.618034) * 917.0;
  let h = hash22(floor(uv * g.res) + vec2f(s, s * 1.37));
  let a = h.x * TAU;
  let o = vec2f(cos(a), sin(a)) * sqrt(h.y) * u.radius * g.res.y / g.res;
  return textureSampleLevel(src, smp, uv + o, 0.0);
}`,
};

const kuwahara: OpDef = {
  type: 'kuwahara', label: 'Kuwahara', category: 'Filter', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }],
  help: 'Painterly 4-quadrant Kuwahara: each pixel takes the mean of its least-varying quadrant (smoothly weighted). Radius is a fraction of height; large radii stride over at most 8 taps per side.',
  params: [
    { k: 'float', name: 'radius', def: 0.005, min: 0.0005, max: 0.02, step: 0.0005 },
  ],
  body: /* wgsl */`
fn op(uv: vec2f) -> vec4f {
  let c = textureSampleLevel(src, smp, uv, 0.0);
  let rpx = max(u.radius * g.res.y, 1.0);
  let n = clamp(i32(ceil(rpx)), 1, 8);
  let px = (rpx / f32(n)) / g.res;
  var m: array<vec3f, 4>; var s: array<vec3f, 4>;
  for (var j = -n; j <= n; j++) {
    for (var i = -n; i <= n; i++) {
      let v = textureSampleLevel(src, smp, uv + vec2f(f32(i), f32(j)) * px, 0.0).rgb;
      let v2 = v * v;
      if (i <= 0 && j <= 0) { m[0] += v; s[0] += v2; }
      if (i >= 0 && j <= 0) { m[1] += v; s[1] += v2; }
      if (i <= 0 && j >= 0) { m[2] += v; s[2] += v2; }
      if (i >= 0 && j >= 0) { m[3] += v; s[3] += v2; }
    }
  }
  let k = 1.0 / f32((n + 1) * (n + 1));
  var acc = vec3f(0.0); var wsum = 0.0;
  for (var q = 0; q < 4; q++) {
    let mean = m[q] * k;
    let vr = abs(s[q] * k - mean * mean);
    let w = 1.0 / (1e-8 + pow(vr.r + vr.g + vr.b, 2.0));
    acc += mean * w; wsum += w;
  }
  return vec4f(acc / wsum, c.a);
}`,
};

const ascii: OpDef = {
  type: 'ascii', label: 'Glyph Grid', category: 'Filter', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }],
  help: 'Replaces each cell with a procedural glyph whose ink density follows perceptual luma: dot, dash, plus, cross, hash, disc, block.',
  params: [
    { k: 'float', name: 'cellSize', label: 'Cell size', def: 0.02, min: 0.004, max: 0.1, step: 0.001 },
    { k: 'float', name: 'density', def: 1, min: 0.2, max: 4, help: 'Luma gain before picking a glyph.' },
    { k: 'enum', name: 'look', label: 'Colour', options: ['Source', 'Mono tint'], def: 0 },
    { k: 'color', name: 'tint', def: [0.4, 1, 0.6, 1] },
    { k: 'color', name: 'background', def: [0.01, 0.01, 0.015, 1] },
  ],
  body: /* wgsl */`
fn ascii_box(p: vec2f, b: vec2f) -> f32 {
  let d = abs(p) - b;
  return length(max(d, vec2f(0.0))) + min(max(d.x, d.y), 0.0);
}
fn ascii_glyph(f: vec2f, i: i32) -> f32 {
  switch (i) {
    case 1 { return length(f) - 0.08; }
    case 2 { return ascii_box(f, vec2f(0.26, 0.05)); }
    case 3 { return min(ascii_box(f, vec2f(0.3, 0.05)), ascii_box(f, vec2f(0.05, 0.3))); }
    case 4 { let r = rot(PI * 0.25) * f; return min(ascii_box(r, vec2f(0.36, 0.055)), ascii_box(r, vec2f(0.055, 0.36))); }
    case 5 {
      let v = min(ascii_box(f - vec2f(0.13, 0.0), vec2f(0.05, 0.36)), ascii_box(f + vec2f(0.13, 0.0), vec2f(0.05, 0.36)));
      let h = min(ascii_box(f - vec2f(0.0, 0.13), vec2f(0.36, 0.05)), ascii_box(f + vec2f(0.0, 0.13), vec2f(0.36, 0.05)));
      return min(v, h);
    }
    case 6 { return length(f) - 0.32; }
    case 7 { return ascii_box(f, vec2f(0.42)); }
    default { return 1.0; }
  }
}
fn op(uv: vec2f) -> vec4f {
  let cpx = max(u.cellSize * g.res.y, 4.0);
  let p = uv * g.res / cpx;
  let cell = floor(p);
  let f = p - cell - 0.5;
  let cuv = (cell + 0.5) * cpx / g.res;
  let o = vec2f(0.25 * cpx) / g.res;
  let c = (textureSampleLevel(src, smp, cuv + vec2f(-o.x, -o.y), 0.0) + textureSampleLevel(src, smp, cuv + vec2f(o.x, -o.y), 0.0)
         + textureSampleLevel(src, smp, cuv + vec2f(-o.x, o.y), 0.0) + textureSampleLevel(src, smp, cuv + o, 0.0)) * 0.25;
  let l = sat(pow(max(luma(c.rgb), 0.0), 1.0 / 2.2) * u.density);
  let idx = i32(floor(l * 7.999));
  let aa = 1.0 / cpx;
  let cov = 1.0 - smoothstep(-aa, aa, ascii_glyph(f, idx));
  let mx = max(c.r, max(c.g, c.b));
  var col = c.rgb / max(mx, 1e-3) * max(mx, 1.0);
  if (u.look == 1) { col = u.tint.rgb; }
  return vec4f(mix(u.background.rgb, col, cov), c.a);
}`,
};

export const ops: OpDef[] = [bloom, dirblur, radialblur, chromab, edge, sharpen, emboss, glowedge, halftone, dither,
  crt, vhs, glitch, rgbshift, scanshift, bitcrush, grain, scatter, kuwahara, ascii];
