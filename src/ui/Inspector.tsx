// Parameter inspector for the selected node.
import { isKeyed, keyHere, motionDefault, resetMotion, selectedClip, setMotion, stepKey, toggleMotionKey } from './clipMotion';
import { motionComp, type MotionProp } from '../nerve/motion';
import { exposeParam, groupOf, isGroupId, ungroup } from './graphView';
import { enterGroup } from './Graph';
import { DRAG_TYPE, SourceStrip, sourceColor, sourceValue } from './Mod';
import { XYPad, opWidget } from './Widgets';
import { addLane } from './Lanes';
import { useState } from 'react';
import type { NodeData, OpDef, ParamDef, PState } from '../nerve/types';
import { getOp } from '../nerve/registry';
import { compileCached } from '../nerve/expr';
import { engine, project, ui, useDoc, useTick, useUI, fmt, CAT_COLOR } from './state';
import { ColorField, CtxMenu, Dial, Num, Seg, Toggle, type CtxItem } from './Fields';
import { Icon } from './Icon';

const TAB = <div className="pane-tabs"><button className="ptab on"><Icon n="sliders" />Parameters</button></div>;

export function Inspector() {
  const doc = useDoc();
  const sel = useUI(s => s.sel);
  useTick(120);
  const node = sel.length === 1 ? doc.nodes.find(n => n.id === sel[0]) : undefined;
  if (sel.length === 1 && isGroupId(sel[0])) return <div className="pane" style={{ flex: 1 }}>{TAB}<GroupPanel key={sel[0]} vid={sel[0]} /></div>;
  const clip = sel.length === 0 ? selectedClip() : null;
  if (!node && clip) return <div className="pane" style={{ flex: 1 }}>{TAB}<ClipPanel key={clip.id} id={clip.id} /></div>;
  if (!node) {
    return (
      <div className="pane" style={{ flex: 1 }}>
        {TAB}
        <div className="empty">
          <Icon n="sliders" size={28} />
          {sel.length > 1 ? `${sel.length} operators selected` : <>Select an operator to edit its parameters.<br />Press <span className="kbd">Tab</span> in the network to add one.</>}
        </div>
      </div>
    );
  }
  const def = getOp(node.type);
  return (
    <div className="pane" style={{ flex: 1 }}>
      {TAB}
      {def ? <Body key={node.id} node={node} def={def} /> : <div className="empty">Unknown operator type “{node.type}”.</div>}
    </div>
  );
}

const closed = new Set<string>();

function Body({ node, def }: { node: NodeData; def: OpDef }) {
  const [name, setName] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [help, setHelp] = useState(false);
  const [, bump] = useState(0);
  const err = engine.nodeErr(node.id);
  const query = q.trim().toLowerCase();
  const groups: { title: string; params: ParamDef[] }[] = [];
  for (const p of def.params) {
    if (query && !(p.label ?? p.name).toLowerCase().includes(query)) continue;
    const t = p.group ?? def.label;
    let g = groups.find(x => x.title === t);
    if (!g) groups.push((g = { title: t, params: [] }));
    g.params.push(p);
  }
  return (
    <>
      <div className="insp-head">
        <i className="cat" style={{ background: CAT_COLOR[def.category] }} />
        <input className="insp-name" spellCheck={false} value={name ?? node.name} onChange={e => setName(e.target.value)}
          onBlur={() => { if (name !== null) project.rename(node.id, name); setName(null); }}
          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setName(null); (e.target as HTMLInputElement).blur(); } e.stopPropagation(); }} />
        <span className="insp-type">{def.label}</span>
        <span className="insp-ms">{def.output !== 'sig' ? `${engine.nodeMs(node.id).toFixed(2)} ms` : fmt(engine.sigValue(node.id))}</span>
      </div>
      <div className="insp-bar">
        <Icon n="search" size={11} />
        <input placeholder="Search" spellCheck={false} value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.stopPropagation()} />
        {def.help && <button className={`mini${help ? ' lit' : ''}`} title="Show operator help" onClick={() => setHelp(!help)}>?</button>}
      </div>
      {help && def.help && <div className="insp-help">{def.help}</div>}
      {err && <div className="insp-err">{err}</div>}
      <SourceStrip />
      <div className="insp">
        {!query && opWidget(node, def)}
        {groups.map(g => {
          const key = `${def.type}:${g.title}`, open = !closed.has(key) || !!query;
          return (
            <div key={g.title}>
              <button className={`sect-head${open ? ' open' : ''}`} onClick={() => { closed.has(key) ? closed.delete(key) : closed.add(key); bump(n => n + 1); }}>
                <Icon n="chevron" size={9} />{g.title}
              </button>
              {open && <div className="sect-body">{g.params.map(p => <Row key={p.name} node={node} p={p} />)}</div>}
            </div>
          );
        })}
        {!def.params.length && <div className="empty">This operator has no parameters.</div>}
      </div>
    </>
  );
}

