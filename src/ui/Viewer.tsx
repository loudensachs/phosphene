// Viewer: the displayed node on a stage, through the view transform (exposure, channel isolate, tone map).
import { useEffect, useRef, useState } from 'react';
import type { PVec2 } from '../nerve/types';
import { getOp } from '../nerve/registry';
import { engine, project, ui, useDoc, useUI } from './state';
import { Num, Seg } from './Fields';
import { Icon } from './Icon';
import { selectedClip, setMotion } from './clipMotion';
import { motionComp } from '../nerve/motion';

const MODES = ['RGB', 'R', 'G', 'B', 'A'];

export function Viewer() {
  const ref = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const hud = useRef<HTMLDivElement>(null);
  const hud2 = useRef<HTMLDivElement>(null);
  const doc = useDoc();
  const v = useUI(s => s.viewer);
  const node = doc.nodes.find(n => n.id === doc.display);
  const isField = !!node && getOp(node.type)?.output === 'field';
  const [rect, setRect] = useState({ x: 0, y: 0, w: 1, h: 1 });

  useEffect(() => {
    const cv = ref.current!, box = wrap.current!;
    const ctx = engine.configure(cv);
    let n = 0;
    return engine.onFrame(() => {
      const dpr = window.devicePixelRatio || 1;
      const bw = box.clientWidth, bh = box.clientHeight;
      if (bw < 40 || bh < 40) return;
      const s = project.doc.settings;
      const pad = 22;
      const k = Math.min((bw - pad * 2) / s.width, (bh - pad * 2 - 6) / s.height);
      const w = Math.max(8, Math.floor(s.width * k)), h = Math.max(8, Math.floor(s.height * k));
      const x = Math.floor((bw - w) / 2), y = Math.floor((bh - h) / 2) - 3;
      if (cv.style.width !== `${w}px` || cv.style.left !== `${x}px` || cv.style.top !== `${y}px`) {
        cv.style.width = `${w}px`; cv.style.height = `${h}px`; cv.style.left = `${x}px`; cv.style.top = `${y}px`;
        hud.current!.style.cssText = `left:${x}px;top:${y + h + 5}px`;
        hud2.current!.style.cssText = `right:${bw - x - w}px;top:${y + h + 5}px`;
        setRect({ x, y, w, h });
      }
      const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
      if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
      engine.present(ctx, project.doc.display, ui.get().viewer);
      if (n++ % 6 === 0) {
        const [rw, rh] = engine.resolution();
        hud.current!.textContent = `${rw} × ${rh}   ${Math.round(k * (s.width / rw) * dpr * 100)}%`;
        hud2.current!.textContent = `${engine.fpsMeasured.toFixed(0)} fps`;
      }
    });
  }, []);

  return (
    <div className="pane" style={{ flex: 1 }}>
      <div className="pane-tabs">
        <button className="ptab on"><Icon n="eye" />Viewer<span className="count">{node ? node.name : 'nothing displayed'}</span></button>
        <div className="pane-tools">
          <span style={{ width: isField ? 192 : 164, display: 'flex', flex: 'none' }}><Seg options={isField ? [...MODES, 'Vec'] : MODES} value={v.mode} onChange={m => ui.set({ viewer: { ...v, mode: m } })} /></span>
          <span style={{ width: 58, display: 'flex', flex: 'none' }} title="View exposure in stops — does not affect the render">
            <Num value={v.exposure} min={-6} max={6} step={0.1} unit="ev" def={0} onChange={x => ui.set({ viewer: { ...v, exposure: x } })} />
          </span>
          <button className={`btn sm${v.tonemap ? ' on' : ''}`} onClick={() => ui.set({ viewer: { ...v, tonemap: !v.tonemap } })} title="ACES tone map for viewing HDR values — does not affect the render">ACES</button>
        </div>
      </div>
      <div className="stage" ref={wrap}>
        <canvas ref={ref} />
        <div className="hud" ref={hud} /><div className="hud" ref={hud2} />
        <Gizmos rect={rect} />
        <ClipHandles rect={rect} />
      </div>
    </div>
  );
}

