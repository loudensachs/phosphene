// Stage operators: projection mapping (surfaces, warps, blends, alignment) and live control inputs.
import type { OpDef, ParamDef } from '../types';

/** Homography taking the unit square (source uv) onto a quad, returned inverted (output uv → source uv), row-major. */
function quadInverse(p: [number, number][]): number[] {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = p;
  const dx1 = x1 - x2, dx2 = x3 - x2, sx = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, sy = y0 - y1 + y2 - y3;
  const det = dx1 * dy2 - dy1 * dx2;
  const g = Math.abs(det) < 1e-9 ? 0 : (sx * dy2 - sy * dx2) / det;
  const h = Math.abs(det) < 1e-9 ? 0 : (dx1 * sy - dy1 * sx) / det;
  const a = x1 - x0 + g * x1, b = x3 - x0 + h * x3, c = x0;
  const d = y1 - y0 + g * y1, e = y3 - y0 + h * y3, f = y0;
  // adjugate of [[a,b,c],[d,e,f],[g,h,1]]
  return [e - f * h, c * h - b, b * f - c * e, f * g - d, a - c * g, c * d - a * f, d * h - e * g, b * g - a * h, a * e - b * d];
}

const corner = (name: string, label: string, def: [number, number]): ParamDef =>
  ({ k: 'vec2', name, label, def, min: -0.5, max: 1.5, step: 0.001, gizmo: 'uv', group: 'Corners', help: 'Drag the handle in the viewer, or type a position (0–1 across the output).' });