function Row({ node, p, alias }: { node: NodeData; p: ParamDef; alias?: string }) {
  const st: PState = node.params[p.name] ?? { v: p.def };
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [over, setOver] = useState(false);
  const set = (v: any) => project.setParam(node.id, p.name, v);
  const commit = () => project.commit();
  const live = engine.resolved(node.id)?.[p.name];
  const numeric = p.k === 'float' || p.k === 'int' || p.k === 'vec2';
  const n = p.k === 'vec2' ? 2 : 1;
  const hasEx = !!st.ex?.some(Boolean), hasMod = !!st.mods?.length, hasKey = !!st.keys?.some(k => k?.length);
  const modified = JSON.stringify(st.v) !== JSON.stringify(p.def);
  const label = alias ?? p.label ?? p.name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase());

  const toggleEx = (i: number) => project.patchParam(node.id, p.name, s => {
    const ex = s.ex ? [...s.ex] : [];
    ex[i] = ex[i] ? null : String(+(Array.isArray(s.v) ? s.v[i] : s.v).toFixed(4));
    s.ex = ex.some(Boolean) ? ex : undefined;
  });

  // keyframe diamond: filled when a key sits under the playhead, outlined when the parameter is animated
  const half = 0.5 / project.doc.settings.fps;
  const keyHere = !!st.keys?.some(ks => ks?.some(k => Math.abs(k.t - engine.time) < half));
  const toggleKey = () => {
    const t = +engine.time.toFixed(4), had = hasKey;
    project.batch(() => {
      project.patchParam(node.id, p.name, s => {
        const cur = Array.isArray(live) ? live : [live ?? (Array.isArray(s.v) ? s.v[0] : s.v)];
        s.ex = undefined;   // keyframes replace a typed expression
        s.keys ??= [];
        for (let i = 0; i < n; i++) {
          const ks = s.keys[i] ?? [];
          const at = ks.findIndex(k => Math.abs(k.t - t) < half);
          if (at >= 0) ks.splice(at, 1);
          else { ks.push({ t, v: +(+(cur[i] ?? 0)).toFixed(5) }); ks.sort((a, b) => a.t - b.t); }
          s.keys[i] = ks.length ? ks : null;
        }
        if (!s.keys.some(k => k?.length)) s.keys = undefined;
      });
      // the first key opens the parameter's curve on the timeline
      if (!had) for (let i = 0; i < n; i++) addLane(node.id, p.name, i);
    });
    ui.set({ status: keyHere ? `Removed the ${label} key at the playhead.` : had ? `${label} keyed at the playhead.` : `${label} is animated now: move the playhead and change the value to add keys, or shape the curve on the timeline.` });
  };

  const items: CtxItem[] = [];
  if (numeric) {
    for (let i = 0; i < n; i++) items.push({ label: n > 1 ? `Edit ${['X', 'Y', 'Z', 'W'][i]} as a Curve` : 'Edit as a Curve on the Timeline', hint: '∿', run: () => addLane(node.id, p.name, i) });
    items.push({ sep: true, label: '' });
    items.push({ label: hasEx ? 'Remove Expression' : 'Add Expression', hint: 'fx', run: () => { for (let i = 0; i < n; i++) if (!!st.ex?.[i] === hasEx) toggleEx(i); } });
    const shapers = project.doc.shapers;
    items.push({ sep: true, label: '' });
    if (!shapers.length) items.push({ label: 'No shapers yet', disabled: true });
    for (const s of shapers) items.push({
      label: `Modulate with ${s.name}`, run: () => project.patchParam(node.id, p.name, q => { (q.mods ??= []).push({ src: s.name, amt: 0.5, comp: 0 }); }),
    });
    for (const b of project.doc.bands ?? []) items.push({
      label: `Modulate with ${b.name}`, hint: 'band', run: () => project.patchParam(node.id, p.name, q => { (q.mods ??= []).push({ src: b.name, amt: 0.5, comp: 0 }); }),
    });
    for (const src of ['bass', 'mid', 'high', 'level', 'kick']) items.push({
      label: `Modulate with ${src}`, hint: 'audio', run: () => project.patchParam(node.id, p.name, q => { (q.mods ??= []).push({ src, amt: 0.5, comp: 0 }); }),
    });
    items.push({ sep: true, label: '' });
    items.push({
      label: engine.midi.available ? 'MIDI Learn — move a control' : 'MIDI Learn (no MIDI access)', disabled: !engine.midi.available,
      run: () => {
        ui.set({ status: `MIDI learn: move a knob or fader to bind it to ${label}…` });
        engine.midi.learnNext(cc => {
          project.patchParam(node.id, p.name, q => { (q.mods ??= []).push({ src: `cc(${cc})`, amt: 1, comp: 0 }); });
          ui.set({ status: `Bound CC ${cc} to ${label}` });
        });
      },
    });
    items.push({ sep: true, label: '' });
  }
  if (node.group) {
    const shown = !!project.doc.groups?.find(g => g.id === node.group)?.exposed.some(e => e.node === node.name && e.param === p.name);
    items.push({ label: shown ? 'Remove from Group Box' : 'Show on Group Box', hint: '▣', run: () => exposeParam(node.id, p.name, !shown) }, { sep: true, label: '' });
  }
  if (hasKey) items.push({ label: 'Clear Automation', run: () => project.patchParam(node.id, p.name, s => { s.keys = undefined; }) });
  items.push({ label: 'Reset to default', hint: '⌘ click', run: () => project.patchParam(node.id, p.name, s => { s.v = Array.isArray(p.def) ? [...p.def] : p.def; s.ex = undefined; s.mods = undefined; s.keys = undefined; }) });

  let ctl: React.ReactNode = null;
  switch (p.k) {
    case 'float': case 'int':
      ctl = <>
        {p.k === 'float' && p.unit === '°' && !hasEx && <Dial value={st.v} onChange={set} onCommit={commit} />}
        <Num value={st.v} onChange={set} onCommit={commit} min={p.min} max={p.max} step={p.k === 'float' ? p.step : 1} int={p.k === 'int'}
          unit={p.k === 'float' ? p.unit : undefined} def={p.def} driven={hasEx || hasMod || hasKey} live={typeof live === 'number' ? live : undefined} mods={st.mods?.map(m => ({ amt: m.amt, color: sourceColor(m.src) }))} />
      </>;
      break;
    case 'vec2':
      ctl = [0, 1].map(i => <Num key={i} axis={'XY'[i]} value={st.v[i]} onChange={v => { const a = [...st.v]; a[i] = v; set(a); }} onCommit={commit} min={p.min} max={p.max} step={p.step}
        def={p.def[i]} driven={!!st.ex?.[i] || !!st.mods?.some(m => (m.comp ?? 0) === i)} live={Array.isArray(live) ? live[i] : undefined} mods={st.mods?.filter(m => (m.comp ?? 0) === i).map(m => ({ amt: m.amt, color: sourceColor(m.src) }))} />);
      break;
    case 'bool': ctl = <Toggle on={!!st.v} onChange={v => project.setParam(node.id, p.name, v, false)} />; break;
    case 'enum':
      ctl = p.options.length <= 4 && p.options.join('').length <= 26
        ? <Seg options={p.options} value={st.v} onChange={v => project.setParam(node.id, p.name, v, false)} />
        : <select className="sel" style={{ flex: 1, minWidth: 0 }} value={st.v} onChange={e => project.setParam(node.id, p.name, +e.target.value, false)}>
            {p.options.map((o, i) => <option key={i} value={i}>{o}</option>)}</select>;
      break;
    case 'color': ctl = <ColorField value={st.v} onChange={set} onCommit={commit} />; break;
    case 'string': {
      const names = p.name === 'source' ? project.doc.nodes.filter(q => q.id !== node.id && getOp(q.type)?.output !== 'sig').map(q => q.name)
        : p.name === 'global' && node.type === 'getglobal' ? project.doc.nodes.filter(q => q.type === 'global').map(q => q.name) : null;
      ctl = names
        ? <select className="sel" style={{ flex: 1, minWidth: 0 }} value={st.v} onChange={e => project.setParam(node.id, p.name, e.target.value, false)}>
            <option value="">— none —</option>{names.map(nm => <option key={nm}>{nm}</option>)}</select>
        : <input className="txt" spellCheck={false} value={st.v} onChange={e => set(e.target.value)} onKeyDown={e => e.stopPropagation()} />;
      break;
    }
    case 'file':
      ctl = <FileCtl node={node} name={p.name} value={st.v} accept={p.accept} />;
      break;
    case 'code':
      ctl = <span className="dim">edit below</span>;
      break;
  }

  return (
    <>
      <div className={`row${modified ? ' mod' : ''}${hasEx ? ' has-ex' : ''}${hasMod ? ' has-mod' : ''}${hasKey ? ' has-key' : ''}${over ? ' drop' : ''}`} title={p.help}
        onContextMenu={e => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}
        onDragOver={e => { if (numeric && e.dataTransfer.types.includes(DRAG_TYPE)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; if (!over) setOver(true); } }}
        onDragLeave={() => setOver(false)}
        onDrop={e => {
          const src = e.dataTransfer.getData(DRAG_TYPE); setOver(false);
          if (!src || !numeric) return;
          e.preventDefault(); e.stopPropagation();
          // on a two-axis parameter the half you drop on picks the axis
          const r = e.currentTarget.querySelector('.ctl')?.getBoundingClientRect();
          const comp = n > 1 && r && e.clientX > r.left + r.width / 2 ? 1 : 0;
          project.patchParam(node.id, p.name, q => { (q.mods ??= []).push({ src, amt: 0.5, comp }); });
          ui.set({ status: `${src} now modulates ${label}. Drag its depth below.` });
        }}>
        <span className="lbl">{label}</span>
        <div className="ctl">{ctl}</div>
        <div className="acts">
          {numeric && <button className={`mini key${hasKey ? ' on' : ''}${keyHere ? ' here' : ''}`} title={keyHere ? 'Remove the key at the playhead' : hasKey ? 'Add a key at the playhead' : 'Animate: set a key at the playhead and show the curve on the timeline'} onClick={toggleKey}>
            <svg width="9" height="9" viewBox="0 0 10 10"><path d="M5 .8 9.2 5 5 9.2.8 5Z" /></svg></button>}
          {numeric && <button className={`mini fx${hasEx ? ' on' : ''}`} title="Drive with an expression" onClick={() => { for (let i = 0; i < n; i++) if (!!st.ex?.[i] === hasEx) toggleEx(i); }}>ƒ</button>}
          {modified && <button className="mini rst" title="Reset to default" onClick={() => project.patchParam(node.id, p.name, q => { q.v = Array.isArray(p.def) ? [...p.def] : p.def; })}><Icon n="reset" size={10} /></button>}
        </div>
      </div>
      {numeric && Array.from({ length: n }, (_, i) => st.ex?.[i] ? <ExprLine key={i} node={node} p={p} i={i} n={n} src={st.ex[i]!} live={Array.isArray(live) ? live[i] : live} /> : null)}
      {st.mods?.map((m, i) => (
        <div className="row sub has-mod" key={`m${i}`}>
          <span className="lbl mod-lbl"><i style={{ background: sourceColor(m.src) }} />{m.src}{n > 1 ? ` → ${'XY'[m.comp ?? 0]}` : ''}<em><u style={{ width: `${Math.min(1, Math.abs(sourceValue(m.src))) * 100}%`, background: sourceColor(m.src) }} /></em></span>
          <div className="ctl"><Num axis="Depth" value={m.amt} min={-1} max={1} step={0.01} def={0.5}
            onChange={v => project.patchParam(node.id, p.name, s => { s.mods![i].amt = v; }, `mod:${node.id}:${p.name}:${i}`)} onCommit={commit} /></div>
          <div className="acts">
            {n > 1 && <button className="mini" title="Switch axis" onClick={() => project.patchParam(node.id, p.name, s => { s.mods![i].comp = (m.comp ?? 0) ? 0 : 1; })}>⇄</button>}
            <button className="mini" title="Remove modulation" onClick={() => project.patchParam(node.id, p.name, s => { s.mods!.splice(i, 1); if (!s.mods!.length) s.mods = undefined; })}><Icon n="close" size={9} /></button>
          </div>
        </div>
      ))}
      {p.k === 'vec2' && ((p as any).gizmo || (p.min !== undefined && p.min < 0)) && <XYPad node={node} p={p} />}
      {p.k === 'code' && <CodeCtl node={node} name={p.name} value={st.v} />}
      {menu && <CtxMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
    </>
  );
}

