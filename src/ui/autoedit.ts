// Auto Edit: cuts the project's footage to the song. Every cut lands on the beat; shot length follows the song's
// energy; clips are picked for variety and for movement that suits the moment; each clip gets an effect, a
// transition and sometimes a blend; and a grouped effects network is built to play those choices. One undo step.
import type { Clip, Doc, NodeData } from '../nerve/types';
import { uid } from '../nerve/project';
import { engine, project, ui } from './state';
import { host } from './host';
import { analyzeSong, musicTrack } from './actions';
import { makeGroup, tidy } from './graphView';

export const STYLES = ['Psychedelic', 'Glitch', 'Dreamy', 'Clean'] as const;
export type EditStyle = typeof STYLES[number];
export interface EditOptions {
  style: EditStyle;
  /** 0 slow, 1 medium, 2 fast */
  pace: number;
  /** 0 light, 1 medium, 2 heavy: share of clips that get a subject effect */
  effects: number;
  /** 0 few, 1 some, 2 most: share of cuts that become moshes */
  transitions: number;
  blends: boolean;
  seed: number;
  /** cut only the export region instead of the whole song */
  regionOnly: boolean;
}
export const DEFAULT_OPTIONS: EditOptions = { style: 'Psychedelic', pace: 1, effects: 1, transitions: 1, blends: true, seed: 1, regionOnly: false };

interface Stats { dur: number; rate: number; motion: number[]; luma: number[] }
interface Source { path: string; name: string; dur: number; stats: Stats | null; cuts?: number[] }
/** A stretch of one file the planner can draw from: one shot of an edited video, or a chunk of a long take. */
interface Seg extends Source { key: string; a: number; b: number }

// ---------------- footage ----------------
const statCache = new Map<string, Stats>();
function cached(path: string): Stats | null {
  if (statCache.has(path)) return statCache.get(path)!;
  try { const s = localStorage.getItem('phos.stats:' + path); if (s) { const v = JSON.parse(s) as Stats; statCache.set(path, v); return v; } } catch { /* storage unavailable */ }
  return null;
}
/** Every distinct piece of footage in the project: remembered in `doc.pool` so re-rolls keep drawing from all of it. */
export function footagePool(doc: Doc): { path: string; name: string; dur: number }[] {
  const seen = new Map<string, { path: string; name: string; dur: number }>();
  for (const p of doc.pool ?? []) seen.set(p.path, p);
  for (const t of doc.tracks) for (const c of t.clips) if (c.kind === 'video' && !seen.has(c.path)) seen.set(c.path, { path: c.path, name: c.name, dur: c.srcDur || c.in + c.dur });
  return [...seen.values()];
}
async function measure(pool: { path: string; name: string; dur: number }[], onStage: (s: string) => void): Promise<Source[]> {
  const out: Source[] = [];
  let done = 0;
  const todo = pool.filter(p => !cached(p.path));
  const run = async (p: { path: string; name: string; dur: number }) => {
    const r = await host.footageStats(p.path, p.dur) as { rate?: number; motion?: number[]; luma?: number[] };
    if (r.motion && r.luma) {
      const st: Stats = { dur: p.dur, rate: r.rate ?? 2, motion: r.motion.map((v: number) => +v.toFixed(4)), luma: r.luma.map((v: number) => +v.toFixed(3)) };
      statCache.set(p.path, st);
      try { localStorage.setItem('phos.stats:' + p.path, JSON.stringify(st)); } catch { /* full or unavailable */ }
    }
    done++; onStage(`Measuring motion in your footage: ${done} of ${todo.length}`);
  };
  // two at a time: the work is mostly reading the files
  const queue = [...todo];
  await Promise.all([0, 1].map(async () => { while (queue.length) await run(queue.shift()!); }));
  // shot changes inside each file, so one long edited video gives many shots to choose from
  let sd = 0;
  for (const p of pool) {
    let cuts: number[] | undefined;
    try { const c = localStorage.getItem('phos.cuts:' + p.path); if (c) cuts = JSON.parse(c); } catch { /* storage unavailable */ }
    if (!cuts && p.dur > 6) {
      onStage(`Finding the shots in ${p.name}${pool.length > 1 ? ` (${++sd} of ${pool.length})` : ''}…`);
      const r = await host.footageScenes(p.path) as { cuts?: number[] };
      cuts = r.cuts ?? [];
      try { localStorage.setItem('phos.cuts:' + p.path, JSON.stringify(cuts)); } catch { /* full */ }
    }
    out.push({ ...p, stats: cached(p.path), cuts: cuts ?? [] });
  }
  return out;
}

