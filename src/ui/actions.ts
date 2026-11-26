// Document-level commands shared by menus, toolbar, shortcuts and drag-and-drop.
import { DEFAULT_BANDS } from './Bands';
import type { Clip, Doc } from '../nerve/types';
import { defaultShaper, emptyDoc, uid } from '../nerve/project';
import { defaultParams, getOp } from '../nerve/registry';
import { parseMidi } from '../nerve/midifile';
import { engine, project, ui } from './state';
import { host } from './host';
import { media } from './media';
import { frameAll } from './Graph';

const VIDEO = ['mp4', 'mov', 'm4v', 'webm', 'mkv'];
const IMAGE = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif'];
const AUDIO = ['wav', 'mp3', 'aiff', 'aif', 'flac', 'm4a', 'ogg', 'aac'];
const MIDI = ['mid', 'midi'];
const ext = (p: string) => p.split('.').pop()!.toLowerCase();
const base = (p: string) => p.split(/[\\/]/).pop()!;

type Over = Record<string, any>;
function builder(d: Doc) {
  return (type: string, name: string, x: number, y: number, over: Over = {}) => {
    const params = defaultParams(getOp(type)!);
    for (const [k, v] of Object.entries(over)) params[k] = v && typeof v === 'object' && !Array.isArray(v) ? v : { v };
    const n = { id: uid(), type, name, x, y, params };
    d.nodes.push(n);
    return n.id;
  };
}

/** Blank project: one video layer wired to the output, ready for clips. */
export function blankDoc(): Doc {
  const d = emptyDoc();
  const mk = builder(d);
  d.tracks.push({ id: uid('t'), name: 'V1', clips: [] });
  const l = mk('layer', 'layer1', 0, 0, { track: 1 });
  const o = mk('out', 'out1', 260, 0);
  d.conns.push({ from: l, to: o, slot: 0 });
  d.display = o;
  d.bands = DEFAULT_BANDS();
  return d;
}

/** Example patch: colour noise fed into a rotating feedback loop. */
export function feedbackDoc(): Doc {
  const d = emptyDoc();
  d.name = 'Feedback Bloom';
  const mk = builder(d);
  const noise = mk('noise', 'noise1', 0, 0, { scale: 2.2, color: true, contrast: 1.6, speed: 0.15 });
  const lv = mk('levels', 'levels1', 190, 0, { inBlack: 0.55, inWhite: 1.0, gamma: 0.8 });
  const fb = mk('feedback', 'feedback1', 0, 170, { source: 'comp1' });
  const tf = mk('transform', 'transform1', 190, 170, { scale: 1.035, rotate: { v: 1.5, ex: ['1.5 + sin(t * 0.3) * 2'] } });
  const fade = mk('levels', 'decay', 380, 170, { outWhite: 0.965 });
  const comp = mk('comp', 'comp1', 570, 70, { mode: 2 });
  const out = mk('out', 'out1', 760, 70);
  d.conns.push({ from: noise, to: lv, slot: 0 }, { from: fb, to: tf, slot: 0 }, { from: tf, to: fade, slot: 0 },
    { from: fade, to: comp, slot: 0 }, { from: lv, to: comp, slot: 1 }, { from: comp, to: out, slot: 0 });
  d.display = out;
  return d;
}

function install(doc: Doc, path: string | null = null) {
  engine.pause();
  project.load(doc, path);
  engine.restart();
  ui.set({ sel: [], shaper: doc.shapers[0]?.id ?? null });
  requestAnimationFrame(() => requestAnimationFrame(frameAll));
}
// ---------- project lifecycle ----------
/** Offer to save unsaved changes. Resolves false when the user cancels, so the caller must not go on. */
export async function confirmDiscard(): Promise<boolean> {
  if (!project.dirty) return true;
  const r = await host.confirmSave(project.doc.name);
  if (r === 'cancel') return false;
  if (r === 'save') return saveProject();
  return true;
}
function guarded(run: () => void | Promise<void>): void | Promise<void> {
  if (!project.dirty) return run();
  return confirmDiscard().then(ok => { if (ok) return run(); });
}
export function newProject() { return guarded(() => { install(blankDoc()); void clearRecovery(); ui.set({ status: 'New project' }); }); }
export function loadExample(_k: string) { return guarded(() => { install(feedbackDoc()); void clearRecovery(); engine.play(); }); }

