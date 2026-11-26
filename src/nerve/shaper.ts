// NERVE — Shapers: drawable, tempo-synced modulation curves assignable to any parameter.
import type { AudioFrame, ShaperData, ShaperPoint } from './types';

/** Evaluate a shape at x ∈ [0,1]. Each point's `c` bends the segment that follows it (-1..1). */
export function shapeAt(pts: ShaperPoint[], x: number): number {
  if (!pts.length) return 0;
  if (x <= pts[0].x) return pts[0].y;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (x <= b.x) {
      const span = b.x - a.x;
      if (span <= 1e-6) return b.y;
      let t = (x - a.x) / span;
      const c = a.c;
      if (c > 0) t = Math.pow(t, 1 + c * 5);
      else if (c < 0) t = 1 - Math.pow(1 - t, 1 - c * 5);
      return a.y + (b.y - a.y) * t;
    }
  }
  return pts[pts.length - 1].y;
}

interface RT { pos: number; armed: boolean; value: number; phase: number }

export class Shapers {
  private rt = new Map<string, RT>();
  /** Current output by shaper name. */
  values = new Map<string, number>();
  /** Current cycle position 0..1 by id (for the editor playhead). */
  phases = new Map<string, number>();

  reset() { this.rt.clear(); }

  update(list: ShaperData[], time: number, beat: number, dt: number, audio: AudioFrame) {
    this.values.clear();
    for (const s of list) {
      let r = this.rt.get(s.id);
      if (!r) this.rt.set(s.id, (r = { pos: 1e9, armed: true, value: 0, phase: 0 }));
      const len = Math.max(1e-4, s.length);
      let ph: number;
      if (s.mode === 'sync') ph = beat / len + s.phase;
      else if (s.mode === 'free') ph = time / len + s.phase;
      else {
        const src = audio[s.trig] as number;
        if (src >= s.threshold && r.armed) { r.pos = 0; r.armed = false; }
        else if (src < s.threshold * 0.7) r.armed = true;
        r.pos += dt;
        ph = Math.min(1, r.pos / len); // length is in seconds for trigger mode
      }
      const x = s.mode === 'trigger' ? ph : ph - Math.floor(ph);
      let y = shapeAt(s.points, x);
      if (s.smooth > 0 && dt > 0) { const k = 1 - Math.exp(-dt / (s.smooth * 0.5 + 1e-4)); r.value += (y - r.value) * k; y = r.value; }
      else r.value = y;
      r.phase = x;
      this.phases.set(s.id, x);
      this.values.set(s.name, s.bipolar ? y * 2 - 1 : y);
    }
  }
}
