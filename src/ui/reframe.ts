// Auto-frame: finds the subject in every piece of footage and stores a smooth camera path for it, so the Layer
// operator's Fill crop follows the person when the project is a different shape from the footage (vertical, square).
import { detectStill, type TrackBox } from '../nerve/ml';
import { project, ui } from './state';
import { host } from './host';
import { footagePool } from './autoedit';

let running: Promise<void> | null = null;
/** 0..1 while Auto-frame works, with the clip it is on; null when idle. */
let progress: { f: number; clip: string } | null = null;
export const autoFrameProgress = () => progress;

/** Raw subject position per sample: the most prominent person, held steady across frames. */
function targets(boxes: TrackBox[][]): ([number, number] | null)[] {
  let prev: [number, number] | null = null;
  return boxes.map(bs => {
    const people = bs.filter(b => b.label === 'person' && b.score > 0.35);
    const pool = people.length ? people : bs.filter(b => b.score > 0.5 && b.w * b.h > 0.02);
    if (!pool.length) return null;
    let best: TrackBox | null = null, score = -Infinity;
    for (const b of pool) {
      const cx = b.x + b.w / 2, cy = b.y + b.h * 0.38;   // aim a little above the middle: keep heads in frame
      const sc = Math.sqrt(b.w * b.h) * (people.length ? 1 : 0.6) - (prev ? Math.hypot(cx - prev[0], cy - prev[1]) * 0.35 : Math.abs(cx - 0.5) * 0.1);
      if (sc > score) { score = sc; best = b; }
    }
    prev = [best!.x + best!.w / 2, best!.y + best!.h * 0.38];
    return prev;
  });
}

/** Turns jittery detections into a camera move: fill gaps, ignore small wobbles, then ease (both ways, so no lag). */
export function cameraPath(raw: ([number, number] | null)[], rate: number): number[] {
  const n = raw.length;
  if (!n) return [0.5, 0.5];
  const first = raw.find(Boolean) ?? [0.5, 0.5];
  const filled: [number, number][] = [];
  let last = first;
  for (const r of raw) { if (r) last = r; filled.push([...last] as [number, number]); }
  const out: number[] = new Array(n * 2);
  for (const ax of [0, 1]) {
    const dz = 0.05;
    let cam = filled[0][ax];
    const v = filled.map(p => { const d = p[ax] - cam; if (Math.abs(d) > dz) cam += d - Math.sign(d) * dz; return cam; });
    const a = 1 - Math.exp(-1 / (rate * 0.55));      // ~0.55 s ease
    for (let i = 1; i < n; i++) v[i] = v[i - 1] + (v[i] - v[i - 1]) * a;
    for (let i = n - 2; i >= 0; i--) v[i] = v[i + 1] + (v[i] - v[i + 1]) * a;
    v.forEach((x, i) => { out[i * 2 + ax] = +Math.min(1, Math.max(0, x)).toFixed(4); });
  }
  return out;
}

/** Looks at every piece of footage not yet framed (or all of it with `redo`). */
export function autoFrame(redo = false): Promise<void> {
  if (running) return running;
  running = (async () => {
    const pool = footagePool(project.doc).filter(p => redo || !project.doc.focus?.[p.path]);
    if (!pool.length) { ui.set({ status: 'Auto-frame: every clip is already framed. Shift-click to look again.' }); return; }
    let done = 0;
    progress = { f: 0, clip: '' };
    for (const p of pool) {
      progress = { f: done / pool.length, clip: p.name };
      // footage framed in another project is remembered by file
      if (!redo) { try { const c = localStorage.getItem('phos.focus:' + p.path); if (c) { const v = JSON.parse(c); project.tx(d => { (d.focus ??= {})[p.path] = v; }); done++; continue; } } catch { /* storage unavailable */ } }
      ui.set({ status: `Auto-frame: finding the subject in ${p.name} (${done + 1} of ${pool.length})…` });
      const r = await host.footageFrames(p.path, p.dur) as { rate?: number; w?: number; h?: number; n?: number; data?: Uint8Array };
      if (!r.data || !r.w || !r.h || !r.n) { done++; continue; }
      const boxes: TrackBox[][] = [];
      const sz = r.w * r.h * 4;
      for (let i = 0; i < r.n; i++) {
        const img = new ImageData(new Uint8ClampedArray(r.data.buffer, r.data.byteOffset + i * sz, sz).slice(), r.w, r.h);
        progress = { f: (done + (i + 1) / r.n) / pool.length, clip: p.name };
        try { boxes.push(await detectStill(img)); } catch (e) { ui.set({ status: `Auto-frame: the detector failed (${String((e as Error).message ?? e)})` }); return; }
        if (i % 8 === 7) await new Promise(res => setTimeout(res, 0));   // keep the editor responsive
      }
      const xy = cameraPath(targets(boxes), r.rate ?? 2);
      project.tx(d => { (d.focus ??= {})[p.path] = { rate: r.rate ?? 2, xy }; });
      try { localStorage.setItem('phos.focus:' + p.path, JSON.stringify({ rate: r.rate ?? 2, xy })); } catch { /* full or unavailable */ }
      done++;
    }
    project.commit();
    ui.set({ status: `Auto-frame: framed ${done} clip${done === 1 ? '' : 's'}. Layers with Follow subject now keep the subject in frame.` });
  })().finally(() => { running = null; progress = null; });
  return running;
}

export const autoFrameRunning = () => !!running;

/** Detections on the whole frame plus two square crops (left and right), so people who are small in a wide frame still register. */
export async function detectAll(img: ImageData): Promise<TrackBox[]> {
  const out = (await detectStill(img)).map(b => ({ ...b }));
  const { width: W, height: H } = img;
  if (W > H * 1.2) {
    for (const x0 of [0, W - H]) {
      const c = new ImageData(H, H), src = img.data, dst = c.data;
      for (let y = 0; y < H; y++) dst.set(src.subarray((y * W + x0) * 4, (y * W + x0 + H) * 4), y * H * 4);
      for (const b of await detectStill(c)) out.push({ ...b, x: (x0 + b.x * H) / W, w: b.w * H / W, tile: 1 } as TrackBox);
    }
  }
  return out;
}
