// Automation lanes: any parameter drawn as an editable curve under the timeline. Points are dragged, and the pen tools
// write whole shapes (freehand, steps, ramps, sine) onto the beat grid — editing the motion itself, not a list of numbers.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Key, Lane, NodeData, ParamDef } from '../nerve/types';
import { evalKeys } from '../nerve/engine';
import { getOp } from '../nerve/registry';
import { uid } from '../nerve/project';
import { CAT_COLOR, engine, project, ui } from './state';
import { CtxMenu, type CtxItem } from './Fields';
import { HEAD, tv } from './tlview';

export type LaneTool = 'point' | 'draw' | 'step' | 'ramp' | 'sine';
export const GRIDS: [string, number][] = [['1 bar', 4], ['1/2', 2], ['1/4', 1], ['1/8', 0.5], ['1/16', 0.25]];
let st = { tool: 'point' as LaneTool, grid: 1 };
const subs = new Set<() => void>();
export const laneUI = {
  get: () => st,
  set(p: Partial<typeof st>) { st = { ...st, ...p }; subs.forEach(f => f()); },
  use: () => useSyncExternalStore(f => { subs.add(f); return () => { subs.delete(f); }; }, () => st),
};

const LANE_H = 78, PAD = 9;
/** A lane to scroll to and flash once (set when a lane is opened from elsewhere). */
let focusLane: { key: string; at: number; scrolled: boolean } | null = null;

interface Info { lane: Lane; node: NodeData; pd: ParamDef; keys: Key[]; lo: number; hi: number; color: string; label: string; base: number }
function info(lane: Lane): Info | null {
  const node = project.node(lane.node), def = node && getOp(node.type), pd = def?.params.find(p => p.name === lane.param);
  if (!node || !def || !pd) return null;
  const ps = node.params[lane.param];
  const keys = ps?.keys?.[lane.comp] ?? [];
  const raw = ps?.v ?? (pd as any).def;
  const base = Array.isArray(raw) ? +raw[lane.comp] : +raw;
  let lo = 'min' in pd && typeof pd.min === 'number' ? pd.min : 0, hi = 'max' in pd && typeof pd.max === 'number' ? pd.max : 1;
  // show the part of the range the curve actually uses when the parameter's full range would flatten it
  const vs = keys.length ? keys.map(k => k.v) : [base];
  const kmin = Math.min(...vs), kmax = Math.max(...vs);
  if (kmin >= 0 && kmax <= 1 && hi - lo > 4) { lo = 0; hi = 1; }
  else if (kmin < lo || kmax > hi) { lo = Math.min(lo, kmin); hi = Math.max(hi, kmax); }
  const comps = pd.k === 'vec2' ? ['X', 'Y'] : pd.k === 'color' ? ['R', 'G', 'B', 'A'] : null;
  return { lane, node, pd, keys, lo, hi, base, color: CAT_COLOR[def.category] ?? '#9a9aa3', label: ((pd as any).label ?? pd.name) + (comps ? ` ${comps[lane.comp]}` : '') };
}

function writeKeys(lane: Lane, keys: Key[], coalesce?: string) {
  const sorted = keys.slice().sort((a, b) => a.t - b.t);
  project.patchParam(lane.node, lane.param, s => { const ks = s.keys ? [...s.keys] : []; ks[lane.comp] = sorted.length ? sorted : null; s.keys = ks.some(k => k?.length) ? ks : undefined; }, coalesce);
}

