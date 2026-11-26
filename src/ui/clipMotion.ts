// Editing a clip's Motion: plain values until a property has keyframes, then edits write keys at the playhead
// (clip-local time), as in After Effects. Shared by the Parameters panel and the viewer handles.
import type { Clip } from '../nerve/types';
import { MOTION_DEF, motionComp, motionState, type MotionProp } from '../nerve/motion';
import { engine, project } from './state';
import { tv } from './tlview';

export function selectedClip(): Clip | null {
  if (!tv.sel) return null;
  for (const t of project.doc.tracks) { const c = t.clips.find(q => q.id === tv.sel); if (c) return c; }
  return null;
}
const comps = (p: MotionProp) => (p === 'pos' ? 2 : 1);
const half = () => 0.5 / project.doc.settings.fps;
const local = (cl: Clip) => +(engine.time - cl.start).toFixed(4);
export const isKeyed = (cl: Clip, p: MotionProp) => !!motionState(cl, p).keys?.some(k => k?.length);
export const keyHere = (cl: Clip, p: MotionProp) => !!motionState(cl, p).keys?.some(ks => ks?.some(k => Math.abs(k.t - local(cl)) < half()));

function edit(id: string, fn: (c: Clip) => void, coalesce?: string) {
  project.tx(d => { for (const t of d.tracks) { const c = t.clips.find(q => q.id === id); if (c) fn(c); } }, coalesce);
}

/** Set one component; writes a key at the playhead when the property is animated. */
export function setMotion(cl: Clip, p: MotionProp, comp: number, v: number, coalesce = true) {
  const lt = local(cl), keyed = isKeyed(cl, p);
  edit(cl.id, c => {
    const st = (c.motion ??= {})[p] ??= motionState(c, p);
    if (keyed) {
      st.keys ??= [];
      const ks = (st.keys[comp] ?? []).filter(k => Math.abs(k.t - lt) >= half());
      ks.push({ t: lt, v }); ks.sort((a, b) => a.t - b.t);
      st.keys[comp] = ks;
    } else if (Array.isArray(st.v)) { st.v = [...st.v]; st.v[comp] = v; } else st.v = v;
  }, coalesce ? `motion:${cl.id}:${p}` : undefined);
}
/** The diamond: add a key for every component at the playhead, or remove the one there. */
export function toggleMotionKey(cl: Clip, p: MotionProp) {
  const lt = local(cl), here = keyHere(cl, p);
  const cur = Array.from({ length: comps(p) }, (_, i) => motionComp(cl, p, i, lt));
  edit(cl.id, c => {
    const st = (c.motion ??= {})[p] ??= motionState(c, p);
    st.keys ??= [];
    for (let i = 0; i < comps(p); i++) {
      let ks = (st.keys[i] ?? []).filter(k => Math.abs(k.t - lt) >= half());
      if (!here) { ks.push({ t: lt, v: +cur[i].toFixed(3) }); ks.sort((a, b) => a.t - b.t); }
      st.keys[i] = ks.length ? ks : null;
    }
    if (!st.keys.some(k => k?.length)) { delete st.keys; st.v = comps(p) > 1 ? cur.map(x => +x.toFixed(3)) : +cur[0].toFixed(3); }
  });
  project.commit();
}
export function resetMotion(cl: Clip, p?: MotionProp) {
  edit(cl.id, c => { if (!c.motion) return; if (p) delete c.motion[p]; else delete c.motion; if (c.motion && !Object.keys(c.motion).length) delete c.motion; });
  project.commit();
}
/** Jump the playhead to the previous / next motion key on this clip. */
export function stepKey(cl: Clip, dir: -1 | 1) {
  const lt = engine.time - cl.start, ts = new Set<number>();
  for (const st of Object.values(cl.motion ?? {})) for (const ks of st?.keys ?? []) for (const k of ks ?? []) ts.add(k.t);
  const list = [...ts].sort((a, b) => a - b);
  const t = dir > 0 ? list.find(x => x > lt + 1e-3) : [...list].reverse().find(x => x < lt - 1e-3);
  if (t !== undefined) engine.seek(cl.start + t);
}
export const motionDefault = (p: MotionProp, comp: number) => { const d = MOTION_DEF[p]; return Array.isArray(d) ? d[comp] : d; };