function ExprLine({ node, p, i, n, src, live }: { node: NodeData; p: ParamDef; i: number; n: number; src: string; live: any }) {
  const [t, setT] = useState<string | null>(null);
  const text = t ?? src;
  const parseErr = compileCached(text).err;
  const runErr = engine.exprErrors.get(`${node.id}:${p.name}:${i}`);
  const bad = parseErr ?? runErr;
  // operators this expression reads by name that carry keyframes: one click opens their curve on the timeline
  const refs = [...new Set(text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])].flatMap(w => {
    const r = w !== node.name ? project.doc.nodes.find(q => q.name === w) : undefined;
    if (!r) return [];
    const keyed = Object.entries(r.params).find(([, ps]) => ps.keys?.some(k => k?.length));
    return [{ node: r, param: keyed?.[0] ?? (r.type === 'sigconst' ? 'value' : null), comp: keyed ? Math.max(0, keyed[1].keys!.findIndex(k => k?.length)) : 0 }];
  });
  return (
    <>
    <div className="row sub has-ex" title={bad ?? undefined}>
      <span className="lbl">expr{n > 1 ? ` ${'XY'[i]}` : ''}</span>
      <div className="ctl">
        <input className={`txt ex-in${bad ? ' bad' : ''}`} spellCheck={false} value={text} placeholder="bass * 2 + sin(t)"
          onChange={e => { setT(e.target.value); if (!compileCached(e.target.value).err && e.target.value.trim()) project.patchParam(node.id, p.name, s => { (s.ex ??= [])[i] = e.target.value; }, `ex:${node.id}:${p.name}:${i}`); }}
          onBlur={() => { setT(null); project.commit(); }}
          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); e.stopPropagation(); }} />
      </div>
      <div className="acts"><span className="ex-val">{bad ? '!' : typeof live === 'number' ? fmt(live) : ''}</span></div>
    </div>
    {refs.length > 0 && <div className="row sub ex-refs"><span className="lbl" /><div className="ctl" style={{ gap: 4, flexWrap: 'wrap' }}>
      {refs.map(r => r.param
        ? <button key={r.node.id} className="btn sm" title={`Open ${r.node.name}'s keyframes as a curve on the timeline`} onClick={() => addLane(r.node.id, r.param!, r.comp)}><Icon n="curve" size={12} />Edit {r.node.name} curve</button>
        : <button key={r.node.id} className="btn sm ghost" title={`Select ${r.node.name}`} onClick={() => ui.set({ sel: [r.node.id] })}>Go to {r.node.name}</button>)}
    </div></div>}
    </>
  );
}

