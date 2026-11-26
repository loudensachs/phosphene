// Fluid dynamics and the Neon Contours look.
import type { OpDef } from '../types';

// ------------------------------------------------------------------------------------------------
// Fluid: incompressible Navier–Stokes (semi-Lagrangian advection, vorticity confinement, Jacobi
// pressure projection). Velocity is in uv per second. Footage is the dye.
// ------------------------------------------------------------------------------------------------
const fluid: OpDef = {
  type: 'fluid', label: 'Fluid', category: 'Simulate', output: 'tex', animated: true,
  inputs: [{ name: 'src', type: 'tex', optional: true }, { name: 'force', type: 'field', optional: true }, { name: 'obstacle', type: 'tex', optional: true }],
  help: 'A real fluid solver. Whatever you connect to Source is poured in as dye and carried by the flow. Connect Optical Flow to Force so movement in a clip stirs the fluid; Obstacle\'s bright areas become solid walls.',
  params: [
    { k: 'enum', name: 'stir', label: 'Emitters', options: ['None', 'Twin jets', 'Orbiting', 'Turbulence', 'Fountain', 'Audio burst'], def: 1, group: 'Forces' },
    { k: 'float', name: 'power', def: 0.6, min: 0, max: 3, group: 'Forces' },
    { k: 'float', name: 'forceAmt', label: 'Force input', def: 1, min: 0, max: 8, group: 'Forces', help: 'How hard the Force field pushes.' },
    { k: 'float', name: 'buoyancy', def: 0, min: -2, max: 2, group: 'Forces', help: 'Bright dye rises (positive) or sinks.' },
    { k: 'float', name: 'swirl', label: 'Vorticity', def: 0.35, min: 0, max: 2, group: 'Forces', help: 'Re-energises small curls that numerical diffusion would smooth away.' },
    { k: 'float', name: 'speed', label: 'Time scale', def: 1, min: 0, max: 4, group: 'Solver' },
    { k: 'float', name: 'viscosity', label: 'Velocity fade', def: 0.2, min: 0, max: 4, group: 'Solver' },
    { k: 'int', name: 'iterations', label: 'Pressure quality', def: 28, min: 4, max: 80, group: 'Solver' },
    { k: 'enum', name: 'grid', label: 'Grid', options: ['Coarse', 'Medium', 'Fine'], def: 1, group: 'Solver' },
    { k: 'float', name: 'inject', label: 'Source feed', def: 0.03, min: 0, max: 1, step: 0.001, group: 'Dye', help: 'How much of the Source is poured in per frame. Low values let the fluid take over.' },
    { k: 'enum', name: 'feed', label: 'Feed mode', options: ['Mix', 'Add', 'Where bright'], def: 0, group: 'Dye' },
    { k: 'float', name: 'fade', label: 'Dye fade', def: 0.15, min: 0, max: 4, group: 'Dye' },
    { k: 'enum', name: 'view', options: ['Dye', 'Velocity', 'Pressure'], def: 0, group: 'Dye' },
    { k: 'bool', name: 'restart', def: false, group: 'Solver' },
  ],
  passes: {
    fl_adv: {
      inputs: ['vel', 'q', 'obstacle'], fields: [['dt', 'f32'], ['fade', 'f32']],
      body: `fn op(uv: vec2f) -> vec4f {
  let v = textureSampleLevel(vel, smp, uv, 0.0).rg;
  var r = textureSampleLevel(q, smp, uv - v * u.dt, 0.0) * exp(-u.fade * u.dt);
  if (u.has_obstacle > 0.5 && luma(textureSampleLevel(obstacle, smp, uv, 0.0).rgb) > 0.5) { r = vec4f(0.0, 0.0, 0.0, r.a); }
  return r;
}`,
    },
    fl_force: {
      inputs: ['vel', 'force', 'dye'], fields: [['dt', 'f32'], ['stir', 'i32'], ['power', 'f32'], ['forceAmt', 'f32'], ['buoyancy', 'f32'], ['swirl', 'f32']],
      body: `fn fl_curl(uv: vec2f) -> f32 {
  let px = 1.0 / g.res;
  return (textureSampleLevel(vel, smp, uv + vec2f(px.x, 0.0), 0.0).g - textureSampleLevel(vel, smp, uv - vec2f(px.x, 0.0), 0.0).g)
       - (textureSampleLevel(vel, smp, uv + vec2f(0.0, px.y), 0.0).r - textureSampleLevel(vel, smp, uv - vec2f(0.0, px.y), 0.0).r);
}
fn fl_jet(p: vec2f, at: vec2f, dir: vec2f, r: f32) -> vec2f { return dir * exp(-dot(p - at, p - at) / (r * r)); }
fn op(uv: vec2f) -> vec4f {
  let px = 1.0 / g.res;
  var v = textureSampleLevel(vel, smp, uv, 0.0).rg;
  let p = centered(uv);
  var f = vec2f(0.0);
  let t = g.time;
  if (u.stir == 1) { f = fl_jet(p, vec2f(-g.aspect * 0.8, 0.25 * sin(t * 0.7)), vec2f(1.0, 0.2 * sin(t * 1.3)), 0.12) + fl_jet(p, vec2f(g.aspect * 0.8, -0.25 * sin(t * 0.9)), vec2f(-1.0, 0.2 * cos(t * 1.1)), 0.12); }
  else if (u.stir == 2) { for (var i = 0; i < 3; i++) { let a = t * 0.8 + f32(i) * TAU / 3.0; let at = vec2f(cos(a), sin(a)) * 0.55; f += fl_jet(p, at, vec2f(-sin(a), cos(a)) * 0.8 - at * 0.6, 0.1); } }
  else if (u.stir == 3) { let n = vec3f(p * 2.5, t * 0.35); let e = 0.02; f = vec2f(snoise(n + vec3f(0.0, e, 0.0)) - snoise(n - vec3f(0.0, e, 0.0)), -(snoise(n + vec3f(e, 0.0, 0.0)) - snoise(n - vec3f(e, 0.0, 0.0)))) / (2.0 * e) * 0.25; }
  else if (u.stir == 4) { f = fl_jet(p, vec2f(0.3 * sin(t * 0.5), 0.9), vec2f(0.25 * sin(t * 2.1), -1.2), 0.1); }
  else if (u.stir == 5) { let a = hash11(floor(g.beat)) * TAU; f = normalize(p + 1e-4) * exp(-dot(p, p) * 6.0) * g.audio2.x * 3.0 + vec2f(cos(a), sin(a)) * exp(-dot(p, p) * 3.0) * g.audio.x; }
  // centred coords are y-down like uv; convert to uv-per-second
  v += f * u.power * u.dt * vec2f(1.0 / g.aspect, 1.0) * 1.5;
  if (u.has_force > 0.5) { v += textureSampleLevel(force, smp, uv, 0.0).rg / 40.0 * u.forceAmt * 60.0 * u.dt * 8.0; }
  if (u.buoyancy != 0.0) { v.y -= luma(textureSampleLevel(dye, smp, uv, 0.0).rgb) * u.buoyancy * u.dt * 0.5; }
  if (u.swirl > 0.0) {
    let c = fl_curl(uv);
    let gr = vec2f(abs(fl_curl(uv + vec2f(px.x, 0.0))) - abs(fl_curl(uv - vec2f(px.x, 0.0))), abs(fl_curl(uv + vec2f(0.0, px.y))) - abs(fl_curl(uv - vec2f(0.0, px.y))));
    let nrm = gr / (length(gr) + 1e-5);
    v += vec2f(nrm.y, -nrm.x) * c * u.swirl * u.dt * 0.6;
  }
  return vec4f(v, 0.0, 1.0);
}`,
    },
    fl_div: {
      inputs: ['vel'],
      body: `fn op(uv: vec2f) -> vec4f {
  let px = 1.0 / g.res;
  // reflect velocity at the frame edge so the fluid stays in the box
  var l = textureSampleLevel(vel, smp, uv - vec2f(px.x, 0.0), 0.0).r; var r = textureSampleLevel(vel, smp, uv + vec2f(px.x, 0.0), 0.0).r;
  var t = textureSampleLevel(vel, smp, uv - vec2f(0.0, px.y), 0.0).g; var b = textureSampleLevel(vel, smp, uv + vec2f(0.0, px.y), 0.0).g;
  let c = textureSampleLevel(vel, smp, uv, 0.0).rg;
  if (uv.x - px.x < 0.0) { l = -c.x; } if (uv.x + px.x > 1.0) { r = -c.x; }
  if (uv.y - px.y < 0.0) { t = -c.y; } if (uv.y + px.y > 1.0) { b = -c.y; }
  return vec4f(0.5 * ((r - l) * g.res.x + (b - t) * g.res.y) / g.res.y, 0.0, 0.0, 1.0);
}`,
    },
    fl_jac: {
      inputs: ['prs', 'dv'],
      body: `fn op(uv: vec2f) -> vec4f {
  let px = 1.0 / g.res;
  let l = textureSampleLevel(prs, smp, uv - vec2f(px.x, 0.0), 0.0).r; let r = textureSampleLevel(prs, smp, uv + vec2f(px.x, 0.0), 0.0).r;
  let t = textureSampleLevel(prs, smp, uv - vec2f(0.0, px.y), 0.0).r; let b = textureSampleLevel(prs, smp, uv + vec2f(0.0, px.y), 0.0).r;
  return vec4f((l + r + t + b - textureSampleLevel(dv, smp, uv, 0.0).r) * 0.25, 0.0, 0.0, 1.0);
}`,
    },
    fl_grad: {
      inputs: ['prs', 'vel', 'obstacle'],
      body: `fn op(uv: vec2f) -> vec4f {
  let px = 1.0 / g.res;
  let l = textureSampleLevel(prs, smp, uv - vec2f(px.x, 0.0), 0.0).r; let r = textureSampleLevel(prs, smp, uv + vec2f(px.x, 0.0), 0.0).r;
  let t = textureSampleLevel(prs, smp, uv - vec2f(0.0, px.y), 0.0).r; let b = textureSampleLevel(prs, smp, uv + vec2f(0.0, px.y), 0.0).r;
  var v = textureSampleLevel(vel, smp, uv, 0.0).rg - 0.5 * vec2f((r - l) / g.aspect, b - t);
  if (u.has_obstacle > 0.5 && luma(textureSampleLevel(obstacle, smp, uv, 0.0).rgb) > 0.5) { v = vec2f(0.0); }
  return vec4f(clamp(v, vec2f(-4.0), vec2f(4.0)), 0.0, 1.0);
}`,
    },
    fl_feed: {
      inputs: ['dye', 'src'], fields: [['inject', 'f32'], ['feed', 'i32']],
      body: `fn op(uv: vec2f) -> vec4f {
  let d = textureSampleLevel(dye, smp, uv, 0.0);
  if (u.has_src < 0.5) {
    // no source: seed with slowly cycling colour at the emitters so there is something to see
    let p = centered(uv);
    let k = exp(-dot(p, p) * 2.0) * 0.02 * u.inject * 30.0;
    return d + vec4f(palette(g.time * 0.07 + length(p), vec3f(0.5), vec3f(0.5), vec3f(1.0), vec3f(0.0, 0.33, 0.67)) * k, k);
  }
  let s = textureSampleLevel(src, smp, uv, 0.0);
  if (u.feed == 1) { return d + s * u.inject; }
  if (u.feed == 2) { return mix(d, s, sat(u.inject * 8.0 * smoothstep(0.2, 0.8, luma(s.rgb)))); }
  return mix(d, s, u.inject);
}`,
    },
    fl_view: {
      inputs: ['dye', 'vel', 'prs'], fields: [['view', 'i32']],
      body: `fn op(uv: vec2f) -> vec4f {
  if (u.view == 1) { let v = textureSampleLevel(vel, smp, uv, 0.0).rg; return vec4f(hsv2rgb(vec3f(atan2(v.y, v.x) / TAU + 0.5, 0.9, sat(length(v) * 3.0))), 1.0); }
  if (u.view == 2) { let p = textureSampleLevel(prs, smp, uv, 0.0).r * 40.0; return vec4f(max(p, 0.0), abs(p) * 0.2, max(-p, 0.0), 1.0); }
  let d = textureSampleLevel(dye, smp, uv, 0.0);
  return vec4f(d.rgb, sat(d.a));
}`,
    },
  },
  cook(c) {
    const gh = [180, 288, 432][c.p.grid] ?? 288, gw = Math.round(gh * (c.w / c.h));
    const res: [number, number] = [gw, gh];
    let v0 = c.tex('v0', gw, gh), v1 = c.tex('v1', gw, gh);
    let p0 = c.tex('p0', gw, gh), p1 = c.tex('p1', gw, gh);
    const dv = c.tex('dv', gw, gh);
    let d0 = c.tex('d0'), d1 = c.tex('d1');
    const st = c.state as { flip?: boolean };
    if (c.reset || c.p.restart || v0.fresh || d0.fresh) { for (const t of [v0, v1, p0, p1, d0, d1]) c.clear(t.view); st.flip = false; }
    // persistent results always live in the "0" textures after a step
    const dt = Math.min(1 / 24, c.dt) * c.p.speed;
    const obs = c.ins[2];
    if (dt > 0) {
      c.run('fl_adv', v1.view, [v0.view, v0.view, obs], { dt, fade: c.p.viscosity }, res);
      c.run('fl_force', v0.view, [v1.view, c.ins[1], d0.view], { dt, stir: c.p.stir, power: c.p.power, forceAmt: c.p.forceAmt, buoyancy: c.p.buoyancy, swirl: c.p.swirl }, res);
      c.run('fl_div', dv.view, [v0.view], {}, res);
      const n = Math.max(2, c.p.iterations & ~1);
      for (let i = 0; i < n; i++) { c.run('fl_jac', p1.view, [p0.view, dv.view], {}, res); [p0, p1] = [p1, p0]; }
      c.run('fl_grad', v1.view, [p0.view, v0.view, obs], {}, res);
      c.copy(v1.tex, v0.tex);
      c.run('fl_adv', d1.view, [v0.view, d0.view, obs], { dt, fade: c.p.fade });
      c.run('fl_feed', d0.view, [d1.view, c.ins[0]], { inject: c.p.inject, feed: c.p.feed });
    }
    c.run('fl_view', c.out, [d0.view, v0.view, p0.view], { view: c.p.view });
  },
};

