import { AssistButton } from './Assist';
import { useEffect, useState } from 'react';
import { engine, project, ui, useDoc, useTick, useUI } from './state';
import { CtxMenu, Num, type CtxItem } from './Fields';
import { Icon, Mark } from './Icon';
import { host } from './host';
import { clearRecent, addAudio, analyzeSong, importMedia, loadExample, newProject, openOutput, openProject, openProjectPath, recentProjects, revertProject, saveProject, separateStems } from './actions';
import { copySel, deleteSel, frameAll, pasteClip } from './Graph';
import { autoDesign, STYLES, type Style } from './autodesign';
import { autoFrame, autoFrameProgress } from './reframe';
import { footagePool } from './autoedit';
import { AutoEditDialog } from './AutoEditDialog';

const lastStyle: { v: Style } = { v: 'Psychedelic' };

/** Cut/copy/paste/select-all act on text while a text field has focus, on operators otherwise. */
function textEdit(cmd: 'cut' | 'copy' | 'paste' | 'selectAll'): boolean {
  const a = document.activeElement as HTMLElement | null;
  if (!a || !(a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return false;
  document.execCommand(cmd);
  return true;
}
const menuRuns = new Map<string, () => void>(), menuHints = new Map<string, string>();
let menuHooked = false;
/** The last ⌘ shortcut the page itself handled: the menu bar skips the same shortcut right after, so nothing runs twice. */
let handled: { key: string; t: number } | null = null;
const comboOf = (e: KeyboardEvent) => (e.shiftKey ? '⇧' : '') + '⌘' + (e.key === 'Enter' ? '↩' : e.key.toUpperCase());
if (typeof window !== 'undefined') window.addEventListener('keydown', e => {
  if (!(e.metaKey || e.ctrlKey)) return;
  setTimeout(() => { if (e.defaultPrevented) handled = { key: comboOf(e), t: performance.now() }; }, 0);
}, true);
function syncNativeMenu(menus: Record<string, CtxItem[]>) {
  if (!host.mac) return;
  if (!menuHooked) {
    menuHooked = true;
    host.onMenu(id => {
      if (id === 'help:search') { const g = document.querySelector('.graph canvas') as HTMLElement | null; g?.focus(); g?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })); return; }
      const hint = menuHints.get(id);
      if (hint && handled && handled.key === hint && performance.now() - handled.t < 250) return;
      menuRuns.get(id)?.();
    });
  }
  menuRuns.clear(); menuHints.clear();
  const ser = (items: CtxItem[], pre: string): unknown[] => items.map((it, i) => {
    const id = `${pre}:${i}`;
    if (it.run) menuRuns.set(id, it.run);
    if (it.hint?.includes('⌘')) menuHints.set(id, it.hint);
    return it.sep ? { sep: true } : { id, label: it.label, hint: it.hint, disabled: !!it.disabled, ...(it.sub ? { sub: ser(it.sub, id) } : {}) };
  });
  host.setMenu(Object.fromEntries(Object.entries(menus).map(([k, v]) => [k, ser(v, k)])));
}

const RES: [string, number, number][] = [
  ['1920 × 1080  HD', 1920, 1080], ['3840 × 2160  UHD', 3840, 2160], ['1280 × 720', 1280, 720], ['2560 × 1440  QHD', 2560, 1440],
  ['1080 × 1920  Vertical', 1080, 1920], ['1080 × 1350  Portrait', 1080, 1350], ['1080 × 1080  Square', 1080, 1080],
  ['2160 × 3840  Vertical 4K', 2160, 3840], ['4096 × 2160  DCI 4K', 4096, 2160], ['7680 × 4320  8K', 7680, 4320],
];

