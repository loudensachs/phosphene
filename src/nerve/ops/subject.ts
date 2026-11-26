// Subject operators: pick part of the picture with any matte (depth, luma, a person matte, a drawn shape) and give
// that part echoes, trails or live duplicates. Nothing here knows about depth; it only reads a mask.
import type { OpDef } from '../types';

// ------------------------------------------------------------------------------------------------
// Range Matte: white where a map's value falls inside a band. With a depth map this isolates a slice of distance.
// ------------------------------------------------------------------------------------------------
const rangematte: OpDef = {
  type: 'rangematte', label: 'Range Matte', category: 'Filter', output: 'tex',
  inputs: [{ name: 'map', type: 'tex' }],
  help: 'Turns any map into a matte: white where its value lies between Low and High. Feed it a Depth Estimate to select the foreground (near is bright), then use the result as the mask of Subject Echo or any masked operator.',
  params: [
    { k: 'float', name: 'low', def: 0.55, min: 0, max: 1, step: 0.005, help: 'Values below this are excluded.' },
    { k: 'float', name: 'high', def: 1, min: 0, max: 1, step: 0.005, help: 'Values above this are excluded.' },
    { k: 'float', name: 'feather', def: 0.06, min: 0, max: 0.5, step: 0.005, help: 'Softness of both edges of the band.' },
    { k: 'enum', name: 'channel', options: ['Luma', 'Red', 'Green', 'Blue', 'Alpha'], def: 0 },
    { k: 'bool', name: 'invert', def: false },
    { k: 'float', name: 'grow', def: 0, min: -0.02, max: 0.02, step: 0.0005, help: 'Expand (positive) or shrink (negative) the matte, as a fraction of image height.' },
  ],
  body: /* wgsl */`
fn rangematte_v(uv: vec2f) -> f32 {
  let m = textureSampleLevel(map, smp, uv, 0.0);
  var v = luma(m.rgb);
  if (u.channel == 1) { v = m.r; } else if (u.channel == 2) { v = m.g; } else if (u.channel == 3) { v = m.b; } else if (u.channel == 4) { v = m.a; }
  let f = max(u.feather, 1e-4);
  return smoothstep(u.low - f, u.low, v) * (1.0 - smoothstep(u.high, u.high + f, v));
}
fn op(uv: vec2f) -> vec4f {
  var k = rangematte_v(uv);
  if (abs(u.grow) > 1e-5) {
    // eight taps on a ring: max grows the matte, min shrinks it
    let r = abs(u.grow) * vec2f(1.0 / g.aspect, 1.0);
    for (var i = 0; i < 8; i++) {
      let a = f32(i) * TAU / 8.0;
      let s = rangematte_v(uv + vec2f(cos(a), sin(a)) * r);
      k = select(min(k, s), max(k, s), u.grow > 0.0);
    }
  }
  if (u.invert == 1) { k = 1.0 - k; }
  return vec4f(vec3f(k), 1.0);
}`,
};

// ------------------------------------------------------------------------------------------------
// Subject Echo: the masked part of the picture leaves delayed copies, a fading trail, or live duplicates.
// ------------------------------------------------------------------------------------------------
const SE_XF = /* wgsl */`
fn se_uv(uv: vec2f, off: vec2f, zoom: f32, spin: f32) -> vec2f {
  var p = (uv - 0.5) * vec2f(g.aspect, 1.0) - off;
  p = rot(-spin) * p / max(zoom, 1e-3);
  return p / vec2f(g.aspect, 1.0) + 0.5;
}
fn se_take(t: texture_2d<f32>, uv: vec2f, hue: f32) -> vec4f {
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { return vec4f(0.0); }
  var c = textureSampleLevel(t, smp, uv, 0.0);
  if (abs(hue) > 0.5 && c.a > 1e-4) {
    var h = rgb2hsv(c.rgb / c.a);
    h.x = fract(h.x + hue / 360.0);
    c = vec4f(hsv2rgb(h) * c.a, c.a);
  }
  return c;
}`;

