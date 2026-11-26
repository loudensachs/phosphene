// Network editor: custom canvas renderer with live node thumbnails composited from a WebGPU atlas.
import { useEffect, useRef, useState } from 'react';
import { CtxMenu, type CtxItem } from './Fields';
import type { NodeData, OpDef } from '../nerve/types';
import { getOp } from '../nerve/registry';
import { CAT_COLOR, TYPE_COLOR, engine, project, ui, fmt, useUI } from './state';
import { realWire, clipGateOf, graphView, groupOf, isGroupId, makeGlobal, makeGroup, stopClipEffect, tidy, ungroup, useAsClipEffect } from './graphView';
import { CUSTOM_SLOTS, slotEffect } from '../nerve/clipfx';

const GV = () => graphView(project.doc, ui.get().groupView);

const W = 152, HEAD = 22, THUMB = 86, FOOT = 17, SIG_BODY = 34, PORT = 5, R = 6;
const SLOT_W = 192, SLOT_H = 108, COLS = 8, ROWS = 12;

interface Geo { x: number; y: number; w: number; h: number; ins: { x: number; y: number }[]; out: { x: number; y: number } }
/** Globals are small pills, not operator cards: they are routing, not effects. */
export const isPill = (n: NodeData) => n.type === 'global' || n.type === 'getglobal';
const PILL_W = 128, PILL_H = 26;
export function geo(n: NodeData, def: OpDef | undefined): Geo {
  if (isPill(n)) {
    const cy = n.y + PILL_H / 2;
    return { x: n.x, y: n.y, w: PILL_W, h: PILL_H, ins: n.type === 'global' ? [{ x: n.x, y: cy }] : [], out: { x: n.x + PILL_W, y: cy } };
  }
  const sig = def?.output === 'sig';
  const h = sig ? HEAD + SIG_BODY : HEAD + THUMB + FOOT;
  const nIn = def?.inputs.length ?? 0;
  const ins = [];
  for (let i = 0; i < nIn; i++) ins.push({ x: n.x, y: n.y + HEAD + ((i + 1) * (h - HEAD - (sig ? 0 : FOOT))) / (nIn + 1) });
  return { x: n.x, y: n.y, w: W, h, ins, out: { x: n.x + W, y: n.y + HEAD + (h - HEAD - (sig ? 0 : FOOT)) / 2 } };
}

type Drag =
  | { k: 'pan'; sx: number; sy: number; vx: number; vy: number }
  | { k: 'move'; sx: number; sy: number; start: Map<string, { x: number; y: number }>; moved: boolean }
  | { k: 'box'; x0: number; y0: number; x1: number; y1: number; add: boolean; base: string[] }
  | { k: 'wire'; from?: string; to?: { id: string; slot: number }; x: number; y: number };

type Hit =
  | { k: 'out'; id: string } | { k: 'in'; id: string; slot: number }
  | { k: 'bypass'; id: string } | { k: 'display'; id: string } | { k: 'node'; id: string }
  | { k: 'wire'; from: string; to: string; slot: number; notch: boolean } | null;
interface Wire { from: string; to: string; slot: number }

let clipboard: { nodes: NodeData[]; conns: { from: string; to: string; slot: number }[] } | null = null;
const history = new Map<string, Float32Array>();

export function frameSel() { frameNodes(true); }
export function frameAll() { frameNodes(false); }
function frameNodes(onlySel: boolean) {
  const el = document.querySelector('.graph') as HTMLElement | null;
  const gv = GV(), sel = ui.get().sel, nodes = onlySel && sel.length ? gv.nodes.filter(n => sel.includes(n.id)) : gv.nodes;
  if (!el || !nodes.length) return;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) { const g = geo(n, gv.defOf(n.id)); x0 = Math.min(x0, g.x); y0 = Math.min(y0, g.y); x1 = Math.max(x1, g.x + g.w); y1 = Math.max(y1, g.y + g.h); }
  const r = el.getBoundingClientRect();
  const k = Math.min(onlySel ? 0.9 : 1, Math.min((r.width - 160) / (x1 - x0), (r.height - 160) / (y1 - y0)));
  ui.set({ view: { k, x: r.width / 2 - ((x0 + x1) / 2) * k, y: r.height / 2 - ((y0 + y1) / 2) * k } });
}

export function copySel() {
  const sel = new Set(ui.get().sel);
  if (!sel.size) return;
  clipboard = JSON.parse(JSON.stringify({
    nodes: project.doc.nodes.filter(n => sel.has(n.id)),
    conns: project.doc.conns.filter(c => sel.has(c.to)),
  }));
}
export function pasteClip(dx = 30, dy = 30) {
  if (!clipboard) return;
  ui.set({ sel: project.paste(clipboard.nodes, clipboard.conns, dx, dy) });
  for (const n of clipboard.nodes) { n.x += dx; n.y += dy; }
}
export function deleteSel() { const s = ui.get().sel; if (s.length) { project.removeNodes(s); ui.set({ sel: [] }); } }
export function groupSel() {
  const sel = ui.get().sel.filter(id => !isGroupId(id));
  if (sel.length < 2) { ui.set({ status: 'Select two or more operators to group them.' }); return; }
  const g = makeGroup(sel);
  if (g) ui.set({ sel: [g], status: 'Grouped. Double-click the box to open it; right-click a parameter inside and choose Show on group to put it on the box.' });
}
export function enterGroup(vid: string | null) { ui.set({ groupView: vid ? vid.slice(2) : null, sel: [] }); requestAnimationFrame(frameAll); }

