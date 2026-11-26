// Inspector field primitives: scrub-able numeric field, toggle, colour picker, popover shell.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { fmt } from './state';

interface NumProps {
  value: number; onChange(v: number): void; onCommit?(): void;
  min?: number; max?: number; step?: number; unit?: string; int?: boolean;
  def?: number; driven?: boolean; live?: number;
  /** Small prefix inside the field, e.g. an axis letter. */
  axis?: string;
  /** Modulation reaching this value: each is drawn as a span from the set value, as wide as its depth. */
  mods?: { amt: number; color: string }[];
}

/**
 * Drag horizontally to scrub (Shift = fine, Alt = coarse), click to type, Cmd-click to reset.
 * The fill shows the position inside the soft range; values outside the range are allowed when typed.
 */
export function Num({ value, onChange, onCommit, min, max, step, unit, int, def, driven, live, axis, mods }: NumProps) {
  const [edit, setEdit] = useState<string | null>(null);
  const drag = useRef<{ x: number; v: number; moved: boolean } | null>(null);
  const range = min !== undefined && max !== undefined ? max - min : undefined;
  const st = step ?? (int ? 1 : range ? Math.pow(10, Math.floor(Math.log10(range / 200))) : 0.01);
  const shown = driven && live !== undefined ? live : value;
  const fill = range ? Math.min(1, Math.max(0, (shown - min!) / range)) : 0;

  const down = (e: React.PointerEvent) => {
    if (edit !== null || e.button !== 0) return;
    if (e.metaKey && def !== undefined) { onChange(def); onCommit?.(); return; }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, v: value, moved: false };
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    if (!d.moved && Math.abs(dx) < 3) return;
    d.moved = true;
    const per = (range ? range / 260 : st * 2) * (e.shiftKey ? 0.1 : e.altKey ? 10 : 1);
    let v = d.v + dx * per;
    if (min !== undefined) v = Math.max(min, v);
    if (max !== undefined) v = Math.min(max, v);
    v = int ? Math.round(v) : Math.round(v / (st * 0.1)) * (st * 0.1);
    onChange(v);
  };
  const up = () => {
    const d = drag.current; drag.current = null;
    if (!d) return;
    if (!d.moved) setEdit(int ? String(value) : String(+value.toFixed(5)));
    else onCommit?.();
  };
  const finish = (s: string) => {
    setEdit(null);
    const v = parseFloat(s);
    if (Number.isFinite(v)) { onChange(int ? Math.round(v) : v); onCommit?.(); }
  };

  return (
    <div className={`num${edit !== null ? ' edit' : ''}${driven ? ' driven' : ''}${axis === 'X' ? ' ax-x' : axis === 'Y' ? ' ax-y' : ''}`} onPointerDown={down} onPointerMove={move} onPointerUp={up}
      onDoubleClick={() => { if (def !== undefined && edit === null) { onChange(def); onCommit?.(); } }}
      onWheel={e => {
        if (edit !== null || !e.shiftKey && Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
        // wheel nudges only while Alt is held, so scrolling the inspector never changes values by accident
        if (!e.altKey) return;
        let v = value - Math.sign(e.deltaY) * st * (e.shiftKey ? 0.1 : 1);
        if (min !== undefined) v = Math.max(min, v); if (max !== undefined) v = Math.min(max, v);
        onChange(int ? Math.round(v) : v);
      }}>
      {range !== undefined && <div className="fill" style={{ width: `${fill * 100}%` }} />}
      {range !== undefined && mods?.map((m, i) => {
        const base = Math.min(1, Math.max(0, (value - min!) / range)), lo = Math.max(0, Math.min(base, base + m.amt)), hi = Math.min(1, Math.max(base, base + m.amt));
        return <div key={i} className="modspan" style={{ left: `${lo * 100}%`, width: `${(hi - lo) * 100}%`, bottom: i * 3, background: m.color }} />;
      })}
      {range !== undefined && mods?.length ? <div className="modtick" style={{ left: `${fill * 100}%` }} /> : null}
      {edit === null
        ? <div className="val">{axis && <span className="axis">{axis}</span>}{int ? Math.round(shown) : fmt(shown, st)}{unit && <span className="unit">{unit}</span>}</div>
        : <input autoFocus defaultValue={edit} onFocus={e => e.target.select()} onBlur={e => finish(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') finish((e.target as HTMLInputElement).value); else if (e.key === 'Escape') setEdit(null); e.stopPropagation(); }} />}
    </div>
  );
}

/** Rotary control for angles: drag around the dial; pairs with a Num for exact entry. */
export function Dial({ value, onChange, onCommit }: { value: number; onChange(v: number): void; onCommit?(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const st = useRef<{ last: number; acc: number } | null>(null);
  const ang = (e: React.PointerEvent) => { const r = ref.current!.getBoundingClientRect(); return (Math.atan2(e.clientY - r.top - r.height / 2, e.clientX - r.left - r.width / 2) * 180) / Math.PI; };
  return (
    <div ref={ref} className="dial" title="Drag to rotate"
      onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); st.current = { last: ang(e), acc: value }; }}
      onPointerMove={e => {
        const s = st.current; if (!s) return;
        const a = ang(e); let d = a - s.last; if (d > 180) d -= 360; if (d < -180) d += 360;
        s.last = a; s.acc += d; onChange(e.shiftKey ? Math.round(s.acc / 15) * 15 : Math.round(s.acc * 10) / 10);
      }}
      onPointerUp={() => { st.current = null; onCommit?.(); }}>
      <i style={{ transform: `rotate(${value}deg)` }} />
    </div>
  );
}

/** Segmented choice for short option lists — one click instead of open-then-pick. */
export function Seg({ options, value, onChange }: { options: string[]; value: number; onChange(v: number): void }) {
  return <div className="seg">{options.map((o, i) => <button key={i} className={i === value ? 'on' : ''} title={o} onClick={() => onChange(i)}>{o}</button>)}</div>;
}

export function Toggle({ on, onChange }: { on: boolean; onChange(v: boolean): void }) {
  return <button className={`check${on ? ' on' : ''}`} role="checkbox" aria-checked={on} onClick={() => onChange(!on)} />;
}

/** Fixed-position popover that closes on outside press or Escape and stays inside the window. */
export function Pop({ x, y, onClose, className, children }: { x: number; y: number; onClose(): void; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  useLayoutEffect(() => {
    const r = ref.current!.getBoundingClientRect();
    setPos({ x: Math.max(6, Math.min(x, innerWidth - r.width - 6)), y: Math.max(6, Math.min(y, innerHeight - r.height - 6)) });
  }, [x, y]);
  useEffect(() => {
    const d = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('pointerdown', d, true); window.addEventListener('keydown', k, true);
    return () => { window.removeEventListener('pointerdown', d, true); window.removeEventListener('keydown', k, true); };
  }, [onClose]);
  return createPortal(<div ref={ref} className={`pop ${className ?? ''}`} style={{ left: pos.x, top: pos.y }}>{children}</div>, document.body);
}

export interface CtxItem { label: string; hint?: string; run?(): void; disabled?: boolean; sep?: boolean; sub?: CtxItem[] }
export function CtxMenu({ x, y, items, onClose }: { x: number; y: number; items: CtxItem[]; onClose(): void }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <Pop x={x} y={y} onClose={onClose} className="ctx">
      {items.map((it, i) => it.sep ? <div key={i} className="ctx-sep" onPointerEnter={() => setOpen(null)} />
        : it.sub ? <SubItem key={i} it={it} open={open === i} onOpen={() => setOpen(i)} onClose={onClose} />
        : <button key={i} className="ctx-item" disabled={it.disabled} onPointerEnter={() => setOpen(null)} onClick={() => { onClose(); it.run?.(); }}>{it.label}<span>{it.hint}</span></button>)}
    </Pop>
  );
}
/** A menu row that opens a second menu beside it on hover (fixed position, so the parent's clipping doesn't cut it). */
function SubItem({ it, open, onOpen, onClose }: { it: CtxItem; open: boolean; onOpen(): void; onClose(): void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const sub = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    if (!open || !ref.current) { setPos(null); return; }
    const r = ref.current.getBoundingClientRect(), w = sub.current?.offsetWidth ?? 220, h = sub.current?.offsetHeight ?? 0;
    const x = r.right + w + 4 > innerWidth ? r.left - w - 4 : r.right + 4;
    setPos({ x, y: Math.max(6, Math.min(r.top - 5, innerHeight - h - 6)) });
  }, [open]);
  const empty = !it.sub!.length;
  // the submenu is a sibling of the row, not inside it, so the row's hover colours never leak into it
  return (
    <>
      <button ref={ref} className={`ctx-item has-sub${open ? ' open' : ''}`} disabled={it.disabled || empty} onPointerEnter={onOpen} onClick={onOpen}>
        {it.label}<span>{empty ? it.hint ?? 'none' : '›'}</span>
      </button>
      {open && !empty && (
        <div ref={sub} className="pop ctx ctx-sub" style={{ position: 'fixed', left: pos?.x ?? -9999, top: pos?.y ?? -9999 }}>
          {it.sub!.map((c, j) => c.sep ? <div key={j} className="ctx-sep" />
            : <button key={j} className="ctx-item" disabled={c.disabled} onClick={() => { onClose(); c.run?.(); }}>{c.label}<span>{c.hint}</span></button>)}
        </div>
      )}
    </>
  );
}

// ---------- colour ----------
function hsv2rgb(h: number, s: number, v: number): [number, number, number] {
  const f = (n: number) => { const k = (n + h * 6) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [f(5), f(3), f(1)];
}
function rgb2hsv(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, mx ? d / mx : 0, mx];
}
const hex = (c: number[]) => '#' + c.slice(0, 3).map(v => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
const css = (c: number[]) => `rgba(${c.slice(0, 3).map(v => Math.round(Math.min(1, Math.max(0, v)) * 255)).join(',')},${c[3] ?? 1})`;

export function ColorField({ value, onChange, onCommit }: { value: number[]; onChange(v: number[]): void; onCommit?(): void }) {
  const [open, setOpen] = useState<{ x: number; y: number } | null>(null);
  return (
    <>
      <button className="swatch" onClick={e => { const r = e.currentTarget.getBoundingClientRect(); setOpen({ x: r.left - 214, y: r.top }); }}><i style={{ background: css(value) }} /></button>
      <HexInput value={value} onChange={v => { onChange(v); onCommit?.(); }} />
      {open && <Pop x={open.x} y={open.y} onClose={() => { setOpen(null); onCommit?.(); }}><Picker value={value} onChange={onChange} /></Pop>}
    </>
  );
}

function HexInput({ value, onChange }: { value: number[]; onChange(v: number[]): void }) {
  const [t, setT] = useState<string | null>(null);
  const apply = (s: string) => {
    setT(null);
    const m = /^#?([0-9a-f]{6})$/i.exec(s.trim());
    if (m) onChange([0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16) / 255).concat(value[3] ?? 1));
  };
  return <input className="txt mono" style={{ fontSize: 10.5 }} value={t ?? hex(value)} onChange={e => setT(e.target.value)} onBlur={e => apply(e.target.value)}
    onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); e.stopPropagation(); }} />;
}

