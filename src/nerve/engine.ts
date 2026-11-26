// NERVE — the engine: transport, parameter resolution, dirty-tracked cook loop, presentation.
import { clipValue } from './clipfx';
import type { CookCtx, Doc, FrameInfo, Key, NodeData, OpDef, ParamDef, PassDecl, PState, SigCtx, Vals } from './types';
import { MediaEngine } from './media';
import { Midi } from './midi';
import { ccAt, noteState, type MidiData, type MidiPlaced } from './midifile';
import { Gpu, Pass } from './gpu';
import { passesOf } from './wgsl';
import { getOp } from './registry';
import { Project } from './project';
import { AudioEngine } from './audio';
import { Shapers } from './shaper';
import { compileCached, type Env } from './expr';

interface NodeRT {
  tex: GPUTexture | null; view: GPUTextureView | null;
  /** View actually exposed downstream (differs from `view` when bypassed). */
  outView: GPUTextureView | null; outTex: GPUTexture | null;
  value: number;
  state: any;
  texs: Map<string, { tex: GPUTexture; view: GPUTextureView }>;
  hash: string;
  cookedAt: number;
  ms: number;
  err: string | null;
  p: Record<string, any>;
}

const srgb2lin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const ANIM_RE = /\bg\.(time|beat|frame|dt|audio2?)\b/;

export function evalKeys(keys: Key[], t: number): number {
  if (t <= keys[0].t) return keys[0].v;
  if (t >= keys[keys.length - 1].t) return keys[keys.length - 1].v;
  let lo = 0, hi = keys.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (keys[m].t <= t) lo = m; else hi = m; }
  for (let i = lo; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    if (t <= b.t) {
      let u = (t - a.t) / Math.max(1e-9, b.t - a.t);
      switch (a.ease) {
        case 'hold': return a.v;
        case 'smooth': u = u * u * (3 - 2 * u); break;
        case 'in': u = u * u * u; break;
        case 'out': u = 1 - Math.pow(1 - u, 3); break;
      }
      return a.v + (b.v - a.v) * u;
    }
  }
  return keys[keys.length - 1].v;
}

const VIEW_PASS: PassDecl = {
  inputs: ['src'],
  fields: [['exposure', 'f32'], ['mode', 'i32'], ['tonemap', 'i32'], ['checker', 'i32'], ['encode', 'i32']],
  body: /* wgsl */`
fn aces(x: vec3f) -> vec3f { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0)); }
fn enc(c: vec3f) -> vec3f {
  let lo = c * 12.92; let hi = 1.055 * pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3f(0.0031308));
}
fn op(uv: vec2f) -> vec4f {
  var c = textureSampleLevel(src, smp, uv, 0.0);
  var rgb = c.rgb;
  var a = c.a;
  if (u.mode == 1) { rgb = vec3f(c.r); a = 1.0; }
  else if (u.mode == 2) { rgb = vec3f(c.g); a = 1.0; }
  else if (u.mode == 3) { rgb = vec3f(c.b); a = 1.0; }
  else if (u.mode == 4) { rgb = vec3f(c.a); a = 1.0; }
  else if (u.mode == 5) {
    let m = length(c.rg);
    rgb = hsv2rgb(vec3f(atan2(c.g, c.r) / TAU + 0.5, 1.0, sat(m * 20.0)));
    rgb = pow(rgb, vec3f(2.2)); a = 1.0;
  }
  rgb = max(rgb, vec3f(0.0)) * exp2(u.exposure);
  if (u.tonemap == 1) { rgb = aces(rgb); }
  if (u.checker == 1) {
    let q = floor(uv * g.res / 8.0);
    let k = mix(0.018, 0.035, f32((i32(q.x) + i32(q.y)) & 1));
    rgb = rgb + vec3f(k) * (1.0 - sat(a));
  }
  if (u.encode == 1) { rgb = enc(clamp(rgb, vec3f(0.0), vec3f(1.0))); }
  return vec4f(rgb, 1.0);
}`,
};

export interface ViewOpts { exposure: number; mode: number; tonemap: boolean }