function FileCtl({ node, name, value, accept }: { node: NodeData; name: string; value: string; accept?: string }) {
  return (
    <>
      <span className="dim mono" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10.5 }}>{value ? value.split('/').pop() : 'No file'}</span>
      <button className="btn sm" onClick={async () => {
        const { host } = await import('./host');
        const { media } = await import('./media');
        const [f] = await host.pickMedia((accept ?? '').split(',').map(s => s.trim().replace(/^\./, '')).filter(Boolean));
        if (!f) return;
        if (f.file) media.register(f.path, f.file);
        project.setParam(node.id, name, f.path, false);
      }}>Browse</button>
    </>
  );
}

function CodeCtl({ node, name, value }: { node: NodeData; name: string; value: string }) {
  const [t, setT] = useState<string | null>(null);
  return (
    <div style={{ padding: '2px 8px 6px 10px' }}>
      <textarea className="txt mono" spellCheck={false} value={t ?? value}
        style={{ height: 240, padding: 6, resize: 'vertical', fontSize: 10.5, lineHeight: 1.5, whiteSpace: 'pre', tabSize: 2 }}
        onChange={e => { setT(e.target.value); project.setParam(node.id, name, e.target.value); }}
        onBlur={() => { setT(null); project.commit(); }}
        onKeyDown={e => {
          e.stopPropagation();
          if (e.key === 'Tab') { e.preventDefault(); const el = e.currentTarget; const s = el.selectionStart; el.setRangeText('  ', s, el.selectionEnd, 'end'); setT(el.value); project.setParam(node.id, name, el.value); }
        }} />
    </div>
  );
}