export function Graph() {
  const ref = useRef<HTMLCanvasElement>(null);
  const inside = useUI(s => s.groupView);
  const insideName = inside ? project.doc.groups?.find(g => g.id === inside)?.name : null;
  const [nodeMenu, setNodeMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const openNodeMenu = useRef(setNodeMenu); openNodeMenu.current = setNodeMenu;

  useEffect(() => {
    const cv = ref.current!;
    const c2 = cv.getContext('2d')!;
    const atlas = document.createElement('canvas');
    atlas.width = SLOT_W * COLS; atlas.height = SLOT_H * ROWS;
    const actx = engine.configure(atlas);
    let drag: Drag | null = null;
    let mouse = { x: 0, y: 0 };
    let hover: Hit = null;
    let space = false;
    /** While a loose node is dragged over a connection: the wire it would be slotted into on release. */
    let dropWire: Wire | null = null;
    const sameWire = (a: Wire | null, b: Wire | null) => !!a && !!b && a.from === b.from && a.to === b.to && a.slot === b.slot;
    const bez = (ax: number, ay: number, bx: number, by: number, t: number) => {
      const d = Math.max(30, Math.min(120, Math.abs(bx - ax) * 0.5)), u = 1 - t;
      return { x: u * u * u * ax + 3 * u * u * t * (ax + d) + 3 * u * t * t * (bx - d) + t * t * t * bx, y: u * u * u * ay + 3 * u * u * t * ay + 3 * u * t * t * by + t * t * t * by };
    };
    const wireEnds = (cn: Wire) => {
      const gv = GV(), a = gv.nodes.find(n => n.id === cn.from), b = gv.nodes.find(n => n.id === cn.to);
      if (!a || !b) return null;
      const ga = geo(a, gv.defOf(a.id)), gb = geo(b, gv.defOf(b.id));
      return gb.ins[cn.slot] ? { a: ga.out, b: gb.ins[cn.slot] } : null;
    };
    /** Closest connection to a point, within `tol` world units; `rect` instead tests a node-sized box. */
    const wireAt = (wx: number, wy: number, tol: number, rect?: { x: number; y: number; w: number; h: number }, ok?: (c: Wire) => boolean): { c: Wire; d: number; notch: boolean } | null => {
      let best: { c: Wire; d: number; notch: boolean } | null = null;
      for (const cn of GV().conns) {
        const e = wireEnds(cn);
        if (!e || (ok && !ok(cn))) continue;
        let dmin = Infinity;
        for (let i = 1; i < 24; i++) {
          const p = bez(e.a.x, e.a.y, e.b.x, e.b.y, i / 24);
          const dd = rect ? (p.x > rect.x && p.x < rect.x + rect.w && p.y > rect.y && p.y < rect.y + rect.h ? Math.hypot(p.x - wx, p.y - wy) * 0.01 : Infinity) : Math.hypot(p.x - wx, p.y - wy);
          if (dd < dmin) dmin = dd;
        }
        if (dmin > tol || (best && best.d <= dmin)) continue;
        const mid = bez(e.a.x, e.a.y, e.b.x, e.b.y, 0.5);
        best = { c: { from: cn.from, to: cn.to, slot: cn.slot }, d: dmin, notch: Math.hypot(mid.x - wx, mid.y - wy) < tol * 1.5 };
      }
      return best;
    };

    const toWorld = (sx: number, sy: number) => { const v = ui.get().view; return { x: (sx - v.x) / v.k, y: (sy - v.y) / v.k }; };
    const local = (e: { clientX: number; clientY: number }) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

    const hitTest = (wx: number, wy: number): Hit => {
      const gv = GV(), nodes = gv.nodes;
      const pr = 8 / Math.max(0.6, ui.get().view.k);
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i], def = gv.defOf(n.id), g = geo(n, def);
        if (isGroupId(n.id)) continue;   // a group's ports are its members'; rewire inside the group
        if (Math.hypot(wx - g.out.x, wy - g.out.y) < pr) return { k: 'out', id: n.id };
        for (let s = 0; s < g.ins.length; s++) if (Math.hypot(wx - g.ins[s].x, wy - g.ins[s].y) < pr) return { k: 'in', id: n.id, slot: s };
      }
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i], def = gv.defOf(n.id), g = geo(n, def);
        if (wx >= g.x && wx <= g.x + g.w && wy >= g.y && wy <= g.y + g.h) {
          if (def?.output !== 'sig' && !isPill(n) && wy > g.y + g.h - FOOT) {
            if (wx < g.x + 26) return { k: 'bypass', id: n.id };
            if (wx > g.x + g.w - 26) return { k: 'display', id: n.id };
          }
          return { k: 'node', id: n.id };
        }
      }
      const wr = wireAt(wx, wy, 7 / Math.max(0.5, ui.get().view.k));
      if (wr) return { k: 'wire', ...wr.c, notch: wr.notch };
      return null;
    };

    // ---------- drawing ----------
    const wirePath = (ax: number, ay: number, bx: number, by: number) => {
      const d = Math.max(30, Math.min(120, Math.abs(bx - ax) * 0.5));
      c2.beginPath(); c2.moveTo(ax, ay); c2.bezierCurveTo(ax + d, ay, bx - d, by, bx, by);
    };

    const hexA = (hex: string, a: number) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };
    const gridLayer = (ox: number, oy: number, step: number, cw: number, ch: number, alpha: number) => {
      if (step < 7) return;
      c2.beginPath();
      for (let x = ((ox % step) + step) % step; x < cw; x += step) { const px = Math.round(x) + 0.5; c2.moveTo(px, 0); c2.lineTo(px, ch); }
      for (let y = ((oy % step) + step) % step; y < ch; y += step) { const py = Math.round(y) + 0.5; c2.moveTo(0, py); c2.lineTo(cw, py); }
      c2.strokeStyle = `rgba(255,255,255,${alpha})`; c2.lineWidth = 1; c2.stroke();
    };

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const cw = cv.clientWidth, ch = cv.clientHeight;
      if (!cw || !ch) return;
      if (cv.width !== Math.round(cw * dpr) || cv.height !== Math.round(ch * dpr)) { cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr); }
      const { view, sel } = ui.get();
      const doc = project.doc, gv = GV();
      const selSet = new Set(sel);
      c2.setTransform(dpr, 0, 0, dpr, 0, 0);
      c2.fillStyle = '#0c0c0e'; c2.fillRect(0, 0, cw, ch);

      // 2.5D backdrop: a far grid plane that drifts at half speed behind the working grid
      const kd = 0.35 + view.k * 0.3;
      gridLayer(cw / 2 + (view.x - cw / 2) * 0.45, ch / 2 + (view.y - ch / 2) * 0.45, 190 * kd, cw, ch, 0.022);
      gridLayer(view.x, view.y, 24 * view.k, cw, ch, 0.026);
      gridLayer(view.x, view.y, 120 * view.k, cw, ch, 0.05);
      const vg = c2.createRadialGradient(cw / 2, ch / 2, Math.min(cw, ch) * 0.35, cw / 2, ch / 2, Math.max(cw, ch) * 0.75);
      vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.5)');
      c2.fillStyle = vg; c2.fillRect(0, 0, cw, ch);

      // visible nodes + thumbnail atlas
      const geos = new Map<string, Geo>();
      const defs = new Map<string, OpDef | undefined>();
      const slots = new Map<string, number>();
      const x0 = -view.x / view.k, y0 = -view.y / view.k, x1 = (cw - view.x) / view.k, y1 = (ch - view.y) / view.k;
      let slot = 0;
      const detail = view.k > 0.32;
      for (const n of gv.nodes) {
        const def = gv.defOf(n.id), g = geo(n, def);
        geos.set(n.id, g); defs.set(n.id, def);
        const vis = g.x + g.w > x0 && g.x < x1 && g.y + g.h > y0 && g.y < y1;
        if (vis && detail && def && def.output !== 'sig' && slot < COLS * ROWS && engine.viewOf(gv.real(n.id))) {
          engine.present(actx, gv.real(n.id), { exposure: 0, mode: 0, tonemap: false },
            [(slot % COLS) * SLOT_W, Math.floor(slot / COLS) * SLOT_H, SLOT_W, SLOT_H], slot > 0);
          slots.set(n.id, slot++);
        }
      }

      c2.setTransform(dpr * view.k, 0, 0, dpr * view.k, dpr * view.x, dpr * view.y);
      c2.lineCap = 'round';

      // wires: dark casing under a coloured core reads as depth
      for (const cn of gv.conns) {
        const a = geos.get(cn.from), b = geos.get(cn.to);
        if (!a || !b || !b.ins[cn.slot]) continue;
        const t = defs.get(cn.from)?.output ?? 'tex';
        const over = hover?.k === 'wire' && sameWire(hover, cn), target = sameWire(dropWire, cn);
        const hot = selSet.has(cn.from) || selSet.has(cn.to) || over || target;
        wirePath(a.out.x, a.out.y, b.ins[cn.slot].x, b.ins[cn.slot].y);
        c2.strokeStyle = 'rgba(0,0,0,0.65)'; c2.lineWidth = 5; c2.stroke();
        if (target) { c2.strokeStyle = 'rgba(230,180,80,0.35)'; c2.lineWidth = 9; c2.stroke(); }
        c2.strokeStyle = target ? '#e6b450' : TYPE_COLOR[t]; c2.globalAlpha = hot ? 1 : 0.7; c2.lineWidth = target ? 2.8 : hot ? 2.4 : 1.9; c2.stroke();
        c2.globalAlpha = 1;
        // insertion notch at the middle of every connection: click to slot an operator in
        if (detail && !drag) {
          const mid = bez(a.out.x, a.out.y, b.ins[cn.slot].x, b.ins[cn.slot].y, 0.5);
          const on = over && hover?.k === 'wire' && hover.notch, r = on ? 7.5 : over ? 5.5 : 3.2;
          c2.beginPath(); c2.arc(mid.x, mid.y, r, 0, 7);
          c2.fillStyle = on ? TYPE_COLOR[t] : '#17171a'; c2.fill();
          c2.lineWidth = 1.3; c2.strokeStyle = on ? '#0c0c0e' : hexA(TYPE_COLOR[t], over ? 1 : 0.6); c2.stroke();
          if (over) {
            c2.beginPath(); c2.moveTo(mid.x - r * 0.5, mid.y); c2.lineTo(mid.x + r * 0.5, mid.y); c2.moveTo(mid.x, mid.y - r * 0.5); c2.lineTo(mid.x, mid.y + r * 0.5);
            c2.strokeStyle = on ? '#0c0c0e' : TYPE_COLOR[t]; c2.lineWidth = 1.5; c2.stroke();
          }
        }
      }

      // nodes
      c2.textBaseline = 'middle';
      const sk = dpr * view.k;
      for (const n of gv.nodes) {
        const g = geos.get(n.id)!, def = defs.get(n.id), grp = isGroupId(n.id);
        if (g.x + g.w < x0 - 30 || g.x > x1 + 30 || g.y + g.h < y0 - 30 || g.y > y1 + 30) continue;
        const selected = selSet.has(n.id);
        const sig = def?.output === 'sig';
        const err = engine.nodeErr(n.id);
        const cat = err ? '#e5604f' : CAT_COLOR[def?.category ?? 'IO'] ?? '#888888';

        if (grp) {
          // a group box is drawn as a small stack of cards
          for (const off of [8, 4]) { c2.beginPath(); c2.roundRect(g.x + off, g.y - off, g.w, g.h, R); c2.fillStyle = off === 8 ? '#141417' : '#18181b'; c2.fill(); c2.strokeStyle = 'rgba(232,194,122,0.25)'; c2.lineWidth = 1; c2.stroke(); }
        }
        if (isPill(n)) {
          // a pill: ◆ marks a Global, ◇ a reader of one; the label is the global's name
          const get = n.type === 'getglobal', gname = get ? String(n.params.global?.v || '—') : n.name;
          const col = err ? '#e5604f' : '#e8c27a';
          c2.save();
          c2.shadowColor = selected ? 'rgba(230,180,80,0.45)' : 'rgba(0,0,0,0.55)'; c2.shadowBlur = 10 * sk; c2.shadowOffsetY = (selected ? 0 : 3) * sk;
          c2.beginPath(); c2.roundRect(g.x, g.y, g.w, g.h, g.h / 2); c2.fillStyle = get ? '#17171a' : '#221e16'; c2.fill();
          c2.restore();
          c2.beginPath(); c2.roundRect(g.x + 0.5, g.y + 0.5, g.w - 1, g.h - 1, g.h / 2);
          c2.lineWidth = selected ? 1.6 : 1; c2.strokeStyle = selected ? '#e6b450' : get ? 'rgba(232,194,122,0.35)' : 'rgba(232,194,122,0.6)';
          if (get) c2.setLineDash([3, 2.5]);
          c2.stroke(); c2.setLineDash([]);
          if (detail) {
            const dx = g.x + 15, dy = g.y + g.h / 2;
            c2.beginPath(); c2.moveTo(dx, dy - 4.5); c2.lineTo(dx + 4.5, dy); c2.lineTo(dx, dy + 4.5); c2.lineTo(dx - 4.5, dy); c2.closePath();
            if (get) { c2.strokeStyle = col; c2.lineWidth = 1.2; c2.stroke(); } else { c2.fillStyle = col; c2.fill(); }
            c2.font = '600 10.5px "Instrument Sans", -apple-system, sans-serif'; c2.textAlign = 'left'; c2.fillStyle = n.bypass ? '#8a8a92' : '#eee6d6';
            c2.save(); c2.beginPath(); c2.rect(g.x + 24, g.y, g.w - 34, g.h); c2.clip();
            c2.fillText(gname, g.x + 25, dy + 0.5); c2.restore();
          }
        } else {
        // body with drop shadow
        c2.save();
        c2.shadowColor = selected ? 'rgba(230,180,80,0.45)' : 'rgba(0,0,0,0.6)';
        c2.shadowBlur = (selected ? 14 : 16) * sk; c2.shadowOffsetY = (selected ? 0 : 5) * sk;
        c2.beginPath(); c2.roundRect(g.x, g.y, g.w, g.h, R); c2.fillStyle = '#19191c'; c2.fill();
        c2.restore();

        // header: category tint fading across the title
        c2.save();
        c2.beginPath(); c2.roundRect(g.x, g.y, g.w, g.h, R); c2.clip();
        c2.fillStyle = '#242428'; c2.fillRect(g.x, g.y, g.w, HEAD);
        const hg = c2.createLinearGradient(g.x, 0, g.x + g.w, 0);
        hg.addColorStop(0, hexA(cat, 0.5)); hg.addColorStop(0.75, hexA(cat, 0.08));
        c2.fillStyle = hg; c2.fillRect(g.x, g.y, g.w, HEAD);
        c2.fillStyle = 'rgba(255,255,255,0.07)'; c2.fillRect(g.x, g.y, g.w, 1);
        c2.fillStyle = 'rgba(0,0,0,0.55)'; c2.fillRect(g.x, g.y + HEAD - 1, g.w, 1);

        if (detail) {
          c2.font = '600 11px "Instrument Sans", "Instrument Sans", -apple-system, sans-serif';
          c2.fillStyle = n.bypass ? '#8a8a92' : '#f0f0f2'; c2.textAlign = 'left';
          c2.save(); c2.beginPath(); c2.rect(g.x, g.y, g.w - 40, HEAD); c2.clip();
          c2.fillText(n.name, g.x + 9, g.y + HEAD / 2 + 0.5); c2.restore();
          c2.font = '9px "Fragment Mono", ui-monospace, monospace'; c2.fillStyle = 'rgba(255,255,255,0.38)'; c2.textAlign = 'right';
          const ms = engine.nodeMs(n.id);
          c2.fillText(sig ? 'SIG' : ms >= 0.05 ? `${ms.toFixed(1)}ms` : '', g.x + g.w - 7, g.y + HEAD / 2 + 0.5);
        }

        if (sig) {
          const v = engine.sigValue(n.id);
          let hbuf = history.get(n.id);
          if (!hbuf) history.set(n.id, (hbuf = new Float32Array(72)));
          hbuf.copyWithin(0, 1); hbuf[71] = v;
          c2.fillStyle = '#0d0d0f'; c2.fillRect(g.x + 1, g.y + HEAD, g.w - 2, SIG_BODY - 1);
          if (detail) {
            let lo = Infinity, hi = -Infinity;
            for (const q of hbuf) { if (q < lo) lo = q; if (q > hi) hi = q; }
            if (hi - lo < 1e-4) { hi += 0.5; lo -= 0.5; }
            c2.beginPath();
            for (let i = 0; i < 72; i++) {
              const px = g.x + 8 + (i / 71) * 80, py = g.y + HEAD + SIG_BODY - 7 - ((hbuf[i] - lo) / (hi - lo)) * (SIG_BODY - 14);
              i ? c2.lineTo(px, py) : c2.moveTo(px, py);
            }
            c2.strokeStyle = TYPE_COLOR.sig; c2.lineWidth = 1.2; c2.stroke();
            c2.font = '500 11.5px "Fragment Mono", ui-monospace, monospace'; c2.fillStyle = '#e4e4e8'; c2.textAlign = 'right';
            c2.fillText(fmt(v), g.x + g.w - 9, g.y + HEAD + SIG_BODY / 2);
          }
        } else {
          const s = slots.get(n.id);
          if (s !== undefined) c2.drawImage(atlas, (s % COLS) * SLOT_W, Math.floor(s / COLS) * SLOT_H, SLOT_W, SLOT_H, g.x, g.y + HEAD, W, THUMB);
          else { c2.fillStyle = '#08080a'; c2.fillRect(g.x, g.y + HEAD, W, THUMB); }
          if (n.bypass) {
            c2.fillStyle = 'rgba(12,12,14,0.72)'; c2.fillRect(g.x, g.y + HEAD, W, THUMB);
            if (detail) { c2.font = '600 9px "Instrument Sans", -apple-system, sans-serif'; c2.fillStyle = '#e6b450'; c2.textAlign = 'center'; c2.fillText('BYPASSED', g.x + g.w / 2, g.y + HEAD + THUMB / 2); }
          }
          // footer: bypass flag, operator type, display flag
          const fy = g.y + g.h - FOOT;
          c2.fillStyle = '#151518'; c2.fillRect(g.x, fy, g.w, FOOT);
          c2.fillStyle = 'rgba(0,0,0,0.55)'; c2.fillRect(g.x, fy, g.w, 1);
          const disp = doc.display === n.id;
          const flag = (x: number, on: boolean, col: string, hot: boolean) => {
            c2.beginPath(); c2.roundRect(x, fy + 5, 16, 7, 3.5);
            c2.fillStyle = on ? col : hot ? '#3c3c42' : '#2a2a2e'; c2.fill();
            if (on) { c2.beginPath(); c2.arc(x + 12, fy + 8.5, 2, 0, 7); c2.fillStyle = '#111'; c2.fill(); }
          };
          flag(g.x + 7, !!n.bypass, '#e6b450', hover?.k === 'bypass' && hover.id === n.id);
          flag(g.x + g.w - 23, disp, '#5a9bd8', hover?.k === 'display' && hover.id === n.id);
          if (detail && view.k > 0.6) {
            c2.font = '9.5px "Instrument Sans", "Instrument Sans", -apple-system, sans-serif'; c2.fillStyle = '#6c6c75'; c2.textAlign = 'center';
            c2.fillText(def?.label ?? n.type, g.x + g.w / 2, fy + FOOT / 2 + 1);
          }
        }
        c2.restore();

        c2.beginPath(); c2.roundRect(g.x, g.y, g.w, g.h, R);
        c2.lineWidth = selected ? 1.6 : 1;
        c2.strokeStyle = selected ? '#e6b450' : err ? '#8a362c' : 'rgba(0,0,0,0.9)';
        c2.stroke();
        if (!selected) { c2.beginPath(); c2.roundRect(g.x + 1, g.y + 1, g.w - 2, g.h - 2, R - 1); c2.strokeStyle = 'rgba(255,255,255,0.045)'; c2.lineWidth = 1; c2.stroke(); }
        }

        // ports
        if (def) {
          const port = (x: number, y: number, col: string, filled: boolean, hot: boolean) => {
            c2.beginPath(); c2.arc(x, y, hot ? PORT + 2 : PORT, 0, 7);
            c2.fillStyle = filled ? col : '#131315'; c2.fill();
            c2.lineWidth = 2.4; c2.strokeStyle = '#0c0c0e'; c2.stroke();
            c2.beginPath(); c2.arc(x, y, hot ? PORT + 2 : PORT, 0, 7); c2.lineWidth = 1.3; c2.strokeStyle = col; c2.stroke();
          };
          def.inputs.forEach((inp, i) => {
            const on = gv.conns.some(q => q.to === n.id && q.slot === i);
            const hot = hover?.k === 'in' && hover.id === n.id && hover.slot === i;
            c2.globalAlpha = inp.optional && !on ? 0.5 : 1;
            port(g.ins[i].x, g.ins[i].y, TYPE_COLOR[inp.type], on, hot);
            c2.globalAlpha = 1;
            if (detail && (hot || selected || drag?.k === 'wire') && view.k > 0.55) {
              c2.font = '9.5px "Fragment Mono", ui-monospace, monospace'; c2.textAlign = 'right';
              const tw = c2.measureText(inp.name).width;
              c2.fillStyle = 'rgba(12,12,14,0.85)'; c2.beginPath(); c2.roundRect(g.ins[i].x - 14 - tw, g.ins[i].y - 7, tw + 8, 14, 3); c2.fill();
              c2.fillStyle = '#b6b6be'; c2.fillText(inp.name, g.ins[i].x - 10, g.ins[i].y + 0.5);
            }
          });
          port(g.out.x, g.out.y, TYPE_COLOR[def.output], true, hover?.k === 'out' && hover.id === n.id);
        }
      }

      // drop target: say what releasing will do, since the wire itself is usually hidden under the dragged node
      if (dropWire && drag?.k === 'move') {
        const id = [...drag.start.keys()][0], g = geos.get(id), ga = geos.get(dropWire.from), gb = geos.get(dropWire.to);
        if (g && ga && gb) {
          const label = 'Release to insert';
          c2.font = '600 10.5px "Instrument Sans", "Instrument Sans", -apple-system, sans-serif'; c2.textAlign = 'center'; c2.textBaseline = 'middle';
          const tw = c2.measureText(label).width + 16;
          c2.beginPath(); c2.roundRect(g.x + g.w / 2 - tw / 2, g.y - 26, tw, 19, 9.5); c2.fillStyle = '#e6b450'; c2.fill();
          c2.fillStyle = '#16130a'; c2.fillText(label, g.x + g.w / 2, g.y - 16);
        }
      }

      // pending wire
      if (drag?.k === 'wire') {
        const w = toWorld(drag.x, drag.y);
        let a = w, b = w, col: string = TYPE_COLOR.tex;
        if (drag.from) { const g = geos.get(drag.from); if (g) a = g.out; col = TYPE_COLOR[defs.get(drag.from)?.output ?? 'tex']; }
        if (drag.to) { const g = geos.get(drag.to.id); if (g) b = g.ins[drag.to.slot]; col = TYPE_COLOR[defs.get(drag.to.id)?.inputs[drag.to.slot]?.type ?? 'tex']; }
        wirePath(a.x, a.y, b.x, b.y);
        c2.strokeStyle = col; c2.lineWidth = 2; c2.setLineDash([6, 5]); c2.stroke(); c2.setLineDash([]);
      }

      c2.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (drag?.k === 'box') {
        const x = Math.min(drag.x0, drag.x1), y = Math.min(drag.y0, drag.y1), w = Math.abs(drag.x1 - drag.x0), h = Math.abs(drag.y1 - drag.y0);
        c2.fillStyle = 'rgba(230,180,80,0.07)'; c2.fillRect(x, y, w, h);
        c2.strokeStyle = 'rgba(230,180,80,0.8)'; c2.lineWidth = 1; c2.strokeRect(x + 0.5, y + 0.5, w, h);
      }

      // zoom readout + minimap
      c2.font = '10px "Fragment Mono", ui-monospace, monospace'; c2.textAlign = 'right'; c2.textBaseline = 'top'; c2.fillStyle = '#5a5a62';
      c2.fillText(`${Math.round(view.k * 100)}%`, cw - 12, 11);
      if (gv.nodes.length > 1 && cw > 520 && ch > 260) {
        let mx0 = Infinity, my0 = Infinity, mx1 = -Infinity, my1 = -Infinity;
        for (const g of geos.values()) { mx0 = Math.min(mx0, g.x); my0 = Math.min(my0, g.y); mx1 = Math.max(mx1, g.x + g.w); my1 = Math.max(my1, g.y + g.h); }
        mx0 = Math.min(mx0, x0); my0 = Math.min(my0, y0); mx1 = Math.max(mx1, x1); my1 = Math.max(my1, y1);
        const MW = 168, MH = 104, pad = 8;
        const mk = Math.min((MW - pad * 2) / (mx1 - mx0), (MH - pad * 2) / (my1 - my0));
        const bx = cw - MW - 12, by = ch - MH - 12;
        const tx = (x: number) => bx + pad + (x - mx0) * mk + ((MW - pad * 2) - (mx1 - mx0) * mk) / 2;
        const ty = (y: number) => by + pad + (y - my0) * mk + ((MH - pad * 2) - (my1 - my0) * mk) / 2;
        c2.beginPath(); c2.roundRect(bx, by, MW, MH, 5); c2.fillStyle = 'rgba(16,16,18,0.88)'; c2.fill();
        c2.strokeStyle = 'rgba(255,255,255,0.08)'; c2.lineWidth = 1; c2.stroke();
        for (const n of gv.nodes) {
          const g = geos.get(n.id)!;
          c2.fillStyle = selSet.has(n.id) ? '#e6b450' : hexA(CAT_COLOR[defs.get(n.id)?.category ?? 'IO'] ?? '#888888', 0.75);
          c2.fillRect(tx(g.x), ty(g.y), Math.max(2, g.w * mk), Math.max(2, g.h * mk));
        }
        c2.strokeStyle = 'rgba(255,255,255,0.5)'; c2.lineWidth = 1;
        c2.strokeRect(Math.round(tx(x0)) + 0.5, Math.round(ty(y0)) + 0.5, (x1 - x0) * mk, (y1 - y0) * mk);
      }
    };
    const off = engine.onFrame(draw);

    // ---------- interaction ----------
    const openMenu = (sx: number, sy: number, extra: Partial<{ from: string; to: { id: string; slot: number } }> = {}) => {
      const r = cv.getBoundingClientRect(); const w = toWorld(sx, sy);
      ui.set({ menu: { x: r.left + sx, y: r.top + sy, gx: w.x, gy: w.y, ...extra } });
    };

    const down = (e: PointerEvent) => {
      cv.focus();
      const m = local(e); const w = toWorld(m.x, m.y);
      try { cv.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      if (e.button === 1 || (e.button === 0 && space)) { const v = ui.get().view; drag = { k: 'pan', sx: m.x, sy: m.y, vx: v.x, vy: v.y }; return; }
      if (e.button !== 0) return;
      let h = hitTest(w.x, w.y);
      if (h?.k === 'wire') {
        if (e.altKey) { const rw = realWire(h); if (rw) project.disconnect(rw.to, rw.slot); hover = null; return; }
        if (h.notch) { const mid = wireEnds(h), rw = realWire(h); if (mid && rw) { const p = bez(mid.a.x, mid.a.y, mid.b.x, mid.b.y, 0.5), v = ui.get().view; openMenu(p.x * v.k + v.x, p.y * v.k + v.y, { from: rw.from, to: { id: rw.to, slot: rw.slot } }); } return; }
        h = null;   // the rest of a wire behaves like empty canvas
      }
      if (!h) { drag = { k: 'box', x0: m.x, y0: m.y, x1: m.x, y1: m.y, add: e.shiftKey, base: e.shiftKey ? ui.get().sel : [] }; if (!e.shiftKey) ui.set({ sel: [] }); return; }
      if (h.k === 'out') { drag = { k: 'wire', from: h.id, x: m.x, y: m.y }; return; }
      if (h.k === 'in') {
        const ex = project.inputOf(h.id, h.slot);
        if (ex) { project.disconnect(h.id, h.slot); drag = { k: 'wire', from: ex.from, x: m.x, y: m.y }; }
        else drag = { k: 'wire', to: { id: h.id, slot: h.slot }, x: m.x, y: m.y };
        return;
      }
      if (h.k === 'bypass') { project.setBypass([h.id]); return; }
      if (h.k === 'display') { project.setDisplay(h.id); return; }
      let sel = ui.get().sel;
      if (e.shiftKey) sel = sel.includes(h.id) ? sel.filter(s => s !== h.id) : [...sel, h.id];
      else if (!sel.includes(h.id)) sel = [h.id];
      ui.set({ sel });
      const start = new Map<string, { x: number; y: number }>();
      for (const n of GV().nodes) if (sel.includes(n.id)) start.set(n.id, { x: n.x, y: n.y });
      drag = { k: 'move', sx: w.x, sy: w.y, start, moved: false };
      project.commit();
    };

    const move = (e: PointerEvent) => {
      const m = local(e); mouse = m; const w = toWorld(m.x, m.y);
      if (!drag) { hover = hitTest(w.x, w.y); cv.style.cursor = hover?.k === 'wire' ? (hover.notch ? 'pointer' : 'default') : hover && hover.k !== 'node' ? 'crosshair' : space ? 'grab' : 'default'; return; }
      if (drag.k === 'pan') { const d = drag; ui.set(s => ({ view: { ...s.view, x: d.vx + m.x - d.sx, y: d.vy + m.y - d.sy } })); }
      else if (drag.k === 'move') {
        const dx = w.x - drag.sx, dy = w.y - drag.sy;
        if (!drag.moved && Math.hypot(dx, dy) * ui.get().view.k < 3) return;
        drag.moved = true;
        project.moveNodes([...drag.start].map(([id, p]) => ({ id, x: Math.round(p.x + dx), y: Math.round(p.y + dy) })));
        // a single unconnected node dragged across a connection offers to slot into it
        dropWire = null;
        if (drag.start.size === 1) {
          const id = [...drag.start.keys()][0], n = project.node(id);
          if (n && !isGroupId(id) && !project.doc.conns.some(c => c.from === id || c.to === id)) {
            const g = geo(n, getOp(n.type));
            { const hit = wireAt(g.x + g.w / 2, g.y + g.h / 2, 5, { x: g.x, y: g.y, w: g.w, h: g.h }, c => { const rw = realWire(c); return !!rw && project.canInsert(id, rw); })?.c; dropWire = hit ?? null; }
          }
        }
      } else if (drag.k === 'box') {
        drag.x1 = m.x; drag.y1 = m.y;
        const a = toWorld(Math.min(drag.x0, drag.x1), Math.min(drag.y0, drag.y1)), b = toWorld(Math.max(drag.x0, drag.x1), Math.max(drag.y0, drag.y1));
        const gv = GV(); const inside = gv.nodes.filter(n => { const g = geo(n, gv.defOf(n.id)); return g.x < b.x && g.x + g.w > a.x && g.y < b.y && g.y + g.h > a.y; }).map(n => n.id);
        ui.set({ sel: [...new Set([...drag.base, ...inside])] });
      } else if (drag.k === 'wire') { drag.x = m.x; drag.y = m.y; hover = hitTest(w.x, w.y); }
    };

    const up = (e: PointerEvent) => {
      const d = drag; drag = null;
      if (!d) return;
      const m = local(e); const w = toWorld(m.x, m.y);
      if (d.k === 'move') {
        project.commit();
        if (dropWire && d.start.size === 1) { const id = [...d.start.keys()][0]; const rw = realWire(dropWire); if (rw && project.insertOnWire(id, rw)) ui.set({ status: `Inserted ${project.node(id)?.name} into the connection` }); }
        dropWire = null;
      }
      if (d.k === 'wire') {
        const h = hitTest(w.x, w.y);
        if (d.from) {
          if (h?.k === 'in') project.connect(d.from, h.id, h.slot);
          else if (h?.k === 'node' || h?.k === 'bypass' || h?.k === 'display') {
            const def = getOp(project.node(h.id)?.type ?? '');
            const free = def?.inputs.findIndex((_, i) => !project.inputOf(h.id, i) && project.canConnect(d.from!, h.id, i)) ?? -1;
            const slot = free >= 0 ? free : def?.inputs.findIndex((_, i) => project.canConnect(d.from!, h.id, i)) ?? -1;
            if (slot >= 0) project.connect(d.from, h.id, slot);
          } else if (!h) openMenu(m.x, m.y, { from: d.from });
        } else if (d.to) {
          if (h && (h.k === 'out' || h.k === 'node')) project.connect(h.id, d.to.id, d.to.slot);
          else if (!h) openMenu(m.x, m.y, { to: d.to });
        }
      }
    };

    const dbl = (e: MouseEvent) => {
      const m = local(e); const w = toWorld(m.x, m.y); const h = hitTest(w.x, w.y);
      if (h?.k === 'node' && isGroupId(h.id)) enterGroup(h.id);
      else if (h?.k === 'node') project.setDisplay(h.id);
      else if (h?.k === 'wire') { const rw = realWire(h); if (rw) openMenu(m.x, m.y, { from: rw.from, to: { id: rw.to, slot: rw.slot } }); }
      else if (!h) openMenu(m.x, m.y);
    };
    const ctx = (e: MouseEvent) => { e.preventDefault(); const m = local(e); const w = toWorld(m.x, m.y); const h = hitTest(w.x, w.y); if (h?.k === 'wire') openMenu(m.x, m.y, { from: h.from, to: { id: h.to, slot: h.slot } }); else if (h?.k === 'node') { if (!ui.get().sel.includes(h.id)) ui.set({ sel: [h.id] }); openNodeMenu.current({ x: e.clientX, y: e.clientY, id: h.id }); } else if (!h) openMenu(m.x, m.y); };

    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const m = local(e); const v = ui.get().view;
      const mouseWheel = !e.ctrlKey && e.deltaX === 0 && Math.abs(e.deltaY) >= 50 && Number.isInteger(e.deltaY);
      if (e.ctrlKey || e.metaKey || mouseWheel) {
        const f = Math.exp(-e.deltaY * (mouseWheel ? 0.0015 : 0.01));
        const k = Math.min(3, Math.max(0.12, v.k * f));
        ui.set({ view: { k, x: m.x - ((m.x - v.x) / v.k) * k, y: m.y - ((m.y - v.y) / v.k) * k } });
      } else ui.set({ view: { ...v, x: v.x - e.deltaX, y: v.y - e.deltaY } });
    };

    const key = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === ' ') return; // handled globally
      if (e.key === 'Tab') { e.preventDefault(); openMenu(mouse.x, mouse.y); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSel(); }
      else if (mod && e.key === 'a') { e.preventDefault(); ui.set({ sel: GV().nodes.map(n => n.id) }); }
      else if (mod && (e.key === 'g' || e.key === 'G')) { e.preventDefault(); if (e.shiftKey) { for (const id of ui.get().sel) if (isGroupId(id)) ungroup(id); ui.set({ sel: [] }); } else groupSel(); }
      else if ((e.key === 'Escape' || e.key === 'u') && ui.get().groupView) enterGroup(null);
      else if (mod && e.key === 'c') { e.preventDefault(); copySel(); }
      else if (mod && e.key === 'x') { e.preventDefault(); copySel(); deleteSel(); }
      else if (mod && e.key === 'v') { e.preventDefault(); pasteClip(); }
      else if (mod && e.key === 'd') { e.preventDefault(); copySel(); pasteClip(); }
      else if (!mod && e.key === 'b') project.setBypass(ui.get().sel.filter(id => !isGroupId(id)));
      else if (!mod && e.key === 'd') { const s = ui.get().sel[0]; if (s) project.setDisplay(s); }
      else if (!mod && (e.key === 'h' || e.key === 'f')) frameAll();
      else if (!mod && e.key === 'l') { tidy(ui.get().groupView); requestAnimationFrame(frameAll); }
    };
    const kd = (e: KeyboardEvent) => { if (e.key === ' ') space = true; };
    const ku = (e: KeyboardEvent) => { if (e.key === ' ') space = false; };

    cv.addEventListener('pointerdown', down); cv.addEventListener('pointermove', move); cv.addEventListener('pointerup', up);
    cv.addEventListener('dblclick', dbl); cv.addEventListener('contextmenu', ctx);
    cv.addEventListener('wheel', wheel, { passive: false }); cv.addEventListener('keydown', key);
    window.addEventListener('keydown', kd); window.addEventListener('keyup', ku);
    return () => {
      off();
      cv.removeEventListener('pointerdown', down); cv.removeEventListener('pointermove', move); cv.removeEventListener('pointerup', up);
      cv.removeEventListener('dblclick', dbl); cv.removeEventListener('contextmenu', ctx);
      cv.removeEventListener('wheel', wheel); cv.removeEventListener('keydown', key);
      window.removeEventListener('keydown', kd); window.removeEventListener('keyup', ku);
    };
  }, []);

  return (
    <div className="graph">
      <canvas ref={ref} tabIndex={0} />
      <div className="graph-crumb"><b>Project</b><span>/</span>{insideName ? <><button className="crumb-btn" onClick={() => enterGroup(null)}>Network</button><span>/</span><b className="crumb-group">{insideName}</b><span className="crumb-hint">Esc to leave</span></> : <span>Network</span>}</div>
      {nodeMenu && <CtxMenu x={nodeMenu.x} y={nodeMenu.y} onClose={() => setNodeMenu(null)} items={nodeItems(nodeMenu.id)} />}
      <div className="graph-tools"><button className="btn sm" title="Lay the network out by data flow (L)" onClick={() => { tidy(ui.get().groupView); requestAnimationFrame(frameAll); }}>Tidy</button></div>
      <div className="graph-hint">
        <span><span className="kbd">Tab</span>Add operator</span><span><span className="kbd">D</span>Display</span>
        <span><span className="kbd">B</span>Bypass</span><span><span className="kbd">+</span>Click a wire's notch to insert</span><span><span className="kbd">⌥</span>Click a wire to cut</span><span><span className="kbd">⌘G</span>Group</span><span><span className="kbd">H</span>Frame all</span><span><span className="kbd">Space</span>Play</span>
      </div>
    </div>
  );
}