export interface Recent { path: string; name: string }
export function recentProjects(): Recent[] { try { return JSON.parse(localStorage.getItem('phos.recent') ?? '[]'); } catch { return []; } }
function pushRecent(path: string) {
  const name = base(path).replace(/\.phos$/, '');
  const list = [{ path, name }, ...recentProjects().filter(r => r.path !== path)].slice(0, 20);
  try { localStorage.setItem('phos.recent', JSON.stringify(list)); } catch { /* storage unavailable */ }
  host.addRecent(path);
}
export function clearRecent() { try { localStorage.setItem('phos.recent', '[]'); } catch { /* ignore */ } host.clearRecent(); }
function dropRecent(path: string) { try { localStorage.setItem('phos.recent', JSON.stringify(recentProjects().filter(r => r.path !== path))); } catch { /* ignore */ } }

/** Every file a project refers to: clips, audio, MIDI and file parameters on operators. */
function mediaRefs(doc: Doc): { get(): string; set(p: string): void }[] {
  const refs: { get(): string; set(p: string): void }[] = [];
  for (const t of doc.tracks) for (const c of t.clips) refs.push({ get: () => c.path, set: p => { c.path = p; } });
  for (const a of doc.audio) refs.push({ get: () => a.path, set: p => { a.path = p; } });
  for (const m of doc.midi) refs.push({ get: () => m.path, set: p => { m.path = p; } });
  for (const n of doc.nodes) {
    const def = getOp(n.type);
    for (const pd of def?.params ?? []) if (pd.k === 'file') { const st = n.params[pd.name]; if (st && typeof st.v === 'string' && st.v) refs.push({ get: () => st.v as string, set: p => { st.v = p; } }); }
  }
  return refs;
}
/** When media has moved, ask once where one file went and find the rest beside it. */
async function relinkMissing(doc: Doc) {
  if (!host.native) return;
  const refs = mediaRefs(doc).filter(r => r.get().startsWith('/'));
  const missing: string[] = [];
  for (const p of new Set(refs.map(r => r.get()))) if (!(await host.exists(p))) missing.push(p);
  if (!missing.length) return;
  const list = missing.slice(0, 6).map(base).join('\n') + (missing.length > 6 ? `\n… and ${missing.length - 6} more` : '');
  const pick = await host.ask({ type: 'warning', message: `${missing.length} media file${missing.length > 1 ? 's are' : ' is'} missing`, detail: `${list}\n\nLocate one and Phosphene will look for the others in the same folder.`, buttons: ['Locate…', 'Skip'] });
  if (pick !== 0) { ui.set({ status: `${missing.length} media file${missing.length > 1 ? 's' : ''} missing` }); return; }
  const found = await host.locateFile();
  if (!found) return;
  const dir = found.slice(0, found.lastIndexOf('/'));
  const map = new Map<string, string>([[missing[0], found]]);
  for (const m of missing.slice(1)) { const cand = `${dir}/${base(m)}`; if (await host.exists(cand)) map.set(m, cand); }
  for (const r of refs) { const to = map.get(r.get()); if (to) r.set(to); }
  ui.set({ status: `Relinked ${map.size} of ${missing.length} missing file${missing.length > 1 ? 's' : ''}` });
  return map.size > 0;
}

