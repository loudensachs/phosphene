// Graphics: type set with the app's bundled faces, drawn on the CPU once per change and composited on the GPU.
import type { OpDef } from '../types';

const FACES = ['Instrument Serif', 'Instrument Sans', 'Michroma', 'Fragment Mono', 'Bodoni Moda'];
const STYLES = ['Regular', 'Italic', 'Bold', 'Black'];

interface TextState { cv?: HTMLCanvasElement; key?: string; loading?: boolean }

const text: OpDef = {
  type: 'text', label: 'Text', category: 'Generate', output: 'tex',
  inputs: [{ name: 'src', type: 'tex', optional: true }],
  help: 'Sets a line of type in one of the bundled typefaces. Connect a picture to draw over it, or leave it empty for text on transparent. Reveal types the line on letter by letter; drive it with a keyframe or expression.',
  params: [
    { k: 'string', name: 'content', label: 'Text', def: 'MONSTER' },
    { k: 'enum', name: 'face', label: 'Typeface', options: FACES, def: 0 },
    { k: 'enum', name: 'style', options: STYLES, def: 1 },
    { k: 'float', name: 'size', def: 0.16, min: 0.01, max: 1, step: 0.001, help: 'Cap height as a fraction of image height.' },
    { k: 'vec2', name: 'stretch', def: [1, 1], min: 0.2, max: 4, step: 0.01, help: 'Horizontal and vertical stretch of the letters.' },
    { k: 'bool', name: 'upper', label: 'Capitals', def: false },
    { k: 'float', name: 'tracking', def: 0, min: -0.1, max: 1, step: 0.005, help: 'Extra space between letters, as a fraction of the size.' },
    { k: 'vec2', name: 'pos', label: 'Position', def: [0.5, 0.5], min: 0, max: 1, step: 0.001, gizmo: 'uv', help: 'Anchor point in the frame (0..1, top-left origin).' },
    { k: 'enum', name: 'align', options: ['Left', 'Centre', 'Right'], def: 1 },
    { k: 'color', name: 'color', label: 'Colour', def: [1, 1, 1, 1] },
    { k: 'float', name: 'opacity', def: 1, min: 0, max: 1 },
    { k: 'float', name: 'reveal', def: 1, min: 0, max: 1, help: 'Share of the letters shown, left to right.' },
    { k: 'enum', name: 'blend', options: ['Over', 'Add', 'Difference'], def: 0, group: 'Composite' },
    { k: 'float', name: 'shadow', def: 0, min: 0, max: 1, group: 'Composite', help: 'Soft dark halo behind the letters for legibility.' },
  ],
  passes: {
    tx_comp: {
      inputs: ['src', 'glyphs'], fields: [['color', 'vec4f'], ['opacity', 'f32'], ['blend', 'i32'], ['shadow', 'f32']],
      body: /* wgsl */`fn op(uv: vec2f) -> vec4f {
  let b = textureSampleLevel(src, smp, uv, 0.0);
  let a = textureSampleLevel(glyphs, smp, uv, 0.0).a * u.opacity;
  var rgb = b.rgb;
  if (u.shadow > 0.0) {
    var s = 0.0;
    let r = vec2f(0.006 / g.aspect, 0.006);
    for (var i = 0; i < 8; i++) { let t = f32(i) * TAU / 8.0; s += textureSampleLevel(glyphs, smp, uv + vec2f(cos(t), sin(t)) * r, 0.0).a; }
    rgb *= 1.0 - sat(s / 8.0 * u.shadow * u.opacity);
  }
  let ink = u.color.rgb;
  if (u.blend == 1) { rgb = rgb + ink * a; }
  else if (u.blend == 2) { rgb = mix(rgb, abs(ink - rgb), a); }
  else { rgb = mix(rgb, ink, a); }
  return vec4f(rgb, max(b.a, a));
}`,
    },
  },
  cook(c) {
    const p = c.p, st = c.state as TextState, w = c.w, h = c.h;
    const face = FACES[p.face] ?? FACES[0], style = p.style;
    const px = Math.max(4, p.size * h * 1.42);   // cap height → font size, roughly, for these faces
    const font = `${style === 1 ? 'italic ' : ''}${style === 3 ? '900 ' : style === 2 ? '700 ' : '400 '}${px.toFixed(1)}px "${face}"`;
    const content = p.upper ? String(p.content ?? '').toUpperCase() : String(p.content ?? '');
    const shown = Array.from(content).slice(0, Math.round(Array.from(content).length * Math.min(1, Math.max(0, p.reveal)))).join('');
    const key = [w, h, font, shown, p.tracking, p.pos[0], p.pos[1], p.align, p.stretch[0], p.stretch[1]].join('|');
    const glyphs = c.tex('glyphs');
    if (st.key !== key || glyphs.fresh) {
      if (!document.fonts.check(font)) {
        // draw with the fallback this frame, and again once the face has arrived
        if (!st.loading) { st.loading = true; void document.fonts.load(font).then(() => { st.loading = false; st.key = undefined; }); }
      }
      const cv = (st.cv ??= document.createElement('canvas'));
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      const g2 = cv.getContext('2d')!;
      g2.clearRect(0, 0, w, h);
      g2.font = font; g2.fillStyle = '#fff'; g2.textBaseline = 'middle';
      (g2 as any).letterSpacing = `${(p.tracking * px).toFixed(2)}px`;
      g2.textAlign = (['left', 'center', 'right'] as const)[p.align] ?? 'center';
      g2.save(); g2.translate(p.pos[0] * w, p.pos[1] * h); g2.scale(p.stretch[0], p.stretch[1]);
      g2.fillText(shown, 0, 0); g2.restore();
      c.gpu.device.queue.copyExternalImageToTexture({ source: cv }, { texture: glyphs.tex }, [w, h]);
      st.key = document.fonts.check(font) ? key : undefined;
    }
    c.run('tx_comp', c.out, [c.ins[0] ?? glyphs.view, glyphs.view], { color: p.color, opacity: p.opacity, blend: p.blend, shadow: p.shadow });
  },
};

