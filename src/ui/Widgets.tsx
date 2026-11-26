// Visual controls for the parameter panel: the picture of what a group of numbers does, edited by dragging it.
import { useEffect, useRef } from 'react';
import type { NodeData, OpDef, ParamDef } from '../nerve/types';
import { engine, project } from './state';

const val = (node: NodeData, def: OpDef, name: string): any => node.params[name]?.v ?? def.params.find(p => p.name === name)?.def;
const live = (node: NodeData, name: string, fallback: any): any => engine.resolved(node.id)?.[name] ?? fallback;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const drive = (el: HTMLElement, onMove: (e: PointerEvent) => void, done?: () => void) => (e: React.PointerEvent) => {
  el.setPointerCapture(e.pointerId); project.commit(); onMove(e.nativeEvent);
  const mv = (ev: PointerEvent) => onMove(ev);
  const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); project.commit(); done?.(); };
  el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up);
};

// ---------------- XY pad ----------------
/** Two-axis position edited as a point on a pad. The faint dot is where modulation has pushed it right now. */
export function XYPad({ node, p }: { node: NodeData; p: Extract<ParamDef, { k: 'vec2' }> }) {
  const ref = useRef<HTMLDivElement>(null);
  const v = (node.params[p.name]?.v ?? p.def) as number[];
  const lv = live(node, p.name, v) as number[];
  const lo = p.min ?? -1, hi = p.max ?? 1, down = (p as any).gizmo === 'uv' || lo >= 0;
  const fx = (x: number) => clamp((x - lo) / (hi - lo), 0, 1) * 100, fy = (y: number) => (down ? clamp((y - lo) / (hi - lo), 0, 1) : 1 - clamp((y - lo) / (hi - lo), 0, 1)) * 100;
  const set = (e: PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    let x = lo + clamp((e.clientX - r.left) / r.width, 0, 1) * (hi - lo), yy = clamp((e.clientY - r.top) / r.height, 0, 1);
    let y = lo + (down ? yy : 1 - yy) * (hi - lo);
    if (!e.shiftKey) { const s = (hi - lo) / 200; x = Math.round(x / s) * s; y = Math.round(y / s) * s; }
    project.setParam(node.id, p.name, [+x.toFixed(4), +y.toFixed(4)]);
  };
  return (
    <div className="xy" ref={ref} onPointerDown={e => drive(ref.current!, set)(e)} onDoubleClick={() => project.setParam(node.id, p.name, [...p.def], false)} title="Drag to position · double-click to reset">
      <i className="xy-h" style={{ top: `${fy(v[1])}%` }} /><i className="xy-v" style={{ left: `${fx(v[0])}%` }} />
      {Array.isArray(lv) && (Math.abs(lv[0] - v[0]) > 1e-4 || Math.abs(lv[1] - v[1]) > 1e-4) && <b className="xy-live" style={{ left: `${fx(lv[0])}%`, top: `${fy(lv[1])}%` }} />}
      <b className="xy-dot" style={{ left: `${fx(v[0])}%`, top: `${fy(v[1])}%` }} />
    </div>
  );
}

// ---------------- levels ----------------
let probe: { cv: HTMLCanvasElement; ctx: GPUCanvasContext; rd: CanvasRenderingContext2D } | null = null;
/** Brightness histogram (linear light, 64 bins up to 1.5) of an operator's output, read from a tiny render of it. */
function histogram(nodeId: string): Float32Array | null {
  if (!engine.viewOf(nodeId)) return null;
  if (!probe) {
    const cv = document.createElement('canvas'); cv.width = 96; cv.height = 54;
    const rc = document.createElement('canvas'); rc.width = 96; rc.height = 54;
    probe = { cv, ctx: engine.configure(cv), rd: rc.getContext('2d', { willReadFrequently: true })! };
  }
  try {
    engine.present(probe.ctx, nodeId, { exposure: 0, mode: 0, tonemap: false });
    probe.rd.drawImage(probe.cv, 0, 0);
    const px = probe.rd.getImageData(0, 0, 96, 54).data, h = new Float32Array(64);
    for (let i = 0; i < px.length; i += 4) {
      const lin = (c: number) => Math.pow(c / 255, 2.2);
      const l = 0.2126 * lin(px[i]) + 0.7152 * lin(px[i + 1]) + 0.0722 * lin(px[i + 2]);
      h[Math.min(63, Math.floor(Math.sqrt(l / 1.5) * 64))]++;
    }
    let m = 0; for (let i = 1; i < 64; i++) m = Math.max(m, h[i]);
    for (let i = 0; i < 64; i++) h[i] = Math.min(1, h[i] / (m || 1));
    return h;
  } catch { return null; }
}
const LX = (v: number) => Math.sqrt(clamp(v, 0, 1.5) / 1.5), LV = (x: number) => clamp(x, 0, 1) ** 2 * 1.5;