/** Draggable handles for the selected operator's position parameters, drawn over the picture. */
function Gizmos({ rect }: { rect: { x: number; y: number; w: number; h: number } }) {
  const sel = useUI(s => s.sel);
  const doc = useDoc();
  const node = sel.length === 1 ? doc.nodes.find(n => n.id === sel[0]) : undefined;
  const def = node && getOp(node.type);
  // calibration handles only appear while calibration is switched on
  const ps = (def?.params.filter(p => p.k === 'vec2' && (p as PVec2).gizmo && (p.group !== 'Calibration' || node?.params.calibrate?.v)) ?? []) as PVec2[];
  if (!node || !ps.length) return null;
  const base = (p: PVec2): [number, number] => (p.gizmo === 'uv' ? [0, 0] : (p.gizmo as { base: [number, number] }).base);
  const pos = (p: PVec2) => { const v = node.params[p.name]?.v ?? p.def, b = base(p); return [rect.x + (b[0] + v[0]) * rect.w, rect.y + (b[1] + v[1]) * rect.h]; };
  const quad = node.type === 'surface' ? ['tl', 'tr', 'br', 'bl'].map(n => pos(ps.find(p => p.name === n)!)) : null;
  const box = node.type === 'object3d' && ps.length === 8 ? ps.map(pos) : null;
  const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const drag = (p: PVec2) => (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault(); e.stopPropagation();
    const el = e.currentTarget; el.setPointerCapture(e.pointerId); project.commit();
    const box = el.parentElement!.getBoundingClientRect(), b = base(p);
    const mv = (ev: PointerEvent) => {
      let x = (ev.clientX - box.left - rect.x) / rect.w - b[0], y = (ev.clientY - box.top - rect.y) / rect.h - b[1];
      if (ev.shiftKey) { x = Math.round(x * 100) / 100; y = Math.round(y * 100) / 100; }
      project.setParam(node.id, p.name, [+x.toFixed(4), +y.toFixed(4)]);
    };
    const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); project.commit(); };
    el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up);
  };
  return (
    <>
      {quad && <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
        <polygon points={quad.map(q => q.join(',')).join(' ')} fill="rgba(230,180,80,0.06)" stroke="#000" strokeWidth={3} />
        <polygon points={quad.map(q => q.join(',')).join(' ')} fill="none" stroke="#e6b450" strokeWidth={1.2} />
      </svg>}
      {box && <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
        {EDGES.map(([i, j], n) => <line key={n} x1={box[i][0]} y1={box[i][1]} x2={box[j][0]} y2={box[j][1]} stroke="#e6b450" strokeWidth={i >= 4 && j >= 4 ? 1.4 : 0.8} strokeDasharray={i >= 4 && j >= 4 ? undefined : '4 3'} />)}
      </svg>}
      {ps.map(p => { const [x, y] = pos(p); return <div key={p.name} className="gizmo" data-l={p.label ?? p.name} style={{ left: x, top: y }} onPointerDown={drag(p)} />; })}
    </>
  );
}

/** With a clip selected (and no operator), the picture itself is the handle: drag to move, scroll to scale, Option-drag to rotate. */
function ClipHandles({ rect }: { rect: { x: number; y: number; w: number; h: number } }) {
  const sel = useUI(s => s.sel);
  useDoc();
  const [, bump] = useState(0);
  useEffect(() => { const id = setInterval(() => bump(n => n + 1), 150); return () => clearInterval(id); }, []);
  const cl = sel.length === 0 ? selectedClip() : null;
  if (!cl) return null;
  const lt = engine.time - cl.start;
  if (lt < 0 || lt > cl.dur) return null;
  const s = project.doc.settings, k = rect.w / s.width;
  const mx = motionComp(cl, 'pos', 0, lt), my = motionComp(cl, 'pos', 1, lt), sc = motionComp(cl, 'scale', 0, lt), rot = motionComp(cl, 'rot', 0, lt);
  const cx = rect.x + rect.w / 2 + mx * k, cy = rect.y + rect.h / 2 + my * k;
  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget; el.setPointerCapture(e.pointerId); project.commit();
    const x0 = e.clientX, y0 = e.clientY, p0 = [mx, my], r0 = rot, rotate = e.altKey;
    const box = el.getBoundingClientRect(), ox = box.left + cx - rect.x, oy = box.top + cy - rect.y, a0 = Math.atan2(y0 - oy, x0 - ox);
    const mv = (ev: PointerEvent) => {
      const c2 = selectedClip(); if (!c2) return;
      if (rotate) { let d = ((Math.atan2(ev.clientY - oy, ev.clientX - ox) - a0) * 180) / Math.PI; if (ev.shiftKey) d = Math.round(d / 15) * 15; setMotion(c2, 'rot', 0, +(r0 + d).toFixed(1)); return; }
      let dx = (ev.clientX - x0) / k, dy = (ev.clientY - y0) / k;
      if (ev.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }   // shift keeps to one axis
      setMotion(c2, 'pos', 0, Math.round(p0[0] + dx)); setMotion(c2, 'pos', 1, Math.round(p0[1] + dy));
    };
    const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); project.commit(); };
    el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up);
  };
  const wheel = (e: React.WheelEvent) => {
    const c2 = selectedClip(); if (!c2) return;
    const cur = motionComp(c2, 'scale', 0, engine.time - c2.start);
    setMotion(c2, 'scale', 0, +Math.min(800, Math.max(1, cur * Math.exp(-e.deltaY * 0.0015))).toFixed(1));
  };
  return (
    <div className="clip-handles" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }} onPointerDown={down} onWheel={wheel}
      title="Drag to move · scroll to scale · Option-drag to rotate · Shift locks the axis or snaps to 15°">
      <svg width={rect.w} height={rect.h}>
        <g transform={`translate(${cx - rect.x} ${cy - rect.y}) rotate(${rot})`}>
          <rect x={(-rect.w / 2) * sc / 100} y={(-rect.h / 2) * sc / 100} width={(rect.w * sc) / 100} height={(rect.h * sc) / 100} fill="none" stroke="#e6b450" strokeWidth={1} strokeDasharray="5 4" opacity={0.8} />
          <line x1={-8} y1={0} x2={8} y2={0} stroke="#e6b450" strokeWidth={1.4} /><line x1={0} y1={-8} x2={0} y2={8} stroke="#e6b450" strokeWidth={1.4} />
        </g>
      </svg>
      <span className="clip-handles-label">{cl.name} · {Math.round(mx)}, {Math.round(my)} · {sc.toFixed(0)}% · {rot.toFixed(0)}°</span>
    </div>
  );
}