// ------------------------------------------------------------------------------------------------
// Panels: two or three pictures in one frame — split screen, three strips, or picture in picture.
// ------------------------------------------------------------------------------------------------
const panels: OpDef = {
  type: 'panels', label: 'Panels', category: 'Composite', output: 'tex',
  inputs: [{ name: 'a', type: 'tex' }, { name: 'b', type: 'tex' }, { name: 'c', type: 'tex', optional: true }],
  help: 'Lays pictures side by side: a split screen, three strips, or a small window over the main picture. Each panel shows the centre of its picture. Open slides the panels in; drive it with a keyframe for animated layouts.',
  params: [
    { k: 'enum', name: 'arrangement', label: 'Layout', options: ['Split left/right', 'Split top/bottom', 'Three strips', 'Picture in picture'], def: 0 },
    { k: 'float', name: 'split', def: 0.5, min: 0.1, max: 0.9, help: 'Where the frame divides (split layouts).' },
    { k: 'float', name: 'open', def: 1, min: 0, max: 1, help: '0 shows only A; 1 shows the full layout. Panels slide in between.' },
    { k: 'float', name: 'gap', label: 'Border', def: 0.004, min: 0, max: 0.05, step: 0.0005, help: 'Line between panels, fraction of image height.' },
    { k: 'color', name: 'gapColor', label: 'Border colour', def: [0.02, 0.02, 0.02, 1] },
    { k: 'vec2', name: 'pipPos', label: 'Window position', def: [0.74, 0.28], min: 0, max: 1, step: 0.001, gizmo: 'uv', group: 'Picture in picture' },
    { k: 'float', name: 'pipSize', label: 'Window size', def: 0.34, min: 0.05, max: 0.9, group: 'Picture in picture', help: 'Width of the window as a fraction of the frame width.' },
    { k: 'float', name: 'zoom', label: 'Panel zoom', def: 1, min: 0.5, max: 2, help: 'Scales the picture inside every panel.' },
  ],
  body: /* wgsl */`
fn panels_take(t: texture_2d<f32>, q: vec2f) -> vec4f {
  let z = (q - 0.5) / max(u.zoom, 0.05) + 0.5;
  return textureSampleLevel(t, smp, clamp(z, vec2f(0.0), vec2f(1.0)), 0.0);
}
fn op(uv: vec2f) -> vec4f {
  let o = sat(u.open);
  let gx = u.gap / g.aspect;
  let gy = u.gap;
  let bc = vec4f(u.gapColor.rgb, 1.0);
  if (u.arrangement == 0) {
    // B's panel slides in from the right edge
    let s = mix(1.0 + gx, u.split, o);
    if (uv.x < s - gx * 0.5) { return panels_take(a, vec2f(uv.x - s * 0.5 + 0.5, uv.y)); }
    if (uv.x < s + gx * 0.5) { return bc; }
    return panels_take(b, vec2f(uv.x - (s + 1.0) * 0.5 + 0.5, uv.y));
  }
  if (u.arrangement == 1) {
    let s = mix(1.0 + gy, u.split, o);
    if (uv.y < s - gy * 0.5) { return panels_take(a, vec2f(uv.x, uv.y - s * 0.5 + 0.5)); }
    if (uv.y < s + gy * 0.5) { return bc; }
    return panels_take(b, vec2f(uv.x, uv.y - (s + 1.0) * 0.5 + 0.5));
  }
  if (u.arrangement == 2) {
    let i = clamp(floor(uv.x * 3.0), 0.0, 2.0);
    let local = uv.x * 3.0 - i;
    if (local < gx * 1.5 && i > 0.0) { return bc; }
    // strips drop in one after another
    let oi = sat(o * 3.0 - i);
    let q = vec2f((i + 0.5) / 3.0 + (local - 0.5) / 3.0 - (i + 0.5) / 3.0 + 0.5, uv.y + (1.0 - oi) * (1.0 - oi) * 1.05);
    if (q.y > 1.0) { return panels_take(a, uv); }
    if (i < 0.5) { return panels_take(a, q); }
    if (i < 1.5) { return panels_take(b, q); }
    if (u.has_c > 0.5) { return panels_take(c, q); }
    return panels_take(a, q);
  }
  // picture in picture: B in a window that grows from its centre
  let base = panels_take(a, uv);
  let ws = vec2f(u.pipSize, u.pipSize) * o;
  let d = abs(uv - u.pipPos) - ws * 0.5;
  if (max(d.x, d.y) > max(gx, gy)) { return base; }
  if (d.x > 0.0 || d.y > 0.0) { return bc; }
  let q = (uv - u.pipPos) / max(ws, vec2f(1e-4)) + 0.5;
  return panels_take(b, q);
}`,
};