function timecode(t: number, fps: number) {
  const f = Math.floor(t * fps + 1e-6);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(f / fps / 3600))}:${p(Math.floor(f / fps / 60) % 60)}:${p(Math.floor(f / fps) % 60)}:${p(f % fps)}`;
}

export function TitleBar({ onExport }: { onExport(): void }) {
  const doc = useDoc();
  useTick(500);
  const [menu, setMenu] = useState<{ k: string; x: number; y: number } | null>(null);
  const q = engine.quality;
  const recent = recentProjects();
  const folder = (p: string) => { const parts = p.split('/'); return parts.length > 2 ? parts[parts.length - 2] : ''; };
  const menus: Record<string, CtxItem[]> = {
    File: [
      { label: 'New Project', hint: '⌘N', run: () => void newProject() },
      { label: 'Open…', hint: '⌘O', run: openProject },
      { label: 'Open Recent', sub: [
        ...recent.map(r => ({ label: r.name, hint: r.path === project.path ? '●' : folder(r.path), run: () => void openProjectPath(r.path) })),
        ...(recent.length ? [{ sep: true, label: '' }, { label: 'Clear Recent', run: clearRecent }] : []),
      ] },
      { sep: true, label: '' },
      { label: 'Save', hint: '⌘S', run: () => void saveProject() },
      { label: 'Save As…', hint: '⇧⌘S', run: () => void saveProject(true) },
      { label: 'Revert to Saved', disabled: !project.path || !project.dirty, run: () => void revertProject() },
      { label: 'Show Project in Finder', disabled: !project.path, run: () => project.path && host.reveal(project.path) },
      { sep: true, label: '' },
      { label: 'Import Media…', hint: '⌘I', run: importMedia },
      { label: 'Import Audio…', run: addAudio },
      { label: 'Export Video…', hint: '⌘E', run: onExport },
      { sep: true, label: '' },
      { label: 'Analyse Song (tempo, sections)', run: analyzeSong },
      { label: 'Separate Stems (drums, bass, vocals)', run: () => void separateStems() },
      { label: 'Clear Recorded Performance', run: () => project.tx(d => { d.take = { cc: {}, notes: [] }; }) },
      { sep: true, label: '' },
      { label: 'Example: Feedback Bloom', run: () => void loadExample('feedback') },
    ],
    Edit: [
      { label: 'Undo', hint: '⌘Z', run: () => project.undo() },
      { label: 'Redo', hint: '⇧⌘Z', run: () => project.redo() },
      { sep: true, label: '' },
      { label: 'Cut', hint: '⌘X', run: () => textEdit('cut') || (copySel(), deleteSel()) },
      { label: 'Copy', hint: '⌘C', run: () => textEdit('copy') || copySel() },
      { label: 'Paste', hint: '⌘V', run: () => textEdit('paste') || pasteClip() },
      { label: 'Duplicate', hint: '⌘D', run: () => { copySel(); pasteClip(); } },
      { label: 'Delete', hint: '⌫', run: deleteSel },
      { sep: true, label: '' },
      { label: 'Select All', hint: '⌘A', run: () => textEdit('selectAll') || ui.set({ sel: project.doc.nodes.map(n => n.id) }) },
    ],
    View: [
      { label: 'Frame All Operators', hint: 'H', run: frameAll },
      { sep: true, label: '' },
      { label: 'Preview at Full Resolution', hint: q === 1 ? '●' : '', run: () => { engine.quality = 1; } },
      { label: 'Preview at Half', hint: q === 2 ? '●' : '', run: () => { engine.quality = 2; } },
      { label: 'Preview at Quarter', hint: q === 4 ? '●' : '', run: () => { engine.quality = 4; } },
      { sep: true, label: '' },
      { label: 'Open Output Window', hint: '⌘↩', run: () => openOutput() },
      { label: 'Reset Simulation State', hint: '⌘R', run: () => engine.restart() },
    ],
  };
  // the macOS menu bar shows the same menus
  useEffect(() => { syncNativeMenu(menus); });
  const errs = doc.nodes.filter(n => engine.nodeErr(n.id)).length;
  return (
    <div className={`titlebar${host.mac ? ' mac' : ''}`}>
      <span className="brand"><Mark />PHOSPHENE</span>
      {Object.keys(menus).map(k => (
        <button key={k} className={`menu-btn${menu?.k === k ? ' open' : ''}`}
          onClick={e => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ k, x: r.left, y: r.bottom + 3 }); }}>{k}</button>
      ))}
      {menu && <CtxMenu x={menu.x} y={menu.y} items={menus[menu.k]} onClose={() => setMenu(null)} />}
      <span className="doc-title" title={project.path ?? 'Not saved yet'}>{project.dirty && <i className="dirty-dot" />}<b>{doc.name}</b>{project.dirty ? <em>Edited</em> : !project.path ? <em>Unsaved</em> : null}</span>
      <div className="spacer" />
      <div className={`engine-mark${errs ? ' bad' : engine.cookMs > 1000 / doc.settings.fps ? ' warn' : ''}`} title={errs ? `${errs} operator${errs > 1 ? 's have' : ' has'} an error` : 'NERVE: Node Engine for Realtime Visual Effects'}>
        <b>NERVE</b><em>{errs ? `${errs} error${errs > 1 ? 's' : ''}` : engine.cookMs > 1000 / doc.settings.fps ? 'behind' : 'realtime'}</em>
      </div>
    </div>
  );
}

export function Toolbar({ onExport }: { onExport(): void }) {
  const doc = useDoc();
  const [outMenu, setOutMenu] = useState<{ x: number; y: number } | null>(null);
  const [adMenu, setAdMenu] = useState<{ x: number; y: number } | null>(null);
  const [autoEditOpen, setAutoEdit] = useState(false);
  useTick(50);
  const s = doc.settings;
  const beat = (engine.time * s.bpm) / 60;
  const resKey = `${s.width}x${s.height}`;
  return (
    <div className="toolbar">
      <div className="tgroup">
        <button className="tool" onClick={importMedia} title="Import video, images or audio (⌘I)"><Icon n="import" />Import</button>
        <button className="tool" title="Add an operator to the network (Tab)" onClick={() => {
          const r = (document.querySelector('.graph') as HTMLElement).getBoundingClientRect(); const v = ui.get().view;
          ui.set({ menu: { x: r.left + r.width / 2 - 300, y: r.top + 60, gx: (r.width / 2 - v.x) / v.k, gy: (r.height / 2 - v.y) / v.k } });
        }}><Icon n="plus" />Operator</button>
        <button className="tool" title="Analyse the song and generate a unique effect chain in a chosen style"
          onClick={e => { const r = e.currentTarget.getBoundingClientRect(); setAdMenu({ x: r.left, y: r.bottom + 3 }); }}><Icon n="bolt" />Auto Design</button>
        <button className="tool" title="Cut your clips to the song automatically, with transitions and effects" onClick={() => setAutoEdit(true)}><Icon n="cut" />Auto Edit</button>
        {autoEditOpen && <AutoEditDialog onClose={() => setAutoEdit(false)} />}
        <AssistButton />
        {adMenu && <CtxMenu x={adMenu.x} y={adMenu.y} onClose={() => setAdMenu(null)} items={[
          ...STYLES.map(st => ({ label: st, run: () => { lastStyle.v = st; autoDesign(st); } })),
          { sep: true, label: '' },
          { label: 'Shuffle variation', hint: lastStyle.v, run: () => autoDesign(lastStyle.v, true) },
        ]} />}
      </div>
      <div className="tsep" />
      <div style={{ flex: 1 }} />

      <div className="tgroup" style={{ gap: 5 }}>
        <button className="tool icon" title="Return to start (Home)" onClick={() => engine.restart()}><Icon n="start" /></button>
        <button className={`playbtn${engine.playing ? ' on' : ''}`} title="Play / pause (Space)" onClick={() => engine.toggle()}><Icon n={engine.playing ? 'pause' : 'play'} size={15} /></button>
        <button className={`tool icon rec${engine.recording ? ' on' : ''}`} title="Record performance: MIDI controllers and parameter moves are written to the timeline while playing (R)" onClick={() => engine.setRecording(!engine.recording)}><i /></button>
        <button className={`tool icon${engine.loop ? ' on' : ''}`} title="Loop playback" onClick={() => { engine.loop = !engine.loop; }}><Icon n="loop" /></button>
        <div className="lcd" style={{ marginLeft: 4 }}>
          <div><span className="v">{timecode(engine.time, s.fps)}</span><span className="k">Timecode</span></div>
          <div><span className="v">{String(Math.floor(beat / 4) + 1).padStart(3, '0')}.{(Math.floor(beat) % 4) + 1}</span><span className="k">Bar · Beat</span></div>
          <div title="Tempo — drag to change, click to type">
            <Num value={s.bpm} min={40} max={240} step={0.1} def={120} onChange={v => project.tx(d => { d.settings.bpm = v; }, 'bpm')} onCommit={() => project.commit()} />
            <span className="k">BPM</span>
          </div>
        </div>
      </div>

      <div style={{ flex: 1 }} />
      <div className="tsep" />
      <div className="tgroup" style={{ gap: 4 }}>
        <select className="sel" value={resKey} title="Project resolution" onChange={e => {
          const [w, h] = e.target.value.split('x').map(Number);
          project.tx(d => { d.settings.width = w; d.settings.height = h; });
          // going narrower than the footage: find the subjects so Fill can follow them
          if (w / h < 1.3 && footagePool(project.doc).some(p => !project.doc.focus?.[p.path])) void autoFrame();
        }}>
          {RES.map(([l, w, h]) => <option key={l} value={`${w}x${h}`}>{l}</option>)}
          {!RES.some(r => `${r[1]}x${r[2]}` === resKey) && <option value={resKey}>{s.width} × {s.height}</option>}
        </select>
        {(() => {
          const pr = autoFrameProgress(), R = 11.5, C = 2 * Math.PI * R;
          return (
            <button className={`tool${pr ? ' framing' : ' icon'}`} title={pr ? `Auto-frame: finding the subject in ${pr.clip}… Keep working; the crop starts following as each clip finishes.` : 'Auto-frame: find the subject in every clip so a vertical or square crop keeps them in frame.\nShift-click to look at every clip again.'}
              onClick={e => void autoFrame(e.shiftKey)}>
              <span className="frame-ring">
                <Icon n="target" />
                {pr && <svg viewBox="0 0 26 26"><circle cx="13" cy="13" r={R} className="track" /><circle cx="13" cy="13" r={R} className="fill" strokeDasharray={C} strokeDashoffset={C * (1 - pr.f)} /></svg>}
              </span>
              {pr && <span className="mono frame-pct">{Math.round(pr.f * 100)}%</span>}
            </button>
          );
        })()}
        <select className="sel" value={s.fps} title="Frame rate" onChange={e => project.tx(d => { d.settings.fps = +e.target.value; })}>
          {[24, 25, 30, 50, 60, 120].map(f => <option key={f} value={f}>{f} fps</option>)}
        </select>
      </div>
      <div className="tsep" />
      <button className="tool" title="Open an output window. With several Out operators, each can drive its own display (⌘↩)"
        onClick={e => { const outs = doc.nodes.filter(n => n.type === 'out'); if (outs.length > 1) { const r = e.currentTarget.getBoundingClientRect(); setOutMenu({ x: r.left, y: r.bottom + 3 }); } else openOutput(); }}><Icon n="monitor" />Output</button>
      {outMenu && <CtxMenu x={outMenu.x} y={outMenu.y} onClose={() => setOutMenu(null)} items={[
        ...doc.nodes.filter(n => n.type === 'out').map(n => ({ label: `Open ${n.name}`, run: () => openOutput(n.id) })),
        { sep: true, label: '' },
        { label: 'Open all outputs', run: () => doc.nodes.filter(n => n.type === 'out').forEach(n => openOutput(n.id)) },
      ]} />}
      <button className="tool primary" onClick={onExport} title="Render through the encoder (⌘E)"><Icon n="export" />Export</button>
    </div>
  );
}

export function StatusBar() {
  const doc = useDoc();
  const status = useUI(s => s.status);
  useTick(250);
  const budget = 1000 / doc.settings.fps;
  const load = Math.min(1, engine.cookMs / budget);
  const [w, h] = engine.gpu ? engine.resolution() : [0, 0];
  return (
    <div className="status">
      <span className="msg">{status || 'Ready'}</span>
      <div className="cells">
        <div className="cell">{doc.nodes.length} <span>operators</span></div>
        <div className="cell">{doc.tracks.reduce((n, t) => n + t.clips.length, 0)} <span>clips</span></div>
        <div className="cell"><b>{w}×{h}</b>{engine.quality > 1 ? ` 1/${engine.quality}` : ''}</div>
        <div className="cell" title="Engine cook time against the frame budget">cook <b>{engine.cookMs.toFixed(1)}</b> ms
          <span className="meter"><i style={{ width: `${load * 100}%`, background: load > 0.9 ? 'var(--err)' : load > 0.6 ? 'var(--accent)' : undefined }} /></span></div>
        <div className="cell"><b>{engine.fpsMeasured.toFixed(0)}</b> fps</div>
        <div className="cell" title="Live control inputs"><i className={`led${engine.midi.devices.length ? '' : ' off'}`} />MIDI {engine.midi.devices.length || '—'}
          <i className={`led${engine.midi.oscPort ? (engine.midi.oscLast && performance.now() - engine.midi.oscLast.at < 400 ? ' warn' : '') : ' off'}`} style={{ marginLeft: 8 }} />OSC {engine.midi.oscPort ? `:${engine.midi.oscPort}` : '—'}</div>
        <div className="cell">RGBA16F linear</div>
      </div>
    </div>
  );
}