export class Engine {
  gpu!: Gpu;
  audio = new AudioEngine();
  shapers = new Shapers();
  media = new MediaEngine();
  midi = new Midi();
  /** Parsed MIDI files by clip id. */
  midiData = new Map<string, MidiData>();
  /** True while a performance is being captured to the timeline. */
  recording = false;
  private recNotes = new Map<number, { t: number; v: number }>();
  private notes = { gate: 0, pitch: -1, count: 0, last: -Infinity, vel: new Float32Array(128) };
  rts = new Map<string, NodeRT>();
  // transport
  time = 0;
  playing = false;
  loop = true;
  /** Preview resolution divisor (1, 2, 4). */
  quality = 1;
  /** Engine tick counter (monotonic, independent of transport). */
  tickN = 0;
  fpsMeasured = 0;
  cookMs = 0;
  info: FrameInfo = { time: 0, dt: 0, frame: 0, beat: 0, bpm: 120, fps: 60, reset: true };
  exprErrors = new Map<string, string>();
  private frameSubs = new Set<() => void>();
  /** Called after every cooked frame, in subscription order. */
  onFrame(fn: () => void) { this.frameSubs.add(fn); return () => { this.frameSubs.delete(fn); }; }

  passes = new Map<string, Pass>();
  private dyn = new Map<string, { src: string; err: string | null; pending: boolean }>();
  private viewPass!: Pass;
  private order: NodeData[] = [];
  private orderTopo = -1;
  private orderDoc: Doc | null = null;
  private lastReal = 0;
  private lastTime = -1;
  private pendingReset = true;
  private raf = 0;
  private audioTex!: GPUTexture;
  private audioView!: GPUTextureView;
  private audioData = new Float32Array(512 * 2 * 4);
  private audioHalf = new Uint16Array(512 * 2 * 4);
  private overrideRes: [number, number] | null = null;
  private fpsAcc = 0; private fpsN = 0;

  constructor(public project: Project) {}

  async init() {
    this.project.keyTime = has => (has ? +this.time.toFixed(4) : null);
    this.gpu = await Gpu.create();
    this.viewPass = new Pass(this.gpu, VIEW_PASS, this.gpu.canvasFormat, 'view');
    this.audioTex = this.gpu.texture(512, 2);
    this.audioView = this.audioTex.createView();
  }

  // ---------- transport ----------
  play() {
    if (this.playing) return;
    const d = this.project.doc;
    if (this.time >= d.settings.duration - 1e-3) this.seek(0);
    this.playing = true;
    if (d.audio.length) this.audio.play(this.time, d.audio);
  }
  pause() { this.playing = false; this.audio.stop(); if (this.recording) this.setRecording(false); }
  toggle() { this.playing ? this.pause() : this.play(); }
  seek(t: number) {
    const was = this.playing;
    if (was) this.audio.stop();
    this.time = Math.max(0, t);
    if (t <= 0) this.pendingReset = true;
    if (was && this.project.doc.audio.length) this.audio.play(this.time, this.project.doc.audio);
  }
  // ---------- MIDI clips, takes, sections ----------
  private placedMidi(): MidiPlaced[] {
    const d = this.project.doc, out: MidiPlaced[] = [];
    for (const c of d.midi) { const data = this.midiData.get(c.id); if (data) out.push({ data, start: c.start, mute: c.mute }); }
    if (d.take.notes.length) out.push({ data: { dur: 0, notes: d.take.notes, cc: d.take.cc }, start: 0 });
    return out;
  }
  private midiCC(n: number): number[] | undefined {
    for (const c of this.project.doc.midi) { const cv = this.midiData.get(c.id)?.cc[n]; if (cv && !c.mute) return c.start ? cv.map((x, i) => (i % 2 ? x : x + c.start)) : cv; }
    return undefined;
  }
  /** A controller's value: your hand if it moved just now or you are recording, otherwise the recorded take. */
  ccValue(n: number): number {
    if (this.recording || this.exporting === false && performance.now() - this.midi.ccAt[n] < 1500) return this.midi.cc[n];
    return ccAt(this.project.doc.take.cc[n], this.time) ?? ccAt(this.midiCC(n), this.time) ?? this.midi.cc[n];
  }
  sectionAt(t: number) {
    const s = this.project.doc.sections;
    let i = -1;
    for (let k = 0; k < s.length && s[k].t <= t; k++) i = k;
    if (i < 0) return { index: 0, level: 0, phase: 0 };
    const end = s[i + 1]?.t ?? this.project.doc.settings.duration;
    return { index: i, level: s[i].level, phase: Math.min(1, (t - s[i].t) / Math.max(1e-3, end - s[i].t)) };
  }
  /** Arm or disarm performance capture. Controller moves from the playhead onward replace the existing take. */
  setRecording(on: boolean) {
    if (on === this.recording) return;
    const take = this.project.doc.take;
    if (on) {
      const t0 = this.time;
      for (const k of Object.keys(take.cc)) { const c = take.cc[k]; let n = 0; while (n < c.length && c[n] < t0) n += 2; c.length = n; }
      const keep: number[] = [];
      for (let i = 0; i < take.notes.length; i += 4) if (take.notes[i] < t0) keep.push(take.notes[i], take.notes[i + 1], take.notes[i + 2], take.notes[i + 3]);
      take.notes = keep;
      this.midi.onEvent = (kind, a, b) => {
        if (!this.playing) return;
        const t = +this.time.toFixed(4);
        if (kind === 'cc') { const c = (take.cc[a] ??= []); if (c.length >= 2 && t - c[c.length - 2] < 1 / 120) c[c.length - 1] = b; else c.push(t, b); }
        else if (kind === 'on') this.recNotes.set(a, { t, v: b });
        else { const q = this.recNotes.get(a); if (q) { take.notes.push(q.t, Math.max(0.02, t - q.t), a, q.v); this.recNotes.delete(a); } }
      };
      this.project.keyTime = () => (this.playing ? +this.time.toFixed(4) : null);
      if (!this.playing) this.play();
    } else {
      this.midi.onEvent = null; this.recNotes.clear();
      this.project.keyTime = has => (has ? +this.time.toFixed(4) : null);
      // notes may have been captured out of order across pitches
      const rows: number[][] = [];
      for (let i = 0; i < take.notes.length; i += 4) rows.push(take.notes.slice(i, i + 4));
      rows.sort((x, y) => x[0] - y[0]);
      this.project.tx(d => { d.take.notes = rows.flat(); });
    }
    this.recording = on;
  }