// ------------------------------------------------------------------------------------------------
// UV Map and Project: an image looked up through a coordinate map. Track a UV Map with Datamosh (motion from the
// scene) and the projected picture stays glued to the scene's surfaces, crisp, instead of being smeared.
// ------------------------------------------------------------------------------------------------
const uvmap: OpDef = {
  type: 'uvmap', label: 'UV Map', category: 'Generate', output: 'tex', inputs: [{ name: 'depth', type: 'tex', optional: true }],
  help: 'Writes each pixel\'s own position into red and green. Carry it with Datamosh (refresh 0, motion from your shot) to get coordinates that move with the scene, then use Project to map another picture through them. A depth map adds parallax: near surfaces shift more.',
  params: [
    { k: 'float', name: 'parallax', def: 0.06, min: 0, max: 0.3, help: 'How far near surfaces are offset from far ones.' },
    { k: 'vec2', name: 'look', label: 'View offset', def: [0.4, 0.15], min: -1, max: 1, step: 0.01, help: 'Direction of the parallax offset.' },
    { k: 'float', name: 'scale', def: 1, min: 0.2, max: 4, help: 'Size of the projected picture: above 1 tiles it smaller.' },
  ],
  body: /* wgsl */`fn op(uv: vec2f) -> vec4f {
  var q = (uv - 0.5) * u.scale + 0.5;
  if (u.has_depth > 0.5) { let d = luma(textureSampleLevel(depth, smp, uv, 0.0).rgb); q += u.look * (d - 0.5) * u.parallax; }
  return vec4f(q, 0.0, 1.0);
}`,
};

const project: OpDef = {
  type: 'project', label: 'Project', category: 'Composite', output: 'tex',
  inputs: [{ name: 'src', type: 'tex' }, { name: 'map', type: 'tex' }, { name: 'scene', type: 'tex', optional: true }],
  help: 'Looks up Src through a coordinate map (red = x, green = y, as made by UV Map). Connect Scene to light the projected picture with the scene\'s own light and shadow, as if it were painted on its surfaces.',
  params: [
    { k: 'float', name: 'shade', def: 0.7, min: 0, max: 1, help: 'How much the scene\'s light and shadow show through the projection.' },
    { k: 'float', name: 'gain', def: 1.1, min: 0, max: 3 },
    { k: 'enum', name: 'wrap', options: ['Mirror', 'Repeat', 'Clamp'], def: 0 },
  ],
  body: /* wgsl */`fn op(uv: vec2f) -> vec4f {
  var q = textureSampleLevel(map, smp, uv, 0.0).rg;
  if (u.wrap == 0) { q = 1.0 - abs(1.0 - (q - 2.0 * floor(q * 0.5))); }
  else if (u.wrap == 1) { q = fract(q); }
  else { q = clamp(q, vec2f(0.0), vec2f(1.0)); }
  var c = textureSampleLevel(src, smp, q, 0.0);
  if (u.has_scene > 0.5) {
    let l = luma(textureSampleLevel(scene, smp, uv, 0.0).rgb);
    c = vec4f(c.rgb * mix(1.0, clamp(l * 2.6, 0.0, 2.0), u.shade), c.a);
  }
  return vec4f(c.rgb * u.gain, c.a);
}`,
};

export const ops: OpDef[] = [text, panels, uvmap, project];