const echo: OpDef = {
  type: 'echo', label: 'Subject Echo', category: 'Time', output: 'tex', animated: true,
  inputs: [{ name: 'src', type: 'tex' }, { name: 'mask', type: 'tex', optional: true }],
  help: 'Gives the masked part of the picture ghosts. Echoes: copies from a few frames ago, each fainter. Trail: a continuous smear that fades. Set Delay to 0 for live duplicates that stay locked to the subject, spread out by Offset. Without a mask the whole frame is the subject. For a foreground-only effect, connect Depth Estimate → Range Matte to Mask.',
  params: [
    { k: 'enum', name: 'mode', options: ['Echoes', 'Trail'], def: 0 },
    { k: 'int', name: 'count', def: 4, min: 1, max: 8, group: 'Echoes', help: 'Number of copies.' },
    { k: 'int', name: 'delay', label: 'Delay (frames)', def: 3, min: 0, max: 30, group: 'Echoes', help: 'Frames between copies. 0 makes live duplicates of the current frame.' },
    { k: 'float', name: 'decay', def: 0.68, min: 0, max: 1, group: 'Echoes', help: 'Each copy is this much as strong as the one before.' },
    { k: 'float', name: 'persistence', def: 0.9, min: 0, max: 0.995, step: 0.005, group: 'Trail', help: 'How slowly the trail fades.' },
    { k: 'vec2', name: 'offset', def: [0, 0], min: -0.3, max: 0.3, step: 0.001, group: 'Shape', help: 'Shift of each copy from the previous one (fraction of image height). In Trail mode the trail drifts this way.' },
    { k: 'float', name: 'scale', def: 1, min: 0.8, max: 1.25, step: 0.001, group: 'Shape', help: 'Size of each copy relative to the previous one.' },
    { k: 'float', name: 'rotate', def: 0, min: -45, max: 45, unit: '°', group: 'Shape', help: 'Turn of each copy relative to the previous one.' },
    { k: 'float', name: 'hueShift', label: 'Hue step', def: 0, min: -180, max: 180, unit: '°', group: 'Look', help: 'Colour shift added per copy.' },
    { k: 'enum', name: 'blend', options: ['Normal', 'Add', 'Screen'], def: 0, group: 'Look' },
    { k: 'enum', name: 'order', options: ['Behind subject', 'In front'], def: 0, group: 'Look' },
    { k: 'float', name: 'opacity', def: 0.85, min: 0, max: 1, group: 'Look' },
  ],
  passes: {
    // the subject on its own, premultiplied by the mask
    se_cut: {
      inputs: ['src', 'mask'], fields: [['masked', 'f32']],
      body: /* wgsl */`fn op(uv: vec2f) -> vec4f {
  let c = textureSampleLevel(src, smp, uv, 0.0);
  var m = c.a;
  if (u.masked > 0.5) { let k = textureSampleLevel(mask, smp, uv, 0.0); m = sat(luma(k.rgb) * k.a) * c.a; }
  return vec4f(c.rgb * m, m);
}`,
    },
    // one layer over a base, moved and tinted
    se_blend: {
      inputs: ['base', 'layer'], fields: [['off', 'vec2f'], ['zoom', 'f32'], ['spin', 'f32'], ['alpha', 'f32'], ['hue', 'f32'], ['blend', 'i32']],
      body: /* wgsl */`${SE_XF}
fn op(uv: vec2f) -> vec4f {
  let b = textureSampleLevel(base, smp, uv, 0.0);
  let l = se_take(layer, se_uv(uv, u.off, u.zoom, u.spin), u.hue) * u.alpha;
  var rgb = b.rgb * (1.0 - l.a) + l.rgb;
  if (u.blend == 1) { rgb = b.rgb + l.rgb; }
  else if (u.blend == 2) { rgb = b.rgb + l.rgb - min(b.rgb, vec3f(1.0)) * min(l.rgb, vec3f(1.0)); }
  return vec4f(rgb, max(b.a, l.a));
}`,
    },
    // the running trail: the subject over the faded, drifted trail so far
    se_trail: {
      inputs: ['acc', 'cut'], fields: [['off', 'vec2f'], ['zoom', 'f32'], ['spin', 'f32'], ['keep', 'f32'], ['hue', 'f32']],
      body: /* wgsl */`${SE_XF}
fn op(uv: vec2f) -> vec4f {
  let now = textureSampleLevel(cut, smp, uv, 0.0);
  let old = se_take(acc, se_uv(uv, u.off, u.zoom, u.spin), u.hue) * u.keep;
  return now + old * (1.0 - now.a);
}`,
    },
  },
  cook(c) {
    const p = c.p, src = c.ins[0];
    if (!src) return;
    const st = c.state as { n?: number; head?: number; filled?: number; count?: number };
    const cut = c.tex('cut');
    c.run('se_cut', cut.view, [src, c.ins[1] ?? src], { masked: c.ins[1] ? 1 : 0 });
    const pa = c.tex('pa'), pb = c.tex('pb');
    const rad = (p.rotate * Math.PI) / 180, behind = p.order === 0;
    // layers to stack over the source, farthest first: [view, steps from the subject, strength]
    const layers: { view: GPUTextureView; k: number; alpha: number; blend: number }[] = [];
    if (p.mode === 1) {
      const acc = c.tex('acc'), tmp = c.tex('tmp');
      if (acc.fresh || c.reset) c.clear(acc.view);
      c.run('se_trail', tmp.view, [acc.view, cut.view], { off: [p.offset[0], p.offset[1]], zoom: p.scale, spin: rad, keep: p.persistence, hue: p.hueShift });
      c.copy(tmp.tex, acc.tex);
      layers.push({ view: acc.view, k: 0, alpha: p.opacity, blend: p.blend });
    } else {
      const count = Math.max(1, Math.min(8, p.count | 0)), delay = Math.max(0, p.delay | 0);
      const rw = Math.max(8, Math.ceil(c.w / 2)), rh = Math.max(8, Math.ceil(c.h / 2));
      if (c.reset || st.count !== count || st.n === undefined) { st.n = 0; st.head = 0; st.filled = 0; st.count = count; }
      for (let i = count; i >= 1; i--) {
        let view: GPUTextureView | null = null;
        if (delay === 0) view = cut.view;
        else if (i <= st.filled!) view = c.tex(`r${(st.head! - i + count * 2) % count}`, rw, rh).view;
        if (view) layers.push({ view, k: i, alpha: p.opacity * Math.pow(p.decay, i - 1), blend: p.blend });
      }
      if (delay > 0) {
        // keep a short history at half size: a new copy every `delay` frames
        if (st.n! % delay === 0) {
          const slot = c.tex(`r${st.head!}`, rw, rh);
          c.run('se_cut', slot.view, [src, c.ins[1] ?? src], { masked: c.ins[1] ? 1 : 0 }, [rw, rh]);
          st.head = (st.head! + 1) % count; st.filled = Math.min(count, st.filled! + 1);
        }
        st.n!++;
      }
    }
    if (behind) layers.push({ view: cut.view, k: 0, alpha: 1, blend: 0 });   // the subject itself goes back on top
    if (!layers.length) { c.run('se_blend', c.out, [src, cut.view], { off: [0, 0], zoom: 1, spin: 0, alpha: 0, hue: 0, blend: 0 }); return; }
    let base: GPUTextureView = src;
    layers.forEach((l, i) => {
      const last = i === layers.length - 1, target = last ? c.out : i % 2 ? pb.view : pa.view;
      const trail = p.mode === 1;
      c.run('se_blend', target, [base, l.view], {
        off: trail ? [0, 0] : [p.offset[0] * l.k, p.offset[1] * l.k], zoom: trail ? 1 : Math.pow(p.scale, l.k), spin: trail ? 0 : rad * l.k,
        alpha: l.alpha, hue: trail ? 0 : p.hueShift * l.k, blend: l.blend,
      });
      base = target;
    });
  },
};

