// NERVE — core type definitions. No DOM or GPU access at import time.

/** Wire types. `tex` = RGBA16F image, `field` = vector field (xy in RG, same storage as tex), `sig` = scalar signal. */
export type SockType = 'tex' | 'field' | 'sig';

export type Category =
  | 'Generate' | 'Filter' | 'Distort' | 'Color' | 'Composite'
  | 'Time' | 'Glitch' | 'Simulate' | 'Field' | 'Spectral' | 'Signal' | 'Audio' | 'IO' | 'Stage';

interface PBase { name: string; label?: string; group?: string; help?: string }
export interface PFloat extends PBase { k: 'float'; def: number; min?: number; max?: number; step?: number; unit?: string }
export interface PInt extends PBase { k: 'int'; def: number; min?: number; max?: number }
export interface PBool extends PBase { k: 'bool'; def: boolean }
export interface PEnum extends PBase { k: 'enum'; options: string[]; def: number }
export interface PVec2 extends PBase {
  k: 'vec2'; def: [number, number]; min?: number; max?: number; step?: number;
  /** Draggable handle in the viewer: 'uv' = the value is a 0..1 picture position; `base` = the value is an offset from that position. */
  gizmo?: 'uv' | { base: [number, number] };
}
/** RGBA, authored in sRGB, delivered to shaders as linear `vec4f`. */
export interface PColor extends PBase { k: 'color'; def: [number, number, number, number] }
/** Free text; not passed to shaders (e.g. node references). */
export interface PString extends PBase { k: 'string'; def: string }
export interface PCode extends PBase { k: 'code'; def: string }
export interface PFile extends PBase { k: 'file'; def: string; accept?: string }
export type ParamDef = PFloat | PInt | PBool | PEnum | PVec2 | PColor | PString | PCode | PFile;

export type FieldT = 'f32' | 'i32' | 'vec2f' | 'vec3f' | 'vec4f';
export type Field = [name: string, type: FieldT];

/** A statically declared fullscreen fragment pass. `body` must define `fn op(uv: vec2f) -> vec4f`. */
export interface PassDecl {
  /** Texture binding names, in order. Each becomes `var <name>: texture_2d<f32>` and a `u.has_<name>` flag. */
  inputs: string[];
  /** Uniform fields, available as `u.<name>`. */
  fields?: Field[];
  body: string;
}

export interface InputDef { name: string; type: SockType; optional?: boolean }

export type Vals = Record<string, number | boolean | number[]>;

export interface OpDef {
  type: string;
  label: string;
  category: Category;
  inputs: InputDef[];
  output: SockType;
  params: ParamDef[];
  help?: string;
  /** Extra words that find this operator in search (synonyms, what people call the look). */
  keywords?: string;
  /** Extra state that should trigger a re-cook when it changes (e.g. the motion of the clip under the playhead). */
  hashExtra?(doc: Doc, time: number, p: Record<string, any>): string;
  /** Reads the operator named by this string parameter as a hidden input 0 (Get Global). */
  refInput?: string;
  /**
   * Single-pass shorthand. Texture inputs are bound under their input names, every numeric
   * param is available as `u.<name>` (float→f32, int/bool/enum→i32, vec2→vec2f, color→vec4f).
   */
  body?: string;
  /** Named passes for multi-pass ops; run them from `cook` with `c.run(name, ...)`. */
  passes?: Record<string, PassDecl>;
  /** Custom cook. Must leave the result in `c.out`. */
  cook?(c: CookCtx): void;
  /** Cue time-based media for this frame. Must be idempotent. */
  prep?(c: PrepCtx): void;
  /** Runs after every node has cooked this frame (feedback capture and the like). */
  post?(c: CookCtx): void;
  /** Signal ops: return this frame's value. */
  sig?(c: SigCtx): number;
  /** Re-cook every frame even when params are unchanged. Auto-detected for `body` that reads `g.`. */
  animated?: boolean;
  /** Free per-node GPU state. */
  dispose?(state: any): void;
}

export interface FrameInfo {
  time: number; dt: number; frame: number; beat: number; bpm: number; fps: number;
  /** True on the first frame after a transport reset/seek to 0 — stateful ops should clear. */
  reset: boolean;
}

export interface CookCtx extends FrameInfo {
  device: GPUDevice;
  /** Working resolution in pixels. */
  w: number; h: number;
  /** Resolved param values for this frame (expressions, modulation and keyframes applied). */
  p: Record<string, any>;
  /** Input texture views by slot; null when unconnected. */
  ins: (GPUTextureView | null)[];
  inTex: (GPUTexture | null)[];
  /** This node's output. */
  out: GPUTextureView;
  outTex: GPUTexture;
  /** Persistent per-node scratch object. */
  state: any;
  /** Run a declared pass. `texs` follow the pass's `inputs` order; null binds transparent black. */
  run(pass: string, target: GPUTextureView, texs: (GPUTextureView | null)[], vals?: Vals, res?: [number, number], opts?: { viewport?: [number, number, number, number]; load?: boolean }): void;
  /** Compile (or reuse) a pass from source at runtime — for user-authored shaders. Returns an error string while invalid. */
  dynamic(key: string, decl: PassDecl): string | null;
  runDynamic(key: string, target: GPUTextureView, texs: (GPUTextureView | null)[], vals?: Vals): void;
  /** Persistent per-node texture (created on first use, recreated on size change). Default size = working res. */
  tex(key: string, w?: number, h?: number): { tex: GPUTexture; view: GPUTextureView; fresh: boolean };
  copy(src: GPUTexture, dst: GPUTexture): void;
  clear(target: GPUTextureView): void;
  /** Look up another node's current output by name (feedback-style references). */
  ref(name: string): { tex: GPUTexture; view: GPUTextureView } | null;
  /** Shared audio texture: 512×2, row 0 = log spectrum (R), row 1 = waveform (R). */
  audioView: GPUTextureView;
  doc: Doc;
  media: import('./media').MediaEngine;
  playing: boolean;
  nodeId: string;
  gpu: import('./gpu').Gpu;
}