const surface: OpDef = {
  type: 'surface', label: 'Projection Surface', category: 'Stage', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }, { name: 'under', type: 'tex', optional: true }],
  help: 'Pins a picture onto a four-cornered surface with true perspective. Drag the corner handles in the viewer to line it up with a wall, screen or object face. Chain surfaces through Under to map many faces from one output.',
  params: [
    corner('tl', 'Top left', [0.15, 0.15]), corner('tr', 'Top right', [0.85, 0.15]),
    corner('br', 'Bottom right', [0.85, 0.85]), corner('bl', 'Bottom left', [0.15, 0.85]),
    { k: 'enum', name: 'shape', options: ['Quad', 'Ellipse', 'Triangle'], def: 0, group: 'Surface' },
    { k: 'float', name: 'feather', def: 0, min: 0, max: 0.5, step: 0.001, group: 'Surface', help: 'Soft edge, as a fraction of the surface.' },
    { k: 'float', name: 'opacity', def: 1, min: 0, max: 1, group: 'Surface' },
    { k: 'float', name: 'gain', label: 'Brightness', def: 1, min: 0, max: 4, group: 'Surface' },
    { k: 'vec2', name: 'srcScale', label: 'Source scale', def: [1, 1], min: 0.1, max: 4, group: 'Source' },
    { k: 'vec2', name: 'srcOffset', label: 'Source offset', def: [0, 0], min: -1, max: 1, group: 'Source' },
    { k: 'bool', name: 'guide', label: 'Alignment grid', def: false, group: 'Align', help: 'Overlay a grid and outline on the surface while lining up.' },
    { k: 'bool', name: 'solo', label: 'Black out rest', def: false, group: 'Align', help: 'Ignore the Under input while aligning this surface.' },
  ],
  passes: {
    main: {
      inputs: ['src', 'under'],
      fields: [['h0', 'vec3f'], ['h1', 'vec3f'], ['h2', 'vec3f'], ['shape', 'i32'], ['feather', 'f32'], ['opacity', 'f32'], ['gain', 'f32'],
        ['srcScale', 'vec2f'], ['srcOffset', 'vec2f'], ['guide', 'i32'], ['solo', 'i32']],
      body: `fn op(uv: vec2f) -> vec4f {
  var base = vec4f(0.0);
  if (u.has_under > 0.5 && u.solo == 0) { base = textureSampleLevel(under, smp, uv, 0.0); }
  let q = vec3f(dot(u.h0, vec3f(uv, 1.0)), dot(u.h1, vec3f(uv, 1.0)), dot(u.h2, vec3f(uv, 1.0)));
  let s = q.xy / select(q.z, 1e-6, abs(q.z) < 1e-6);
  // coverage with a feathered edge, per shape
  var d = min(min(s.x, 1.0 - s.x), min(s.y, 1.0 - s.y));
  if (u.shape == 1) { d = 0.5 - length(s - 0.5); }
  else if (u.shape == 2) { d = min(1.0 - s.y, (s.y - abs(s.x - 0.5) * 2.0) * 0.5); }
  // one output pixel expressed in surface units keeps the hard edge anti-aliased
  let aa = max(length(vec2f(dpdx(s.x), dpdy(s.x))), length(vec2f(dpdx(s.y), dpdy(s.y)))) + 1e-5;
  var cov = smoothstep(0.0, max(u.feather, aa), d);
  if (q.z * sign(u.h2.z + 1e-9) < 0.0) { cov = 0.0; }
  let suv = (s - 0.5) / u.srcScale + 0.5 - u.srcOffset;
  var c = textureSampleLevel(src, smp, suv, 0.0);
  if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) { c = vec4f(0.0); }
  c = vec4f(c.rgb * u.gain, c.a);
  if (u.guide == 1) {
    let gl = abs(fract(s * 8.0 + 0.5) - 0.5) / (aa * 8.0);
    let line = 1.0 - sat(min(gl.x, gl.y) - 0.5);
    let edge = 1.0 - smoothstep(0.0, aa * 3.0, d);
    let diag = 1.0 - sat(min(abs(s.x - s.y), abs(s.x + s.y - 1.0)) / aa - 0.5);
    c = vec4f(mix(c.rgb * 0.5, vec3f(1.0, 0.85, 0.2), sat(max(line * 0.6, max(edge, diag * 0.5)))), 1.0);
  }
  let a = cov * u.opacity * c.a;
  return vec4f(mix(base.rgb, c.rgb, a), max(base.a, a));
}`,
    },
  },
  cook(c) {
    const h = quadInverse([c.p.tl, c.p.tr, c.p.br, c.p.bl]);
    c.run('main', c.out, [c.ins[0], c.ins[1]], {
      h0: h.slice(0, 3), h1: h.slice(3, 6), h2: h.slice(6, 9), shape: c.p.shape, feather: c.p.feather, opacity: c.p.opacity, gain: c.p.gain,
      srcScale: c.p.srcScale, srcOffset: c.p.srcOffset, guide: c.p.guide, solo: c.p.solo,
    });
  },
};