async function openDoc(json: string, path: string | null, dirty = false) {
  const doc = JSON.parse(json) as Doc;
  if (doc.version !== 1 || !Array.isArray(doc.nodes)) throw new Error('Not a Phosphene project');
  doc.tracks ??= []; doc.audio ??= []; doc.midi ??= [];
  const relinked = await relinkMissing(doc);
  install(doc, path);
  if (dirty || relinked) project.dirty = true;
  await loadAudioFor(doc);
  if (path) pushRecent(path);
}
/** Open a project file by path (recent list, Finder, drag and drop). */
export async function openProjectPath(path: string) {
  if (!(await confirmDiscard())) return;
  const json = await host.readText(path);
  if (json === null) { dropRecent(path); ui.set({ status: `Could not read ${path}` }); return; }
  try { await openDoc(json, path); void clearRecovery(); ui.set({ status: `Opened ${project.doc.name}` }); }
  catch (e: any) { ui.set({ status: `Could not open project: ${e.message}` }); }
}
export async function revertProject() {
  if (!project.path || !project.dirty) return;
  const pick = await host.ask({ type: 'warning', message: `Revert “${project.doc.name}” to the last saved version?`, detail: 'Changes made since then will be lost.', buttons: ['Revert', 'Cancel'] });
  if (pick !== 0) return;
  const path = project.path;
  project.dirty = false;
  await openProjectPath(path);
}

// ---------- crash recovery ----------
let recoveryPath: string | null | undefined, recoveredRev = -1;
async function recoveryFile() { return (recoveryPath ??= await host.userPath('recovery.phos')); }
export async function clearRecovery() { const p = await recoveryFile(); if (p) await host.unlink(p); recoveredRev = project.rev; }
/** Keep a copy of unsaved work so a crash or power cut costs at most a few seconds. */
export async function writeRecovery() {
  if (!host.native || !project.dirty || project.rev === recoveredRev || engine.exporting) return;
  const p = await recoveryFile();
  if (!p) return;
  recoveredRev = project.rev;
  await host.writeFile(p, JSON.stringify({ path: project.path, doc: project.doc }));
}
export async function offerRecovery() {
  const p = await recoveryFile();
  if (!p || !(await host.exists(p))) return;
  const text = await host.readText(p);
  let rec: { path: string | null; doc: Doc } | null = null;
  try { rec = text ? JSON.parse(text) : null; } catch { rec = null; }
  if (!rec?.doc) { await host.unlink(p); return; }
  const pick = await host.ask({ message: `Restore unsaved changes to “${rec.doc.name}”?`, detail: 'Phosphene closed before this project was saved.', buttons: ['Restore', 'Discard'] });
  if (pick !== 0) { await host.unlink(p); return; }
  try { await openDoc(JSON.stringify(rec.doc), rec.path, true); ui.set({ status: `Restored unsaved changes to ${rec.doc.name}` }); }
  catch { await host.unlink(p); }
}

export async function loadAudioFor(doc: Doc) {
  for (const t of doc.audio) {
    if (engine.audio.tracks.has(t.id)) continue;
    const data = await media.get(t.path);
    if (data) await engine.audio.loadTrack(t.id, data).catch(() => ui.set({ status: `Could not decode ${t.name}` }));
    else ui.set({ status: `Missing audio file: ${t.path}` });
  }
  for (const m of doc.midi) {
    if (engine.midiData.has(m.id)) continue;
    const data = await media.get(m.path);
    if (data) { try { engine.midiData.set(m.id, parseMidi(data)); } catch { ui.set({ status: `Could not read ${m.name}` }); } }
  }
  const stems = (doc as any).stems as Record<string, string> | undefined;
  const names: Record<string, string> = { drums: 'drums', bass: 'bassline', vocals: 'vocals', other: 'other' };
  const song = doc.audio.find(a => !a.clip) ?? doc.audio[0];
  if (stems && song) for (const [k, path] of Object.entries(stems)) { const d = await host.readFile(path); if (d && names[k]) await engine.audio.loadStem(names[k], d, song.start).catch(() => {}); }
}

export async function openProject() {
  if (!(await confirmDiscard())) return;
  const r = await host.openProject();
  if (!r) return;
  try { await openDoc(r.json, r.path); void clearRecovery(); ui.set({ status: `Opened ${project.doc.name}` }); }
  catch (e: any) { ui.set({ status: `Could not open project: ${e.message}` }); }
}

