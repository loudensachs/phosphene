// Per-clip Motion, as in Premiere: position (project pixels, from where the clip normally sits), scale (%) and rotation
// (degrees, clockwise). Each can carry keyframes, timed from the clip's own start so they travel with the clip.
import type { Clip, Key, PState } from './types';

export type MotionProp = 'pos' | 'scale' | 'rot';
export const MOTION_DEF: Record<MotionProp, number | [number, number]> = { pos: [0, 0], scale: 100, rot: 0 };

function evalKeys(keys: Key[], t: number): number {
  if (t <= keys[0].t) return keys[0].v;
  const last = keys[keys.length - 1];
  if (t >= last.t) return last.v;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    if (t > b.t) continue;
    let u = (t - a.t) / Math.max(1e-9, b.t - a.t);
    switch (a.ease) {
      case 'hold': return a.v;
      case 'lin': break;
      case 'in': u = u * u * u; break;
      case 'out': u = 1 - Math.pow(1 - u, 3); break;
      default: u = u * u * (3 - 2 * u);   // motion eases by default, like an editor's bezier keyframes
    }
    return a.v + (b.v - a.v) * u;
  }
  return last.v;
}

export function motionState(cl: Clip, p: MotionProp): PState {
  return cl.motion?.[p] ?? { v: Array.isArray(MOTION_DEF[p]) ? [...(MOTION_DEF[p] as number[])] : MOTION_DEF[p] };
}
/** Value of one component at clip-local time `lt`. */
export function motionComp(cl: Clip, p: MotionProp, comp: number, lt: number): number {
  const st = motionState(cl, p), ks = st.keys?.[comp];
  if (ks?.length) return evalKeys(ks, lt);
  return Array.isArray(st.v) ? st.v[comp] : st.v;
}
/** Motion at project time t. */
export function motionAt(cl: Clip, t: number) {
  const lt = t - cl.start;
  return { x: motionComp(cl, 'pos', 0, lt), y: motionComp(cl, 'pos', 1, lt), s: motionComp(cl, 'scale', 0, lt), r: motionComp(cl, 'rot', 0, lt) };
}
export const hasMotion = (cl: Clip) => !!cl.motion && Object.keys(cl.motion).length > 0;
/** Every keyframe time on the clip (clip-local seconds), for drawing diamonds on the timeline. */
export function motionKeyTimes(cl: Clip): number[] {
  const out = new Set<number>();
  for (const st of Object.values(cl.motion ?? {})) for (const ks of st?.keys ?? []) for (const k of ks ?? []) out.add(+k.t.toFixed(3));
  return [...out].sort((a, b) => a - b);
}