// 3×3 control lattice: each handle is an offset from its rest position; the image bends smoothly between them.
const GRID: [string, string, [number, number]][] = [
  ['p00', 'Top left', [0, 0]], ['p10', 'Top', [0.5, 0]], ['p20', 'Top right', [1, 0]],
  ['p01', 'Left', [0, 0.5]], ['p11', 'Centre', [0.5, 0.5]], ['p21', 'Right', [1, 0.5]],
  ['p02', 'Bottom left', [0, 1]], ['p12', 'Bottom', [0.5, 1]], ['p22', 'Bottom right', [1, 1]],
];
const meshwarp: OpDef = {
  type: 'meshwarp', label: 'Mesh Warp', category: 'Stage', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }],
  help: 'Bends the picture with a 3×3 lattice of handles, for curved or uneven projection surfaces. Drag the handles in the viewer.',
  params: [
    ...GRID.map(([name, label, base]): ParamDef => ({ k: 'vec2', name, label, def: [0, 0], min: -0.5, max: 0.5, step: 0.001, gizmo: { base }, group: 'Lattice' })),
    { k: 'float', name: 'amount', def: 1, min: 0, max: 1 },
    { k: 'bool', name: 'guide', label: 'Alignment grid', def: false },
  ],
  body: `// quadratic B-spline-like weights through three control values
fn mw_w(t: f32) -> vec3f { return vec3f((1.0 - t) * (1.0 - 2.0 * t), 4.0 * t * (1.0 - t), t * (2.0 * t - 1.0)); }
fn mw_off(p: vec2f) -> vec2f {
  let wx = mw_w(clamp(p.x, 0.0, 1.0)); let wy = mw_w(clamp(p.y, 0.0, 1.0));
  return wy.x * (wx.x * u.p00 + wx.y * u.p10 + wx.z * u.p20)
       + wy.y * (wx.x * u.p01 + wx.y * u.p11 + wx.z * u.p21)
       + wy.z * (wx.x * u.p02 + wx.y * u.p12 + wx.z * u.p22);
}
fn op(uv: vec2f) -> vec4f {
  // invert the forward warp p + off(p) = uv with a few fixed-point steps
  var p = uv;
  for (var i = 0; i < 6; i++) { p = uv - mw_off(p) * u.amount; }
  if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) { return vec4f(0.0); }
  var c = textureSampleLevel(src, smp, p, 0.0);
  if (u.guide == 1) {
    let gl = abs(fract(p * 8.0 + 0.5) - 0.5) * g.res.y / 8.0;
    c = vec4f(mix(c.rgb * 0.5, vec3f(1.0, 0.85, 0.2), (1.0 - sat(min(gl.x * g.aspect, gl.y) - 0.5)) * 0.7), 1.0);
  }
  return c;
}`,
};

const edgeblend: OpDef = {
  type: 'edgeblend', label: 'Edge Blend', category: 'Stage', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }],
  help: 'Soft-edge blending for overlapping projectors: fades each chosen edge with a gamma-corrected curve so the overlap adds up to even brightness.',
  params: [
    { k: 'float', name: 'left', def: 0, min: 0, max: 0.5, step: 0.001 }, { k: 'float', name: 'right', def: 0.15, min: 0, max: 0.5, step: 0.001 },
    { k: 'float', name: 'top', def: 0, min: 0, max: 0.5, step: 0.001 }, { k: 'float', name: 'bottom', def: 0, min: 0, max: 0.5, step: 0.001 },
    { k: 'float', name: 'gamma', def: 2.2, min: 1, max: 3, help: 'Match the projector\'s response so the overlap is neither bright nor dark.' },
    { k: 'float', name: 'curve', label: 'Curve power', def: 2, min: 1, max: 4 },
    { k: 'float', name: 'blackLift', label: 'Black lift', def: 0, min: 0, max: 0.1, step: 0.001, help: 'Raises black outside the overlap to match the doubled black level inside it.' },
  ],
  body: `fn eb_ramp(x: f32, w: f32) -> f32 {
  if (w <= 0.0) { return 1.0; }
  let t = sat(x / w);
  let s = select(1.0 - 0.5 * pow(2.0 * (1.0 - t), u.curve), 0.5 * pow(2.0 * t, u.curve), t < 0.5);
  return pow(s, 1.0 / u.gamma);
}
fn op(uv: vec2f) -> vec4f {
  let c = textureSampleLevel(src, smp, uv, 0.0);
  let k = eb_ramp(uv.x, u.left) * eb_ramp(1.0 - uv.x, u.right) * eb_ramp(uv.y, u.top) * eb_ramp(1.0 - uv.y, u.bottom);
  let inside = step(u.left, uv.x) * step(u.right, 1.0 - uv.x) * step(u.top, uv.y) * step(u.bottom, 1.0 - uv.y);
  return vec4f(c.rgb * k + u.blackLift * inside, c.a);
}`,
};