function Picker({ value, onChange }: { value: number[]; onChange(v: number[]): void }) {
  const sv = useRef<HTMLCanvasElement>(null);
  const hue = useRef<HTMLCanvasElement>(null);
  const init = rgb2hsv(value[0], value[1], value[2]);
  const hRef = useRef(init[0]);
  const [h, s, v] = (() => { const c = rgb2hsv(value[0], value[1], value[2]); if (c[1] > 0.001 && c[2] > 0.001) hRef.current = c[0]; return [hRef.current, c[1], c[2]]; })();
  const a = value[3] ?? 1;

  useEffect(() => {
    const c = sv.current!.getContext('2d')!;
    const [r, g, b] = hsv2rgb(h, 1, 1).map(x => Math.round(x * 255));
    const gx = c.createLinearGradient(0, 0, 188, 0); gx.addColorStop(0, '#fff'); gx.addColorStop(1, `rgb(${r},${g},${b})`);
    c.fillStyle = gx; c.fillRect(0, 0, 188, 120);
    const gy = c.createLinearGradient(0, 0, 0, 120); gy.addColorStop(0, 'rgba(0,0,0,0)'); gy.addColorStop(1, '#000');
    c.fillStyle = gy; c.fillRect(0, 0, 188, 120);
    c.strokeStyle = v > 0.5 ? '#000' : '#fff'; c.lineWidth = 1.5;
    c.beginPath(); c.arc(s * 188, (1 - v) * 120, 4.5, 0, 7); c.stroke();
    const hc = hue.current!.getContext('2d')!;
    for (let x = 0; x < 188; x++) { const [r2, g2, b2] = hsv2rgb(x / 188, 1, 1); hc.fillStyle = `rgb(${r2 * 255},${g2 * 255},${b2 * 255})`; hc.fillRect(x, 0, 1, 12); }
    hc.fillStyle = '#fff'; hc.fillRect(h * 188 - 1, 0, 2, 12); hc.strokeStyle = '#000'; hc.lineWidth = 0.5; hc.strokeRect(h * 188 - 1, 0, 2, 12);
  });

  const dragOn = (fn: (x: number, y: number) => void) => (e: React.PointerEvent<HTMLCanvasElement>) => {
    const el = e.currentTarget; el.setPointerCapture(e.pointerId);
    const go = (ev: { clientX: number; clientY: number }) => { const r = el.getBoundingClientRect(); fn(Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height))); };
    go(e);
    const mv = (ev: PointerEvent) => go(ev);
    const end = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', end); };
    el.addEventListener('pointermove', mv); el.addEventListener('pointerup', end);
  };
  return (
    <div className="picker">
      <canvas ref={sv} width={188} height={120} onPointerDown={dragOn((x, y) => onChange([...hsv2rgb(h, x, 1 - y), a]))} />
      <canvas ref={hue} width={188} height={12} onPointerDown={dragOn(x => { hRef.current = x; onChange([...hsv2rgb(x, Math.max(s, 0.002), Math.max(v, 0.002)), a]); })} />
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <span className="dim" style={{ width: 34 }}>Alpha</span>
        <Num value={a} min={0} max={1} step={0.01} onChange={x => onChange([value[0], value[1], value[2], x])} />
      </div>
    </div>
  );
}