// ---------------- planning ----------------
function rng(seed: number) { let a = seed >>> 0 || 1; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const pickW = <T,>(r: () => number, items: [T, number][]) => { const tot = items.reduce((a, b) => a + b[1], 0); let x = r() * tot; for (const [v, w] of items) { x -= w; if (x <= 0) return v; } return items[items.length - 1][0]; };

const STYLE = {
  Psychedelic: { fx: [[1, 3], [2, 2], [3, 3], [4, 3], [5, 2], [6, 2], [7, 3]], tr: [[1, 3], [2, 2], [3, 2], [4, 2], [5, 1]], bl: [[1, 2], [2, 1], [3, 2], [4, 1], [5, 2]], fxMul: 1, trMul: 1, tape: 0.45, glow: 0.18 },
  Glitch: { fx: [[1, 2], [4, 3], [5, 4], [7, 3], [6, 1]], tr: [[1, 4], [3, 3], [4, 3], [5, 2]], bl: [[3, 2], [5, 1], [2, 1]], fxMul: 1, trMul: 1.2, tape: 0.75, glow: 0.12 },
  Dreamy: { fx: [[2, 3], [3, 4], [4, 2], [6, 2]], tr: [[2, 4], [3, 3], [1, 2]], bl: [[1, 3], [5, 4], [3, 2]], fxMul: 0.9, trMul: 0.9, tape: 0.3, glow: 0.3 },
  Clean: { fx: [[6, 3], [1, 2], [2, 1]], tr: [[5, 3], [1, 1]], bl: [[5, 1], [2, 1]], fxMul: 0.55, trMul: 0.6, tape: 0.12, glow: 0.12 },
} as Record<EditStyle, { fx: [number, number][]; tr: [number, number][]; bl: [number, number][]; fxMul: number; trMul: number; tape: number; glow: number }>;

/** Splits footage into shots at its cuts; long unbroken stretches become ~8 s chunks so even one take can be cut up. */
function segments(sources: Source[]): Seg[] {
  const out: Seg[] = [];
  for (const s of sources) {
    const edges = [0, ...(s.cuts ?? []).filter(t => t > 0.4 && t < s.dur - 0.4), s.dur];
    // fold slivers (flash frames, dissolves) into the shot before them
    const kept: number[] = [edges[0]];
    for (let i = 1; i < edges.length; i++) if (edges[i] - kept[kept.length - 1] >= 1.2 || i === edges.length - 1) kept.push(edges[i]);
    for (let i = 0; i < kept.length - 1; i++) {
      const a = kept[i], b = kept[i + 1], n = Math.max(1, Math.round((b - a) / 8));
      for (let j = 0; j < n; j++) out.push({ ...s, key: `${s.path}#${i}.${j}`, a: a + ((b - a) * j) / n, b: a + ((b - a) * (j + 1)) / n });
    }
  }
  return out;
}

interface Plan { main: Clip[]; second: Clip[]; start: number; end: number; rises: [number, number][] }

function plan(doc: Doc, files: Source[], o: EditOptions, start: number, end: number): Plan {
  const sources = segments(files), nFiles = files.length;
  const r = rng(o.seed * 7919 + 13), sty = STYLE[o.style];
  const bpm = doc.settings.bpm, beat = 60 / bpm, off = doc.settings.offset ?? 0;
  const secs = doc.sections.length ? doc.sections : [{ t: 0, level: 0.7, name: 'Main' }];
  const energyAt = (t: number) => { let s = secs[0]; for (const q of secs) if (q.t <= t + 1e-3) s = q; return s; };
  const nextSection = (t: number) => secs.find(q => q.t > t + 0.05)?.t ?? Infinity;
  const grid = (t: number) => off + Math.round((t - off) / beat) * beat;
  // all footage motion, ranked, so "high motion" means high for this footage
  const all = sources.flatMap(s => s.stats?.motion ?? []).sort((a, b) => a - b);
  const rank = (m: number) => { let lo = 0, hi = all.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (all[mid] < m) lo = mid + 1; else hi = mid; } return all.length ? lo / all.length : 0.5; };
  const used = new Map<string, [number, number][]>(), count = new Map<string, number>();
  const spots: { path: string; t: number }[] = [];
  const window = (s: Seg, d: number, want: number, avoidDark: boolean, reuse = false) => {
    const st = s.stats, lo = Math.max(0.25, s.a + 0.1), hi = Math.min(s.dur - 0.15, s.b - 0.05);
    if (hi - lo < d) return null;
    let best: { inn: number; score: number } | null = null;
    for (let inn = lo; inn + d <= hi; inn += 0.5) {
      if (!reuse && (used.get(s.path) ?? []).some(([a, b]) => inn < b + 0.4 && inn + d > a - 0.4)) continue;
      let m = 0.5, l = 0.3;
      if (st && st.motion.length) {
        const a = Math.floor(inn * st.rate), b = Math.max(a + 1, Math.ceil((inn + d) * st.rate));
        const ms = st.motion.slice(a, b), ls = st.luma.slice(a, b);
        if (ms.length) { m = rank(ms.reduce((x, y) => x + y, 0) / ms.length); l = ls.reduce((x, y) => x + y, 0) / ls.length; }
      }
      const score = -Math.abs(m - want) * 2 + r() * 0.5 - (avoidDark && l < 0.05 ? 2 : 0);
      if (!best || score > best.score) best = { inn, score };
    }
    return best;
  };
  // `avoid` holds segment keys (and file paths when there are several files) used just before
  const choose = (d: number, want: number, avoid: string[]) => {
    type Pick = { s: Seg; inn: number; score: number };
    let pick = null as Pick | null;
    for (const reuse of [false, true]) {
      for (const s of sources) {
        if (avoid.includes(s.key) || avoid.includes(s.path)) continue;
        const w = window(s, d, want, true, reuse);
        if (!w) continue;
        // stay away from the part of the same file the last shots came from: undetected cuts would otherwise repeat a scene
        const near = spots.slice(-3).some(q => q.path === s.path && Math.abs(q.t - w.inn) < 30) ? 1.4 : 0;
        const score = w.score - (count.get(s.key) ?? 0) * 0.55 - (nFiles > 1 ? (count.get(s.path) ?? 0) * 0.3 : 0) - (reuse ? 1 : 0) - near;
        if (!pick || score > pick.score) pick = { s, inn: w.inn, score };
      }
      if (pick) break;   // only reuse footage once nothing fresh is left
    }
    if (pick) {
      (used.get(pick.s.path) ?? used.set(pick.s.path, []).get(pick.s.path)!).push([pick.inn, pick.inn + d]);
      for (const k of [pick.s.key, pick.s.path]) count.set(k, (count.get(k) ?? 0) + 1);
    }
    return pick;
  };
  // shot lengths in seconds by energy and pace, then snapped to whole beats (powers of two, so cuts stay on the bar)
  const lengths = (e: number): number[] => {
    const pm = [1.5, 1, 0.65][o.pace];
    const secsFor = e > 0.72 ? [1.4, 2.2, 2.8] : e < 0.4 ? [4, 5.5, 7] : [2.4, 3.2, 4.2];
    return secsFor.map(x => { const b = (x * pm) / beat; return Math.max(2, 2 ** Math.round(Math.log2(b))); });
  };
  const main: Clip[] = [], second: Clip[] = [], rises: [number, number][] = [];
  let t = start, lastFx = 0, lastBlend = false, k = 0;
  const recent: string[] = [], recentPaths: string[] = [];
  while (t < end - 0.2) {
    const sec = energyAt(t), e = sec.level;
    let beats = lengths(e)[Math.floor(r() * lengths(e).length)];
    // two quick shots at the end of a four-bar phrase in the loud parts
    const barNo = Math.round((t - off) / (beat * 4));
    if (e > 0.72 && o.pace > 0 && barNo % 4 === 3 && beats >= 4 && r() < 0.45) beats = 2;
    let e2 = Math.min(end, grid(t + beats * beat), grid(nextSection(t)));
    if (e2 - t < beat * 0.9) e2 = Math.min(end, grid(t + beats * beat));
    if (end - e2 < beat * 1.5) e2 = end;
    const d = e2 - t;
    const pick = choose(d + 0.05, Math.min(1, 0.25 + e * 0.75), [...recent.slice(-2), ...(nFiles >= 3 ? recentPaths.slice(-1) : [])]);
    if (!pick) break;
    recent.push(pick.s.key); recentPaths.push(pick.s.path); spots.push({ path: pick.s.path, t: pick.inn });
    const sectionStart = secs.some(q => Math.abs(q.t - t) < 0.1) && t > start + 0.1;
    const c: Clip = { id: uid('c'), path: pick.s.path, name: pick.s.name, start: +t.toFixed(4), in: +pick.inn.toFixed(3), dur: +d.toFixed(4), speed: 1, srcDur: pick.s.dur, kind: 'video' };
    // effect
    const pFx = [0.35, 0.6, 0.85][o.effects] * sty.fxMul;
    if (r() < pFx) { let fx = pickW(r, sty.fx); if (fx === lastFx) fx = pickW(r, sty.fx); c.fx = fx; lastFx = fx; } else lastFx = 0;
    // transition into it
    if (k > 0) {
      const pTr = Math.min(0.95, [0.3, 0.55, 0.8][o.transitions] * sty.trMul * (e > 0.72 ? 1.1 : 0.9));
      if (sectionStart) c.trans = e > 0.72 ? pickW(r, [[2, 2], [5, 2], [1, 1]]) : 2;
      else if (r() < pTr) c.trans = pickW(r, sty.tr);
      if (c.trans && c.trans !== 5) c.transLen = e > 0.72 ? 0.3 : e < 0.4 ? 0.6 : 0.38;
    }
    // blend with a second picture
    if (o.blends && d >= beat * 3.5 && !lastBlend && r() < (o.style === 'Clean' ? 0.12 : 0.28)) {
      const b2 = choose(d + 0.05, 0.6, [pick.s.key, ...recent.slice(-2), ...(nFiles > 1 ? [pick.s.path] : [])]);
      if (b2) { c.blend = pickW(r, sty.bl); second.push({ id: uid('c'), path: b2.s.path, name: b2.s.name, start: c.start, in: +b2.inn.toFixed(3), dur: c.dur, speed: 1, srcDur: b2.s.dur, kind: 'video' }); lastBlend = true; }
    } else lastBlend = false;
    // a cross mosh borrows another clip's motion for its few frames
    if (c.trans === 4) {
      const prevBlend = main.length && main[main.length - 1].blend;
      const b3 = !prevBlend && choose(1.1, 0.8, [pick.s.key, ...(nFiles > 1 ? [pick.s.path] : [])]);
      if (b3) second.push({ id: uid('c'), path: b3.s.path, name: b3.s.name, start: +(t - 0.2).toFixed(4), in: +b3.inn.toFixed(3), dur: 1.1, speed: 1, srcDur: b3.s.dur, kind: 'video' });
      else c.trans = 1;
    }
    // the bar before a loud section pulls in
    if (sectionStart && e > 0.72 && main.length) rises.push([t - beat * 4, t]);
    main.push(c); t = e2; k++;
  }
  return { main, second: second.sort((a, b) => a.start - b.start), start, end, rises };
}