const testpattern: OpDef = {
  type: 'testpattern', label: 'Test Pattern', category: 'Stage', inputs: [], output: 'tex',
  help: 'Alignment and calibration patterns for lining up projectors and LED walls.',
  params: [
    { k: 'enum', name: 'pattern', options: ['Grid + circle', 'Colour bars', 'Grey ramp', 'Checker', 'Focus', 'White', 'Crosshatch'], def: 0 },
    { k: 'int', name: 'divisions', def: 16, min: 2, max: 64 },
    { k: 'float', name: 'line', label: 'Line width', def: 0.002, min: 0.0005, max: 0.02, step: 0.0001 },
    { k: 'color', name: 'ink', label: 'Colour', def: [1, 1, 1, 1] },
    { k: 'float', name: 'level', def: 1, min: 0, max: 1 },
  ],
  body: `fn tp_line(d: f32) -> f32 { return 1.0 - smoothstep(u.line * 0.5, u.line * 0.5 + 1.0 / g.res.y, abs(d)); }
fn op(uv: vec2f) -> vec4f {
  let p = centered(uv) * 0.5;               // y spans -0.5..0.5, square units
  var v = vec3f(0.0);
  let n = f32(u.divisions);
  if (u.pattern == 0) {
    let cell = 1.0 / n;
    let gx = (fract(p.x / cell + 0.5) - 0.5) * cell; let gy = (fract(p.y / cell + 0.5) - 0.5) * cell;
    var k = max(tp_line(gx), tp_line(gy)) * 0.6;
    k = max(k, tp_line(length(p) - 0.45)); k = max(k, tp_line(length(p) - 0.225) * 0.7);
    k = max(k, max(tp_line(p.x), tp_line(p.y)));
    k = max(k, tp_line((abs(p.x) / g.aspect - abs(p.y)) * 0.7) * 0.5);
    let e = min(min(uv.x, 1.0 - uv.x) * g.aspect, min(uv.y, 1.0 - uv.y));
    k = max(k, 1.0 - smoothstep(u.line * 2.0, u.line * 2.0 + 1.0 / g.res.y, e));
    v = u.ink.rgb * k;
    let cr = step(length(abs(p) - vec2f(0.5 * g.aspect - 0.06, 0.44)), 0.03);
    v = max(v, vec3f(cr) * vec3f(1.0, 0.3, 0.2));
  } else if (u.pattern == 1) {
    let i = i32(floor(uv.x * 7.0));
    let bars = array<vec3f, 7>(vec3f(0.75), vec3f(0.75, 0.75, 0.0), vec3f(0.0, 0.75, 0.75), vec3f(0.0, 0.75, 0.0), vec3f(0.75, 0.0, 0.75), vec3f(0.75, 0.0, 0.0), vec3f(0.0, 0.0, 0.75));
    v = pow(bars[clamp(i, 0, 6)], vec3f(2.2));
    if (uv.y > 0.75) { v = vec3f(pow(floor(uv.x * n) / max(n - 1.0, 1.0), 2.2)); }
  } else if (u.pattern == 2) { v = vec3f(pow(select(uv.x, floor(uv.x * n) / max(n - 1.0, 1.0), uv.y > 0.5), 2.2)); }
  else if (u.pattern == 3) { let q = floor(vec2f(p.x, p.y) * n); v = u.ink.rgb * (q.x + q.y - 2.0 * floor((q.x + q.y) * 0.5)); }
  else if (u.pattern == 4) {
    let a = atan2(p.y, p.x); let r = length(p);
    v = u.ink.rgb * step(0.5, fract(a / TAU * n * 2.0)) * step(r, 0.45) + u.ink.rgb * step(0.5, fract(r * g.res.y * 0.25)) * step(0.45, r) * 0.5;
  } else if (u.pattern == 5) { v = u.ink.rgb; }
  else { let cell = 1.0 / n; v = u.ink.rgb * max(tp_line((fract((p.x + p.y) / cell + 0.5) - 0.5) * cell * 0.7), tp_line((fract((p.x - p.y) / cell + 0.5) - 0.5) * cell * 0.7)); }
  return vec4f(v * u.level, 1.0);
}`,
};

