// Auto Design: turn the analysis of a song into a unique, music-bound effect chain in a chosen style.
// Generation is seeded by the song itself, so the same track and style always give the same design and
// different tracks give different ones; Shuffle steps to the next variation.
import { getOp } from '../nerve/registry';
import { engine, project, ui } from './state';
import { analyzeSong } from './actions';
import { frameAll } from './Graph';

export const STYLES = ['Psychedelic', 'Glitch', 'Neon', 'Liquid', 'Rave', 'Cinematic'] as const;
export type Style = (typeof STYLES)[number];

interface Step { type: string; name?: string; set?: Record<string, any>; ex?: Record<string, string>; loop?: boolean }
interface Song { bpm: number; bass: number; bright: number; density: number; dynamic: number; K: string; B: string; V: string; H: string; rnd(): number; pick<T>(a: T[]): T; int(lo: number, hi: number): number; f(lo: number, hi: number): string }

function songContext(seed: number): Song {
  const d = project.doc, p = ((d as any).profile ?? { bass: 0.5, bright: 0.5, density: 0.5, dynamic: 0.5 }) as { bass: number; bright: number; density: number; dynamic: number };
  let s = seed >>> 0;
  const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const stems = engine.audio.stems.size > 0;
  return {
    bpm: d.settings.bpm, ...p, rnd,
    // with separated stems the design listens to the actual instruments; otherwise to frequency bands
    K: stems ? 'drums.hit' : 'kick', B: stems ? 'bassline' : 'bass', V: stems ? 'vocals' : 'mid', H: stems ? 'other' : 'high',
    pick: a => a[Math.floor(rnd() * a.length)],
    int: (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1)),
    f: (lo, hi) => (lo + rnd() * (hi - lo)).toFixed(3),
  };
}