// ------------------------------------------------------------------------------------------------
// Neon Contours: brightness iso-lines and edges traced as glowing wire over the footage, with melt.
// ------------------------------------------------------------------------------------------------
const neon: OpDef = {
  type: 'neon', label: 'Neon Contours', category: 'Filter', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }],
  help: 'Traces the picture\'s brightness contours and edges as glowing neon wire in the footage\'s own colours, with optional downward melt. The look of hand-rotoscoped light outlines, generated live.',
  params: [
    { k: 'float', name: 'levels', label: 'Contour levels', def: 7, min: 1, max: 32, group: 'Lines' },
    { k: 'float', name: 'width', label: 'Line width', def: 0.0016, min: 0.0004, max: 0.01, step: 0.0001, group: 'Lines' },
    { k: 'float', name: 'edges', label: 'Edge lines', def: 0.25, min: 0, max: 2, group: 'Lines', help: 'Adds outlines where the picture changes sharply.' },
    { k: 'float', name: 'detail', def: 0.004, min: 0.001, max: 0.03, step: 0.0005, group: 'Lines', help: 'Smoothing before tracing. Higher gives fewer, bolder contours.' },
    { k: 'float', name: 'drift', label: 'Contour drift', def: 0.15, min: 0, max: 2, group: 'Lines', help: 'Speed at which the contour levels crawl through the image.' },
    { k: 'float', name: 'melt', def: 0.05, min: 0, max: 0.5, step: 0.001, group: 'Melt', help: 'Lines drip downward in vertical strands.' },
    { k: 'float', name: 'meltScale', label: 'Strand width', def: 90, min: 8, max: 400, group: 'Melt' },
    { k: 'float', name: 'meltSpeed', label: 'Melt speed', def: 0.3, min: 0, max: 4, group: 'Melt' },
    { k: 'float', name: 'glow', def: 0.8, min: 0, max: 6, group: 'Light' },
    { k: 'float', name: 'radius', label: 'Glow radius', def: 0.03, min: 0.002, max: 0.2, step: 0.001, group: 'Light' },
    { k: 'float', name: 'core', label: 'White core', def: 0.6, min: 0, max: 1, group: 'Light' },
    { k: 'float', name: 'saturation', def: 1.6, min: 0, max: 4, group: 'Light' },
    { k: 'float', name: 'hue', label: 'Hue shift', def: 0, min: -180, max: 180, unit: '°', group: 'Light' },
    { k: 'color', name: 'tint', def: [1, 1, 1, 1], group: 'Light' },
    { k: 'float', name: 'under', label: 'Footage level', def: 0.45, min: 0, max: 1.5, group: 'Light', help: 'How much of the original picture shows beneath the lines.' },
  ],
  passes: {
    nc_lines: {
      inputs: ['src'],
      fields: [['levels', 'f32'], ['width', 'f32'], ['edges', 'f32'], ['detail', 'f32'], ['drift', 'f32'], ['melt', 'f32'], ['meltScale', 'f32'], ['meltSpeed', 'f32'],
        ['core', 'f32'], ['saturation', 'f32'], ['hue', 'f32'], ['tint', 'vec4f']],
      body: `fn nc_l(uv: vec2f) -> f32 {
  // 5-tap smoothed perceptual luma
  let r = vec2f(u.detail / g.aspect, u.detail);
  var s = textureSampleLevel(src, smp, uv, 0.0).rgb * 2.0;
  s += textureSampleLevel(src, smp, uv + vec2f(r.x, 0.0), 0.0).rgb + textureSampleLevel(src, smp, uv - vec2f(r.x, 0.0), 0.0).rgb;
  s += textureSampleLevel(src, smp, uv + vec2f(0.0, r.y), 0.0).rgb + textureSampleLevel(src, smp, uv - vec2f(0.0, r.y), 0.0).rgb;
  return sqrt(max(luma(s / 6.0), 0.0));
}
fn op(uv: vec2f) -> vec4f {
  // strands: each column slides down by its own amount, more where the picture is bright above it
  let col = floor(uv.x * u.meltScale);
  let n = vnoise(vec2f(col * 0.37, g.time * u.meltSpeed)) * 0.7 + hash11(col) * 0.3;
  let drip = u.melt * n * n * smoothstep(0.0, 0.6, sqrt(max(luma(textureSampleLevel(src, smp, vec2f(uv.x, uv.y - u.melt * 0.5), 0.0).rgb), 0.0)));
  let q = vec2f(uv.x, uv.y - drip);
  let e = vec2f(1.0 / g.res.y / g.aspect, 1.0 / g.res.y) * 1.5;
  let l = nc_l(q);
  let gx = (nc_l(q + vec2f(e.x, 0.0)) - nc_l(q - vec2f(e.x, 0.0))) / (2.0 * e.x * g.aspect);
  let gy = (nc_l(q + vec2f(0.0, e.y)) - nc_l(q - vec2f(0.0, e.y))) / (2.0 * e.y);
  let gm = length(vec2f(gx, gy));                      // luma change per unit of image height
  // distance to the nearest iso-level, converted to image-height units so lines keep constant width
  let v = l * u.levels + g.time * u.drift;
  let dist = abs(fract(v + 0.5) - 0.5) / max(gm * u.levels, 1e-3);
  let aa = 1.0 / g.res.y;
  var line = (1.0 - smoothstep(u.width * 0.5, u.width * 0.5 + aa, dist)) * smoothstep(0.02, 0.15, gm * u.detail * 20.0);
  // where levels crowd closer than a few line widths (texture, noise, hard edges) they would fuse into a solid: thin them out
  line *= smoothstep(2.5, 7.0, 1.0 / (max(gm * u.levels, 1e-3) * u.width));
  line = max(line, sat((gm * u.detail * 6.0 - 0.35) * u.edges));
  var c = textureSampleLevel(src, smp, q, 0.0).rgb;
  var h = rgb2hsv(c / max(max(c.r, max(c.g, c.b)), 1e-4));
  h = vec3f(fract(h.x + u.hue / 360.0), sat(h.y * u.saturation), 1.0);
  let colour = mix(hsv2rgb(h), vec3f(1.0), u.core * line * line) * u.tint.rgb;
  return vec4f(colour * line * (0.7 + l), line);
}`,
    },
    nc_blur: {
      inputs: ['src'], fields: [['dir', 'vec2f'], ['radius', 'f32']],
      body: `fn op(uv: vec2f) -> vec4f {
  let rpx = u.radius * g.res.y;
  let stride = max(1.0, rpx / 12.0);
  var acc = vec4f(0.0); var ws = 0.0;
  for (var i = -12.0; i <= 12.0; i += 1.0) {
    let d = i * stride; let w = exp(-0.5 * d * d / max(rpx * rpx * 0.25, 1e-4));
    acc += textureSampleLevel(src, smp, uv + u.dir * d / g.res, 0.0) * w; ws += w;
  }
  return acc / ws;
}`,
    },
    nc_comp: {
      inputs: ['src', 'lines', 'glowS', 'glowL'], fields: [['glow', 'f32'], ['under', 'f32']],
      body: `fn op(uv: vec2f) -> vec4f {
  let s = textureSampleLevel(src, smp, uv, 0.0);
  let l = textureSampleLevel(lines, smp, uv, 0.0);
  let gl = textureSampleLevel(glowS, smp, uv, 0.0).rgb * 0.9 + textureSampleLevel(glowL, smp, uv, 0.0).rgb * 1.6;
  return vec4f(s.rgb * u.under + l.rgb * 1.2 + gl * u.glow, s.a);
}`,
    },
  },
  cook(c) {
    const lines = c.tex('lines');
    c.run('nc_lines', lines.view, [c.ins[0]], {
      levels: c.p.levels, width: c.p.width, edges: c.p.edges, detail: c.p.detail, drift: c.p.drift, melt: c.p.melt, meltScale: c.p.meltScale, meltSpeed: c.p.meltSpeed,
      core: c.p.core, saturation: c.p.saturation, hue: c.p.hue, tint: c.p.tint,
    });
    // two glow scales at reduced resolution: a tight halo and a wide bloom
    const hw = c.w / 2, hh = c.h / 2, qw = c.w / 4, qh = c.h / 4;
    const a = c.tex('a', hw, hh), b = c.tex('b', hw, hh), d = c.tex('d', qw, qh), e = c.tex('e', qw, qh);
    c.run('nc_blur', a.view, [lines.view], { dir: [1, 0], radius: c.p.radius * 0.35 }, [a.tex.width, a.tex.height]);
    c.run('nc_blur', b.view, [a.view], { dir: [0, 1], radius: c.p.radius * 0.35 }, [a.tex.width, a.tex.height]);
    c.run('nc_blur', d.view, [b.view], { dir: [1, 0], radius: c.p.radius * 1.6 }, [d.tex.width, d.tex.height]);
    c.run('nc_blur', e.view, [d.view], { dir: [0, 1], radius: c.p.radius * 1.6 }, [d.tex.width, d.tex.height]);
    c.run('nc_comp', c.out, [c.ins[0], lines.view, b.view, e.view], { glow: c.p.glow, under: c.p.under });
  },
};

export const ops: OpDef[] = [fluid, neon];
