// NERVE — offline render. Steps the same cook loop frame by frame at full quality and hands raw frames to an encoder.
import type { PassDecl } from './types';
import type { Engine } from './engine';
import { Pass } from './gpu';
import { exportSettle } from './hooks';
import { ml } from './ml';

export interface RenderOpts {
  width: number; height: number; fps: number;
  start: number; end: number;
  /** Render at N× the output size and filter down. */
  supersample: 1 | 2;
  /** Sub-frame samples averaged per output frame (1 = off). */
  mbSamples: number;
  /** Fraction of the frame interval the shutter is open (0..1). */
  shutter: number;
  /** 16 bits per channel (rgba64le) instead of 8 (rgba). */
  deep: boolean;
  /** Depth, mattes and tracking: 'exact' waits for every frame's result; 'live' keeps going like the preview (faster, trails). */
  vision?: 'exact' | 'live';
}

const ACCUM: PassDecl = {
  inputs: ['prev', 'src'], fields: [['wgt', 'f32'], ['first', 'f32']],
  body: `fn op(uv: vec2f) -> vec4f {
  let s = textureSampleLevel(src, smp, uv, 0.0) * u.wgt;
  if (u.first > 0.5) { return s; }
  return textureSampleLevel(prev, smp, uv, 0.0) + s;
}`,
};

// Display encode: scene-linear → sRGB, with blue-noise-ish dither when quantising to 8 bits.
const ENCODE: PassDecl = {
  inputs: ['src'], fields: [['dither', 'f32'], ['frame', 'f32']],
  body: `fn enc(c: vec3f) -> vec3f {
  let lo = c * 12.92; let hi = 1.055 * pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3f(0.0031308));
}
fn op(uv: vec2f) -> vec4f {
  // sampling at the output pixel centre with a linear filter is an exact box filter for 2x supersampling
  let c = textureSampleLevel(src, smp, uv, 0.0);
  var rgb = enc(clamp(c.rgb, vec3f(0.0), vec3f(1.0)));
  if (u.dither > 0.0) {
    let p = uv * g.res + u.frame * vec2f(37.0, 17.0);
    let n = vec3f(hash21(p), hash21(p + 19.19), hash21(p + 47.77)) + vec3f(hash21(p + 7.31), hash21(p + 3.7), hash21(p + 91.1)) - 1.0;
    rgb += n * u.dither;
  }
  return vec4f(clamp(rgb, vec3f(0.0), vec3f(1.0)), 1.0);
}`,
};

export interface RenderHandle { cancel(): void; done: Promise<{ frames: number; cancelled: boolean }> }

