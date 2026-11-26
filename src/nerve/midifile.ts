// NERVE — MIDI on the timeline: Standard MIDI Files and recorded performance takes, queried by transport time
// so playback is identical in realtime and at export.

export interface MidiData {
  dur: number;
  /** Flat [start, duration, pitch, velocity 0..1] per note, sorted by start. */
  notes: number[];
  /** Controller curves: flat [time, value 0..1] per event, by CC number. */
  cc: Record<string, number[]>;
  bpm?: number;
}

/** Parse a Standard MIDI File (format 0 or 1) into seconds using its tempo map. */
export function parseMidi(buf: ArrayBuffer): MidiData {
  const d = new DataView(buf);
  let o = 0;
  const str = (n: number) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(d.getUint8(o + i)); o += n; return s; };
  if (str(4) !== 'MThd') throw new Error('Not a MIDI file');
  const hl = d.getUint32(o); o += 4;
  const ntr = d.getUint16(o + 2), div = d.getUint16(o + 4); o += hl;
  if (div & 0x8000) throw new Error('SMPTE-timed MIDI files are not supported');
  type Ev = { tick: number; k: number; a: number; b: number };
  const evs: Ev[] = [], tempos: { tick: number; us: number }[] = [];
  for (let t = 0; t < ntr && o < d.byteLength; t++) {
    if (str(4) !== 'MTrk') break;
    const len = d.getUint32(o); o += 4;
    const end = o + len;
    let tick = 0, run = 0;
    const vlq = () => { let v = 0, b; do { b = d.getUint8(o++); v = (v << 7) | (b & 127); } while (b & 128); return v; };
    while (o < end) {
      tick += vlq();
      let st = d.getUint8(o);
      if (st & 0x80) o++; else st = run;
      if (st === 0xff) { const type = d.getUint8(o++), n = vlq(); if (type === 0x51 && n === 3) tempos.push({ tick, us: (d.getUint8(o) << 16) | (d.getUint8(o + 1) << 8) | d.getUint8(o + 2) }); o += n; }
      else if (st === 0xf0 || st === 0xf7) { o += vlq(); }
      else {
        run = st;
        const hi = st & 0xf0, a = d.getUint8(o++), b = hi === 0xc0 || hi === 0xd0 ? 0 : d.getUint8(o++);
        if (hi === 0x90 || hi === 0x80 || hi === 0xb0) evs.push({ tick, k: hi === 0x90 && b === 0 ? 0x80 : hi, a, b });
      }
    }
    o = end;
  }
  tempos.sort((x, y) => x.tick - y.tick);
  if (!tempos.length || tempos[0].tick > 0) tempos.unshift({ tick: 0, us: 500000 });
  const secs = (tick: number) => { let s = 0; for (let i = 0; i < tempos.length; i++) { const next = tempos[i + 1]?.tick ?? Infinity; const seg = Math.min(tick, next) - tempos[i].tick; if (seg <= 0) break; s += (seg / div) * tempos[i].us / 1e6; } return s; };
  evs.sort((x, y) => x.tick - y.tick);
  const open = new Map<number, { t: number; v: number }[]>(), rows: number[][] = [], cc: Record<string, number[]> = {};
  let dur = 0;
  for (const e of evs) {
    const t = secs(e.tick); dur = Math.max(dur, t);
    if (e.k === 0x90) (open.get(e.a) ?? open.set(e.a, []).get(e.a)!).push({ t, v: e.b / 127 });
    else if (e.k === 0x80) { const q = open.get(e.a)?.shift(); if (q) rows.push([q.t, Math.max(0.01, t - q.t), e.a, q.v]); }
    else (cc[e.a] ??= []).push(t, e.b / 127);
  }
  for (const [p, qs] of open) for (const q of qs) rows.push([q.t, Math.max(0.05, dur - q.t), p, q.v]);
  rows.sort((x, y) => x[0] - y[0]);
  return { dur, notes: rows.flat(), cc, bpm: Math.round(6e7 / tempos[0].us * 100) / 100 };
}

export interface MidiPlaced { data: MidiData; start: number; mute?: boolean }

/** Last controller value at or before `t`, or undefined when the curve has not started. */
export function ccAt(curve: number[] | undefined, t: number): number | undefined {
  if (!curve || !curve.length || t < curve[0]) return undefined;
  let lo = 0, hi = curve.length / 2 - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (curve[m * 2] <= t) lo = m; else hi = m - 1; }
  return curve[lo * 2 + 1];
}

/** Evaluate note state across every placed clip at transport time `t`. */
export function noteState(clips: MidiPlaced[], t: number) {
  let gate = 0, pitch = -1, count = 0, last = -Infinity;
  const vel = new Float32Array(128);
  for (const c of clips) {
    if (c.mute) continue;
    const n = c.data.notes, lt = t - c.start;
    for (let i = 0; i < n.length; i += 4) {
      if (n[i] > lt) break;
      if (n[i] > last - c.start) last = n[i] + c.start;
      if (lt < n[i] + n[i + 1]) { const p = n[i + 2] & 127; vel[p] = Math.max(vel[p], n[i + 3]); gate = Math.max(gate, n[i + 3]); pitch = Math.max(pitch, p); count++; }
    }
  }
  return { gate, pitch, count, last, vel };
}