// ---------------- network ----------------
function buildNetwork(o: EditOptions, rises: [number, number][], lowSections: [number, number][]) {
  const sty = STYLE[o.style];
  for (const n of [...project.doc.nodes]) project.removeNodes([n.id]);
  project.tx(d => { d.groups = []; });
  const made: Record<string, string[]> = {};
  const N = (grp: string, type: string, name: string, params: Record<string, unknown> = {}, ex: Record<string, string | string[]> = {}): NodeData => {
    const n = project.addNode(type, 0, 0)!;
    project.rename(n.id, name);
    for (const k in params) project.setParam(n.id, k, params[k], false);
    for (const k in ex) project.patchParam(n.id, k, s => { s.ex = (Array.isArray(ex[k]) ? ex[k] : [ex[k]]) as string[]; });
    (made[grp] ??= []).push(n.id);
    return project.node(n.id)!;
  };
  const C = (a: NodeData, b: NodeData, i = 0) => project.connect(a.id, b.id, i);
  const gate = (grp: string, prev: NodeData, eff: NodeData, name: string, g: string) => { const m = N(grp, 'comp', name + '_mix', { mode: 0 }, { opacity: g }); C(prev, m, 0); C(eff, m, 1); return m; };
  const L1 = N('io', 'layer', 'shots', { track: 1 }), L2 = N('io', 'layer', 'second', { track: 2 });
  // depth & mattes
  const dp = N('dm', 'depth', 'depth', { temporal: 0.78 }); C(L1, dp);
  const fgRaw = N('dm', 'rangematte', 'subject_matte', { low: 0.52, feather: 0.16, grow: -0.003 }); C(dp, fgRaw);
  const en = N('dm', 'noise', 'edge_noise', { scale: 7, octaves: 2, speed: 0.6, color: true });
  const fg = N('dm', 'displace', 'subject_edge', { mode: 1, amount: 0.009, chroma: 0 }); C(fgRaw, fg, 0); C(en, fg, 1);
  const uvm = N('dm', 'uvmap', 'uv', { parallax: 0.07, look: [0.35, 0.12] }); C(dp, uvm);
  const uvT = N('dm', 'datamosh', 'uv_track', { threshold: 0, refresh: 0, block: 0, smear: 0, amount: 1 }, { keyframe: 'cutpulse > 0.6 ? 1 : 0' }); C(uvm, uvT, 0); C(L1, uvT, 1);
  const dp2 = N('dm', 'depth', 'depth_second', { temporal: 0.78 }); C(L2, dp2);
  const fg2r = N('dm', 'rangematte', 'second_matte', { low: 0.52, feather: 0.18, grow: -0.004 }); C(dp2, fg2r);
  const fg2 = N('dm', 'displace', 'second_edge', { mode: 1, amount: 0.012, chroma: 0 }); C(fg2r, fg2, 0); C(en, fg2, 1);
  // blends
  let prev = L1;
  const proj = N('bl', 'project', 'second_projected', { shade: 0.7, gain: 1.15 }); C(L2, proj, 0); C(uvT, proj, 1); C(L1, proj, 2);
  const projBg = N('bl', 'project', 'second_tracked', { shade: 0, gain: 1 }); C(L2, projBg, 0); C(uvT, projBg, 1);
  const sCut = N('bl', 'subjectfx', 'spirit_cut', { shadow: 0, bgDim: 1, taper: 0.5, lift: 1.1 }); C(L2, sCut, 0); C(fg2, sCut, 1);
  const sTrail = N('bl', 'echo', 'spirit_trail', { mode: 1, persistence: 0.82, offset: [0, -0.004], scale: 1.01, hueShift: 9, opacity: 0.9 }); C(sCut, sTrail);
  const sBig = N('bl', 'transform', 'spirit_scale', { edge: 0, scale: 1.32, translate: [0.18, 0.04] }); C(sTrail, sBig);
  const spirit = N('bl', 'comp', 'spirit', { mode: 2, opacity: 0.68 }); C(L1, spirit, 0); C(sBig, spirit, 1);
  prev = gate('bl', prev, spirit, 'spirit', 'blend(1)');
  const co0 = N('bl', 'comp', 'cutout_place', { mode: 0 }); C(projBg, co0, 0); C(L1, co0, 1); C(fgRaw, co0, 2);
  const co = N('bl', 'subjectfx', 'cutout', { shadow: 0.5, soft: 0.02, shadowOffset: [0.008, 0.012], tear: 1, tearScale: 1.1, paper: 0.007, bgDim: 0.05 }); C(co0, co, 0); C(fgRaw, co, 1);
  prev = gate('bl', prev, co, 'cutout', 'blend(2)');
  const bn = N('bl', 'noise', 'blob_noise', { scale: 1.6, octaves: 3, speed: 0.35, contrast: 1.2 });
  const bm = N('bl', 'rangematte', 'blob_matte', { low: 0.5, feather: 0.07 }); C(bn, bm);
  const bt = N('bl', 'project', 'blob_track', { shade: 0, gain: 1 }); C(bm, bt, 0); C(uvT, bt, 1);
  const mg = N('bl', 'comp', 'melt_merge', { mode: 0 }); C(L1, mg, 0); C(proj, mg, 1); C(bt, mg, 2);
  prev = gate('bl', prev, mg, 'merge', 'blend(3)');
  const w0 = N('bl', 'comp', 'window_place', { mode: 0, opacity: 0.9 }); C(L1, w0, 0); C(proj, w0, 1); C(fgRaw, w0, 2);
  const wn = N('bl', 'subjectfx', 'window', { shadow: 0.35, soft: 0.02, bgDim: 0.12, tear: 0.85, tearScale: 0.8, paper: 0.004 }); C(w0, wn, 0); C(fgRaw, wn, 1);
  prev = gate('bl', prev, wn, 'window', 'blend(4)');
  const db = N('bl', 'comp', 'double', { mode: 2, opacity: 0.62 }); C(L1, db, 0); C(L2, db, 1);
  prev = gate('bl', prev, db, 'double', 'blend(5)');
  // transitions
  const frame = prev, heal = 'mosh(0) > 0.5 ? 0 : 0.15';
  const K1 = N('tr', 'datamosh', 'mosh_carry', { threshold: 0, block: 0.008, smear: 0.25, chroma: 0.15, amount: 0.85 }, { refresh: heal, keyframe: '1 - bleed(1)' }); C(frame, K1);
  const K2 = N('tr', 'datamosh', 'mosh_bloom', { threshold: 0, block: 0, smear: 0.2, driftAngle: 90, amount: 1, freeze: 0.9, drift: 0.12 }, { refresh: heal, keyframe: '1 - bleed(2)' }); C(frame, K2);
  const K3 = N('tr', 'datamosh', 'mosh_ghost', { threshold: 0, block: 0, chroma: 0.3, residual: 0.75, amount: 0.7 }, { refresh: heal, keyframe: '1 - bleed(3)' }); C(frame, K3);
  const K4 = N('tr', 'datamosh', 'mosh_cross', { threshold: 0, block: 0.014, smear: 0.3, chroma: 0.25, amount: 0.95 }, { refresh: heal, keyframe: '1 - bleed(4)' }); C(frame, K4); C(L2, K4, 1);
  prev = frame;
  for (const [k, K] of [[1, K1], [2, K2], [3, K3], [4, K4]] as [number, NodeData][]) prev = gate('tr', prev, K, 'pick' + k, `bleed(${k})`);
  const mh = N('tr', 'hsv', 'mosh_hue', { speed: 0, vibrance: 0.1 }, { hue: 'mosh(3) * -12 + (mosh(0) - mosh(3)) * 6', saturation: '1.04 + mosh(0) * 0.12' }); C(prev, mh); prev = mh;
  // subject fx
  const side = (type: string, name: string, params: Record<string, unknown>, ex: Record<string, string | string[]>, k: number, mask?: NodeData) => { const n = N('fx', type, name, params, ex); C(prev, n); if (mask) C(mask, n, 1); prev = gate('fx', prev, n, name, `clipfx(${k})`); };
  side('echo', 'twins', { delay: 0, count: 3, decay: 0.68, scale: 0.98, opacity: 0.62 }, { offset: ['min(kick, 1) * 0.07', 'min(kick, 1) * -0.008'], hueShift: 'min(kick, 1) * 24' }, 1, fg);
  side('echo', 'echoes', { count: 4, delay: 3, decay: 0.7, opacity: 0.7, offset: [0.004, 0], hueShift: 10 }, {}, 2, fg);
  side('echo', 'trail', { mode: 1, persistence: 0.9, offset: [0.002, -0.0015], scale: 1.008, hueShift: 7, opacity: 0.75 }, {}, 3, fg);
  const bgm = N('fx', 'datamosh', 'melt_bg', { threshold: 0, block: 0.008, smear: 0.4, chroma: 0.3, amount: 1.15 }, { keyframe: 'clipfx(4) > 0.001 ? (cutpulse > 0.6 ? 1 : 0) : 1', refresh: '0.012 + (cout < 0.45 ? (0.45 - cout) * 0.6 : 0)' }); C(prev, bgm);
  const bgc = N('fx', 'comp', 'melt_bg_subject', { mode: 0 }); C(bgm, bgc, 0); C(prev, bgc, 1); C(fg, bgc, 2);
  prev = gate('fx', prev, bgc, 'melt_bg', 'clipfx(4)');
  const bgs = N('fx', 'pixelsort', 'sort_bg', { axis: 0, steps: 90, high: 1.2, grain: 2 }, { low: '0.3 - min(kick, 1) * 0.15' }); C(prev, bgs);
  const bgsk = N('fx', 'comp', 'sort_bg_subject', { mode: 0 }); C(bgs, bgsk, 0); C(prev, bgsk, 1); C(fg, bgsk, 2);
  prev = gate('fx', prev, bgsk, 'sort_bg', 'clipfx(5)');
  side('subjectfx', 'shadow', { shadow: 0.55, soft: 0.03, shadowOffset: [0.016, 0.02], tear: 0.7, paper: 0.003, bgDim: 0.25 }, { lift: '1.08 + min(kick, 1) * 0.1' }, 6, fgRaw);
  side('echo', 'duplicates', { delay: 0, count: 4, decay: 0.7, scale: 0.97, opacity: 0.72, hueShift: 18 }, { offset: ['min(kick, 1) * 0.055', 'min(kick, 1) * 0.012'], rotate: 'min(kick, 1) * 5' }, 7, fg);
  const st = N('fx', 'starglow', 'practicals', { threshold: 0.82, points: 1, len: 0.07, samples: 32, colorMode: 2, srcColor: 0.7, intensity: o.style === 'Clean' ? 0.2 : 0.4 }); C(prev, st); prev = st;
  // light & film
  const sig = (name: string, keys: { t: number; v: number; ease?: 'lin' | 'hold' | 'smooth' | 'in' | 'out' }[]) => { const n = N('lf', 'sigconst', name); project.patchParam(n.id, 'value', s => { s.keys = [keys]; }); return n; };
  sig('rise', [{ t: 0, v: 0 }, ...rises.flatMap(([a, b]) => [{ t: a, v: 0, ease: 'in' as const }, { t: b - 0.02, v: 1, ease: 'hold' as const }, { t: b, v: 0 }])]);
  sig('letterbox_amount', [{ t: 0, v: 0 }, ...lowSections.flatMap(([a, b]) => [{ t: a, v: 0, ease: 'smooth' as const }, { t: a + 1.2, v: 1 }, { t: b - 0.02, v: 1, ease: 'hold' as const }, { t: b, v: 0 }])]);
  const then = (type: string, name: string, params: Record<string, unknown> = {}, ex: Record<string, string | string[]> = {}) => { const n = N('lf', type, name, params, ex); C(prev, n); prev = n; return n; };
  const lk = N('lf', 'lightleak', 'leak', { coverage: 0.3, softness: 0.7, speed: 0.1, saturation: 0.8, flicker: 0.1 }, { intensity: '0.25 + min(kick, 1) * 0.2' });
  const lm = N('lf', 'comp', 'leak_mix', { mode: 2 }, { opacity: o.style === 'Clean' ? '0.04' : '0.07 + min(kick, 1) * 0.07' }); C(prev, lm, 0); C(lk, lm, 1); prev = lm;
  then('transform', 'punch', { edge: 3 }, { scale: '1 + min(kick, 1) * (energy > 0.72 ? 0.018 : 0.008) + rise * 0.07' });
  then('radialblur', 'rise_blur', { samples: 24 }, { amount: 'rise * rise * 0.08 + cutpulse * 0.02' });
  then('rgbshift', 'split', { jitter: 0.0008 }, { amount: 'min(kick, 1) * (energy > 0.72 ? 0.0035 : 0.0015) + cutpulse * 0.003 + mosh(0) * 0.002', angle: 'beat * 45' });
  then('chromab', 'fringe', {}, { amount: '0.0015 + mosh(0) * 0.003' });
  then('bloom', 'glow', { threshold: 0.7, radius: 0.75 }, { intensity: `${sty.glow} + min(kick, 1) * 0.16 + flash * 0.5` });
  then('grade', 'grade', { contrast: 1.07, saturation: 1.05, temperature: 0.06, pivot: 0.2 }, { exposure: 'flash * 0.9 + cutpulse * 0.15' });
  then('halation', 'halation', { threshold: 0.55, strength: 0.8, radius: 0.012 });
  const lb = then('wgsl', 'letterbox', {}, { p1: 'letterbox_amount' });
  project.setParam(lb.id, 'code', 'fn op(uv: vec2f) -> vec4f {\n  let c = textureSampleLevel(a, smp, uv, 0.0);\n  let h = u.p1 * 0.115;\n  if (uv.y < h || uv.y > 1.0 - h) { return vec4f(0.0, 0.0, 0.0, 1.0); }\n  return c;\n}', false);
  then('vhs', 'tape', { speed: 0.6, chromaShift: 0.003, chromaBleed: 0.01, noise: 0.03, jitter: 0.0008, wobble: 0.0015, tracking: 0.15, headSwitch: 0.25 }, { intensity: `${sty.tape} + mosh(0) * 0.3 + cutpulse * 0.2` });
  then('grain', 'grain', { amount: 0.065 });
  then('vignette', 'vignette', { amount: 0.36 });
  const out = N('io', 'out', 'out1'); C(prev, out); project.setDisplay(out.id);
  const G = (key: string, name: string, note: string, exposed: [string, string, string][]) => { const vid = makeGroup(made[key], name, exposed.map(([node, param, label]) => ({ node, param, label }))); project.tx(d => { const g = d.groups?.find(q => 'g:' + q.id === vid); if (g) g.note = note; }); };
  G('dm', 'Depth & Mattes', 'Finds the subject by depth and tracks the scene. The matte drives the subject effects; the tracked grid keeps projected footage glued to the walls.', [['subject_matte', 'low', 'Subject cut-off'], ['subject_matte', 'feather', 'Matte softness'], ['subject_edge', 'amount', 'Ragged edge'], ['uv', 'parallax', 'Projection depth']]);
  G('bl', 'Blends', 'Combines a shot with the Second picture track. Choose the blend per clip: right-click a clip in the timeline.', [['spirit', 'opacity', 'Spirit strength'], ['double', 'opacity', 'Double exposure'], ['second_projected', 'shade', 'Projection shading'], ['cutout', 'paper', 'Torn paper rim']]);
  G('tr', 'Transitions', 'Datamosh transitions between clips. Choose the kind and length per clip: right-click a clip.', [['mosh_carry', 'amount', 'Carry strength'], ['mosh_bloom', 'amount', 'Bloom strength'], ['mosh_ghost', 'residual', 'Ghost burn'], ['mosh_cross', 'amount', 'Cross strength']]);
  G('fx', 'Subject FX', 'Effects on the person or objects in each shot, chosen per clip. They fade in and out with the shot.', [['twins', 'opacity', 'Twins'], ['echoes', 'opacity', 'Echoes'], ['trail', 'persistence', 'Trail length'], ['duplicates', 'opacity', 'Duplicates'], ['practicals', 'intensity', 'Lamp glints']]);
  G('lf', 'Light & Film', 'Camera punch, glow, grade and film texture over the whole edit.', [['grade', 'contrast', 'Contrast'], ['grade', 'saturation', 'Saturation'], ['glow', 'threshold', 'Glow threshold'], ['tape', 'chromaBleed', 'Tape bleed'], ['grain', 'amount', 'Grain'], ['vignette', 'amount', 'Vignette']]);
  for (const g of project.doc.groups ?? []) tidy(g.id);
  tidy(null);
}