/** Save the project. Resolves false when the save dialog was cancelled. */
export async function saveProject(as = false): Promise<boolean> {
  const p = await host.saveProject(project.serialize(), as ? null : project.path, project.doc.name);
  if (!p) return !host.native;
  project.path = p;
  const name = base(p).replace(/\.phos$/, '');
  if (name !== project.doc.name) { project.tx(d => { d.name = name; }); await host.saveProject(project.serialize(), p, name); }
  project.dirty = false;
  pushRecent(p);
  void clearRecovery();
  ui.set({ status: `Saved ${p}` });
  return true;
}

// ---------- media import ----------
function restartAudio() { if (engine.playing) { engine.pause(); engine.play(); } }

async function addAudioBytes(name: string, path: string, data: ArrayBuffer, start = 0, quiet = false) {
  const id = uid('a');
  try {
    const dur = await engine.audio.loadTrack(id, data);
    project.tx(d => {
      d.audio.push(quiet ? { id, name, path, start, gain: 1, clip: true } : { id, name, path, start, gain: 1 });
      if (start + dur > d.settings.duration || (d.audio.length === 1 && !d.tracks.some(t => t.clips.length))) d.settings.duration = Math.ceil(start + dur);
    });
    restartAudio();
    return dur;
  } catch (e: any) {
    if (!quiet) ui.set({ status: `Could not decode audio in ${name}` });
    return 0;
  }
}

/** Make sure a Layer operator exists for a track and reaches the output, stacking with Composite when needed. */
function ensureLayer(trackNo: number) {
  const d = project.doc;
  if (d.nodes.some(n => n.type === 'layer' && n.params.track?.v === trackNo)) return;
  const out = d.nodes.find(n => n.type === 'out');
  const layers = d.nodes.filter(n => n.type === 'layer');
  const y = layers.length ? Math.max(...layers.map(n => n.y)) + 170 : (out?.y ?? 0);
  const x = layers.length ? Math.min(...layers.map(n => n.x)) : (out ? out.x - 420 : 0);
  const l = project.addNode('layer', x, y);
  if (!l) return;
  project.setParam(l.id, 'track', trackNo, false);
  if (!out) return;
  const cur = project.inputOf(out.id, 0);
  if (!cur) { project.connect(l.id, out.id, 0); return; }
  const src = project.node(cur.from)!;
  const comp = project.addNode('comp', Math.max(src.x, x) + 190, (src.y + y) / 2);
  if (!comp) return;
  project.connect(cur.from, comp.id, 0);
  project.connect(l.id, comp.id, 1);
  project.connect(comp.id, out.id, 0);
  if (out.x < comp.x + 190) project.moveNodes([{ id: out.id, x: comp.x + 190, y: out.y }]);
}

function placeClip(clip: Clip): number {
  const d = project.doc;
  let ti = d.tracks.findIndex(t => !t.clips.some(c => clip.start < c.start + c.dur && clip.start + clip.dur > c.start));
  project.tx(doc => {
    if (ti < 0) { doc.tracks.push({ id: uid('t'), name: `V${doc.tracks.length + 1}`, clips: [] }); ti = doc.tracks.length - 1; }
    doc.tracks[ti].clips.push(clip);
    const end = clip.start + clip.dur;
    const first = doc.tracks.reduce((n, t) => n + t.clips.length, 0) === 1 && !doc.audio.length;
    if (first || end > doc.settings.duration) doc.settings.duration = Math.ceil(end);
  });
  ensureLayer(ti + 1);
  return ti;
}