// ---------- live control signals ----------
const midicc: OpDef = {
  type: 'midicc', label: 'MIDI CC', category: 'Signal', inputs: [], output: 'sig',
  help: 'A knob or fader on a MIDI controller. Any expression can also read controllers directly with cc(n).',
  params: [
    { k: 'int', name: 'cc', label: 'Controller', def: 1, min: 0, max: 127 },
    { k: 'float', name: 'lo', label: 'Out low', def: 0, min: -10, max: 10 },
    { k: 'float', name: 'hi', label: 'Out high', def: 1, min: -10, max: 10 },
    { k: 'float', name: 'lag', label: 'Smoothing', def: 0.05, min: 0, max: 2, unit: 's' },
    { k: 'float', name: 'curve', def: 1, min: 0.2, max: 5 },
  ],
  sig(c) {
    const raw = Math.pow(c.midi.cc[c.p.cc & 127], c.p.curve);
    const st = c.state as { v?: number };
    if (c.reset || st.v === undefined) st.v = raw;
    st.v += (raw - st.v) * (c.p.lag > 0 && c.dt > 0 ? 1 - Math.exp(-c.dt / c.p.lag) : 1);
    return c.p.lo + (c.p.hi - c.p.lo) * st.v;
  },
};

const midinote: OpDef = {
  type: 'midinote', label: 'MIDI Note', category: 'Signal', inputs: [], output: 'sig',
  help: 'A key or pad: outputs an envelope while the note is held. Set Note to -1 to respond to any note.',
  params: [
    { k: 'int', name: 'pitch', label: 'Note', def: -1, min: -1, max: 127 },
    { k: 'bool', name: 'velocity', label: 'Use velocity', def: true },
    { k: 'float', name: 'attack', def: 0.005, min: 0, max: 2, unit: 's' },
    { k: 'float', name: 'release', def: 0.25, min: 0, max: 5, unit: 's' },
  ],
  sig(c) {
    let vel = 0;
    if (c.p.pitch >= 0) vel = c.midi.note[c.p.pitch & 127];
    else for (let i = 0; i < 128; i++) vel = Math.max(vel, c.midi.note[i]);
    const target = vel > 0 ? (c.p.velocity ? vel : 1) : 0;
    const st = c.state as { v?: number };
    if (c.reset || st.v === undefined) st.v = 0;
    const tau = target > st.v ? c.p.attack : c.p.release;
    st.v += (target - st.v) * (tau > 0 && c.dt > 0 ? 1 - Math.exp(-c.dt / tau) : 1);
    return st.v;
  },
};

const oscin: OpDef = {
  type: 'oscin', label: 'OSC In', category: 'Signal', inputs: [], output: 'sig',
  help: 'A value received over OSC (UDP port 9000) from a lighting desk, TouchOSC, Ableton or any show controller. Expressions can also read OSC directly: osc.fader.1 reads /fader/1.',
  params: [
    { k: 'string', name: 'address', def: '/fader/1', help: 'OSC address to listen to.' },
    { k: 'int', name: 'index', label: 'Argument', def: 0, min: 0, max: 15 },
    { k: 'float', name: 'lo', label: 'Out low', def: 0, min: -10, max: 10 },
    { k: 'float', name: 'hi', label: 'Out high', def: 1, min: -10, max: 10 },
    { k: 'float', name: 'lag', label: 'Smoothing', def: 0.05, min: 0, max: 2, unit: 's' },
  ],
  sig(c) {
    const raw = c.midi.oscValue(String(c.p.address).trim(), c.p.index);
    const st = c.state as { v?: number };
    if (c.reset || st.v === undefined) st.v = raw;
    st.v += (raw - st.v) * (c.p.lag > 0 && c.dt > 0 ? 1 - Math.exp(-c.dt / c.p.lag) : 1);
    return c.p.lo + (c.p.hi - c.p.lo) * st.v;
  },
};

export const ops: OpDef[] = [surface, meshwarp, edgeblend, testpattern, midicc, midinote, oscin];