  /** Rewind and clear all stateful operators. */
  restart() { this.seek(0); this.pendingReset = true; }

  start() {
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      this.tick(now);
    };
    this.raf = requestAnimationFrame(loop);
  }
  halt() { cancelAnimationFrame(this.raf); }

  /** Set while an offline render owns the engine; the realtime loop idles. */
  exporting = false;
  emitFrame() { for (const f of this.frameSubs) f(); }

  private tick(now: number) {
    if (this.exporting) { this.lastReal = now; return; }
    const real = this.lastReal ? Math.min(0.1, (now - this.lastReal) / 1000) : 0;
    this.lastReal = now;
    if (real > 0) { this.fpsAcc += real; this.fpsN++; if (this.fpsAcc >= 0.5) { this.fpsMeasured = this.fpsN / this.fpsAcc; this.fpsAcc = 0; this.fpsN = 0; } }
    const d = this.project.doc;
    if (this.playing) {
      this.time = this.audio.playing ? this.audio.time() : this.time + real;
      if (this.time >= d.settings.duration) {
        if (this.loop) this.restart(); else { this.time = d.settings.duration; this.pause(); }
      }
    }
    const t0 = performance.now();
    if (this.playing) {
      // cook on the project's frame grid, exactly as export does, so feedback and motion effects look the same in both
      const fps = d.settings.fps, fr = Math.floor(this.time * fps + 1e-6);
      if (fr === this.playFrame) { for (const f of this.frameSubs) f(); return; }
      const adv = this.playFrame >= 0 && fr > this.playFrame ? Math.min(4, fr - this.playFrame) : 1;
      this.playFrame = fr;
      this.cookFrame(fr / fps, adv / fps);
    } else { this.playFrame = -1; this.cookFrame(this.time, 0); }
    this.cookMs += (performance.now() - t0 - this.cookMs) * 0.1;
    for (const f of this.frameSubs) f();
  }
  private playFrame = -1;

  // ---------- cooking ----------
  resolution(): [number, number] {
    if (this.overrideRes) return this.overrideRes;
    const s = this.project.doc.settings;
    return [Math.max(16, Math.round(s.width / this.quality)), Math.max(16, Math.round(s.height / this.quality))];
  }
  setRenderRes(res: [number, number] | null) { this.overrideRes = res; }

  private orderRefs = '';
  /** Wires plus the hidden links of operators that read another by name (Get Global → its Global). */
  private allConns() {
    const doc = this.project.doc, extra: { from: string; to: string; slot: number }[] = [];
    for (const n of doc.nodes) {
      const f = getOp(n.type)?.refInput;
      if (!f) continue;
      const src = this.project.byName(String(n.params[f]?.v ?? ''));
      if (src && src.id !== n.id) extra.push({ from: src.id, to: n.id, slot: 0 });
    }
    return extra.length ? [...doc.conns, ...extra] : doc.conns;
  }
  private refKey() { let k = ''; for (const n of this.project.doc.nodes) { const f = getOp(n.type)?.refInput; if (f) k += n.id + '=' + (n.params[f]?.v ?? '') + ';'; } return k; }
  private topoOrder(): NodeData[] {
    const doc = this.project.doc;
    const refKey = this.refKey();
    if (this.orderTopo === this.project.topo && this.orderDoc === doc && this.orderRefs === refKey) return this.order;
    this.orderRefs = refKey;
    const indeg = new Map<string, number>();
    const outs = new Map<string, string[]>();
    for (const n of doc.nodes) indeg.set(n.id, 0);
    for (const c of this.allConns()) {
      if (!indeg.has(c.to) || !indeg.has(c.from)) continue;
      indeg.set(c.to, indeg.get(c.to)! + 1);
      (outs.get(c.from) ?? outs.set(c.from, []).get(c.from)!).push(c.to);
    }
    const byId = new Map(doc.nodes.map(n => [n.id, n]));
    const q = doc.nodes.filter(n => indeg.get(n.id) === 0).map(n => n.id);
    const order: NodeData[] = [];
    while (q.length) {
      const id = q.shift()!;
      order.push(byId.get(id)!);
      for (const o of outs.get(id) ?? []) { const k = indeg.get(o)! - 1; indeg.set(o, k); if (k === 0) q.push(o); }
    }
    this.order = order; this.orderTopo = this.project.topo; this.orderDoc = doc;
    // drop runtimes of deleted nodes
    for (const [id, rt] of this.rts) if (!byId.has(id)) { this.freeRT(rt, getOp('')); this.rts.delete(id); }
    return order;
  }

  private freeRT(rt: NodeRT, _def?: OpDef) {
    rt.tex?.destroy();
    for (const t of rt.texs.values()) t.tex.destroy();
    rt.texs.clear();
  }

  /** Output of each user band this frame, by name. */
  bandValues = new Map<string, number>();
  /** Envelope-followed level of every band in the project: energy in its range, gained, gated by its floor. */
  private cookBands(dt: number, reset: boolean) {
    const bands = this.project.doc.bands;
    if (!bands?.length) { if (this.bandValues.size) this.bandValues.clear(); return; }
    const seen = new Set<string>();
    for (const b of bands) {
      seen.add(b.name);
      const raw = this.audio.bandHz(b.lo, b.hi) * b.gain;
      const target = Math.min(1, Math.max(0, (raw - b.floor) / Math.max(1e-3, 1 - b.floor)));
      const prev = reset ? 0 : this.bandValues.get(b.name) ?? 0;
      const tc = target > prev ? b.attack : b.release;
      const k = dt <= 0 ? 0 : tc <= 1e-4 ? 1 : 1 - Math.exp(-dt / tc);
      this.bandValues.set(b.name, prev + (target - prev) * k);
    }
    for (const k of this.bandValues.keys()) if (!seen.has(k)) this.bandValues.delete(k);
  }

  /** Value of any expression name right now (transport, audio, bands, shapers, signals, MIDI). */
  env: Env = name => {
    const i = this.info, a = this.audio.frame;
    switch (name) {
      case 't': case 'time': return i.time;
      case 'beat': return i.beat;
      case 'bar': return i.beat / 4;
      case 'frame': return i.frame;
      case 'fps': return i.fps;
      case 'bpm': return i.bpm;
      case 'dt': return i.dt;
      case 'w': return this.project.doc.settings.width;
      case 'h': return this.project.doc.settings.height;
      case 'level': case 'bass': case 'lowmid': case 'mid': case 'high': case 'air': case 'kick': case 'onset': return a[name];
    }
    const sv = this.shapers.values.get(name);
    if (sv !== undefined) return sv;
    const bv = this.bandValues.get(name);
    if (bv !== undefined) return bv;
    const n = this.project.byName(name);
    if (n) return this.rts.get(n.id)?.value ?? 0;
    switch (name) {
      case 'mgate': return this.notes.gate;
      case 'mpitch': return this.notes.pitch < 0 ? 0 : this.notes.pitch / 127;
      case 'mcount': return this.notes.count;
      case 'mtrig': return Math.exp(-8 * Math.max(0, i.time - this.notes.last));
      case 'section': return this.sectionAt(i.time).index;
      case 'energy': return this.sectionAt(i.time).level;
      case 'drop': return this.sectionAt(i.time).level > 0.75 ? 1 : 0;
      case 'secphase': return this.sectionAt(i.time).phase;
    }
    const cv = clipValue(this.project.doc, i.time, name);
    if (cv !== undefined) return cv;
    if (name.startsWith('cc(')) return this.ccValue(parseInt(name.slice(3)) & 127);
    if (name.startsWith('mnote(')) return this.notes.vel[parseInt(name.slice(6)) & 127];
    if (name.startsWith('mcc(')) return ccAt(this.midiCC(parseInt(name.slice(4))), i.time) ?? 0;
    const stem = this.audio.stemValue(name);
    if (stem !== undefined) return stem;
    if (name.startsWith('osc.')) return this.midi.oscValue('/' + name.slice(4).replace(/\./g, '/'));
    if (name.startsWith('note(')) return this.midi.note[parseInt(name.slice(5)) & 127];
    if (name.startsWith('fft(')) {
      const x = parseFloat(name.slice(4));
      return a.spectrum[Math.min(511, Math.max(0, Math.floor(x * 512)))] ?? 0;
    }
    if (name.startsWith('band(')) {
      const [lo, hi] = name.slice(5, -1).split(',').map(Number);
      return this.audio.bandHz(lo, hi ?? lo);
    }
    throw new Error(`Unknown name "${name}"`);
  };

  private comp(nodeId: string, pd: ParamDef, st: PState, idx: number, base: number): number {
    let v = base;
    const keys = st.keys?.[idx];
    if (keys && keys.length) v = evalKeys(keys, this.info.time);
    const ex = st.ex?.[idx];
    const key = `${nodeId}:${pd.name}:${idx}`;
    if (ex) {
      const c = compileCached(ex);
      if (c.fn) {
        try { const r = c.fn(this.env); if (Number.isFinite(r)) v = r; this.exprErrors.delete(key); }
        catch (e: any) { this.exprErrors.set(key, e.message); }
      } else this.exprErrors.set(key, c.err!);
    } else if (this.exprErrors.size) this.exprErrors.delete(key);
    if (st.mods) {
      const range = (('max' in pd ? pd.max : undefined) ?? 1) - (('min' in pd ? pd.min : undefined) ?? 0);
      for (const m of st.mods) {
        if ((m.comp ?? 0) !== idx) continue;
        try { v += this.env(m.src) * m.amt * range; } catch { /* missing source */ }
      }
    }
    return v;
  }

  private resolve(node: NodeData, def: OpDef): Record<string, any> {
    const out: Record<string, any> = {};
    for (const pd of def.params) {
      const st = node.params[pd.name] ?? { v: pd.def };
      switch (pd.k) {
        case 'float': out[pd.name] = this.comp(node.id, pd, st, 0, st.v); break;
        case 'int': out[pd.name] = Math.round(this.comp(node.id, pd, st, 0, st.v)); break;
        case 'vec2': out[pd.name] = [this.comp(node.id, pd, st, 0, st.v[0]), this.comp(node.id, pd, st, 1, st.v[1])]; break;
        case 'color': out[pd.name] = [srgb2lin(st.v[0]), srgb2lin(st.v[1]), srgb2lin(st.v[2]), st.v[3]]; break;
        case 'bool': out[pd.name] = st.v ? 1 : 0; break;
        default: out[pd.name] = st.v;
      }
    }
    return out;
  }

  pass(def: OpDef, name: string): Pass {
    const key = `${def.type}:${name}`;
    let p = this.passes.get(key);
    if (!p) {
      const decl = passesOf(def)[name];
      if (!decl) throw new Error(`Op "${def.type}" has no pass "${name}"`);
      p = new Pass(this.gpu, decl, undefined, key);
      this.passes.set(key, p);
    }
    return p;
  }
  /** Replace a cached pass (live shader editing). */
  setPass(key: string, decl: PassDecl) {
    this.passes.get(key)?.destroy();
    this.passes.set(key, new Pass(this.gpu, decl, undefined, key));
  }
  hasPass(key: string) { return this.passes.has(key); }
  /** Validate asynchronously, then swap the pass in; the previous good version keeps running meanwhile. */
  dynamicPass(key: string, decl: PassDecl): string | null {
    const src = JSON.stringify(decl);
    let d = this.dyn.get(key);
    if (!d || d.src !== src) {
      d = { src, err: d?.err ?? null, pending: true };
      this.dyn.set(key, d);
      const cur = d;
      void Pass.diagnose(this.gpu, decl).then(err => {
        if (this.dyn.get(key) !== cur) return;
        cur.pending = false; cur.err = err;
        if (!err) { try { this.setPass(key, decl); } catch (e: any) { cur.err = e.message; } }
      });
    }
    return d.err;
  }
  dropPass(key: string) { this.passes.get(key)?.destroy(); this.passes.delete(key); }

  private rt(id: string): NodeRT {
    let r = this.rts.get(id);
    if (!r) this.rts.set(id, (r = { tex: null, view: null, outView: null, outTex: null, value: 0, state: {}, texs: new Map(), hash: '', cookedAt: -1, ms: 0, err: null, p: {} }));
    return r;
  }

  /**
   * Cook one frame at transport time `time`. `only` restricts cooking to the upstream cone of the given nodes.
   */
  cookFrame(time: number, dt: number, only?: Set<string>) {
    const doc = this.project.doc;
    const s = doc.settings;
    const reset = this.pendingReset || (this.lastTime > 0 && time < this.lastTime - 0.5 && time < 1 / s.fps);
    this.pendingReset = false;
    const advanced = time !== this.lastTime || reset;
    this.lastTime = time;
    this.tickN++;
    const info = this.info;
    info.time = time; info.dt = dt; info.fps = s.fps; info.bpm = s.bpm;
    info.frame = Math.floor(time * s.fps + 1e-6); info.beat = ((time - (s.offset ?? 0)) * s.bpm) / 60; info.reset = reset;
    this.notes = noteState(this.placedMidi(), time);
    if (reset) { this.audio.resetState(); this.shapers.reset(); }

    const a = advanced || this.audio.live ? this.audio.analyze(time, dt, doc.audio) : this.audio.frame;
    if (advanced || this.audio.live || reset) this.cookBands(dt, reset);
    this.shapers.update(doc.shapers, time, info.beat, dt, a);
    this.uploadAudio();
    const g = this.gpu.gdata;
    g[2] = time; g[3] = dt; g[4] = info.beat; g[5] = info.frame; g[6] = s.bpm;
    g[8] = a.bass; g[9] = a.mid; g[10] = a.high; g[11] = a.level;
    g[12] = a.kick; g[13] = a.lowmid; g[14] = a.air; g[15] = a.onset;

    const [w, h] = this.resolution();
    const order = this.topoOrder();
    this.prepNodes(order);
    const inMap = new Map<string, (string | undefined)[]>();
    for (const c of this.allConns()) (inMap.get(c.to) ?? inMap.set(c.to, []).get(c.to)!)[c.slot] = c.from;

    let cone: Set<string> | null = null;
    if (only) {
      cone = new Set();
      const stack = [...only];
      // signal operators are read by name from expressions, not through wires, so the cone cannot see who needs them:
      // always cook them (they cost nothing), or keyframed and LFO-driven values would freeze during export
      for (const n of order) if (getOp(n.type)?.output === 'sig') stack.push(n.id);
      while (stack.length) {
        const id = stack.pop()!;
        if (cone.has(id)) continue;
        cone.add(id);
        for (const f of inMap.get(id) ?? []) if (f) stack.push(f);
        // feedback-style references keep their source alive
        const n = this.project.node(id);
        const src = n?.params.source?.v;
        if (typeof src === 'string') { const r = this.project.byName(src); if (r) stack.push(r.id); }
      }
    }

    const cooked: { node: NodeData; def: OpDef; ctx: CookCtx }[] = [];
    for (const node of order) {
      if (cone && !cone.has(node.id)) continue;
      const def = getOp(node.type);
      const rt = this.rt(node.id);
      if (!def) { rt.err = `Unknown operator "${node.type}"`; continue; }
      const srcIds = inMap.get(node.id) ?? [];
      const p = this.resolve(node, def);
      rt.p = p;

      if (def.output === 'sig') {
        const ins = def.inputs.map((_, i) => (srcIds[i] ? this.rts.get(srcIds[i]!)?.value ?? 0 : 0));
        const sc: SigCtx = { ...info, p, ins, connected: def.inputs.map((_, i) => !!srcIds[i]), state: rt.state, audio: a, midi: this.midi };
        try { const v = def.sig ? def.sig(sc) : 0; rt.value = Number.isFinite(v) ? v : 0; rt.err = null; }
        catch (e: any) { rt.err = e.message; }
        rt.cookedAt = this.tickN;
        continue;
      }

      const inDefs = def.refInput ? [{ name: 'src' }] : def.inputs;
      const inRT = inDefs.map((_, i) => (srcIds[i] ? this.rts.get(srcIds[i]!) : undefined));
      const ins = inRT.map(r => r?.outView ?? null);
      const inTex = inRT.map(r => r?.outTex ?? null);

      if (!rt.tex || rt.tex.width !== w || rt.tex.height !== h) {
        rt.tex?.destroy();
        rt.tex = this.gpu.texture(w, h); rt.view = rt.tex.createView(); rt.hash = '';
      }
      if (node.bypass && ins[0]) {
        // switching to pass-through changes what downstream sees, so it counts as a fresh result this tick
        const switched = rt.outView !== ins[0];
        rt.outView = ins[0]; rt.outTex = inTex[0];
        if (switched || inRT[0]!.cookedAt === this.tickN) rt.cookedAt = this.tickN;
        continue;
      }
      const wasBypassed = rt.outView !== rt.view;
      rt.outView = rt.view; rt.outTex = rt.tex;

      const animated = def.animated ?? (!!def.prep || this.isAnimated(def));
      const hash = JSON.stringify(p) + srcIds.join(',') + (def.hashExtra ? def.hashExtra(doc, time, p) : '');
      const dirty = wasBypassed || hash !== rt.hash || reset || (animated && advanced) || inRT.some(r => r && r.cookedAt === this.tickN);
      const ctx = this.ctx(node, def, rt, p, ins, inTex, w, h);
      if (dirty) {
        rt.hash = hash;
        const t0 = performance.now();
        try {
          if (def.cook) def.cook(ctx);
          else if (def.body) this.pass(def, 'main').run(rt.view!, def.inputs.filter(i => i.type !== 'sig').map((_, i) => ins[i]), p as Vals, [w, h]);
          rt.err = null;
        } catch (e: any) { rt.err = e.message; }
        rt.ms += (performance.now() - t0 - rt.ms) * 0.2;
        rt.cookedAt = this.tickN;
      }
      if (def.post && (advanced || dirty)) cooked.push({ node, def, ctx });
    }
    for (const c of cooked) { try { c.def.post!(c.ctx); } catch (e: any) { this.rt(c.node.id).err = e.message; } }
    this.media.endFrame();
  }

  private prepNodes(order: NodeData[]) {
    this.media.beginFrame();
    for (const node of order) {
      const def = getOp(node.type);
      if (!def?.prep || node.bypass) continue;
      try { def.prep({ ...this.info, p: this.resolve(node, def), doc: this.project.doc, media: this.media, playing: this.playing, nodeId: node.id }); }
      catch (e: any) { this.rt(node.id).err = e.message; }
    }
  }

  /** Export: cue all media for `time` and wait until every frame is decoded, before `cookFrame(time)`. */
  async prepFrame(time: number) {
    const s = this.project.doc.settings;
    this.info.time = time; this.info.frame = Math.floor(time * s.fps + 1e-6); this.info.beat = (time * s.bpm) / 60; this.info.fps = s.fps; this.info.bpm = s.bpm;
    this.prepNodes(this.topoOrder());
    await this.media.settle();
  }

  private animCache = new Map<string, boolean>();
  private isAnimated(def: OpDef) {
    let v = this.animCache.get(def.type);
    if (v === undefined) {
      v = Object.values(passesOf(def)).some(p => ANIM_RE.test(p.body));
      this.animCache.set(def.type, v);
    }
    return v;
  }

  private ctx(node: NodeData, def: OpDef, rt: NodeRT, p: Record<string, any>, ins: (GPUTextureView | null)[], inTex: (GPUTexture | null)[], w: number, h: number): CookCtx {
    const eng = this;
    return {
      ...this.info, device: this.gpu.device, w, h, p, ins, inTex,
      out: rt.view!, outTex: rt.tex!, state: rt.state, audioView: this.audioView,
      doc: this.project.doc, media: this.media, playing: this.playing, nodeId: node.id, gpu: this.gpu,
      run(pass, target, texs, vals, res, opts) { eng.pass(def, pass).run(target, texs, { ...(vals ?? {}) }, res ?? [w, h], opts); },
      dynamic(key, decl) { return eng.dynamicPass(`${node.id}:${key}`, decl); },
      runDynamic(key, target, texs, vals) { eng.passes.get(`${node.id}:${key}`)?.run(target, texs, { ...(vals ?? {}) }, [w, h]); },
      tex(key, tw = w, th = h) {
        tw = Math.max(1, Math.round(tw)); th = Math.max(1, Math.round(th));
        let t = rt.texs.get(key);
        let fresh = false;
        if (!t || t.tex.width !== tw || t.tex.height !== th) {
          t?.tex.destroy();
          const tex = eng.gpu.texture(tw, th);
          t = { tex, view: tex.createView() };
          rt.texs.set(key, t);
          eng.gpu.clear(t.view);
          fresh = true;
        }
        return { ...t, fresh };
      },
      copy: (a, b) => eng.gpu.copy(a, b),
      clear: v => eng.gpu.clear(v),
      ref(name) {
        const n = eng.project.byName(name);
        const r = n && n.id !== node.id ? eng.rts.get(n.id) : null;
        return r?.outTex && r.outView ? { tex: r.outTex, view: r.outView } : null;
      },
    };
  }

  private uploadAudio() {
    const a = this.audio.frame, d = this.audioData;
    for (let i = 0; i < 512; i++) { d[i * 4] = a.spectrum[i]; d[(512 + i) * 4] = a.wave[i]; }
    const h = this.audioHalf;
    for (let i = 0; i < d.length; i += 4) h[i] = toHalf(d[i]);
    this.gpu.device.queue.writeTexture({ texture: this.audioTex }, h, { bytesPerRow: 512 * 8 }, [512, 2]);
  }

  // ---------- presentation ----------
  viewOf(id: string | null): GPUTextureView | null { return id ? this.rts.get(id)?.outView ?? null : null; }
  nodeErr(id: string) { return this.rts.get(id)?.err ?? null; }
  nodeMs(id: string) { return this.rts.get(id)?.ms ?? 0; }
  sigValue(id: string) { return this.rts.get(id)?.value ?? 0; }
  resolved(id: string) { return this.rts.get(id)?.p; }

  /** The node whose output is the final picture: the first `out` op, else the displayed node. */
  finalNode(): string | null {
    const d = this.project.doc;
    return d.nodes.find(n => n.type === 'out')?.id ?? d.display;
  }

  /** Draw a node's output into a configured canvas context. */
  present(ctx: GPUCanvasContext, id: string | null, o: ViewOpts, viewport?: [number, number, number, number], load = false) {
    const src = this.viewOf(id);
    const target = ctx.getCurrentTexture();
    const def = id ? getOp(this.project.node(id)?.type ?? '') : null;
    const mode = o.mode === 0 && def?.output === 'field' ? 5 : o.mode;
    this.viewPass.run(target.createView(), [src], { exposure: o.exposure, mode, tonemap: o.tonemap, checker: 1, encode: 1 },
      viewport ? [viewport[2], viewport[3]] : [target.width, target.height], { viewport, load });
  }
  configure(canvas: HTMLCanvasElement | OffscreenCanvas): GPUCanvasContext {
    const ctx = canvas.getContext('webgpu') as GPUCanvasContext;
    ctx.configure({ device: this.gpu.device, format: this.gpu.canvasFormat, alphaMode: 'opaque' });
    return ctx;
  }
}

const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
/** float32 → IEEE half. */
export function toHalf(v: number): number {
  f32[0] = v;
  const x = u32[0];
  const sign = (x >> 16) & 0x8000;
  let exp = ((x >> 23) & 0xff) - 127 + 15;
  let man = x & 0x7fffff;
  if (exp <= 0) { if (exp < -10) return sign; man = (man | 0x800000) >> (1 - exp); return sign | ((man + 0x1000) >> 13); }
  if (exp >= 31) return sign | 0x7c00;
  return sign | (exp << 10) | ((man + 0x1000) >> 13);
}