export function selectedNode() { const s = ui.get().sel; return s.length === 1 ? project.node(s[0]) : undefined; }

/** A group: its name, the handful of knobs chosen for it, and a way in. */
function GroupPanel({ vid }: { vid: string }) {
  const g = groupOf(vid);
  const [name, setName] = useState<string | null>(null);
  if (!g) return <div className="empty">This group no longer exists.</div>;
  const members = project.doc.nodes.filter(n => n.group === g.id);
  const rows = g.exposed.map(e => { const n = members.find(m => m.name === e.node), d = n && getOp(n.type), pd = d?.params.find(q => q.name === e.param); return n && pd ? { n, pd, label: e.label } : null; }).filter(Boolean) as { n: NodeData; pd: ParamDef; label?: string }[];
  const rename = (v: string) => { const t = v.trim(); if (t && t !== g.name) project.tx(d => { const q = d.groups?.find(x => x.id === g.id); if (q) q.name = t; }); setName(null); };
  return (
    <>
      <div className="insp-head">
        <i className="cat" style={{ background: '#e8c27a' }} />
        <input className="insp-name" spellCheck={false} value={name ?? g.name} onChange={e => setName(e.target.value)} onBlur={e => rename(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); e.stopPropagation(); }} />
        <span className="insp-type">Group · {members.length} operators</span>
      </div>
      {g.note && <div className="insp-help">{g.note}</div>}
      <div className="insp">
        {rows.length ? <div className="sect-body">{rows.map(r => <Row key={r.n.id + r.pd.name} node={r.n} p={r.pd} alias={r.label} />)}</div>
          : <div className="empty" style={{ padding: '18px 14px' }}>No controls on this box yet. Open the group, right-click any parameter and choose <b>Show on Group Box</b>.</div>}
        <div className="group-actions">
          <button className="btn sm" onClick={() => enterGroup(vid)}>Open group</button>
          <button className="btn sm ghost" onClick={() => ungroup(vid)}>Ungroup</button>
        </div>
      </div>
    </>
  );
}

