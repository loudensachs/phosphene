// Per-clip choices: an effect for while the clip plays, a blend with the picture on the next track up, and a
// transition into the clip. Expressions read them through clipfx(k), blend(k), mosh(k), bleed(k), flash, cin, cout,
// so one network serves a whole edit and the choices are made on the timeline instead of with keyframes.
import type { Clip, Doc } from './types';

export const CLIP_EFFECTS = ['None', 'Twins', 'Echoes', 'Trail', 'Melt background', 'Sort background', 'Shadow', 'Duplicates', 'Custom 1', 'Custom 2', 'Custom 3'] as const;
/** Effect ids of the custom slots: any operator can be made one with Use as Clip Effect. */
export const CUSTOM_SLOTS = [8, 9, 10];
export const CLIP_BLENDS = ['None', 'Spirit', 'Cut-out', 'Melt merge', 'Window', 'Double exposure'] as const;
export const TRANSITIONS = ['Cut', 'Mosh carry', 'Mosh bloom', 'Mosh ghost', 'Mosh cross', 'Flash'] as const;
export const CLIP_EFFECT_HELP: Record<string, string> = {
  Twins: 'Copies of the subject slide out on the kick.',
  Echoes: 'Delayed copies of the subject follow it.',
  Trail: 'A colour trail follows the subject.',
  'Melt background': 'The room datamoshes behind a clean subject.',
  'Sort background': 'The room is pixel-sorted into streaks behind the subject.',
  Shadow: 'A torn-paper cut-out of the subject with a shadow.',
  Duplicates: 'A fan of duplicates of the subject on the kick.',
  'Custom 1': 'Your own effect: right-click any operator in the network and choose Use as Clip Effect.',
  'Custom 2': 'Your own effect: right-click any operator in the network and choose Use as Clip Effect.',
  'Custom 3': 'Your own effect: right-click any operator in the network and choose Use as Clip Effect.',
  Spirit: 'The subject of the clip above floats large and translucent over this one.',
  'Cut-out': 'This clip\'s subject is cut out and placed over the clip above.',
  'Melt merge': 'The clip above bleeds through in blobs that stick to this shot.',
  Window: 'The subject becomes a window onto the clip above.',
  'Double exposure': 'The clip above is laid over this one in light.',
};

const FADE_IN = 0.15, FADE_OUT = 0.35, PRE = 0.05, HEAL = 0.45;

export function clipAtTime(doc: Doc, track: number, t: number): { clip: Clip; prev: Clip | null; next: Clip | null } | null {
  const tr = doc.tracks[track - 1];
  if (!tr || tr.mute) return null;
  let clip: Clip | null = null;
  for (const c of tr.clips) if (t >= c.start && t < c.start + c.dur) clip = c;
  if (!clip) return null;
  let prev: Clip | null = null, next: Clip | null = null;
  for (const c of tr.clips) {
    if (c === clip) continue;
    if (c.start + c.dur <= clip.start + 1e-3 && (!prev || c.start > prev.start)) prev = c;
    if (c.start >= clip.start + clip.dur - 1e-3 && (!next || c.start < next.start)) next = c;
  }
  return { clip, prev, next };
}

const sm = (x: number) => { const v = Math.min(1, Math.max(0, x)); return v * v * (3 - 2 * v); };

/** Value of a clip-aware expression name, or undefined if `name` is not one. */
export function clipValue(doc: Doc, t: number, name: string): number | undefined {
  const call = /^([a-z]+)\(([^)]*)\)$/.exec(name);
  const fn = call ? call[1] : name;
  if (!['clipfx', 'blend', 'mosh', 'bleed', 'flash', 'cin', 'cout', 'cutpulse', 'clipno'].includes(fn)) return undefined;
  const args = call ? call[2].split(',').filter(Boolean).map(Number) : [];
  const k = args[0] ?? -1, track = Math.max(1, Math.round(args[1] ?? (fn === 'cin' || fn === 'cout' || fn === 'flash' || fn === 'cutpulse' || fn === 'clipno' ? args[0] ?? 1 : 1)));
  const at = clipAtTime(doc, track, t);
  if (!at) return 0;
  const { clip, next } = at, cin = t - clip.start, cout = clip.start + clip.dur - t;
  switch (fn) {
    case 'cin': return cin;
    case 'cout': return cout;
    case 'clipno': return doc.tracks[track - 1].clips.indexOf(clip);
    case 'clipfx': return (clip.fx ?? 0) === k && k > 0 ? sm(cin / FADE_IN) * sm(cout / FADE_OUT) : 0;
    case 'blend': return (clip.blend ?? 0) === k && k > 0 ? 1 : 0;
    case 'cutpulse': return Math.exp(-Math.max(0, cin) / 0.07);
    case 'flash': return (clip.trans ?? 0) === 5 ? Math.exp(-cin / 0.08) : 0;
    case 'mosh': case 'bleed': {
      // the window of a transition opens a moment before its cut, so the outgoing picture is what gets carried
      const win = (c: Clip, from: number) => {
        const tr = c.trans ?? 0;
        if (tr < 1 || tr > 4 || (k > 0 && tr !== k)) return 0;
        const len = c.transLen ?? 0.4, d = t - (c.start - PRE);
        if (d < 0) return 0;
        if (d < len) return 1;
        return fn === 'bleed' && d < len + HEAL ? 1 : 0;
        void from;
      };
      return Math.max(win(clip, 0), next ? win(next, 0) : 0);
    }
  }
  return undefined;
}

/** The gate that switches a custom slot on: a Composite whose opacity reads clipfx(k), named after the effect it gates. */
export function slotGate(doc: Doc, k: number) {
  return doc.nodes.find(n => n.type === 'comp' && (n.params.opacity?.ex?.[0] ?? '').replace(/\s/g, '') === `clipfx(${k})` && n.name.endsWith('_clip'));
}
/** Name of the operator in a custom slot, or null when the slot is empty. */
export function slotEffect(doc: Doc, k: number): string | null {
  const g = slotGate(doc, k);
  if (!g) return null;
  const src = doc.conns.find(c => c.to === g.id && c.slot === 1);
  return (src && doc.nodes.find(n => n.id === src.from)?.name) ?? null;
}
