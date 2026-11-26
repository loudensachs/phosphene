// Band editor: the music's live spectrum with draggable frequency bands, like an EQ. Each band is a modulation source
// named after itself — drag its edges to choose what it listens to and its floor line to choose how loud that must be.
import { useEffect, useRef, useState } from 'react';
import type { Band } from '../nerve/types';
import { uid } from '../nerve/project';
import { engine, project, ui, useDoc } from './state';
import { Num } from './Fields';
import { Icon } from './Icon';

const FMIN = 30, FMAX = 16000;
export const BAND_COLORS = ['#e5604f', '#e6b450', '#6cc08b', '#5a9bd8', '#b58bd6', '#d88aa8', '#59c2c0'];
const RESERVED = new Set(['t', 'time', 'beat', 'bar', 'frame', 'fps', 'bpm', 'dt', 'w', 'h', 'level', 'bass', 'lowmid', 'mid', 'high', 'air', 'kick', 'onset', 'section', 'energy', 'drop', 'secphase', 'mgate', 'mpitch', 'mcount', 'mtrig', 'drums', 'bassline', 'vocals', 'other']);
export const DEFAULT_BANDS = (): Band[] => [
  { id: uid('b'), name: 'sub', lo: 30, hi: 70, gain: 1.5, floor: 0.2, attack: 0.005, release: 0.14 },
  { id: uid('b'), name: 'punch', lo: 70, hi: 180, gain: 1.5, floor: 0.2, attack: 0.005, release: 0.1 },
  { id: uid('b'), name: 'body', lo: 300, hi: 1200, gain: 1.6, floor: 0.15, attack: 0.01, release: 0.16 },
  { id: uid('b'), name: 'snap', lo: 2000, hi: 6000, gain: 2, floor: 0.15, attack: 0.003, release: 0.08 },
  { id: uid('b'), name: 'shine', lo: 8000, hi: 16000, gain: 2.5, floor: 0.1, attack: 0.003, release: 0.1 },
];
let selId: string | null = null;
const fHz = (f: number) => (f >= 1000 ? `${+(f / 1000).toFixed(f >= 10000 ? 0 : 1)}k` : `${Math.round(f)}`);
const patch = (id: string, fn: (b: Band) => void, key?: string) => project.tx(d => { const b = d.bands?.find(q => q.id === id); if (b) fn(b); }, key);

export function addBand(f = 1000) {
  const names = new Set((project.doc.bands ?? []).map(b => b.name));
  let n = 1; while (names.has(`band${n}`)) n++;
  const b: Band = { id: uid('b'), name: `band${n}`, lo: Math.max(FMIN, f / 1.5), hi: Math.min(FMAX, f * 1.5), gain: 1.5, floor: 0.15, attack: 0.005, release: 0.12 };
  project.tx(d => { (d.bands ??= []).push(b); });
  selId = b.id;
}