export async function importItems(items: { path: string; file?: File }[]) {
  let n = 0;
  for (const it of items) {
    const e = ext(it.path), name = base(it.path);
    try {
      if (MIDI.includes(e)) {
        const data = it.file ? await it.file.arrayBuffer() : await host.readFile(it.path);
        if (!data) throw new Error('cannot read file');
        if (it.file) media.register(it.path, it.file);
        const md = parseMidi(data), id = uid('m');
        engine.midiData.set(id, md);
        project.tx(d => {
          d.midi.push({ id, name, path: it.path, start: 0 });
          if (md.dur > d.settings.duration) d.settings.duration = Math.ceil(md.dur);
          if (md.bpm && !d.audio.some(a => !a.clip)) d.settings.bpm = md.bpm;
        });
        ui.set({ status: `${name}: ${md.notes.length / 4} notes, ${Object.keys(md.cc).length} controllers. Use mgate, mtrig, mpitch, mnote(60), mcc(1) in expressions.` });
        n++;
      } else if (AUDIO.includes(e)) {
        const data = it.file ? await it.file.arrayBuffer() : await host.readFile(it.path);
        if (!data) throw new Error('cannot read file');
        if (it.file) media.register(it.path, it.file);
        const firstMusic = !project.doc.audio.some(a => !a.clip);
        if (await addAudioBytes(name, it.path, data)) { n++; if (firstMusic) analyzeSong(); }
      } else if (VIDEO.includes(e) || IMAGE.includes(e)) {
        if (it.file) media.register(it.path, it.file);
        const isVid = VIDEO.includes(e);
        const firstClip = !project.doc.tracks.some(t => t.clips.length);
        let dur = 5, srcDur = 0;
        if (isVid) {
          const info = await engine.media.probe(it.path);
          dur = srcDur = info.dur;
          if (firstClip && info.w && info.h) project.tx(d => { d.settings.width = info.w - (info.w % 2); d.settings.height = info.h - (info.h % 2); });
        }
        const start = firstClip ? 0 : Math.round(engine.time * project.doc.settings.fps) / project.doc.settings.fps;
        placeClip({ id: uid('c'), path: it.path, name, start, in: 0, dur, speed: 1, srcDur, kind: isVid ? 'video' : 'image' });
        n++;
        if (isVid) {
          // bring the clip's own soundtrack along as an audio track
          const data = it.file ? await it.file.arrayBuffer() : await host.readFile(it.path);
          if (data && data.byteLength < 1.5e9) await addAudioBytes(`${name} (audio)`, it.path, data, start, true);
        }
      } else ui.set({ status: `Unsupported file type: ${name}` });
    } catch (err: any) { ui.set({ status: `Could not import ${name}: ${err.message}` }); return; }
  }
  if (n) { ui.set({ status: `Imported ${n} file${n > 1 ? 's' : ''}`, bottomTab: 'timeline' }); requestAnimationFrame(frameAll); }
}
export const importMedia = async () => importItems(await host.pickMedia([...VIDEO, ...IMAGE, ...AUDIO, ...MIDI]));
export const importFiles = (files: File[]) => importItems(files.map(file => ({ path: host.pathFor(file) || file.name, file: host.native ? undefined : file })));
export const addAudio = async () => importItems(await host.pickMedia(AUDIO));

/** Detect tempo, downbeat and sections of the first audio track and apply them to the project. */
/** The song: the first track that is not a clip's own soundtrack, else whatever there is. */
export const musicTrack = () => project.doc.audio.find(a => !a.clip) ?? project.doc.audio[0];

export function analyzeSong() {
  const a = musicTrack();
  const r = a && engine.audio.analyzeSong(a.id);
  if (!r) { ui.set({ status: 'Add a music track first.' }); return; }
  project.tx(d => { d.settings.bpm = r.bpm; d.settings.offset = +(a.start + r.offset).toFixed(4); d.sections = r.sections.map(s => ({ ...s, t: +(s.t + a.start).toFixed(3) })); (d as any).profile = r.profile; });
  const alt = r.confidence < 0.12 && r.alt ? ` (could also be ${r.alt}; type it in the tempo field if so)` : '';
  ui.set({ status: `Song analysed: ${r.bpm} BPM${alt}, ${r.sections.length} sections. Expressions: section, energy, drop, secphase.` });
}