/** Passed to `prep`, which runs for every node before cooking so media can be cued (and awaited during export). */
export interface PrepCtx extends FrameInfo { p: Record<string, any>; doc: Doc; media: import('./media').MediaEngine; playing: boolean; nodeId: string }

export interface SigCtx extends FrameInfo {
  p: Record<string, any>;
  /** Input signal values by slot (0 when unconnected). */
  ins: number[];
  connected: boolean[];
  state: any;
  audio: AudioFrame;
  midi: import('./midi').Midi;
}

export interface AudioFrame {
  level: number; bass: number; lowmid: number; mid: number; high: number; air: number;
  /** Decaying onset envelope: 1 on a detected low-band transient, falling toward 0. */
  kick: number;
  /** Decaying onset envelope across the full band. */
  onset: number;
  /** 512 log-spaced magnitudes, 0..1. */
  spectrum: Float32Array;
  /** 512 samples of the current window, -1..1. */
  wave: Float32Array;
}

// ---------- document model ----------

export interface ModLink { src: string; amt: number; comp?: number }
export interface Key { t: number; v: number; ease?: 'lin' | 'hold' | 'smooth' | 'in' | 'out' }

export interface PState {
  v: any;
  /** Expression per component (index 0 for scalars). */
  ex?: (string | null)[];
  mods?: ModLink[];
  /** Keyframes per component. */
  keys?: (Key[] | null)[];
}

export interface NodeData {
  id: string; type: string; name: string; x: number; y: number;
  params: Record<string, PState>;
  bypass?: boolean;
  /** Group this node is folded into. */
  group?: string;
}

/** Nodes folded into one box in the network, with a few of their parameters shown on the box. */
export interface Group {
  id: string; name: string; x: number; y: number;
  /** Parameters shown when the group is selected: node name + parameter name, with an optional label. */
  exposed: { node: string; param: string; label?: string }[];
  color?: string;
  note?: string;
}

export interface Conn { from: string; to: string; slot: number }

export interface ShaperPoint { x: number; y: number; c: number }
export interface ShaperData {
  id: string; name: string;
  points: ShaperPoint[];
  /** Cycle length in beats (sync) or seconds (free). */
  length: number;
  mode: 'sync' | 'free' | 'trigger';
  /** Trigger source band when mode = trigger. */
  trig: 'kick' | 'onset' | 'bass' | 'mid' | 'high';
  threshold: number;
  phase: number;
  smooth: number;
  bipolar: boolean;
}

/** A piece of a media file placed on a video track. Times are in seconds. */
export interface Clip {
  id: string; path: string; name: string;
  /** Repeat the source from its beginning when the clip is longer than the footage. */
  loop?: boolean;
  /** Timeline position. */
  start: number;
  /** Offset into the source media. */
  in: number;
  /** Length on the timeline. */
  dur: number;
  speed: number;
  /** Source media length; 0 for stills. */
  srcDur: number;
  kind: 'video' | 'image';
  /** Effect while this clip plays (index into CLIP_EFFECTS). */
  fx?: number;
  /** Blend with the picture on the track above (index into CLIP_BLENDS). */
  blend?: number;
  /** Transition into this clip (index into TRANSITIONS) and its length in seconds. */
  trans?: number;
  transLen?: number;
  /** Motion, as in Premiere: position (px offset), scale (%), rotation (°); each may be keyframed in clip-local time. */
  motion?: Partial<Record<'pos' | 'scale' | 'rot', PState>>;
}
export interface Track { id: string; name: string; clips: Clip[]; mute?: boolean }

export interface AudioTrackData { id: string; name: string; path: string; start: number; gain: number; mute?: boolean; /** The soundtrack of a video clip rather than the song. */ clip?: boolean }

/** A parameter shown as an editable curve under the timeline. */
export interface Lane { id: string; node: string; param: string; comp: number }
/** A frequency band of the music, drawn on the spectrum and usable by name in any expression or modulation. */
export interface Band { id: string; name: string; lo: number; hi: number; gain: number; floor: number; attack: number; release: number }

export interface Settings { width: number; height: number; fps: number; bpm: number; duration: number; /** Time of the first downbeat, seconds. */ offset?: number }

/** A MIDI file placed on the timeline. */
export interface MidiClipData { id: string; name: string; path: string; start: number; mute?: boolean }
/** A recorded controller performance. */
export interface Take { cc: Record<string, number[]>; notes: number[] }
/** A detected part of the song. `level` is its loudness tier 0..1. */
export interface Section { t: number; level: number; name: string }

export interface Doc {
  version: 1;
  name: string;
  settings: Settings;
  nodes: NodeData[];
  conns: Conn[];
  shapers: ShaperData[];
  audio: AudioTrackData[];
  /** Video layers, bottom to top. A `layer` operator brings each one into the graph. */
  tracks: Track[];
  /** Node shown in the viewer. */
  display: string | null;
  midi: MidiClipData[];
  take: Take;
  sections: Section[];
  /** Time range picked on the timeline for export, seconds. */
  region?: [number, number] | null;
  lanes?: Lane[];
  groups?: Group[];
  /** Footage Auto Edit draws from: every source clip, with its length. */
  pool?: { path: string; name: string; dur: number }[];
  bands?: Band[];
  /** Where the subject is in each piece of footage over its own time: a smoothed camera path, uv 0..1, `rate` samples a second. */
  focus?: Record<string, { rate: number; xy: number[] }>;
}
