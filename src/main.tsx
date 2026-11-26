import * as clipMotionLib from './ui/clipMotion';
import * as opSearchLib from './ui/OpMenu';
import * as graphViewLib from './ui/graphView';
import * as reframeLib from './ui/reframe';
import * as autoeditLib from './ui/autoedit';
import * as gvLib from './ui/graphView';
import '@fontsource/instrument-sans/400.css';
import '@fontsource/instrument-sans/500.css';
import '@fontsource/instrument-sans/600.css';
import '@fontsource/fragment-mono/400.css';
import '@fontsource/michroma/400.css';
import '@fontsource/instrument-serif/400-italic.css';
import '@fontsource/bodoni-moda/400.css';
import '@fontsource/bodoni-moda/700.css';
import '@fontsource/bodoni-moda/900.css';
import * as assistLib from './ui/effectAssist';
import * as lanesUi from './ui/Lanes';
import * as bandsUi from './ui/Bands';
import * as tlView from './ui/tlview';
import * as stockUi from './ui/Stock';
import { createRoot } from 'react-dom/client';
import './ui/theme.css';
import { registerAll } from './nerve/ops/index';
import { engine, project } from './ui/state';
import { App } from './ui/App';
import * as actions from './ui/actions';
import { blankDoc, feedbackDoc } from './ui/actions';
import { ui } from './ui/state';
import * as exp from './nerve/export';
import { host } from './ui/host';
import * as reg from './nerve/registry';
import * as auto from './ui/autodesign';
import { media } from './ui/media';
import { frameAll } from './ui/Graph';

registerAll();
const root = createRoot(document.getElementById('root')!);

engine.init().then(() => {
  engine.gpu.onError = m => console.error('[NERVE]', m);
  engine.media.resolve = p => media.url(p);
  if (host.native) engine.media.makeProxy = async (src, start, dur, onProgress) => {
    const out = await host.tempPath('footage.mp4');
    const r = await host.footageProxy(src, start, dur, out, onProgress);
    if (!r.ok) console.warn('[export cache]', src, r.log);
    return r.ok ? out : null;
  };
  void engine.midi.init();
  void host.oscListen(9000, m => engine.midi.onOsc(m)).then(err => { engine.midi.oscPort = err ? 0 : 9000; });
  const demo = new URLSearchParams(location.search).get('demo') ?? (window as any).__demo;
  project.load(demo ? feedbackDoc() : blankDoc());
  void Promise.all(['11px "Instrument Sans"', '600 11px "Instrument Sans"', '10px "Fragment Mono"', '9px Michroma', 'italic 13px "Instrument Serif"', '900 20px "Bodoni Moda"', '700 20px "Bodoni Moda"'].map(f => document.fonts.load(f))).catch(() => {});
  engine.start();
  if (demo) engine.play();
  root.render(<App />);
  requestAnimationFrame(() => requestAnimationFrame(frameAll));
  // project lifecycle: window title and edited dot, close guard, crash recovery, files opened from Finder
  let lastState = '';
  setInterval(() => {
    const st = { name: project.doc.name, dirty: project.dirty, path: project.path };
    const k = JSON.stringify(st);
    if (k !== lastState) { lastState = k; host.docState(st); document.title = `${st.name}${st.dirty ? ' — Edited' : ''}`; }
  }, 300);
  setInterval(() => void actions.writeRecovery(), 15000);
  host.onCloseRequest(async () => { if (await actions.confirmDiscard()) { await actions.clearRecovery(); host.closeNow(); } });
  host.onOpenFile(p => void actions.openProjectPath(p));
  void host.takePendingOpen().then(p => (p ? actions.openProjectPath(p) : demo ? undefined : actions.offerRecovery()));
  (window as any).__phos = { engine, project, actions, ui, exp, host, reg, auto, stock: stockUi, lanes: lanesUi, bands: bandsUi, tl: tlView, assist: assistLib, gv: gvLib, reframe: reframeLib, autoedit: autoeditLib, opsearch: opSearchLib, gvlib: graphViewLib, motion: clipMotionLib };
}).catch(e => {
  root.render(<div className="fatal"><div><b>NERVE could not start</b><br />{String(e.message ?? e)}<br />Phosphene needs a WebGPU-capable GPU and runtime.</div></div>);
});