function nodeItems(id: string): CtxItem[] {
  if (isGroupId(id)) return [
    { label: 'Open Group', run: () => enterGroup(id) },
    { label: 'Ungroup', hint: '⇧⌘G', run: () => { ungroup(id); ui.set({ sel: [] }); } },
    { sep: true, label: '' },
    { label: 'Delete', hint: '⌫', run: deleteSel },
  ];
  const n = project.node(id), def = n && getOp(n.type);
  const tex = def?.output !== 'sig';
  const feeds = project.doc.conns.filter(c => c.from === id).length;
  const items: CtxItem[] = [];
  if (tex && n?.type !== 'global' && n?.type !== 'getglobal') items.push({
    label: feeds ? 'Make Global' : 'Send to a Global', hint: '◇',
    run: () => { const g = makeGlobal(id); if (g) ui.set({ sel: [g], status: feeds ? `${n!.name} now feeds a Global; a Get Global took its place with all ${feeds} connection${feeds > 1 ? 's' : ''}. Add more Get Globals anywhere (Tab → Get Global).` : `${n!.name} now feeds a Global. Read it anywhere with Tab → Get Global.` }); },
  });
  if (tex && n && def?.inputs.length && n.type !== 'global' && n.type !== 'getglobal' && n.type !== 'out') {
    const gate = clipGateOf(id), cur = gate ? Number((gate.params.opacity?.ex?.[0] ?? '').match(/\d+/)?.[0]) : 0;
    items.push({ label: 'Use as Clip Effect', hint: gate ? `Custom ${CUSTOM_SLOTS.indexOf(cur) + 1}` : '', sub: [
      ...CUSTOM_SLOTS.map((k, i) => { const who = slotEffect(project.doc, k); return { label: `Custom ${i + 1}`, hint: cur === k ? '●' : who ? who : 'empty', run: () => {
        const err = useAsClipEffect(id, k);
        ui.set({ status: err ?? `${n.name} is now Custom ${i + 1}. Right-click any clip on the timeline → Effect → Custom ${i + 1}: ${n.name} to use it there; it fades in and out with the clip.` });
      } }; }),
      ...(gate ? [{ sep: true, label: '' }, { label: 'Stop Using as Clip Effect', run: () => { stopClipEffect(id); ui.set({ status: `${n.name} runs on every frame again.` }); } }] : []),
    ] });
  }
  if (n?.type === 'global') items.push({ label: 'Add a Get Global', hint: '◇', run: () => {
    const g = project.addNode('getglobal', n.x + 230, n.y + 120)!; project.setParam(g.id, 'global', n.name, false); ui.set({ sel: [g.id] });
  } });
  if (n?.type === 'getglobal') { const src = project.byName(n.params.global?.v); if (src) items.push({ label: `Go to ${src.name}`, run: () => { ui.set({ sel: [src.id] }); frameSel(); } }); }
  if (items.length) items.push({ sep: true, label: '' });
  if (tex) items.push({ label: 'Display', hint: 'D', run: () => project.setDisplay(id) });
  items.push({ label: n?.bypass ? 'Turn Bypass Off' : 'Bypass', hint: 'B', run: () => project.setBypass(ui.get().sel.filter(q => !isGroupId(q))) });
  items.push({ label: 'Group Selection', hint: '⌘G', disabled: ui.get().sel.length < 2, run: groupSel });
  items.push({ sep: true, label: '' }, { label: 'Delete', hint: '⌫', run: deleteSel });
  return items;
}