let stemBusy = false;
/** Split the first music track into drums / bass / vocals / other and expose each as a modulation source. */
export async function separateStems() {
  const a = musicTrack();
  if (!a) { ui.set({ status: 'Add a music track first.' }); return; }
  if (stemBusy) return;
  stemBusy = true;
  ui.set({ status: 'Separating stems…' });
  try {
    const r = await host.stemsSeparate(a.path, p => ui.set({ status: `Separating stems: ${p.stage} ${Math.round(p.fraction * 100)}%` }));
    if (r.error || !r.stems) { ui.set({ status: `Stem separation failed: ${r.error ?? 'no output'}` }); return; }
    const names: Record<string, string> = { drums: 'drums', bass: 'bassline', vocals: 'vocals', other: 'other' };
    for (const [k, path] of Object.entries(r.stems)) { const d = await host.readFile(path); if (d && names[k]) await engine.audio.loadStem(names[k], d, a.start); }
    project.tx(d => { (d as any).stems = r.stems; });
    ui.set({ status: 'Stems ready. Expressions: drums, bassline, vocals, other (add .hit for transients, e.g. drums.hit).' });
  } catch (e: any) { ui.set({ status: `Stem separation failed: ${e.message ?? e}` }); }
  finally { stemBusy = false; }
}

export function removeMidi(id: string) { engine.midiData.delete(id); project.tx(d => { d.midi = d.midi.filter(m => m.id !== id); }); }

export function removeAudio(id: string) {
  engine.audio.removeTrack(id);
  project.tx(d => { d.audio = d.audio.filter(a => a.id !== id); });
  restartAudio();
}

export function addShaper() {
  const s = defaultShaper(project.doc.shapers.length + 1);
  while (project.doc.shapers.some(q => q.name === s.name)) s.name = `s${parseInt(s.name.slice(1)) + 1}`;
  project.tx(d => { d.shapers.push(s); });
  ui.set({ shaper: s.id, bottomTab: 'shapers' });
}

// ---------- output windows ----------
const outWins = new Map<string, Window>();
/** Open (or focus) a borderless output window for an Out operator. Each Out can drive its own display. */
export function openOutput(id?: string) {
  const target = id ?? engine.finalNode();
  if (!target) { ui.set({ status: 'Nothing to output yet — add an Out operator.' }); return; }
  const name = project.node(target)?.name ?? 'output';
  const old = outWins.get(target);
  if (old && !old.closed) { old.focus(); return; }
  const w = window.open('', `phosphene-output-${target}`, `width=1280,height=720,left=${120 + outWins.size * 60},top=${120 + outWins.size * 60}`);
  if (!w) { ui.set({ status: 'Could not open the output window' }); return; }
  outWins.set(target, w);
  w.document.title = `Phosphene Output — ${name}`;
  w.document.body.style.cssText = 'margin:0;background:#000;overflow:hidden;cursor:none';
  const cv = w.document.createElement('canvas');
  cv.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;display:block';
  w.document.body.appendChild(cv);
  try {
    const ctx = engine.configure(cv);
    const off = engine.onFrame(() => {
      if (w.closed) { off(); outWins.delete(target); return; }
      const dpr = w.devicePixelRatio || 1;
      const cw = Math.round(w.innerWidth * dpr), ch = Math.round(w.innerHeight * dpr);
      if (cw < 2 || ch < 2) return;
      if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }
      const s = project.doc.settings, k = Math.min(cw / s.width, ch / s.height);
      const vw = Math.floor(s.width * k), vh = Math.floor(s.height * k);
      const node = project.node(target) ? target : engine.finalNode();
      engine.present(ctx, node, { exposure: 0, mode: 0, tonemap: false }, [Math.floor((cw - vw) / 2), Math.floor((ch - vh) / 2), vw, vh]);
    });
    w.addEventListener('dblclick', () => { void w.document.documentElement.requestFullscreen?.(); });
    w.addEventListener('keydown', e => { if (e.key === 'f') void w.document.documentElement.requestFullscreen?.(); if (e.key === ' ') engine.toggle(); });
    ui.set({ status: `Output “${name}” open — drag it to its display and double-click for fullscreen` });
  } catch (e: any) { w.close(); outWins.delete(target); ui.set({ status: `Output window failed: ${e.message}` }); }
}