// ------------------------------------------------------------------------------------------------
// Subject Style: lift the masked subject off its background with shadow, outline, glow, tapered edges and a
// treated background.
// ------------------------------------------------------------------------------------------------
const subjectfx: OpDef = {
  type: 'subjectfx', label: 'Subject Style', category: 'Filter', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }, { name: 'mask', type: 'tex' }],
  help: 'Separates the masked subject from what is behind it: a drop shadow, an outline, a glow around it, edges that taper away, and a dimmed, desaturated or tinted background. The mask can come from Depth Estimate → Range Matte, Person Matte, a key or any picture.',
  params: [
    { k: 'float', name: 'shadow', def: 0.6, min: 0, max: 1, group: 'Shadow', help: 'Opacity of the shadow.' },
    { k: 'vec2', name: 'shadowOffset', label: 'Offset', def: [0.02, 0.025], min: -0.2, max: 0.2, step: 0.001, group: 'Shadow' },
    { k: 'float', name: 'soft', label: 'Softness', def: 0.02, min: 0.001, max: 0.12, step: 0.001, group: 'Shadow', help: 'Blur of the shadow and reach of the glow (fraction of image height).' },
    { k: 'color', name: 'shadowColor', label: 'Colour', def: [0, 0, 0, 1], group: 'Shadow' },
    { k: 'float', name: 'glow', def: 0, min: 0, max: 4, group: 'Glow', help: 'Light spilling out around the subject.' },
    { k: 'color', name: 'glowColor', label: 'Colour', def: [1, 0.35, 0.8, 1], group: 'Glow' },
    { k: 'float', name: 'outline', def: 0, min: 0, max: 1, group: 'Outline', help: 'Opacity of a line drawn around the subject.' },
    { k: 'float', name: 'outlineWidth', label: 'Width', def: 0.004, min: 0.0005, max: 0.03, step: 0.0005, group: 'Outline' },
    { k: 'color', name: 'outlineColor', label: 'Colour', def: [1, 1, 1, 1], group: 'Outline' },
    { k: 'float', name: 'tear', label: 'Torn edge', def: 0, min: 0, max: 1, group: 'Edge', help: 'Cuts the subject out with a jagged, torn edge instead of a soft one.' },
    { k: 'float', name: 'tearScale', label: 'Tear detail', def: 1, min: 0.2, max: 4, group: 'Edge', help: 'Size of the jags.' },
    { k: 'float', name: 'paper', label: 'Paper rim', def: 0.006, min: 0, max: 0.03, step: 0.0005, group: 'Edge', help: 'Width of the torn paper border around the cut (fraction of image height).' },
    { k: 'color', name: 'paperColor', label: 'Paper', def: [0.93, 0.9, 0.82, 1], group: 'Edge' },
    { k: 'float', name: 'taper', label: 'Edge taper', def: 0, min: 0, max: 1, group: 'Subject', help: 'Fades the subject out towards its edges so it dissolves into the background.' },
    { k: 'float', name: 'lift', label: 'Subject gain', def: 1, min: 0, max: 3, group: 'Subject', help: 'Brightness of the subject itself.' },
    { k: 'float', name: 'bgDim', label: 'Dim', def: 0.25, min: 0, max: 1, group: 'Background' },
    { k: 'float', name: 'bgDesat', label: 'Desaturate', def: 0, min: 0, max: 1, group: 'Background' },
    { k: 'color', name: 'bgTint', label: 'Tint', def: [1, 1, 1, 1], group: 'Background' },
  ],
  passes: {
    sf_mask: { inputs: ['mask'], fields: [], body: /* wgsl */`fn op(uv: vec2f) -> vec4f { let k = textureSampleLevel(mask, smp, uv, 0.0); let m = sat(luma(k.rgb) * k.a); return vec4f(m, m, m, 1.0); }` },
    sf_blur: {
      inputs: ['src'], fields: [['dir', 'vec2f'], ['radius', 'f32']],
      body: /* wgsl */`fn op(uv: vec2f) -> vec4f {
  let rpx = max(u.radius * g.res.y, 0.5);
  var acc = 0.0; var ws = 0.0;
  for (var i = -10.0; i <= 10.0; i += 1.0) {
    let d = i / 10.0 * rpx * 2.0; let w = exp(-2.0 * (i / 10.0) * (i / 10.0) * 2.0);
    acc += textureSampleLevel(src, smp, uv + u.dir * d / g.res, 0.0).r * w; ws += w;
  }
  return vec4f(vec3f(acc / ws), 1.0);
}`,
    },
    sf_comp: {
      inputs: ['src', 'm', 'soft'],
      fields: [['shadow', 'f32'], ['shadowOffset', 'vec2f'], ['shadowColor', 'vec4f'], ['glow', 'f32'], ['glowColor', 'vec4f'], ['outline', 'f32'], ['outlineWidth', 'f32'], ['outlineColor', 'vec4f'],
        ['taper', 'f32'], ['lift', 'f32'], ['bgDim', 'f32'], ['bgDesat', 'f32'], ['bgTint', 'vec4f'], ['tear', 'f32'], ['tearScale', 'f32'], ['paper', 'f32'], ['paperColor', 'vec4f']],
      body: /* wgsl */`fn op(uv: vec2f) -> vec4f {
  let c = textureSampleLevel(src, smp, uv, 0.0);
  let k = textureSampleLevel(m, smp, uv, 0.0).r;
  let ks = textureSampleLevel(soft, smp, uv, 0.0).r;
  let asp = vec2f(1.0 / g.aspect, 1.0);
  // background treatment
  var bg = mix(c.rgb, vec3f(luma(c.rgb)), u.bgDesat) * u.bgTint.rgb * (1.0 - u.bgDim);
  // shadow: the soft matte, displaced
  let sh = textureSampleLevel(soft, smp, uv - u.shadowOffset * asp, 0.0).r * u.shadow;
  bg = mix(bg, u.shadowColor.rgb, sat(sh));
  // glow: soft matte outside the subject
  bg += u.glowColor.rgb * ks * u.glow;
  // outline: the matte grown by the width, minus the matte
  if (u.outline > 0.0) {
    var grown = k;
    for (var i = 0; i < 12; i++) { let a = f32(i) * TAU / 12.0; grown = max(grown, textureSampleLevel(m, smp, uv + vec2f(cos(a), sin(a)) * u.outlineWidth * asp, 0.0).r); }
    bg = mix(bg, u.outlineColor.rgb, sat(grown - k) * u.outline);
  }
  // subject, with edges tapered by how deep inside the soft matte each pixel sits
  var kt = mix(k, k * smoothstep(0.5, 0.98, ks), u.taper);
  var subj = c.rgb * u.lift;
  if (u.tear > 0.0) {
    // torn paper: the soft matte pushed by fibrous noise and cut hard, with a rougher, wider rim of paper around it
    let q = uv * vec2f(g.aspect, 1.0) * 26.0 * u.tearScale;
    let jag = fbm(vec3f(q, 0.0), 4, 2.3, 0.55) * 0.5 + 0.5 * vnoise(q * 1.7) + 0.35 * vnoise(q * 4.7) - 0.6;
    let fib = vnoise(q * vec2f(9.0, 1.3)) - 0.5;
    let edge = k * 0.55 + ks * 0.45;
    let px = 1.5 / g.res.y;
    let inner = smoothstep(0.5 - px * 20.0, 0.5 + px * 20.0, edge + jag * 0.32 * u.tear);
    let rimW = u.paper * 14.0;
    let outer = smoothstep(0.5 - px * 20.0, 0.5 + px * 20.0, edge + rimW + (jag * 0.45 + fib * 0.12) * u.tear);
    // paper under the cut, catching a little shadow at its own edge
    let paperShade = 0.82 + 0.18 * smoothstep(0.0, 0.6, outer - inner + 0.3) + fib * 0.06;
    let paperRgb = u.paperColor.rgb * paperShade;
    let shadowUnder = smoothstep(0.5 - 0.06, 0.5 + 0.06, textureSampleLevel(soft, smp, uv - vec2f(0.004, 0.006), 0.0).r + rimW + jag * 0.3 * u.tear) * 0.45 * u.tear;
    bg = bg * (1.0 - shadowUnder * (1.0 - outer));
    bg = mix(bg, paperRgb, sat(outer - inner) * u.tear);
    kt = mix(kt, inner, u.tear);
  }
  return vec4f(mix(bg, subj, kt), c.a);
}`,
    },
  },
  cook(c) {
    const p = c.p, src = c.ins[0], mk = c.ins[1];
    if (!src) return;
    const hw = Math.max(8, Math.ceil(c.w / 2)), hh = Math.max(8, Math.ceil(c.h / 2));
    const m = c.tex('m'), a = c.tex('ba', hw, hh), b = c.tex('bb', hw, hh);
    if (mk) c.run('sf_mask', m.view, [mk], {}); else c.clear(m.view);
    c.run('sf_blur', a.view, [m.view], { dir: [1, 0], radius: p.soft }, [hw, hh]);
    c.run('sf_blur', b.view, [a.view], { dir: [0, 1], radius: p.soft }, [hw, hh]);
    c.run('sf_comp', c.out, [src, m.view, b.view], {
      shadow: p.shadow, shadowOffset: p.shadowOffset, shadowColor: p.shadowColor, glow: p.glow, glowColor: p.glowColor, outline: p.outline, outlineWidth: p.outlineWidth,
      outlineColor: p.outlineColor, taper: p.taper, lift: p.lift, bgDim: p.bgDim, bgDesat: p.bgDesat, bgTint: p.bgTint, tear: p.tear, tearScale: p.tearScale, paper: p.paper, paperColor: p.paperColor,
    });
  },
};

export const ops: OpDef[] = [rangematte, echo, subjectfx];
