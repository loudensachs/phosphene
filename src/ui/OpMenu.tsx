// Operator create dialog (Tab): category rail + searchable grid, fully keyboard driven.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { OpDef } from '../nerve/types';
import { allOps, getOp } from '../nerve/registry';
import { CAT_COLOR, project, ui, useUI } from './state';
import { Pop } from './Fields';
import { Icon } from './Icon';

const ORDER = ['Generate', 'Filter', 'Distort', 'Color', 'Composite', 'Time', 'Glitch', 'Spectral', 'Simulate', 'Field', 'Stage', 'Signal', 'Audio', 'IO'];

export function score(def: OpDef, q: string): number {
  const l = def.label.toLowerCase(), t = def.type;
  if (l.startsWith(q) || t.startsWith(q)) return 3;
  if (l.split(/[\s/]+/).some(w => w.startsWith(q))) return 2;
  if (l.includes(q) || t.includes(q)) return 1;
  // hidden keywords: what people call the look ("ghost", "green screen", "glow")
  const kw = def.keywords?.toLowerCase() ?? '';
  if (kw) {
    const words = q.split(/\s+/).filter(Boolean);
    if (kw.includes(q)) return 0.9;
    if (words.length > 1 && words.every(w => kw.split(/\s+/).some(k => k.startsWith(w)))) return 0.8;
    if (q.length >= 3 && kw.split(/\s+/).some(k => k.startsWith(q))) return 0.85;
  }
  // subsequence match on the name
  let i = 0;
  for (const ch of l) if (ch === q[i]) i++;
  return i === q.length ? 0.5 : 0;
}

export function OpMenu() {
  const menu = useUI(s => s.menu);
  if (!menu) return null;
  return <Menu key={`${menu.x},${menu.y}`} />;
}

function Menu() {
  const menu = ui.get().menu!;
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<string | null>(null);
  const [idx, setIdx] = useState(0);

  // when attaching a wire, only offer operators that can accept / provide it
  const pool = useMemo(() => {
    const fromDef = menu.from ? getOp(project.node(menu.from)?.type ?? '') : null;
    const toDef = menu.to ? getOp(project.node(menu.to.id)?.type ?? '') : null;
    const wantSigIn = fromDef ? fromDef.output === 'sig' : null;
    const wantSigOut = toDef ? toDef.inputs[menu.to!.slot]?.type === 'sig' : null;
    return allOps().filter(d =>
      (wantSigIn === null || d.inputs.some(i => (i.type === 'sig') === wantSigIn)) &&
      (wantSigOut === null || (d.output === 'sig') === wantSigOut));
  }, [menu]);

  const cats = ORDER.filter(c => pool.some(d => d.category === c));
  const query = q.trim().toLowerCase();
  const list = useMemo(() => {
    if (query) return pool.map(d => ({ d, s: score(d, query) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s || a.d.label.localeCompare(b.d.label)).map(x => x.d);
    return pool.filter(d => !cat || d.category === cat).sort((a, b) => ORDER.indexOf(a.category) - ORDER.indexOf(b.category) || a.label.localeCompare(b.label));
  }, [pool, query, cat]);
  const cur = list[Math.min(idx, list.length - 1)];
  // the press that opened the menu can hand focus back to the canvas or button it landed on, so take it again
  // once that press has finished: typing must always go straight into the search box
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const grab = () => { const el = box.current; if (el && document.activeElement !== el) el.focus({ preventScroll: true }); };
    grab();
    const r = requestAnimationFrame(() => requestAnimationFrame(grab)), t1 = setTimeout(grab, 60), t2 = setTimeout(grab, 180);
    window.addEventListener('pointerup', grab, { once: true });
    return () => { cancelAnimationFrame(r); clearTimeout(t1); clearTimeout(t2); window.removeEventListener('pointerup', grab); };
  }, []);
  const close = () => ui.set({ menu: null });

  const create = (def: OpDef) => project.batch(() => createNow(def));
  const createNow = (def: OpDef) => {
    const between = menu.from && menu.to ? { from: menu.from, to: menu.to.id, slot: menu.to.slot } : null;
    const node = between ? project.addNode(def.type, menu.gx - 76, menu.gy - 62) : project.addNode(def.type, menu.gx - (menu.to ? 152 : 0), menu.gy - 40);
    close();
    if (!node) return;
    if (between) {
      // opened from a connection: slot the new operator into it
      if (!project.insertOnWire(node.id, between)) ui.set({ status: `${def.label} cannot sit on that connection` });
      ui.set({ sel: [node.id] });
      (document.querySelector('.graph canvas') as HTMLElement | null)?.focus();
      return;
    }
    if (menu.from) {
      const slot = def.inputs.findIndex((_, i) => project.canConnect(menu.from!, node.id, i));
      if (slot >= 0) project.connect(menu.from, node.id, slot);
    }
    if (menu.to) project.connect(node.id, menu.to.id, menu.to.slot);
    ui.set({ sel: [node.id] });
    (document.querySelector('.graph canvas') as HTMLElement | null)?.focus();
  };

  const key = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    const cols = 3;
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(i => Math.min(list.length - 1, i + cols)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(i => Math.max(0, i - cols)); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); setIdx(i => Math.min(list.length - 1, i + 1)); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); setIdx(i => Math.max(0, i - 1)); }
    else if (e.key === 'Enter' && cur) create(cur);
    else if (e.key === 'Tab') { e.preventDefault(); close(); }
  };

  return (
    <Pop x={menu.x - 40} y={menu.y - 20} onClose={close} className="opmenu">
      <div className="opmenu-search"><Icon n="search" size={14} />
        <input ref={box} autoFocus placeholder="Search operators" spellCheck={false} value={q} onChange={e => { setQ(e.target.value); setIdx(0); }} onKeyDown={key} /></div>
      <div className="opmenu-body">
        <div className="opcats">
          <button className={`opcat${!cat && !query ? ' on' : ''}`} onClick={() => { setCat(null); setQ(''); setIdx(0); }}>All<span>{pool.length}</span></button>
          {cats.map(c => (
            <button key={c} className={`opcat${cat === c && !query ? ' on' : ''}`} onClick={() => { setCat(c); setQ(''); setIdx(0); }}>
              <i style={{ background: CAT_COLOR[c] }} />{c}<span>{pool.filter(d => d.category === c).length}</span>
            </button>
          ))}
        </div>
        <div className="oplist">
          {list.map((d, i) => (
            <button key={d.type} className={`opitem${d === cur ? ' on' : ''}`} onMouseEnter={() => setIdx(i)} onClick={() => create(d)}>
              <i style={{ background: CAT_COLOR[d.category] }} />{d.label}{(query || !cat) && <em>{d.category}</em>}
            </button>
          ))}
          {!list.length && <div className="dim" style={{ padding: 8 }}>No operators match.</div>}
        </div>
      </div>
      <div className="opmenu-foot"><span>{cur ? (cur.help ?? `${cur.label} — ${cur.category}`) : ''}</span>
        <span className="keys"><span className="kbd">↑↓←→</span> navigate&nbsp;&nbsp;<span className="kbd">↵</span> create</span></div>
    </Pop>
  );
}
