// NERVE — local machine-vision inference (monocular depth, person segmentation, pose/hand/object tracking).
// Everything is lazy: no library or model loads until an operator asks for it. Inference is asynchronous and
// at most one request per job is in flight; ops always read the most recent completed result (realtime lags by
// a frame or two). The offline renderer awaits `ml.settle()` through `exportSettle`, so exports are deterministic.
// Heavy libraries are imported dynamically so this module stays importable from Node (WGSL validation).
import { Pass, type Gpu } from './gpu';
import { exportSettle } from './hooks';
import type { PassDecl } from './types';

export type MlStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface ModelState {
  status: MlStatus;
  /** Short human message: progress while loading, the failure when status = error. */
  msg: string;
  /** 0..1 download progress. */
  progress: number;
  /** Bytes downloaded (or read from cache) for this model. */
  bytes: number;
  /** Execution backend actually in use (webgpu / wasm / GPU / CPU). */
  backend: string;
  /** Smoothed inference time in ms (excludes frame readback). */
  ms: number;
  runs: number;
}

/** A float map result (depth or matte) as a filterable r16float texture. */
export interface MapResult { view: GPUTextureView | null; w: number; h: number; status: MlStatus; msg: string; /** Increments per completed inference. */ seq: number }

export interface TrackPoint { x: number; y: number; v: number }
export interface TrackBox { x: number; y: number; w: number; h: number; label: string; score: number }
export interface TrackResult {
  kind: 'pose' | 'hands' | 'objects';
  /** One landmark list per detected person / hand, coordinates 0..1 with origin top-left. */
  people: TrackPoint[][];
  /** Handedness label per hand ('Left' / 'Right'); empty for pose. */
  labels: string[];
  boxes: TrackBox[];
  /** Increments on every completed inference. */
  seq: number;
}

const DEPTH_MODEL = 'onnx-community/depth-anything-v2-small';
const MP_VERSION = '1.2.3';
const MP_WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`;
const MP_MODELS = {
  seg: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite',
  pose: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task',
  hands: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task',
  objects: 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/latest/efficientdet_lite0.tflite',
} as const;
type MpKind = keyof typeof MP_MODELS;
type Kind = 'depth' | MpKind;

/** Renders the (linear, rgba16float) input at the model's working size, sRGB-encoded, for readback. */
const ENCODE: PassDecl = {
  inputs: ['src'],
  fields: [['srcRes', 'vec2f']],
  body: /* wgsl */`