// ---------------- actions ----------------
export function addLane(nodeId: string, param: string, comp = 0) {
  const d = project.doc;
  if (!d.lanes?.some(l => l.node === nodeId && l.param === param && l.comp === comp)) {
    const lane: Lane = { id: uid('l'), node: nodeId, param, comp };
    project.batch(() => {
      project.tx(doc => { (doc.lanes ??= []).push(lane); });
      const i = info(lane);
      // a lane needs a curve to show: start with a flat line at the parameter's present value
      if (i && !i.keys.length) writeKeys(lane, [{ t: 0, v: i.base }]);
    });
  }
  focusLane = { key: `${nodeId}:${param}:${comp}`, at: performance.now(), scrolled: false };
  const ps = project.node(nodeId)?.params[param];
  ui.set({ bottomTab: 'timeline', ...(ps?.ex?.[comp] ? { status: 'This parameter has an expression, which overrides the curve. Remove the expression to see the curve.' } : {}) });
}
export function removeLane(id: string) { project.tx(d => { d.lanes = (d.lanes ?? []).filter(l => l.id !== id); }); }
/** Add a lane for every parameter that already has keyframes (recorded moves, older projects). */
export function showKeyedLanes() {
  let n = 0;
  project.tx(d => {
    const have = new Set((d.lanes ?? []).map(l => `${l.node}:${l.param}:${l.comp}`));
    for (const node of d.nodes) for (const [name, ps] of Object.entries(node.params)) (ps.keys ?? []).forEach((ks, comp) => {
      if (ks?.length && !have.has(`${node.id}:${name}:${comp}`)) { (d.lanes ??= []).push({ id: uid('l'), node: node.id, param: name, comp }); n++; }
    });
  });
  ui.set({ status: n ? `Showing ${n} automated parameter${n > 1 ? 's' : ''} as lanes` : 'No other automated parameters' });
}
export function keyedCount() {
  let n = 0;
  for (const node of project.doc.nodes) for (const ps of Object.values(node.params)) for (const ks of ps.keys ?? []) if (ks?.length) n++;
  return n;
}
/** Remove points that sit on the line between their neighbours (Ramer–Douglas–Peucker). */
export function simplifyLane(lane: Lane, tolerance = 0.02) {
  const i = info(lane);
  if (!i || i.keys.length < 3) return;
  const pts = i.keys, eps = tolerance * (i.hi - i.lo || 1);
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const rec = (a: number, b: number) => {
    let worst = 0, at = -1;
    for (let k = a + 1; k < b; k++) {
      const u = (pts[k].t - pts[a].t) / Math.max(1e-9, pts[b].t - pts[a].t);
      const d = Math.abs(pts[k].v - (pts[a].v + (pts[b].v - pts[a].v) * u));
      if (d > worst) { worst = d; at = k; }
    }
    if (at >= 0 && worst > eps) { keep[at] = 1; rec(a, at); rec(at, b); }
  };
  rec(0, pts.length - 1);
  for (let k = 0; k < pts.length; k++) if (pts[k].ease === 'hold') keep[k] = 1;
  const out = pts.filter((_, k) => keep[k]);
  writeKeys(lane, out);
  ui.set({ status: `Simplified ${i.node.name} ${i.label}: ${pts.length} points to ${out.length}` });
}