export function render(engine: Engine, o: RenderOpts, sink: (frame: Uint8Array) => Promise<void>, progress: (frame: number, total: number) => void): RenderHandle {
  let cancelled = false;
  const done = (async () => {
    const gpu = engine.gpu, dev = gpu.device;
    const wasPlaying = engine.playing, wasTime = engine.time;
    engine.pause();
    engine.exporting = true;
    engine.media.exact = true;
    const W = o.width * o.supersample, H = o.height * o.supersample;
    engine.setRenderRes([W, H]);
    const fmt: GPUTextureFormat = o.deep ? 'rgba16uint' : 'rgba8unorm';
    const bpp = o.deep ? 8 : 4;
    const encode = new Pass(gpu, ENCODE, fmt, 'export:encode');
    const accum = new Pass(gpu, ACCUM, undefined, 'export:accum');
    const target = gpu.texture(o.width, o.height, fmt);
    const tview = target.createView();
    const acc = [gpu.texture(W, H), gpu.texture(W, H)];
    const accV = acc.map(t => t.createView());
    const rowBytes = o.width * bpp, padded = Math.ceil(rowBytes / 256) * 256;
    const buf = dev.createBuffer({ size: padded * o.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const out = new Uint8Array(rowBytes * o.height);
    const total = Math.max(1, Math.round((o.end - o.start) * o.fps));
    const N = Math.max(1, o.mbSamples | 0);
    const fdt = 1 / o.fps;
    let frames = 0;
    try {
      engine.restart();
      // pre-roll: cook the first frame a few times and drain async services (video seeks, ML inference), so results
      // left over from realtime preview cannot leak into frame 0 and every render starts from the same state
      for (let w = 0; w < 3; w++) {
        await engine.prepFrame(o.start);
        const fin = engine.finalNode();
        engine.cookFrame(o.start, 0, fin ? new Set([fin]) : undefined);
        for (const h of exportSettle) await h();
      }
      engine.restart();
      // models are loaded and primed by the pre-roll; from here 'live' stops waiting for each result
      ml.liveExport = o.vision === 'live';
      for (let f = 0; f < total && !cancelled; f++) {
        const t = o.start + f * fdt;
        let srcView: GPUTextureView | null = null;
        for (let k = 0; k < N; k++) {
          const tk = t + (N > 1 ? (k / N) * fdt * o.shutter : 0);
          await engine.prepFrame(tk);
          const final = engine.finalNode();
          engine.cookFrame(tk, k === 0 ? fdt - (N > 1 ? ((N - 1) / N) * fdt * o.shutter : 0) : (fdt * o.shutter) / N, final ? new Set([final]) : undefined);
          for (const h of exportSettle) await h();
          const v = engine.viewOf(final);
          if (N === 1) srcView = v;
          else { accum.run(accV[k & 1], [accV[(k + 1) & 1], v], { wgt: 1 / N, first: k === 0 ? 1 : 0 }, [W, H]); srcView = accV[k & 1]; }
        }
        encode.run(tview, [srcView], { dither: o.deep ? 0 : 0.5 / 255, frame: f }, [o.width, o.height]);
        const enc = dev.createCommandEncoder();
        enc.copyTextureToBuffer({ texture: target }, { buffer: buf, bytesPerRow: padded }, [o.width, o.height]);
        dev.queue.submit([enc.finish()]);
        await buf.mapAsync(GPUMapMode.READ);
        const src = new Uint8Array(buf.getMappedRange());
        if (padded === rowBytes) out.set(src.subarray(0, out.length));
        else for (let y = 0; y < o.height; y++) out.set(src.subarray(y * padded, y * padded + rowBytes), y * rowBytes);
        buf.unmap();
        await sink(out);
        frames++;
        engine.time = t;
        progress(frames, total);
        if (f % 2 === 0) { engine.emitFrame(); await new Promise(r => setTimeout(r, 0)); }
      }
    } finally {
      engine.setRenderRes(null);
      engine.media.exact = false;
      engine.exporting = false;
      ml.liveExport = false;
      target.destroy(); acc.forEach(t => t.destroy()); buf.destroy(); encode.destroy(); accum.destroy();
      engine.seek(wasTime); engine.restart(); engine.seek(wasTime);
      if (wasPlaying) engine.play();
    }
    return { frames, cancelled };
  })();
  return { cancel() { cancelled = true; }, done };
}

/**
 * Build the export cache for every timeline clip that plays in [start, end). Seeking a long-GOP file frame by frame
 * decodes from the previous keyframe each time; an all-keyframe copy of just the used range makes each seek one frame.
 */
export async function prepareFootage(engine: Engine, start: number, end: number, progress: (done: number, total: number, name: string) => void = () => {}): Promise<void> {
  const m = engine.media;
  if (!m.makeProxy) return;
  // the ranges of each source file that are used; uses of one file far apart in time get separate copies
  const need = new Map<string, { a: number; b: number }[]>();
  for (const tr of engine.project.doc.tracks) for (const c of tr.clips) {
    if (c.kind !== 'video') continue;
    const s0 = Math.max(start, c.start), s1 = Math.min(end, c.start + c.dur);
    if (s1 <= s0) continue;
    let a = Math.max(0, c.in + (s0 - c.start) * c.speed - 0.5), b = c.in + (s1 - c.start) * c.speed + 0.5;
    if (c.loop && c.srcDur > 0.2 && b > c.srcDur) { a = 0; b = c.srcDur + 0.5; }   // wraps: the whole source is needed
    const list = need.get(c.path) ?? [];
    list.push({ a, b }); need.set(c.path, list);
  }
  const todo: { path: string; a: number; b: number }[] = [];
  for (const [p, list] of need) {
    list.sort((x, y) => x.a - y.a);
    const merged: { a: number; b: number }[] = [];
    for (const r of list) { const last = merged[merged.length - 1]; if (last && r.a <= last.b + 2) last.b = Math.max(last.b, r.b); else merged.push({ ...r }); }
    const have = m.proxies.get(p) ?? [];
    for (const r of merged) if (!have.some(h => h.t0 <= r.a && h.t1 >= r.b)) todo.push({ path: p, ...r });
  }
  let i = 0;
  for (const r of todo) {
    const name = r.path.split('/').pop() ?? r.path;
    progress(i, todo.length, name);
    const out = await m.makeProxy(r.path, r.a, r.b - r.a, f => progress(i + f, todo.length, name));
    if (out) m.proxies.set(r.path, [...(m.proxies.get(r.path) ?? []), { path: out, t0: r.a, t1: r.b }]);
    i++;
  }
  progress(todo.length, todo.length, '');
}

/** Mix all unmuted audio tracks for [start, end) into a 24-bit stereo WAV. Returns null when there is no audio. */
export async function mixdown(engine: Engine, start: number, end: number): Promise<Uint8Array | null> {
  const tracks = engine.project.doc.audio.filter(a => !a.mute && engine.audio.tracks.has(a.id));
  if (!tracks.length) return null;
  const sr = 48000, len = Math.max(1, Math.ceil((end - start) * sr));
  const ctx = new OfflineAudioContext(2, len, sr);
  for (const a of tracks) {
    const t = engine.audio.tracks.get(a.id)!;
    const src = ctx.createBufferSource(); src.buffer = t.buffer;
    const g = ctx.createGain(); g.gain.value = a.gain;
    src.connect(g).connect(ctx.destination);
    const local = start - a.start;
    if (local >= t.buffer.duration) continue;
    if (local >= 0) src.start(0, local); else src.start(-local);
  }
  const buf = await ctx.startRendering();
  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  const data = new Uint8Array(44 + len * 6), dv = new DataView(data.buffer);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) data[o + i] = s.charCodeAt(i); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + len * 6, true); str(8, 'WAVEfmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * 6, true); dv.setUint16(32, 6, true); dv.setUint16(34, 24, true); str(36, 'data'); dv.setUint32(40, len * 6, true);
  let o = 44;
  for (let i = 0; i < len; i++) for (const ch of [L, R]) {
    const v = Math.max(-1, Math.min(1, ch[i])) * 8388607 | 0;
    data[o++] = v & 255; data[o++] = (v >> 8) & 255; data[o++] = (v >> 16) & 255;
  }
  return data;
}