// ---------------- entry point ----------------
export async function autoEdit(o: EditOptions, onStage: (s: string) => void): Promise<{ ok: boolean; text: string }> {
  const doc = project.doc;
  const song = musicTrack();
  if (!song) return { ok: false, text: 'Import a song first: Auto Edit cuts your footage to the music.' };
  const pool = footagePool(doc);
  if (!pool.length) return { ok: false, text: 'Import some footage first: one long video works, several clips give more variety.' };
  if (!doc.sections.length) analyzeSong();
  onStage('Measuring motion in your footage…');
  const sources = await measure(pool, onStage);
  onStage('Cutting to the beat…');
  const songLen = engine.audio.tracks.get(song.id)?.buffer.duration ?? doc.settings.duration;
  const region = o.regionOnly && doc.region ? doc.region : null;
  const start = region ? region[0] : song.start, end = region ? region[1] : song.start + songLen;
  const p = plan(project.doc, sources, o, start, end);
  if (!p.main.length) return { ok: false, text: 'Your clips are too short for the shot lengths this pace needs. Try a faster pace.' };
  const secs = project.doc.sections;
  const low = secs.map((s, i) => [s, secs[i + 1]?.t ?? end] as const).filter(([s]) => s.level < 0.4 && s.t > start + 1).map(([s, e]) => [s.t, e] as [number, number]);
  project.batch(() => {
    project.tx(d => {
      d.pool = pool;
      d.tracks = [{ id: uid('t'), name: 'Shots', clips: p.main }, { id: uid('t'), name: 'Second picture', clips: p.second }];
      if (end > d.settings.duration) d.settings.duration = Math.ceil(end);
      d.region = [p.start, p.end];
    });
    buildNetwork(o, p.rises, low);
  });
  engine.restart();
  ui.set({ sel: [], groupView: null, bottomTab: 'timeline' });
  const withFx = p.main.filter(c => c.fx).length, moshes = p.main.filter(c => c.trans && c.trans < 5).length, blends = p.main.filter(c => c.blend).length;
  return { ok: true, text: `${p.main.length} shots from ${(n => n === 1 ? 'your video' : `${n} videos`)(new Set(p.main.map(c => c.path)).size)} · ${withFx} with effects · ${moshes} moshes · ${blends} blends. Right-click any clip to change it; Re-roll for a different cut.` };
}