// ---------------- canvas ----------------
export function LaneArea() {
  const ref = useRef<HTMLCanvasElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: CtxItem[] } | null>(null);
  useEffect(() => {
    const cv = ref.current!;
    const c = cv.getContext('2d')!;
    let sy = 0;
    let hover: { lane: number; key: number } | null = null;
    let mouse = { x: -1, y: -1 };
    type Drag =
      | { k: 'pt'; lane: Lane; idx: number }
      | { k: 'pen'; lane: Lane; orig: Key[]; tool: LaneTool; cells: Map<number, number>; last: { cell: number; v: number }; t0: number; v0: number };
    let drag: Drag | null = null;
    const X = (t: number) => HEAD + (t - tv.t0) * tv.pps;
    const T = (x: number) => tv.t0 + (x - HEAD) / tv.pps;
    const lanes = () => (project.doc.lanes ?? []).map(info).filter((i): i is Info => !!i);
    const yOf = (i: Info, n: number, v: number) => n * LANE_H - sy + LANE_H - PAD - ((v - i.lo) / (i.hi - i.lo || 1)) * (LANE_H - PAD * 2);
    const vOf = (i: Info, n: number, y: number) => { const v = i.lo + ((n * LANE_H - sy + LANE_H - PAD - y) / (LANE_H - PAD * 2)) * (i.hi - i.lo); const c2 = Math.min(i.hi, Math.max(i.lo, v)); return i.pd.k === 'int' ? Math.round(c2) : c2; };
    const beatSec = () => 60 / project.doc.settings.bpm;
    const cellLen = () => beatSec() * laneUI.get().grid;
    const cellOf = (t: number) => Math.floor((t - (project.doc.settings.offset ?? 0)) / cellLen() + 1e-6);
    const cellT = (n: number) => (project.doc.settings.offset ?? 0) + n * cellLen();

    const draw = () => {
      const dpr = devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
      if (!w || !h) return;
      if (cv.width !== Math.round(w * dpr)) cv.width = Math.round(w * dpr);
      if (cv.height !== Math.round(h * dpr)) cv.height = Math.round(h * dpr);
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.fillStyle = '#0e0e10'; c.fillRect(0, 0, w, h);
      const L = lanes(), s = project.doc.settings;
      if (focusLane && !focusLane.scrolled) {
        const n = L.findIndex(q => `${q.lane.node}:${q.lane.param}:${q.lane.comp}` === focusLane!.key);
        if (n >= 0) { sy = n * LANE_H - Math.max(0, (h - LANE_H) / 2); focusLane.scrolled = true; }
      }
      sy = Math.max(0, Math.min(sy, L.length * LANE_H - h));
      const bs = beatSec(), off = s.offset ?? 0;
      let div = 1; while (div * bs * tv.pps < 9) div *= 2;
      const tool = laneUI.get().tool;
      L.forEach((i, n) => {
        const y0 = n * LANE_H - sy;
        if (y0 > h || y0 + LANE_H < 0) return;
        c.fillStyle = n % 2 ? '#101012' : '#121215'; c.fillRect(HEAD, y0, w - HEAD, LANE_H);
        // beat grid
        const b0 = Math.max(0, Math.floor((tv.t0 - off) / bs / div) * div);
        for (let b = b0; b * bs + off <= T(w); b += div) {
          const x = Math.round(X(b * bs + off)) + 0.5;
          if (x < HEAD) continue;
          c.strokeStyle = b % 16 === 0 ? 'rgba(255,255,255,0.075)' : b % 4 === 0 ? 'rgba(255,255,255,0.045)' : 'rgba(255,255,255,0.02)';
          c.beginPath(); c.moveTo(x, y0); c.lineTo(x, y0 + LANE_H); c.stroke();
        }
        // value guides at 0, 50 and 100 % of the range
        for (const f of [0, 0.5, 1]) { const y = Math.round(y0 + LANE_H - PAD - f * (LANE_H - PAD * 2)) + 0.5; c.strokeStyle = f === 0.5 ? 'rgba(255,255,255,0.035)' : 'rgba(255,255,255,0.06)'; c.beginPath(); c.moveTo(HEAD, y); c.lineTo(w, y); c.stroke(); }
        // curve, sampled per pixel so eased segments draw as they play
        c.save(); c.beginPath(); c.rect(HEAD, y0, w - HEAD, LANE_H); c.clip();
        const val = (t: number) => (i.keys.length ? evalKeys(i.keys, t) : i.base);
        c.beginPath();
        for (let x = HEAD; x <= w; x += 1) { const y = yOf(i, n, val(T(x))); x === HEAD ? c.moveTo(x, y) : c.lineTo(x, y); }
        c.strokeStyle = i.color; c.lineWidth = 1.7; c.lineJoin = 'round'; c.stroke();
        c.lineTo(w, y0 + LANE_H); c.lineTo(HEAD, y0 + LANE_H); c.closePath();
        const g = c.createLinearGradient(0, y0, 0, y0 + LANE_H); g.addColorStop(0, i.color + '38'); g.addColorStop(1, i.color + '05');
        c.fillStyle = g; c.fill();
        // points: only when there is room to grab them
        const dense = i.keys.length > 1 && (X(i.keys[i.keys.length - 1].t) - X(i.keys[0].t)) / i.keys.length < 5;
        i.keys.forEach((k, ki) => {
          const x = X(k.t); if (x < HEAD - 6 || x > w + 6) return;
          const y = yOf(i, n, k.v), hot = hover?.lane === n && hover.key === ki;
          if (dense && !hot) { c.fillStyle = i.color; c.fillRect(x - 1, y - 1, 2, 2); return; }
          c.beginPath();
          if (k.ease === 'hold') c.rect(x - (hot ? 5 : 3.5), y - (hot ? 5 : 3.5), hot ? 10 : 7, hot ? 10 : 7); else c.arc(x, y, hot ? 5.5 : 3.6, 0, 7);
          c.fillStyle = hot ? '#fff' : '#0e0e10'; c.fill(); c.lineWidth = 1.6; c.strokeStyle = i.color; c.stroke();
        });
        // live value at the playhead
        const px = X(engine.time);
        if (px >= HEAD && px <= w) { const y = yOf(i, n, val(engine.time)); c.beginPath(); c.arc(px, y, 3.2, 0, 7); c.fillStyle = '#e6b450'; c.fill(); }
        // pen preview: the grid cell under the cursor
        if (tool !== 'point' && !drag && mouse.x >= HEAD && mouse.y >= y0 && mouse.y < y0 + LANE_H) {
          const cn = cellOf(T(mouse.x)), xa = X(cellT(cn)), xb = X(cellT(cn + 1));
          c.fillStyle = 'rgba(230,180,80,0.08)'; c.fillRect(xa, y0, xb - xa, LANE_H);
        }
        c.restore();
        c.fillStyle = '#000'; c.fillRect(0, y0 + LANE_H - 1, w, 1);
        // header
        c.fillStyle = '#18181b'; c.fillRect(0, y0, HEAD - 1, LANE_H - 1);
        const fl = focusLane && `${i.lane.node}:${i.lane.param}:${i.lane.comp}` === focusLane.key ? 1 - (performance.now() - focusLane.at) / 1600 : 0;
        if (fl > 0) { c.fillStyle = `rgba(230,180,80,${(0.22 * fl).toFixed(3)})`; c.fillRect(0, y0, w, LANE_H - 1); }
        c.fillStyle = i.color; c.fillRect(0, y0, 3, LANE_H - 1);
        c.textBaseline = 'middle'; c.textAlign = 'left';
        c.save(); c.beginPath(); c.rect(0, y0, HEAD - 30, LANE_H); c.clip();
        c.font = '600 11px "Instrument Sans", "Instrument Sans", -apple-system, sans-serif'; c.fillStyle = '#e4e4e8'; const named = i.node.type === 'sigconst' || i.label.toLowerCase() === 'value'; c.fillText(named ? i.node.name : i.label, 12, y0 + 16);
        c.font = '10px "Instrument Sans", -apple-system, sans-serif'; c.fillStyle = '#7a7a84'; c.fillText(named ? 'signal' : i.node.name, 12, y0 + 31);
        c.font = '500 11px "Fragment Mono", ui-monospace, monospace'; c.fillStyle = i.color; c.fillText(fmtV(val(engine.time)), 12, y0 + 52);
        c.font = '9px "Instrument Sans", -apple-system, sans-serif'; c.fillStyle = '#55555d'; c.fillText(`${i.keys.length} point${i.keys.length === 1 ? '' : 's'}`, 12, y0 + 66);
        c.restore();
        c.font = '9px "Fragment Mono", ui-monospace, monospace'; c.fillStyle = '#55555d'; c.textAlign = 'right';
        c.fillText(fmtV(i.hi), HEAD - 7, y0 + PAD + 1); c.fillText(fmtV(i.lo), HEAD - 7, y0 + LANE_H - PAD);
        c.beginPath(); c.roundRect(HEAD - 26, y0 + 26, 18, 18, 3); c.fillStyle = '#26262a'; c.fill();
        c.font = '600 10px "Instrument Sans", -apple-system, sans-serif'; c.fillStyle = '#9a9aa3'; c.textAlign = 'center'; c.fillText('×', HEAD - 17, y0 + 35.5);
      });
      c.fillStyle = '#000'; c.fillRect(HEAD - 1, 0, 1, h);
      const px = Math.round(X(engine.time)) + 0.5;
      if (px >= HEAD) { c.strokeStyle = 'rgba(230,180,80,0.9)'; c.lineWidth = 1; c.beginPath(); c.moveTo(px, 0); c.lineTo(px, h); c.stroke(); }
      const xe = X(s.duration);
      if (xe < w) { c.fillStyle = 'rgba(0,0,0,0.45)'; c.fillRect(Math.max(HEAD, xe), 0, w - xe, h); }
    };
    const off = engine.onFrame(draw);

    const pos = (e: MouseEvent) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const laneAt = (y: number) => { const L = lanes(), n = Math.floor((y + sy) / LANE_H); return L[n] ? { i: L[n], n } : null; };
    const keyAt = (i: Info, n: number, x: number, y: number) => {
      let best = -1, bd = 8;
      i.keys.forEach((k, ki) => { const d = Math.hypot(X(k.t) - x, yOf(i, n, k.v) - y); if (d < bd) { bd = d; best = ki; } });
      return best;
    };
    const snap = (t: number, e: MouseEvent) => {
      if (e.shiftKey) return Math.max(0, t);
      const g = cellLen() / (laneUI.get().grid >= 1 ? 4 : 1), o = project.doc.settings.offset ?? 0;
      const q = Math.round((t - o) / g) * g + o;
      return Math.max(0, Math.abs(q - t) * tv.pps < 6 ? q : t);
    };
    /** Rebuild a lane from the pen stroke so far: the original curve outside the painted cells, the shape inside. */
    const applyPen = (d: Extract<Drag, { k: 'pen' }>, vNow: number, tNow: number) => {
      const cl = cellLen(), eps = Math.min(0.004, cl / 50);
      let a: number, b: number;
      const shape: Key[] = [];
      if (d.tool === 'draw' || d.tool === 'step') {
        const cs = [...d.cells.keys()].sort((p, q) => p - q);
        a = cellT(cs[0]); b = cellT(cs[cs.length - 1] + 1);
        for (const cn of cs) shape.push({ t: cellT(cn), v: d.cells.get(cn)!, ...(d.tool === 'step' ? { ease: 'hold' as const } : {}) });
        if (d.tool === 'draw') shape.push({ t: b - eps, v: d.cells.get(cs[cs.length - 1])! });
      } else {
        const ca = cellOf(Math.min(d.t0, tNow)), cb = cellOf(Math.max(d.t0, tNow));
        a = cellT(ca); b = cellT(cb + 1);
        for (let cn = ca; cn <= cb; cn++) {
          const s0 = cellT(cn);
          if (d.tool === 'ramp') shape.push({ t: s0, v: d.v0 }, { t: s0 + cl - eps, v: vNow });
          else for (let k = 0; k < 16; k++) shape.push({ t: s0 + (k / 16) * cl, v: (d.v0 + vNow) / 2 + ((d.v0 - vNow) / 2) * Math.cos((k / 16) * Math.PI * 2) });
        }
      }
      const before = d.orig.filter(k => k.t < a - 1e-6), after = d.orig.filter(k => k.t > b + 1e-6);
      const resume = d.orig.length ? evalKeys(d.orig, b) : vNow;
      writeKeys(d.lane, [...before, ...shape.filter(k => k.t >= 0), { t: b, v: resume }, ...after], `lane:${d.lane.id}`);
    };

    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      cv.focus();
      const { x, y } = pos(e), hit = laneAt(y);
      if (!hit) return;
      const { i, n } = hit;
      if (x < HEAD) { if (x > HEAD - 28 && Math.abs(y - (n * LANE_H - sy + 35)) < 11) removeLane(i.lane.id); else ui.set({ sel: [i.node.id] }); return; }
      try { cv.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      project.commit();
      const tool = laneUI.get().tool, ki = keyAt(i, n, x, y);
      if (tool === 'point' || ki >= 0) {
        if (ki >= 0) { drag = { k: 'pt', lane: i.lane, idx: ki }; return; }
        const k: Key = { t: snap(T(x), e), v: vOf(i, n, y) };
        const keys = [...i.keys, k].sort((p, q) => p.t - q.t);
        writeKeys(i.lane, keys, `lane:${i.lane.id}`);
        drag = { k: 'pt', lane: i.lane, idx: keys.indexOf(k) };
        return;
      }
      const cn = cellOf(T(x)), v = vOf(i, n, y);
      drag = { k: 'pen', lane: i.lane, orig: i.keys.map(k => ({ ...k })), tool, cells: new Map([[cn, v]]), last: { cell: cn, v }, t0: T(x), v0: v };
      applyPen(drag, v, T(x));
    };
    const move = (e: PointerEvent) => {
      const { x, y } = pos(e); mouse = { x, y };
      if (!drag) {
        const hit = laneAt(y), ki = hit && x >= HEAD ? keyAt(hit.i, hit.n, x, y) : -1;
        hover = hit && ki >= 0 ? { lane: hit.n, key: ki } : null;
        cv.style.cursor = hover ? 'grab' : x >= HEAD && hit ? (laneUI.get().tool === 'point' ? 'crosshair' : 'cell') : 'default';
        return;
      }
      const L = lanes(), n = L.findIndex(q => q.lane.id === drag!.lane.id), i = L[n];
      if (!i) return;
      if (drag.k === 'pt') {
        const d = drag, keys = i.keys.map(k => ({ ...k })), k = keys[d.idx];
        if (!k) return;
        const lo = d.idx > 0 ? keys[d.idx - 1].t + 1e-3 : 0, hi = d.idx < keys.length - 1 ? keys[d.idx + 1].t - 1e-3 : Infinity;
        k.t = Math.min(hi, Math.max(lo, snap(T(x), e))); k.v = vOf(i, n, y);
        hover = { lane: n, key: d.idx };
        writeKeys(i.lane, keys, `lane:${i.lane.id}`);
      } else {
        const d = drag, cn = cellOf(T(Math.max(HEAD, x))), v = vOf(i, n, y);
        if (d.tool === 'draw' || d.tool === 'step') {
          // fill every cell between the last sample and this one so fast strokes leave no gaps
          const a = d.last.cell, steps = Math.abs(cn - a);
          for (let q = 0; q <= steps; q++) { const cc = a + Math.sign(cn - a) * q; d.cells.set(cc, steps ? d.last.v + (v - d.last.v) * (q / steps) : v); }
          d.last = { cell: cn, v };
        }
        applyPen(d, v, T(Math.max(HEAD, x)));
      }
    };
    const up = () => { if (drag) { drag = null; project.commit(); } };
    const dbl = (e: MouseEvent) => {
      const { x, y } = pos(e), hit = laneAt(y);
      if (!hit || x < HEAD) return;
      const ki = keyAt(hit.i, hit.n, x, y);
      if (ki >= 0 && hit.i.keys.length > 1) writeKeys(hit.i.lane, hit.i.keys.filter((_, q) => q !== ki));
    };
    const ctx = (e: MouseEvent) => {
      e.preventDefault();
      const { x, y } = pos(e), hit = laneAt(y);
      if (!hit) return;
      const { i, n } = hit, ki = x >= HEAD ? keyAt(i, n, x, y) : -1, items: CtxItem[] = [];
      if (ki >= 0) {
        const setEase = (ease: Key['ease']) => writeKeys(i.lane, i.keys.map((k, q) => (q === ki ? { ...k, ease } : k)));
        const cur = i.keys[ki].ease ?? 'lin';
        for (const [label, ease] of [['Straight', 'lin'], ['Smooth', 'smooth'], ['Ease in', 'in'], ['Ease out', 'out'], ['Hold (step)', 'hold']] as [string, Key['ease']][]) items.push({ label, hint: cur === ease ? '●' : '', run: () => setEase(ease) });
        items.push({ sep: true, label: '' }, { label: 'Delete Point', disabled: i.keys.length < 2, run: () => writeKeys(i.lane, i.keys.filter((_, q) => q !== ki)) });
      } else {
        items.push({ label: 'Simplify Curve', disabled: i.keys.length < 3, run: () => simplifyLane(i.lane) });
        items.push({ label: 'Flatten to Current Value', run: () => writeKeys(i.lane, [{ t: 0, v: i.keys.length ? evalKeys(i.keys, engine.time) : i.base }]) });
        items.push({ sep: true, label: '' }, { label: 'Hide Lane', run: () => removeLane(i.lane.id) });
        items.push({ label: 'Remove Automation', run: () => { writeKeys(i.lane, []); removeLane(i.lane.id); } });
      }
      setMenu({ x: e.clientX, y: e.clientY, items });
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const { x } = pos(e);
      if (e.ctrlKey || e.metaKey) { const t = T(x); tv.pps = Math.min(2000, Math.max(0.5, tv.pps * Math.exp(-e.deltaY * 0.01))); tv.t0 = t - (x - HEAD) / tv.pps; }
      else if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) tv.t0 = Math.max(-20 / tv.pps, tv.t0 + (e.deltaX || e.deltaY) / tv.pps);
      else sy += e.deltaY;
    };
    const leave = () => { mouse = { x: -1, y: -1 }; hover = null; };
    cv.addEventListener('pointerdown', down); cv.addEventListener('pointermove', move); cv.addEventListener('pointerup', up);
    cv.addEventListener('dblclick', dbl); cv.addEventListener('contextmenu', ctx); cv.addEventListener('pointerleave', leave);
    cv.addEventListener('wheel', wheel, { passive: false });
    return () => {
      off(); cv.removeEventListener('pointerdown', down); cv.removeEventListener('pointermove', move); cv.removeEventListener('pointerup', up);
      cv.removeEventListener('dblclick', dbl); cv.removeEventListener('contextmenu', ctx); cv.removeEventListener('pointerleave', leave); cv.removeEventListener('wheel', wheel);
    };
  }, []);
  return <div className="lanes"><canvas ref={ref} tabIndex={0} />{menu && <CtxMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}</div>;
}