function fingerprint(style: string, variation: number): number {
  const d = project.doc;
  const str = JSON.stringify([style, variation, d.settings.bpm, d.settings.offset, d.sections.map(s => [Math.round(s.t * 10), Math.round(s.level * 100)]), (d as any).profile, (d.audio.find(a => !a.clip) ?? d.audio[0])?.name]);
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function design(style: Style, c: Song): Step[] {
  const fast = c.bpm >= 138, rate = fast ? 0.5 : 1;                // faster songs get slower sweeps so they do not strobe
  const bloom: Step = { type: 'bloom', ex: { intensity: `${c.f(0.3, 0.6)} + ${c.K} * ${c.f(0.6, 1.4)} + drop * 0.3` }, set: { threshold: 0.7 } };
  const kal = (): Step => ({ type: 'kaleido', ex: { segments: `${c.int(2, 4) * 2} + (section % 3) * 2`, rotation: `beat * ${c.f(4, 18)} * ${rate}`, zoom: `1 + ${c.B} * ${c.f(0.1, 0.35)}` }, set: { spin: 0, mode: c.dynamic > 0.6 && c.rnd() > 0.5 ? 1 : 0 } });
  const colour = (): Step => c.pick<Step>([
    { type: 'colorama', ex: { phase: `beat * ${c.f(0.02, 0.08)} + section * ${c.f(0.1, 0.3)}`, amount: `0.25 + energy * 0.35` }, set: { speed: 0, frequency: +c.f(0.6, 2.2) } },
    { type: 'hsv', ex: { hue: `section * ${c.int(30, 90)} + secphase * ${c.int(20, 80)} + ${c.V} * 40`, saturation: `1 + energy * 0.5` }, set: { speed: 0 } },
    { type: 'gradmap', ex: { phase: `beat * ${c.f(0.01, 0.05)}`, amount: `0.2 + energy * 0.35` }, set: { speed: 0, frequency: +c.f(0.7, 1.8) } },
  ]);
  const aberr: Step = { type: 'chromab', ex: { amount: `${c.f(0.002, 0.006)} + ${c.K} * ${c.f(0.01, 0.03)}` } };
  switch (style) {
    case 'Psychedelic': return [
      { type: 'feedback', loop: true, ex: { scale: `1.01 + energy * ${c.f(0.01, 0.04)} + ${c.K} * 0.02`, rotate: `sin(beat * ${c.f(0.05, 0.2)}) * ${c.f(1, 5)}`, decay: `0.66 + energy * 0.14` } },
      kal(), { type: 'noisewarp', ex: { amount: `${c.f(0.01, 0.03)} + ${c.B} * ${c.f(0.04, 0.12)}` }, set: { speed: 0.15 } }, colour(), bloom,
    ];
    case 'Glitch': return [
      { type: 'datamosh', ex: { keyframe: `drop > 0.5 ? ${c.K} : (frame % ${c.int(60, 180)} < 1)`, amount: `1 + energy * ${c.f(0.5, 2)}`, block: `${c.f(0.01, 0.05)}` }, set: { refresh: +c.f(0, 0.03) } },
      ...(c.density > 0.45 ? [{ type: 'glitch', ex: { probability: `0.03 + ${c.K} * ${c.f(0.3, 0.7)}` } } as Step] : []),
      c.pick<Step>([{ type: 'rgbshift', ex: { amount: `${c.K} * ${c.f(0.01, 0.04)}`, angle: `beat * 90` } }, aberr]),
      { type: 'codec', ex: { quant: `0.04 + energy * ${c.f(0.1, 0.3)}`, corrupt: `${c.H} * ${c.f(0.1, 0.5)} * drop` }, set: { size: c.int(1, 4) } },
      ...(c.bright > 0.5 ? [{ type: 'pixelsort', ex: { high: `0.55 + ${c.V} * 0.45`, low: `0.3 - ${c.B} * 0.2` }, set: { axis: c.int(0, 1), steps: 60 } } as Step] : [{ type: 'scanshift', ex: { amount: `${c.K} * ${c.f(0.02, 0.08)}` } } as Step]),
      { type: 'grain', set: { amount: 0.25 } },
    ];
    case 'Neon': return [
      { type: 'neon', ex: { levels: `${c.int(4, 8)} + energy * ${c.int(4, 10)}`, glow: `0.5 + ${c.K} * ${c.f(0.8, 1.8)}`, hue: `section * ${c.int(40, 120)} + beat * ${c.f(1, 5)}`, melt: `${c.B} * ${c.f(0.05, 0.2)}`, under: `0.5 - drop * 0.35` } },
      aberr, ...(c.dynamic > 0.5 ? [{ type: 'radialblur', ex: { amount: `${c.K} * ${c.f(0.03, 0.1)} * drop` } } as Step] : []), bloom, { type: 'vignette', set: { amount: 0.5 } },
    ];
    case 'Liquid': return [
      { type: 'fluid', ex: { power: `0.3 + ${c.B} * ${c.f(0.8, 2)}`, swirl: `0.2 + energy * 0.8`, inject: `0.01 + ${c.K} * ${c.f(0.03, 0.12)}` }, set: { stir: c.pick([1, 2, 3, 5]) } },
      { type: 'noisewarp', ex: { amount: `${c.V} * ${c.f(0.02, 0.08)}` }, set: { speed: 0.1 } }, colour(), bloom,
    ];
    case 'Rave': return [
      kal(), { type: 'radialblur', ex: { amount: `${c.K} * ${c.f(0.08, 0.25)}` } },
      { type: 'rgbshift', ex: { amount: `${c.K} * ${c.f(0.01, 0.03)} + drop * 0.005`, angle: `beat * ${fast ? 45 : 90}` } },
      { type: 'levels', name: 'strobe', ex: { outWhite: `1 + ${c.K} * ${c.f(0.6, 2)} * drop` } },
      { type: 'glowedge', ex: { amount: `drop * ${c.f(0.5, 1)}` }, set: { hueSpeed: 0.2 } }, colour(), bloom,
    ];
    default: return [
      { type: 'timewarp', ex: { amount: `${c.f(0.1, 0.3)} + ${c.V} * 0.3` }, set: { mode: 1, echoes: c.int(3, 6), decay: 0.6, frames: 24 } },
      { type: 'radialblur', ex: { amount: `${c.K} * ${c.f(0.01, 0.04)}` } },
      { type: 'hsv', ex: { saturation: `0.85 + energy * 0.35`, hue: `section * ${c.int(4, 14)}` }, set: { speed: 0 } },
      { ...aberr, ex: { amount: `0.002 + ${c.K} * 0.006` } }, bloom, { type: 'grain', set: { amount: 0.3 } }, { type: 'vignette', ex: { amount: `0.55 - drop * 0.2` } },
    ];
  }
}

let variation = 0;

/** Build (or rebuild) the Auto Design chain between the picture source and the Out operator. */
export function autoDesign(style: Style, shuffle = false) { project.batch(() => build(style, shuffle)); }
function build(style: Style, shuffle = false) {
  const d = project.doc;
  if (!d.audio.length) { ui.set({ status: 'Auto Design needs a music track: import your song first.' }); return; }
  if (!d.sections.length) analyzeSong();
  if (shuffle) variation++; else variation = 0;
  const out = d.nodes.find(n => n.type === 'out');
  if (!out) { ui.set({ status: 'Auto Design needs an Out operator.' }); return; }
  // find the real picture source by walking back through any previous design, then clear that design
  let cur = project.inputOf(out.id, 0)?.from;
  for (let guard = 0; cur && guard < 200; guard++) {
    const n = project.node(cur);
    if (!n || !n.name.startsWith('auto_')) break;
    cur = project.inputOf(n.id, n.type === 'comp' ? 1 : 0)?.from;
  }
  const old = project.doc.nodes.filter(n => n.name.startsWith('auto_')).map(n => n.id);
  if (old.length) project.removeNodes(old);
  if (cur && project.node(cur)) project.connect(cur, out.id, 0);
  const first = project.inputOf(out.id, 0);
  if (!first) { ui.set({ status: 'Connect a picture source to Out first (import a clip or add a generator).' }); return; }
  const c = songContext(fingerprint(style, variation));
  const steps = design(style, c);
  const src = project.node(first.from)!;
  let prev = first.from, x = src.x + 200, y = src.y, used = 0;
  const apply = (id: string, st: Step) => {
    const def = getOp(project.node(id)!.type)!;
    for (const [k, v] of Object.entries(st.set ?? {})) if (def.params.some(p => p.name === k)) project.setParam(id, k, v, false);
    for (const [k, e] of Object.entries(st.ex ?? {})) { const p = def.params.find(q => q.name === k); if (p && (p.k === 'float' || p.k === 'int')) project.patchParam(id, k, s => { s.ex = [e]; }); }
  };
  const add = (type: string, tag: string, px: number, py: number) => { const n = project.addNode(type, px, py); if (n) project.rename(n.id, `auto_${tag}${project.doc.nodes.filter(q => q.name.startsWith(`auto_${tag}`)).length + 1}`); return n; };
  for (const st of steps) {
    if (!getOp(st.type)) continue;
    if (st.loop) {
      // feedback loop: previous frame → transform → fade → screen over the incoming picture
      const fb = add('feedback', 'fb', x, y + 180), tf = add('transform', 'spin', x + 190, y + 180), fade = add('levels', 'fade', x + 380, y + 180), comp = add('comp', 'mix', x + 570, y);
      if (!fb || !tf || !fade || !comp) continue;
      project.connect(fb.id, tf.id, 0); project.connect(tf.id, fade.id, 0); project.connect(fade.id, comp.id, 0); project.connect(prev, comp.id, 1);
      project.setParam(comp.id, 'mode', 9, false);   // Lighten: trails never pile up past the picture's own brightness
      project.setParam(fb.id, 'source', project.node(comp.id)!.name, false);
      project.patchParam(tf.id, 'scale', s => { s.ex = [st.ex!.scale]; }); project.patchParam(tf.id, 'rotate', s => { s.ex = [st.ex!.rotate]; });
      project.patchParam(fade.id, 'outWhite', s => { s.ex = [st.ex!.decay]; });
      prev = comp.id; x += 760; used++;
      continue;
    }
    const n = add(st.type, st.name ?? st.type, x, y);
    if (!n) continue;
    project.connect(prev, n.id, 0);
    apply(n.id, st);
    prev = n.id; x += 190; used++;
  }
  project.connect(prev, out.id, 0);
  project.moveNodes([{ id: out.id, x, y }]);
  project.setDisplay(out.id);
  project.commit();
  const heard = engine.audio.stems.size ? 'stems' : 'frequency bands (separate stems for instrument-level control)';
  ui.set({ status: `Auto Design: ${style}${variation ? ` · variation ${variation + 1}` : ''} — ${used} operators bound to ${d.settings.bpm} BPM, ${d.sections.length} sections, listening to ${heard}.`, sel: [] });
  requestAnimationFrame(() => requestAnimationFrame(frameAll));
}