/** A clip's Motion: position, scale and rotation, each keyframeable, like Premiere's Motion effect. */
function ClipPanel({ id }: { id: string }) {
  const cl = selectedClip();
  if (!cl || cl.id !== id) return null;
  const lt = engine.time - cl.start, inClip = lt >= 0 && lt <= cl.dur, s = project.doc.settings;
  const commit = () => project.commit();
  const diamond = (p: MotionProp) => {
    const on = isKeyed(cl, p), here = keyHere(cl, p);
    return <button className={`mini key${on ? ' on' : ''}${here ? ' here' : ''}`} style={{ visibility: 'visible' }} title={here ? 'Remove the key at the playhead' : on ? 'Add a key at the playhead' : 'Animate: set a key at the playhead'} onClick={() => toggleMotionKey(cl, p)}>
      <svg width="9" height="9" viewBox="0 0 10 10"><path d="M5 .8 9.2 5 5 9.2.8 5Z" /></svg></button>;
  };
  const row = (label: string, p: MotionProp, ctl: React.ReactNode) => (
    <div className={`row${cl.motion?.[p] ? ' mod' : ''}${isKeyed(cl, p) ? ' has-key' : ''}`}>
      <span className="lbl">{label}</span><div className="ctl">{ctl}</div>
      <div className="acts">{diamond(p)}{cl.motion?.[p] && <button className="mini rst" title="Reset" onClick={() => resetMotion(cl, p)}><Icon n="reset" size={10} /></button>}</div>
    </div>
  );
  const v = (p: MotionProp, i: number) => +motionComp(cl, p, i, lt).toFixed(2);
  const keyed = (['pos', 'scale', 'rot'] as MotionProp[]).some(p => isKeyed(cl, p));
  return (
    <>
      <div className="insp-head">
        <i className="cat" style={{ background: '#5a9bd8' }} />
        <span className="insp-name" style={{ display: 'flex', alignItems: 'center' }}>{cl.name}</span>
        <span className="insp-type">Clip · {cl.dur.toFixed(2)} s</span>
      </div>
      <div className="insp-help">{inClip ? 'Drag the picture in the viewer to move it, scroll to scale, Option-drag to rotate. Click ◆ to animate a property; then every change at a new playhead position adds a key.' : 'Move the playhead onto this clip to see and keyframe its motion.'}</div>
      <div className="insp">
        <div className="sect-head open" style={{ pointerEvents: 'none' }}>Motion</div>
        <div className="sect-body">
          {row('Position', 'pos', [0, 1].map(i => <Num key={i} axis={'XY'[i]} value={v('pos', i)} step={1} unit="px" def={motionDefault('pos', i)} min={-(i ? s.height : s.width) * 2} max={(i ? s.height : s.width) * 2}
            onChange={x => setMotion(cl, 'pos', i, x)} onCommit={commit} />))}
          {row('Scale', 'scale', <Num value={v('scale', 0)} min={1} max={800} step={0.5} unit="%" def={100} onChange={x => setMotion(cl, 'scale', 0, x)} onCommit={commit} />)}
          {row('Rotation', 'rot', <Num value={v('rot', 0)} min={-720} max={720} step={0.5} unit="°" def={0} onChange={x => setMotion(cl, 'rot', 0, x)} onCommit={commit} />)}
        </div>
        <div className="group-actions">
          {keyed && <><button className="btn sm ghost" title="Previous key" onClick={() => stepKey(cl, -1)}>◂ Key</button><button className="btn sm ghost" title="Next key" onClick={() => stepKey(cl, 1)}>Key ▸</button></>}
          <button className="btn sm ghost" style={{ marginLeft: 'auto' }} disabled={!cl.motion} onClick={() => resetMotion(cl)}>Reset Motion</button>
        </div>
      </div>
    </>
  );
}
