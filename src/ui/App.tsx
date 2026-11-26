import { useEffect, useRef, useState } from 'react';
import { engine, project, ui, useUI } from './state';
import { StatusBar, TitleBar, Toolbar } from './TopBar';
import { Graph, copySel, pasteClip } from './Graph';
import { Viewer } from './Viewer';
import { Inspector } from './Inspector';
import { Bottom } from './Bottom';
import { OpMenu } from './OpMenu';
import { importFiles, importMedia, newProject, openOutput, openProject, openProjectPath, saveProject } from './actions';
import { host } from './host';
import { ExportDialog } from './Export';
import { Icon } from './Icon';

function Split({ dir, onDrag }: { dir: 'v' | 'h'; onDrag(delta: number): void }) {
  const last = useRef(0);
  const [on, setOn] = useState(false);
  return (
    <div className={`split ${dir}${on ? ' drag' : ''}`}
      onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); last.current = dir === 'v' ? e.clientX : e.clientY; setOn(true); }}
      onPointerMove={e => { if (!on) return; const p = dir === 'v' ? e.clientX : e.clientY; onDrag(p - last.current); last.current = p; }}
      onPointerUp={() => setOn(false)} />
  );
}

export function App() {
  const sizes = useUI(s => s.sizes);
  const [exporting, setExporting] = useState(false);
  const [dropping, setDropping] = useState(false);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT';
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? project.redo() : project.undo(); }
      else if (mod && k === 's') { e.preventDefault(); void saveProject(e.shiftKey); }
      else if (mod && k === 'o') { e.preventDefault(); void openProject(); }
      else if (mod && k === 'n') { e.preventDefault(); void newProject(); }
      else if (mod && k === 'i') { e.preventDefault(); void importMedia(); }
      else if (mod && k === 'e') { e.preventDefault(); setExporting(true); }
      else if (mod && k === 'r') { e.preventDefault(); engine.restart(); }
      else if (mod && e.key === 'Enter') { e.preventDefault(); openOutput(); }
      else if (typing) return;
      else if (e.key === ' ') { e.preventDefault(); engine.toggle(); }
      else if (e.key === 'Home') engine.restart();
      else if (e.key === 'r' && !mod && !t.closest('.tl')) engine.setRecording(!engine.recording);
      else if (mod && k === 'c' && !t.closest('.graph')) { e.preventDefault(); copySel(); }
      else if (mod && k === 'v' && !t.closest('.graph')) { e.preventDefault(); pasteClip(); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  // panel sizes are limited by the window, so no divider can push a column off screen
  const maxRight = () => Math.max(300, Math.min(1100, window.innerWidth - 360));
  const maxBottom = () => Math.max(110, Math.min(640, window.innerHeight - 300));
  const maxViewer = () => Math.max(140, Math.min(900, window.innerHeight - 260));
  useEffect(() => {
    const fit = () => ui.set(s => ({ sizes: { ...s.sizes, right: clamp(s.sizes.right, 300, maxRight()), bottom: clamp(s.sizes.bottom, 110, maxBottom()), viewer: clamp(s.sizes.viewer, 140, maxViewer()) } }));
    fit(); window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);
  return (
    <div className="app"
      onDragOver={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDropping(true); } }}
      onDragLeave={e => { if (e.relatedTarget === null) setDropping(false); }}
      onDrop={e => {
        e.preventDefault(); setDropping(false);
        const files = [...e.dataTransfer.files];
        const proj = files.find(f => /\.phos$/i.test(f.name));
        if (proj && host.native) void openProjectPath(host.pathFor(proj)); else void importFiles(files);
      }}>
      <TitleBar onExport={() => setExporting(true)} />
      <Toolbar onExport={() => setExporting(true)} />
      <div className="work">
        <div className="col" style={{ flex: 1 }}>
          <div className="pane" style={{ flex: 1 }}>
            <div className="pane-tabs"><button className="ptab on"><Icon n="network" />Network</button></div>
            <Graph />
          </div>
          <Split dir="h" onDrag={d => ui.set(s => ({ sizes: { ...s.sizes, bottom: clamp(s.sizes.bottom - d, 110, maxBottom()) } }))} />
          <div style={{ height: sizes.bottom, flex: 'none', display: 'flex' }}><Bottom /></div>
        </div>
        <Split dir="v" onDrag={d => ui.set(s => ({ sizes: { ...s.sizes, right: clamp(s.sizes.right - d, 300, maxRight()) } }))} />
        <div className="col" style={{ width: sizes.right, flex: 'none' }}>
          <div style={{ height: sizes.viewer, flex: 'none', display: 'flex' }}><Viewer /></div>
          <Split dir="h" onDrag={d => ui.set(s => ({ sizes: { ...s.sizes, viewer: clamp(s.sizes.viewer + d, 140, maxViewer()) } }))} />
          <Inspector />
        </div>
      </div>
      <StatusBar />
      <OpMenu />
      {exporting && <ExportDialog onClose={() => setExporting(false)} />}
      {dropping && <div className="drop-veil">Drop video, images or audio to import</div>}
    </div>
  );
}