/** Levels as a histogram with the transfer curve drawn over it; drag the black, grey and white markers. */
export function LevelsWidget({ node, def }: { node: NodeData; def: OpDef }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const cv = ref.current!, c = cv.getContext('2d')!;
    let hist: Float32Array | null = null, n = 0;
    const off = engine.onFrame(() => {
      const nd = project.node(node.id); if (!nd) return;
      const w = cv.clientWidth, h = cv.clientHeight, dpr = devicePixelRatio || 1;
      if (!w || !h) return;
      if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
      if (n++ % 8 === 0) { const src = project.inputOf(node.id, 0)?.from; hist = src ? histogram(src) : null; }
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.fillStyle = '#0b0b0c'; c.fillRect(0, 0, w, h);
      const P = (k: string) => +live(nd, k, val(nd, def, k));
      const ib = P('inBlack'), iw = P('inWhite'), g = P('gamma'), ob = P('outBlack'), ow = P('outWhite');
      for (const v of [0.25, 0.5, 1]) { const x = Math.round(LX(v) * w) + 0.5; c.strokeStyle = v === 1 ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.05)'; c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke(); }
      if (hist) { c.fillStyle = 'rgba(200,204,214,0.32)'; const bw = w / 64; for (let i = 0; i < 64; i++) { const bh = Math.pow(hist[i], 0.6) * (h - 4); c.fillRect(i * bw, h - bh, bw + 0.5, bh); } }
      // out-of-range input shaded
      c.fillStyle = 'rgba(0,0,0,0.5)'; c.fillRect(0, 0, LX(ib) * w, h); c.fillRect(LX(iw) * w, 0, w - LX(iw) * w, h);
      // transfer curve: what each input brightness becomes
      c.beginPath();
      for (let x = 0; x <= w; x += 2) {
        const v = LV(x / w), t = Math.pow(Math.max(0, (v - ib) / Math.max(1e-5, iw - ib)), 1 / g), o = ob + (ow - ob) * t;
        const y = h - LX(o) * h; x ? c.lineTo(x, y) : c.moveTo(x, y);
      }
      c.strokeStyle = '#e6b450'; c.lineWidth = 1.6; c.stroke();
    });
    return off;
  }, [node.id, def]);
  const v = (k: string) => +val(node, def, k);
  const ib = v('inBlack'), iw = v('inWhite'), g = v('gamma'), ob = v('outBlack'), ow = v('outWhite');
  const mid = ib + (iw - ib) * Math.pow(0.5, g);
  const at = (e: PointerEvent, el: HTMLElement) => { const r = el.getBoundingClientRect(); return LV((e.clientX - r.left) / r.width); };
  const handle = (cls: string, x: number, onMove: (v: number) => void, title: string) => (
    <i className={`lv-h ${cls}`} style={{ left: `${LX(x) * 100}%` }} title={title} onPointerDown={e => { e.stopPropagation(); drive(e.currentTarget, ev => onMove(at(ev, wrap.current!)))(e); }} />
  );
  const set = (k: string, x: number) => project.setParam(node.id, k, +x.toFixed(4));
  return (
    <div className="lv" ref={wrap}>
      <canvas ref={ref} />
      <div className="lv-track">
        {handle('black', ib, x => set('inBlack', clamp(x, 0, iw - 0.01)), 'Black point')}
        {handle('grey', mid, x => { const f = clamp((x - ib) / Math.max(1e-4, iw - ib), 0.02, 0.98); set('gamma', clamp(Math.log(f) / Math.log(0.5), 0.1, 4)); }, 'Midtones (gamma)')}
        {handle('white', iw, x => set('inWhite', clamp(x, ib + 0.01, 2)), 'White point')}
      </div>
      <div className="lv-out">
        {handle('black', ob, x => set('outBlack', clamp(x, 0, 1)), 'Output black')}
        {handle('white', ow, x => set('outWhite', clamp(x, 0, 4)), 'Output white')}
      </div>
    </div>
  );
}