const fmtV = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));

const TOOL_ICON: Record<LaneTool, string> = {
  point: 'M2 12 L6 5 L10 9 L14 3', draw: 'M2 11c2-6 3 3 5-2s2-6 4-3 2 3 3 1', step: 'M2 12h3V7h3V10h3V4h3',
  ramp: 'M2 12L6 4V12L10 4V12L14 4', sine: 'M2 8c1.5-6 3-6 4.5 0s3 6 4.5 0 2.2-4 3-2',
};
const TOOL_NAME: Record<LaneTool, string> = { point: 'Points: click to add, drag to move, double-click to delete', draw: 'Draw freehand on the grid', step: 'Steps: one held value per grid cell', ramp: 'Ramp: drag across cells, start height to end height', sine: 'Sine: drag across cells, top to bottom sets the swing' };
/** Tool and grid picker shown in the timeline's toolbar while lanes exist. */
export function LaneTools() {
  const s = laneUI.use();
  return (
    <>
      <div className="lane-tools">
        {(Object.keys(TOOL_ICON) as LaneTool[]).map(t => (
          <button key={t} className={s.tool === t ? 'on' : ''} title={TOOL_NAME[t]} onClick={() => laneUI.set({ tool: t })}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d={TOOL_ICON[t]} /></svg>
          </button>
        ))}
      </div>
      <div className="lane-tools grid" title="Grid the pens write on">
        {GRIDS.map(([label, g]) => <button key={label} className={s.grid === g ? 'on' : ''} onClick={() => laneUI.set({ grid: g })}>{label}</button>)}
      </div>
    </>
  );
}