export function Bands() {
  const doc = useDoc();
  const ref = useRef<HTMLCanvasElement>(null);
  const [, bump] = useState(0);
  const bands = doc.bands ?? [];
  const sel = bands.find(b => b.id === selId) ?? null;

  useEffect(() => {
    const cv = ref.current!;
    const c = cv.getContext('2d')!;
    const smooth = new Float32Array(512), peak = new Float32Array(512);
    const hist = new Map<string, Float32Array>();
    const PL = 34, PR = 12, PT = 22, PB = 22;
    let hover: { id: string; part: 'lo' | 'hi' | 'floor' | 'body' } | null = null;
    let drag: { id: string; part: 'lo' | 'hi' | 'floor' | 'body'; f0: number; lo: number; hi: number } | null = null;
    const dims = () => ({ w: cv.clientWidth, h: cv.clientHeight });
    const X = (f: number) => { const { w } = dims(); return PL + (Math.log(Math.max(FMIN, Math.min(FMAX, f)) / FMIN) / Math.log(FMAX / FMIN)) * (w - PL - PR); };
    const F = (x: number) => { const { w } = dims(); return FMIN * Math.pow(FMAX / FMIN, Math.min(1, Math.max(0, (x - PL) / (w - PL - PR)))); };
    const Y = (v: number) => { const { h } = dims(); return PT + (1 - Math.min(1, Math.max(0, v))) * (h - PT - PB); };
    const V = (y: number) => { const { h } = dims(); return Math.min(1, Math.max(0, 1 - (y - PT) / (h - PT - PB))); };
    const list = () => project.doc.bands ?? [];

    const draw = () => {
      const dpr = devicePixelRatio || 1, { w, h } = dims();
      if (!w || !h) return;
      if (cv.width !== Math.round(w * dpr)) cv.width = Math.round(w * dpr);
      if (cv.height !== Math.round(h * dpr)) cv.height = Math.round(h * dpr);
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.fillStyle = '#0c0c0e'; c.fillRect(0, 0, w, h);
      const y0 = Y(0), y1 = Y(1);
      // grid
      c.font = '9.5px "Fragment Mono", ui-monospace, monospace'; c.textBaseline = 'middle';
      for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
        const x = Math.round(X(f)) + 0.5;
        c.strokeStyle = f === 100 || f === 1000 || f === 10000 ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.035)';
        c.beginPath(); c.moveTo(x, y1); c.lineTo(x, y0); c.stroke();
        c.fillStyle = '#5a5a62'; c.textAlign = 'center'; c.fillText(fHz(f), x, h - 10);
      }
      for (const v of [0, 0.25, 0.5, 0.75, 1]) {
        const y = Math.round(Y(v)) + 0.5;
        c.strokeStyle = 'rgba(255,255,255,0.04)'; c.beginPath(); c.moveTo(PL, y); c.lineTo(w - PR, y); c.stroke();
        c.fillStyle = '#4a4a52'; c.textAlign = 'right'; c.fillText(String(Math.round(v * 100)), PL - 7, y);
      }
      // spectrum: quick to rise, slow to fall, with a peak line that hangs
      const sp = engine.audio.frame.spectrum;
      for (let i = 0; i < 512; i++) { const v = sp[i] ?? 0; smooth[i] = v > smooth[i] ? v : smooth[i] + (v - smooth[i]) * 0.22; peak[i] = Math.max(v, peak[i] - 0.006); }
      const bx = (i: number) => PL + (i / 511) * (w - PL - PR);
      c.beginPath(); c.moveTo(PL, y0);
      for (let i = 0; i < 512; i++) c.lineTo(bx(i), Y(smooth[i]));
      c.lineTo(w - PR, y0); c.closePath();
      const g = c.createLinearGradient(0, y1, 0, y0); g.addColorStop(0, 'rgba(210,214,224,0.34)'); g.addColorStop(1, 'rgba(210,214,224,0.04)');
      c.fillStyle = g; c.fill();
      c.beginPath(); for (let i = 0; i < 512; i++) { const y = Y(smooth[i]); i ? c.lineTo(bx(i), y) : c.moveTo(bx(i), y); }
      c.strokeStyle = 'rgba(226,228,236,0.75)'; c.lineWidth = 1.2; c.stroke();
      c.beginPath(); for (let i = 0; i < 512; i++) { const y = Y(peak[i]); i ? c.lineTo(bx(i), y) : c.moveTo(bx(i), y); }
      c.strokeStyle = 'rgba(226,228,236,0.2)'; c.lineWidth = 1; c.stroke();

      // bands
      list().forEach((b, n) => {
        const col = BAND_COLORS[n % BAND_COLORS.length], xa = X(b.lo), xb = X(b.hi), on = b.id === selId, hot = hover?.id === b.id;
        const val = engine.bandValues.get(b.name) ?? 0;
        c.fillStyle = col + (on ? '26' : hot ? '1c' : '12'); c.fillRect(xa, y1, xb - xa, y0 - y1);
        // the column fills with the band's output, so you see it firing
        const yv = Y(val); const mg = c.createLinearGradient(0, yv, 0, y0); mg.addColorStop(0, col + 'aa'); mg.addColorStop(1, col + '22');
        c.fillStyle = mg; c.fillRect(xa, yv, xb - xa, y0 - yv);
        c.fillStyle = col; c.fillRect(xa, yv - 1, xb - xa, 2);
        // edges
        c.fillStyle = col; c.globalAlpha = on || hot ? 1 : 0.6;
        c.fillRect(Math.round(xa), y1, hover?.id === b.id && hover.part === 'lo' ? 3 : 1.5, y0 - y1);
        c.fillRect(Math.round(xb) - 1.5, y1, hover?.id === b.id && hover.part === 'hi' ? 3 : 1.5, y0 - y1);
        c.globalAlpha = 1;
        // floor: signal under this line is ignored
        const yf = Y(b.floor / Math.max(0.01, b.gain));
        c.setLineDash([4, 3]); c.strokeStyle = col; c.lineWidth = hover?.id === b.id && hover.part === 'floor' ? 2 : 1.2;
        c.beginPath(); c.moveTo(xa, yf); c.lineTo(xb, yf); c.stroke(); c.setLineDash([]);
        c.beginPath(); c.arc((xa + xb) / 2, yf, hover?.id === b.id && hover.part === 'floor' ? 5 : 3.5, 0, 7); c.fillStyle = '#0c0c0e'; c.fill(); c.strokeStyle = col; c.lineWidth = 1.5; c.stroke();
        // name tab
        c.font = '600 10.5px "Instrument Sans", "Instrument Sans", -apple-system, sans-serif'; c.textAlign = 'center';
        const tw = Math.max(c.measureText(b.name).width + 12, 30), cx = Math.min(w - PR - tw / 2, Math.max(PL + tw / 2, (xa + xb) / 2));
        c.beginPath(); c.roundRect(cx - tw / 2, 3, tw, 16, 3); c.fillStyle = on ? col : '#1c1c20'; c.fill();
        if (!on) { c.strokeStyle = col; c.lineWidth = 1; c.stroke(); }
        c.fillStyle = on ? '#111' : col; c.fillText(b.name, cx, 11.5);
        let hb = hist.get(b.id); if (!hb) hist.set(b.id, (hb = new Float32Array(160)));
        hb.copyWithin(0, 1); hb[159] = val;
      });
      // output history of the selected band, bottom right
      const s = list().find(b => b.id === selId);
      if (s) {
        const hb = hist.get(s.id), col = BAND_COLORS[list().indexOf(s) % BAND_COLORS.length], bw = 170, bh = 46, ox = w - PR - bw - 6, oy = PT + 6;
        c.fillStyle = 'rgba(12,12,14,0.86)'; c.beginPath(); c.roundRect(ox, oy, bw, bh, 4); c.fill(); c.strokeStyle = 'rgba(255,255,255,0.08)'; c.lineWidth = 1; c.stroke();
        if (hb) { c.beginPath(); for (let i = 0; i < 160; i++) { const y = oy + bh - 5 - hb[i] * (bh - 10); i ? c.lineTo(ox + 5 + i, y) : c.moveTo(ox + 5, y); } c.strokeStyle = col; c.lineWidth = 1.4; c.stroke(); }
        c.font = '9px "Instrument Sans", -apple-system, sans-serif'; c.fillStyle = '#6a6a72'; c.textAlign = 'left'; c.fillText(`${s.name} output`, ox + 6, oy + 8);
      }
      if (!list().length) { c.font = '12px "Instrument Sans", "Instrument Sans", -apple-system, sans-serif'; c.fillStyle = '#55555d'; c.textAlign = 'center'; c.fillText('Double-click the spectrum to add a band', w / 2, h / 2); }
    };
    const off = engine.onFrame(draw);

    const pos = (e: MouseEvent) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const hit = (x: number, y: number) => {
      const bs = list();
      // the selected band wins where bands overlap
      const order = [...bs].sort((a, b) => (a.id === selId ? -1 : b.id === selId ? 1 : 0));
      for (const b of order) {
        const xa = X(b.lo), xb = X(b.hi), yf = Y(b.floor / Math.max(0.01, b.gain));
        if (y < 20 && x > xa - 20 && x < xb + 20 && Math.abs(x - (xa + xb) / 2) < 40) return { id: b.id, part: 'body' as const };
        if (Math.abs(x - xa) < 6) return { id: b.id, part: 'lo' as const };
        if (Math.abs(x - xb) < 6) return { id: b.id, part: 'hi' as const };
        if (x > xa && x < xb && Math.abs(y - yf) < 7) return { id: b.id, part: 'floor' as const };
        if (x > xa && x < xb) return { id: b.id, part: 'body' as const };
      }
      return null;
    };
    const down = (e: PointerEvent) => {
      cv.focus();
      const { x, y } = pos(e), h = hit(x, y);
      selId = h?.id ?? null; bump(n => n + 1);
      if (!h) return;
      const b = list().find(q => q.id === h.id)!;
      try { cv.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      project.commit();
      drag = { ...h, f0: F(x), lo: b.lo, hi: b.hi };
    };
    const move = (e: PointerEvent) => {
      const { x, y } = pos(e);
      if (!drag) { hover = hit(x, y); cv.style.cursor = !hover ? 'default' : hover.part === 'floor' ? 'ns-resize' : hover.part === 'body' ? 'grab' : 'ew-resize'; return; }
      const d = drag, f = F(x);
      patch(d.id, b => {
        if (d.part === 'lo') b.lo = Math.max(FMIN, Math.min(f, b.hi / 1.06));
        else if (d.part === 'hi') b.hi = Math.min(FMAX, Math.max(f, b.lo * 1.06));
        else if (d.part === 'floor') b.floor = +Math.min(0.95, V(y) * b.gain).toFixed(3);
        else { const r = Math.min(FMAX / d.hi, Math.max(FMIN / d.lo, f / d.f0)); b.lo = d.lo * r; b.hi = d.hi * r; }
      }, `band:${d.id}`);
    };
    const up = () => { if (drag) { drag = null; project.commit(); } };
    const dbl = (e: MouseEvent) => { const { x, y } = pos(e); if (!hit(x, y)) { addBand(F(x)); bump(n => n + 1); } };
    const wheel = (e: WheelEvent) => {
      const { x, y } = pos(e), h = hit(x, y);
      if (!h) return;
      e.preventDefault();
      patch(h.id, b => { b.gain = +Math.min(8, Math.max(0.1, b.gain * Math.exp(-e.deltaY * 0.004))).toFixed(3); }, `bandgain:${h.id}`);
    };
    const key = (e: KeyboardEvent) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && selId) { e.preventDefault(); const id = selId; selId = null; project.tx(d => { d.bands = (d.bands ?? []).filter(b => b.id !== id); }); bump(n => n + 1); }
    };
    cv.addEventListener('pointerdown', down); cv.addEventListener('pointermove', move); cv.addEventListener('pointerup', up);
    cv.addEventListener('dblclick', dbl); cv.addEventListener('wheel', wheel, { passive: false }); cv.addEventListener('keydown', key);
    return () => { off(); cv.removeEventListener('pointerdown', down); cv.removeEventListener('pointermove', move); cv.removeEventListener('pointerup', up); cv.removeEventListener('dblclick', dbl); cv.removeEventListener('wheel', wheel); cv.removeEventListener('keydown', key); };
  }, []);

  const rename = (b: Band, raw: string) => {
    const name = raw.trim().replace(/[^\w]/g, '_');
    if (!name || name === b.name) return;
    if (/^\d/.test(name) || RESERVED.has(name) || bands.some(q => q.name === name) || project.byName(name) || doc.shapers.some(s => s.name === name)) { ui.set({ status: `"${name}" is already used by something else` }); return; }
    patch(b.id, q => { q.name = name; });
    ui.set({ status: `Band renamed to ${name}. Expressions that used ${b.name} need the new name.` });
  };
  const row = (label: string, ctl: React.ReactNode, help?: string) => <div className="band-row" title={help}><span>{label}</span><div>{ctl}</div></div>;
  const num = (b: Band, k: 'lo' | 'hi' | 'gain' | 'floor' | 'attack' | 'release', min: number, max: number, step: number, unit: string, scale = 1) => (
    <Num value={b[k] * scale} min={min} max={max} step={step} unit={unit} onChange={v => patch(b.id, q => { q[k] = v / scale; if (k === 'lo') q.lo = Math.min(q.lo, q.hi / 1.06); if (k === 'hi') q.hi = Math.max(q.hi, q.lo * 1.06); }, `band:${b.id}:${k}`)} onCommit={() => project.commit()} />
  );
  return (
    <div className="bands">
      <div className="bands-canvas"><canvas ref={ref} tabIndex={0} /></div>
      <div className="bands-side">
        {sel ? <>
          <div className="band-head"><i style={{ background: BAND_COLORS[bands.indexOf(sel) % BAND_COLORS.length] }} />
            <input key={sel.id + sel.name} defaultValue={sel.name} spellCheck={false} onBlur={e => rename(sel, e.target.value)} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); e.stopPropagation(); }} />
          </div>
          {row('From', num(sel, 'lo', FMIN, FMAX, 1, 'Hz'))}
          {row('To', num(sel, 'hi', FMIN, FMAX, 1, 'Hz'))}
          {row('Gain', num(sel, 'gain', 0.1, 8, 0.01, '×'), 'Scroll over the band to change')}
          {row('Floor', num(sel, 'floor', 0, 0.95, 0.005, ''), 'Level under which the band stays at zero. Drag the dashed line.')}
          {row('Attack', num(sel, 'attack', 0, 500, 1, 'ms', 1000), 'How fast the output rises')}
          {row('Release', num(sel, 'release', 0, 2000, 1, 'ms', 1000), 'How fast it falls back')}
          <p className="band-tip">Type <b>{sel.name}</b> in any expression, or right-click a parameter and choose <b>Modulate with {sel.name}</b>.</p>
          <button className="btn sm" onClick={() => { const id = sel.id; selId = null; project.tx(d => { d.bands = (d.bands ?? []).filter(b => b.id !== id); }); bump(n => n + 1); }}>Delete band</button>
        </> : <>
          <p className="band-tip">Each coloured column is a band of the music that drives your visuals. Drag its <b>edges</b> to choose the frequencies, the <b>dashed line</b> to set how loud it must be, and scroll over it for gain. The column lights up as the band fires.</p>
          <button className="btn sm" onClick={() => { addBand(); bump(n => n + 1); }}><Icon n="plus" size={12} />Add band</button>
          {!bands.length && <button className="btn sm" style={{ marginTop: 6 }} onClick={() => project.tx(d => { d.bands = DEFAULT_BANDS(); })}>Add the five standard bands</button>}
        </>}
      </div>
    </div>
  );
}