fn ml_enc(c: vec3f) -> vec3f {
  let lo = c * 12.92; let hi = 1.055 * pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3f(0.0031308));
}
fn op(uv: vec2f) -> vec4f {
  // 2x2 bilinear taps over the destination pixel footprint: a cheap box filter for downscaling
  let o = 0.25 / g.res;
  var c = textureSampleLevel(src, smp, uv + vec2f(-o.x, -o.y), 0.0).rgb;
  c += textureSampleLevel(src, smp, uv + vec2f(o.x, -o.y), 0.0).rgb;
  c += textureSampleLevel(src, smp, uv + vec2f(-o.x, o.y), 0.0).rgb;
  c += textureSampleLevel(src, smp, uv + vec2f(o.x, o.y), 0.0).rgb;
  return vec4f(ml_enc(clamp(c * 0.25, vec3f(0.0), vec3f(1.0))), 1.0);
}`,
};

const f32b = new Float32Array(1), u32b = new Uint32Array(f32b.buffer);
/** float32 → IEEE half bits. */
export function toHalf(v: number): number {
  f32b[0] = v;
  const x = u32b[0];
  const sign = (x >> 16) & 0x8000;
  let exp = ((x >> 23) & 0xff) - 127 + 15;
  let man = x & 0x7fffff;
  if (exp <= 0) { if (exp < -10) return sign; man = (man | 0x800000) >> (1 - exp); return sign | ((man + 0x1000) >> 13); }
  if (exp >= 31) return sign | 0x7c00;
  return sign | (exp << 10) | ((man + 0x1000) >> 13);
}
function fromHalf(h: number): number {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

/** GPU → CPU frame grabber: encode pass into an rgba8 texture, copy to a mappable buffer. */
class Grabber {
  tex: GPUTexture | null = null; view: GPUTextureView | null = null; buf: GPUBuffer | null = null;
  w = 0; h = 0; padded = 0;
  ensure(gpu: Gpu, w: number, h: number) {
    if (this.tex && this.w === w && this.h === h) return;
    this.tex?.destroy(); this.buf?.destroy();
    this.w = w; this.h = h; this.padded = Math.ceil((w * 4) / 256) * 256;
    this.tex = gpu.texture(w, h, 'rgba8unorm');
    this.view = this.tex.createView();
    this.buf = gpu.device.createBuffer({ size: this.padded * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  }
  /** Submits the encode + copy now (so this frame's picture is captured); resolves with tight RGBA bytes. */
  grab(gpu: Gpu, pass: Pass, src: GPUTextureView, srcW: number, srcH: number, w: number, h: number): Promise<ImageData> {
    this.ensure(gpu, w, h);
    pass.run(this.view!, [src], { srcRes: [srcW, srcH] }, [w, h]);
    const enc = gpu.device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: this.tex! }, { buffer: this.buf!, bytesPerRow: this.padded }, [w, h]);
    gpu.device.queue.submit([enc.finish()]);
    const buf = this.buf!, padded = this.padded;
    return buf.mapAsync(GPUMapMode.READ).then(() => {
      const src8 = new Uint8Array(buf.getMappedRange());
      const out = new Uint8ClampedArray(w * h * 4);
      if (padded === w * 4) out.set(src8.subarray(0, out.length));
      else for (let y = 0; y < h; y++) out.set(src8.subarray(y * padded, y * padded + w * 4), y * w * 4);
      buf.unmap();
      return new ImageData(out, w, h);
    });
  }
}

interface Job {
  key: string; kind: Kind;
  busy: Promise<void> | null;
  grab: Grabber;
  /** Uploaded float map (depth / matte). */
  out: GPUTexture | null; outView: GPUTextureView | null;
  err: string | null;
  track: TrackResult | null;
  /** Per-job MediaPipe instance (pose / hands keep tracking state across frames). */
  inst: any;
  ts: number;
  seq: number;
  /** Raw min/max of the last depth inference (verification / debugging). */
  range: [number, number];
  /** Set when we forced a re-cook only to display a finished result: that cook must not start a new inference. */
  skip: boolean;
}

const blank = (): ModelState => ({ status: 'idle', msg: '', progress: 0, bytes: 0, backend: '', ms: 0, runs: 0 });

function plainError(e: any, what: string): string {
  const m = String(e?.message ?? e ?? '');
  if (/fetch|network|Failed to load|ERR_|404|403|offline|NetworkError/i.test(m)) return `Could not download the ${what} model (offline?)`;
  return `${what} model failed: ${m.split('\n')[0].slice(0, 140)}`;
}

/**
 * While the transport is paused nothing re-cooks, so a result that lands later would never be shown. Mark the
 * node dirty through the engine's public runtime map (the only reach outside this module). Returns true if poked.
 */
function poke(nodeKey: string): boolean {
  const e = (globalThis as any).__phos?.engine;
  const rt = e?.rts?.get?.(nodeKey);
  if (!rt || e.playing || e.exporting) return false;
  rt.hash = '';
  return true;
}

class Ml {
  models: Record<Kind, ModelState> = { depth: blank(), seg: blank(), pose: blank(), hands: blank(), objects: blank() };
  /** Latest tracking result per Tracker node name. */
  tracks = new Map<string, TrackResult>();
  /** Tracker job status per node name (so Track Point can tell "loading" from "no such tracker"). */
  trackStatus = new Map<string, MlStatus>();
  /** Export in 'like preview' mode: renders do not wait for inference, so results land a few frames late as in realtime. */
  liveExport = false;
  private jobs = new Map<string, Job>();
  private encode: Pass | null = null;
  private encodeGpu: Gpu | null = null;
  private loads: Partial<Record<Kind, Promise<any>>> = {};
  private depthLock: Promise<void> = Promise.resolve();
  private mpLib: Promise<any> | null = null;
  private mpFiles: Promise<any> | null = null;
  private mpBytes: Partial<Record<MpKind, Promise<Uint8Array>>> = {};

  /** One-line summary of every model that has been asked for. */
  statusText(): string {
    const parts: string[] = [];
    for (const [k, m] of Object.entries(this.models)) {
      if (m.status === 'idle') continue;
      parts.push(`${k}: ${m.status}${m.backend ? ` (${m.backend})` : ''}${m.msg ? ` — ${m.msg}` : ''}${m.runs ? `, ${m.ms.toFixed(1)} ms × ${m.runs}` : ''}`);
    }
    return parts.join('; ') || 'idle';
  }
  /** Debug/verification info for a job (e.g. raw depth range). */
  jobInfo(key: string) {
    const j = (['depth', 'seg', 'pose', 'hands', 'objects'] as Kind[]).map(k => this.jobs.get(`${k}:${key}`)).find(Boolean);
    return j ? { kind: j.kind, seq: j.seq, err: j.err, range: j.range, out: j.out ? [j.out.width, j.out.height] : null, busy: !!j.busy } : null;
  }
  /** Result landed: show it (paused transport) without triggering another inference on the same frame. */
  private landed(j: Job) { if (poke(j.key)) j.skip = true; }
  /** Model became ready: every waiting node should cook and submit its first frame. */
  private wake(kind: Kind) { for (const j of this.jobs.values()) if (j.kind === kind) poke(j.key); }
  /** Consume the skip flag: true when this cook must not start an inference. */
  private skipping(j: Job) { const s = j.skip; j.skip = false; return s; }

  /** Resolves when every in-flight inference (and any model still loading) has finished. */
  async settle() {
    for (let guard = 0; guard < 4; guard++) {
      const p: Promise<any>[] = [];
      for (const k of Object.keys(this.loads) as Kind[]) if (this.models[k].status === 'loading') p.push(this.loads[k]!.catch(() => {}));
      if (!this.liveExport) for (const j of this.jobs.values()) if (j.busy) p.push(j.busy);
      if (!p.length) return;
      // never hang an export on a stuck backend: give up waiting after 30 s
      await Promise.race([Promise.all(p), new Promise(r => setTimeout(r, 30000))]);
    }
  }

  private job(key: string, kind: Kind): Job {
    const id = `${kind}:${key}`;
    let j = this.jobs.get(id);
    if (!j) this.jobs.set(id, (j = { key, kind, busy: null, grab: new Grabber(), out: null, outView: null, err: null, track: null, inst: null, ts: 0, seq: 0, range: [0, 0], skip: false }));
    return j;
  }
  private encoder(gpu: Gpu): Pass {
    if (!this.encode || this.encodeGpu !== gpu) { this.encode = new Pass(gpu, ENCODE, 'rgba8unorm', 'ml:encode'); this.encodeGpu = gpu; }
    return this.encode;
  }

  /** Upload a float map into the job's r16float texture. */
  private upload(gpu: Gpu, j: Job, data: ArrayLike<number>, w: number, h: number, map: (v: number) => number) {
    if (!j.out || j.out.width !== w || j.out.height !== h) {
      j.out?.destroy();
      j.out = gpu.device.createTexture({ size: [w, h], format: 'r16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      j.outView = j.out.createView();
    }
    const half = new Uint16Array(w * h);
    for (let i = 0; i < w * h; i++) half[i] = toHalf(map(data[i]));
    gpu.device.queue.writeTexture({ texture: j.out }, half, { bytesPerRow: w * 2 }, [w, h]);
  }

  private timed(kind: Kind, t0: number) {
    const m = this.models[kind];
    const dt = performance.now() - t0;
    m.ms = m.runs ? m.ms + (dt - m.ms) * 0.2 : dt;
    m.runs++;
  }

  // ------------------------------------------------------------------ depth (Depth Anything V2 Small)

  private loadDepth(): Promise<any> {
    if (this.loads.depth) return this.loads.depth;
    const m = this.models.depth;
    m.status = 'loading'; m.msg = 'loading library';
    const files = new Map<string, [number, number]>();
    const progress = (p: any) => {
      if (p.status === 'progress' && p.file) {
        files.set(p.file, [p.loaded ?? 0, p.total ?? 0]);
        let a = 0, b = 0;
        for (const [l, t] of files.values()) { a += l; b += t; }
        m.bytes = a; m.progress = b ? a / b : 0;
        m.msg = `downloading ${(a / 1e6).toFixed(1)} / ${(b / 1e6).toFixed(1)} MB`;
      }
    };
    this.loads.depth = (async () => {
      const T: any = await import('@huggingface/transformers');
      T.env.allowLocalModels = false;
      const attempts: { device: string; dtype: string }[] = [];
      if ((navigator as any).gpu) attempts.push({ device: 'webgpu', dtype: 'fp16' }, { device: 'webgpu', dtype: 'fp32' });
      attempts.push({ device: 'wasm', dtype: 'q8' });
      let lastErr: any = null;
      for (const a of attempts) {
        try {
          m.msg = `loading (${a.device} ${a.dtype})`;
          const model = await T.AutoModel.from_pretrained(DEPTH_MODEL, { device: a.device, dtype: a.dtype, progress_callback: progress });
          // warm-up proves the backend actually runs this graph (fp16 needs shader-f16 support)
          const px = new Float32Array(3 * 56 * 56);
          const r = await model({ pixel_values: new T.Tensor('float32', px, [1, 3, 56, 56]) });
          if (!r?.predicted_depth) throw new Error('model returned no depth');
          m.status = 'ready'; m.msg = ''; m.backend = `${a.device} ${a.dtype}`; m.progress = 1;
          queueMicrotask(() => this.wake('depth'));
          return { T, model };
        } catch (e) { lastErr = e; console.warn('[ml] depth backend failed', a, e); }
      }
      m.status = 'error'; m.msg = plainError(lastErr, 'depth');
      throw new Error(m.msg);
    })();
    this.loads.depth.catch(() => {});
    return this.loads.depth;
  }

  /**
   * Monocular depth of `src` (near = 1, far = 0, robustly normalised per frame). `size` = long side of the
   * model's working resolution (rounded to multiples of 14). Returns the latest completed result.
   */
  depth(gpu: Gpu, key: string, src: GPUTextureView, srcW: number, srcH: number, size: number): MapResult {
    const j = this.job(key, 'depth');
    const m = this.models.depth;
    void this.loadDepth();
    if (m.status === 'error') return { view: null, w: 0, h: 0, status: 'error', msg: m.msg, seq: 0 };
    if (m.status === 'ready' && !j.busy && !this.skipping(j)) {
      const L = Math.max(56, Math.round(size / 14) * 14);
      const a = srcW / srcH;
      const w = a >= 1 ? L : Math.max(14, Math.round((L * a) / 14) * 14);
      const h = a >= 1 ? Math.max(14, Math.round(L / a / 14) * 14) : L;
      const frame = j.grab.grab(gpu, this.encoder(gpu), src, srcW, srcH, w, h);
      j.busy = (async () => {
        const img = await frame;
        // serialise across nodes: one depth inference at a time
        const prev = this.depthLock;
        let release!: () => void;
        this.depthLock = new Promise<void>(r => (release = r));
        await prev;
        try {
          const { T, model } = await this.loadDepth();
          const n = w * h, px = new Float32Array(3 * n), d = img.data;
          const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
          for (let c = 0; c < 3; c++) {
            const mu = mean[c], is = 1 / (255 * std[c]), off = c * n, k = mu / std[c];
            for (let i = 0; i < n; i++) px[off + i] = d[i * 4 + c] * is - k;
          }
          const t0 = performance.now();
          const r = await model({ pixel_values: new T.Tensor('float32', px, [1, 3, h, w]) });
          const pd = r.predicted_depth;
          const dims: number[] = pd.dims;
          const oh = dims[dims.length - 2], ow = dims[dims.length - 1];
          let raw: ArrayLike<number> = pd.data;
          if (raw instanceof Uint16Array) { const f = new Float32Array(raw.length); for (let i = 0; i < raw.length; i++) f[i] = fromHalf(raw[i]); raw = f; }
          this.timed('depth', t0);
          // robust range: 1st / 99th percentile of a strided sample
          const step = Math.max(1, Math.floor(raw.length / 4096));
          const s: number[] = [];
          let mn = Infinity, mx = -Infinity;
          for (let i = 0; i < raw.length; i += step) { const v = raw[i]; if (Number.isFinite(v)) { s.push(v); if (v < mn) mn = v; if (v > mx) mx = v; } }
          s.sort((x, y) => x - y);
          const lo = s[Math.floor(s.length * 0.01)] ?? 0, hi = s[Math.floor(s.length * 0.99)] ?? 1;
          const inv = 1 / Math.max(1e-6, hi - lo);
          j.range = [mn, mx];
          this.upload(gpu, j, raw, ow, oh, v => Math.min(1, Math.max(0, (v - lo) * inv)));
          j.err = null; j.seq++;
          this.landed(j);
        } catch (e) {
          j.err = plainError(e, 'depth');
          console.warn('[ml] depth inference failed', e);
        } finally { release(); j.busy = null; }
      })();
    }
    if (j.err) return { view: null, w: 0, h: 0, status: 'error', msg: j.err, seq: j.seq };
    return { view: j.outView, w: j.out?.width ?? 0, h: j.out?.height ?? 0, status: m.status, msg: m.msg, seq: j.seq };
  }

  // ------------------------------------------------------------------ MediaPipe tasks

  private mp(kind: MpKind): Promise<{ lib: any; files: any; bytes: Uint8Array }> {
    const m = this.models[kind];
    if (m.status === 'idle') { m.status = 'loading'; m.msg = 'loading runtime'; }
    this.mpLib ??= import('@mediapipe/tasks-vision');
    this.mpFiles ??= this.mpLib.then(lib => lib.FilesetResolver.forVisionTasks(MP_WASM));
    this.mpBytes[kind] ??= (async () => {
      const res = await fetch(MP_MODELS[kind]);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const total = +(res.headers.get('content-length') ?? 0);
      const reader = res.body!.getReader();
      const chunks: Uint8Array[] = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); got += value.length;
        m.bytes = got; m.progress = total ? got / total : 0;
        m.msg = `downloading ${(got / 1e6).toFixed(1)} MB`;
      }
      const out = new Uint8Array(got);
      let o = 0;
      for (const c of chunks) { out.set(c, o); o += c.length; }
      return out;
    })();
    return Promise.all([this.mpLib, this.mpFiles, this.mpBytes[kind]!]).then(([lib, files, bytes]) => ({ lib, files, bytes }));
  }

  private async mpCreate(kind: MpKind): Promise<any> {
    const { lib, files, bytes } = await this.mp(kind);
    const m = this.models[kind];
    m.msg = 'initialising';
    const make = (delegate: 'GPU' | 'CPU') => {
      const baseOptions = { modelAssetBuffer: bytes, delegate };
      switch (kind) {
        case 'seg': return lib.ImageSegmenter.createFromOptions(files, { baseOptions, runningMode: 'VIDEO', outputCategoryMask: false, outputConfidenceMasks: true });
        case 'pose': return lib.PoseLandmarker.createFromOptions(files, { baseOptions, runningMode: 'VIDEO', numPoses: 2 });
        case 'hands': return lib.HandLandmarker.createFromOptions(files, { baseOptions, runningMode: 'VIDEO', numHands: 2 });
        case 'objects': return lib.ObjectDetector.createFromOptions(files, { baseOptions, runningMode: 'VIDEO', maxResults: 12, scoreThreshold: 0.25 });
      }
    };
    try { const inst = await make('GPU'); m.backend = 'GPU'; return inst; }
    catch (e) { console.warn(`[ml] ${kind} GPU delegate failed, using CPU`, e); const inst = await make('CPU'); m.backend = 'CPU'; return inst; }
  }

  /** Shared (stateless) instances for seg/objects; per-job instances for pose/hands (they track across frames). */
  private shared: Partial<Record<MpKind, { p: Promise<any>; inst: any }>> = {};
  /** Kick off (or return) the task instance for a job; null until it has been created. */
  private mpInstance(j: Job): any {
    const kind = j.kind as MpKind;
    const isShared = kind === 'seg' || kind === 'objects';
    let slot: { p: Promise<any>; inst: any } | undefined = isShared ? this.shared[kind] : j.inst;
    if (!slot) {
      const m = this.models[kind];
      const s: { p: Promise<any>; inst: any } = { p: this.mpCreate(kind), inst: null };
      slot = s;
      if (isShared) this.shared[kind] = s; else j.inst = s;
      this.loads[kind] = s.p;
      s.p.then(inst => { s.inst = inst; m.status = 'ready'; m.msg = ''; m.progress = 1; this.wake(kind); },
        e => { m.status = 'error'; m.msg = plainError(e, kind === 'seg' ? 'segmentation' : kind); console.warn(`[ml] ${kind} load failed`, e); });
      s.p.catch(() => {});
    }
    return slot.inst;
  }

  private mpRun(gpu: Gpu, j: Job, src: GPUTextureView, srcW: number, srcH: number, size: number, onResult: (inst: any, img: ImageData, ts: number) => void) {
    const kind = j.kind as MpKind;
    const inst = this.mpInstance(j);
    if (!inst || j.busy || this.models[kind].status === 'error' || this.skipping(j)) return;
    const a = srcW / srcH;
    const w = a >= 1 ? size : Math.max(16, Math.round(size * a));
    const h = a >= 1 ? Math.max(16, Math.round(size / a)) : size;
    const frame = j.grab.grab(gpu, this.encoder(gpu), src, srcW, srcH, w, h);
    j.busy = (async () => {
      try {
        const img = await frame;
        // VIDEO mode needs strictly increasing timestamps per instance
        inst.__ts = (inst.__ts ?? 0) + 33;
        j.ts = inst.__ts;
        const t0 = performance.now();
        onResult(inst, img, inst.__ts);
        this.timed(kind, t0);
        j.err = null; j.seq++;
        this.landed(j);
      } catch (e) {
        j.err = plainError(e, kind);
        console.warn(`[ml] ${kind} inference failed`, e);
      } finally { j.busy = null; }
    })();
  }

  /**
   * Multiclass selfie segmentation. `cls`: 0 Person (everything but background), 1 Hair, 2 Body skin,
   * 3 Face skin, 4 Clothes, 5 Background. Returns a 0..1 matte.
   */
  segment(gpu: Gpu, key: string, src: GPUTextureView, srcW: number, srcH: number, cls: number, size = 256): MapResult {
    const j = this.job(key, 'seg');
    const m = this.models.seg;
    this.mpRun(gpu, j, src, srcW, srcH, size, (inst, img, ts) => {
      inst.segmentForVideo(img, ts, (r: any) => {
        const masks = r.confidenceMasks ?? [];
        // model classes: 0 background, 1 hair, 2 body-skin, 3 face-skin, 4 clothes, 5 others (accessories)
        const idx = cls === 0 || cls === 5 ? 0 : cls === 1 ? 1 : cls === 2 ? 2 : cls === 3 ? 3 : 4;
        const mk = masks[idx];
        if (!mk) throw new Error('segmenter returned no mask');
        const data: Float32Array = mk.getAsFloat32Array();
        this.upload(gpu, j, data, mk.width, mk.height, cls === 0 ? v => 1 - v : v => v);
      });
    });
    if (m.status === 'error') return { view: null, w: 0, h: 0, status: 'error', msg: m.msg, seq: 0 };
    if (j.err) return { view: null, w: 0, h: 0, status: 'error', msg: j.err, seq: j.seq };
    return { view: j.outView, w: j.out?.width ?? 0, h: j.out?.height ?? 0, status: m.status, msg: m.msg, seq: j.seq };
  }

  /** Pose / hand landmarks or object boxes. Results are also published under `name` in `ml.tracks`. */
  track(gpu: Gpu, key: string, name: string, src: GPUTextureView, srcW: number, srcH: number, mode: 0 | 1 | 2, size = 512): { result: TrackResult | null; status: MlStatus; msg: string } {
    const kind: MpKind = mode === 0 ? 'pose' : mode === 1 ? 'hands' : 'objects';
    // switching model on a node: drop the other kinds' results for that node
    for (const k of ['pose', 'hands', 'objects'] as MpKind[]) if (k !== kind) { const o = this.jobs.get(`${k}:${key}`); if (o) o.track = null; }
    const j = this.job(key, kind);
    const m = this.models[kind];
    this.mpRun(gpu, j, src, srcW, srcH, size, (inst, img, ts) => {
      const r = inst.detectForVideo(img, ts);
      const res: TrackResult = { kind, people: [], labels: [], boxes: [], seq: j.seq + 1 };
      if (kind === 'pose') {
        for (const lm of r.landmarks ?? []) res.people.push(lm.map((p: any) => ({ x: p.x, y: p.y, v: p.visibility ?? 1 })));
      } else if (kind === 'hands') {
        (r.landmarks ?? []).forEach((lm: any[], i: number) => {
          res.people.push(lm.map((p: any) => ({ x: p.x, y: p.y, v: 1 })));
          res.labels.push(r.handedness?.[i]?.[0]?.categoryName ?? r.handednesses?.[i]?.[0]?.categoryName ?? '');
        });
      } else {
        for (const d of r.detections ?? []) {
          const b = d.boundingBox, c = d.categories?.[0];
          if (!b) continue;
          res.boxes.push({ x: b.originX / img.width, y: b.originY / img.height, w: b.width / img.width, h: b.height / img.height, label: c?.categoryName ?? '', score: c?.score ?? 0 });
        }
      }
      j.track = res;
    });
    const status: MlStatus = m.status === 'error' || j.err ? 'error' : m.status;
    this.trackStatus.set(name, status);
    if (j.track) this.tracks.set(name, j.track); else this.tracks.delete(name);
    if (status === 'error') return { result: null, status, msg: j.err ?? m.msg };
    return { result: j.track, status, msg: m.msg };
  }
}

export const ml = new Ml();
// debugging and scripted measurements reach the inference state through this
(globalThis as any).__ml = ml;

/** People in a still picture (boxes 0..1, origin top-left). Shares the object model with Object Track. */
let stillDetector: Promise<any> | null = null;
export async function detectStill(img: ImageData): Promise<TrackBox[]> {
  stillDetector ??= (async () => {
    const { lib, files, bytes } = await (ml as any).mp('objects');
    const make = (delegate: 'GPU' | 'CPU') => lib.ObjectDetector.createFromOptions(files, { baseOptions: { modelAssetBuffer: bytes, delegate }, runningMode: 'IMAGE', maxResults: 8, scoreThreshold: 0.1 });
    try { return await make('GPU'); } catch { return make('CPU'); }
  })();
  const det = await stillDetector;
  const r = det.detect(img);
  const out: TrackBox[] = [];
  for (const d of r.detections ?? []) {
    const b = d.boundingBox, c = d.categories?.[0];
    if (b) out.push({ x: b.originX / img.width, y: b.originY / img.height, w: b.width / img.width, h: b.height / img.height, label: c?.categoryName ?? '', score: c?.score ?? 0 });
  }
  return out;
}
exportSettle.push(() => ml.settle());
// debugging / scripted-test handle (the module may be loaded under a cache-busting URL after hot reloads)
(globalThis as any).__phosMl = ml;