// ---------------- hue wheel ----------------
/** Hue shift as rotation and saturation as distance from the centre, on a colour wheel. */
export function HueWheel({ node, def }: { node: NodeData; def: OpDef }) {
  const ref = useRef<HTMLDivElement>(null);
  const hue = +val(node, def, 'hue'), sat = +val(node, def, 'saturation');
  const lh = +live(node, 'hue', hue), ls = +live(node, 'saturation', sat);
  const R = 46, pos = (h: number, s: number) => { const a = ((h - 90) * Math.PI) / 180, r = clamp(s / 3, 0, 1) * R; return { left: 56 + Math.cos(a) * r, top: 56 + Math.sin(a) * r }; };
  const set = (e: PointerEvent) => {
    const r = ref.current!.getBoundingClientRect(), dx = e.clientX - r.left - 56, dy = e.clientY - r.top - 56;
    let h = (Math.atan2(dy, dx) * 180) / Math.PI + 90; if (h > 180) h -= 360;
    if (!e.shiftKey) h = Math.round(h);
    project.patchParam(node.id, 'hue', s => { s.v = h; }, `wheel:${node.id}`);
    if (!e.altKey) project.patchParam(node.id, 'saturation', s => { s.v = +clamp((Math.hypot(dx, dy) / R) * 3, 0, 3).toFixed(3); }, `wheel:${node.id}`);
  };
  const moved = Math.abs(lh - hue) > 0.05 || Math.abs(ls - sat) > 0.005;
  return (
    <div className="wheel-row">
      <div className="wheel" ref={ref} onPointerDown={e => drive(ref.current!, set)(e)} title="Angle = hue shift, distance = saturation · Alt locks saturation">
        <div className="wheel-ring" />
        <div className="wheel-in" style={{ transform: `rotate(${lh}deg)` }} />
        <i className="wheel-unit" style={{ width: (R / 3) * 2, height: (R / 3) * 2 }} />
        {moved && <b className="wheel-live" style={pos(lh, ls)} />}
        <b className="wheel-dot" style={pos(hue, sat)} />
      </div>
      <div className="wheel-read"><span>Hue</span><b>{lh.toFixed(0)}°</b><span>Saturation</span><b>{ls.toFixed(2)}</b><em>Outer ring is the original colour, inner ring is what it becomes.</em></div>
    </div>
  );
}

// ---------------- cosine palette preview ----------------
/** The gradient a cosine palette produces, with the live phase marked. */
export function PaletteStrip({ node, def }: { node: NodeData; def: OpDef }) {
  const P = (k: string) => live(node, k, val(node, def, k));
  const a = P('pa') as number[], b = P('pb') as number[], cc = P('pc') as number[], d = P('pd') as number[];
  if (![a, b, cc, d].every(Array.isArray)) return null;
  const freq = +P('frequency') || 1, phase = +P('phase') || 0, speed = +val(node, def, 'speed') || 0;
  const stops: string[] = [];
  const ph = phase + engine.time * speed;
  for (let i = 0; i <= 32; i++) {
    const t = (i / 32) * freq + ph;
    const ch = (k: number) => Math.round(clamp(Math.pow(clamp(a[k] + b[k] * Math.cos(6.28318 * (cc[k] * t + d[k])), 0, 1), 1 / 2.2), 0, 1) * 255);
    stops.push(`rgb(${ch(0)},${ch(1)},${ch(2)}) ${(i / 32) * 100}%`);
  }
  return <div className="pal" title="Dark picture areas take the left colours, bright areas the right"><div style={{ background: `linear-gradient(90deg, ${stops.join(',')})` }} /><span>dark</span><span>bright</span></div>;
}

/** The visual control an operator gets at the top of its parameters, if it has one. */
export function opWidget(node: NodeData, def: OpDef) {
  if (def.type === 'levels') return <LevelsWidget node={node} def={def} />;
  if (def.type === 'hsv') return <HueWheel node={node} def={def} />;
  if (def.type === 'colorama') return <PaletteStrip node={node} def={def} />;
  return null;
}
