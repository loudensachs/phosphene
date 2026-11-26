// Media sources: timeline layers, standalone movie and still image.
import type { Clip, CookCtx, Doc, OpDef, ParamDef } from '../types';
import { hasMotion, motionAt } from '../motion';

const FIT: ParamDef[] = [
  { k: 'enum', name: 'fit', options: ['Fill', 'Fit', 'Stretch', 'Original size'], def: 0 },
  { k: 'float', name: 'follow', label: 'Follow subject', def: 1, min: 0, max: 1, help: 'When Fill crops the picture (vertical from landscape footage, say), slide the crop to keep the subject in frame. Needs Auto-frame (the target button beside the resolution) to have looked at the footage.' },
  { k: 'float', name: 'opacity', def: 1, min: 0, max: 1 },
  { k: 'float', name: 'gain', label: 'Exposure', def: 0, min: -4, max: 4, unit: 'ev', help: 'Exposure in stops, applied in linear light.' },
];

const PLACE = {
  inputs: ['vid'],
  fields: [['fit', 'i32'], ['opacity', 'f32'], ['gain', 'f32'], ['srcSize', 'vec2f'], ['flip', 'f32'], ['focus', 'vec2f'], ['mpos', 'vec2f'], ['mscale', 'f32'], ['mrot', 'f32']] as [string, 'i32' | 'f32' | 'vec2f'][],
  body: /* wgsl */`
fn op(uv: vec2f) -> vec4f {
  let sa = u.srcSize.x / max(u.srcSize.y, 1.0);
  var s = vec2f(1.0);
  if (u.fit == 0) { s = select(vec2f(1.0, sa / g.aspect), vec2f(g.aspect / sa, 1.0), sa > g.aspect); }
  else if (u.fit == 1) { s = select(vec2f(g.aspect / sa, 1.0), vec2f(1.0, sa / g.aspect), sa > g.aspect); }
  else if (u.fit == 3) { s = g.res / u.srcSize; }
  // the crop window (s < 1 on an axis) slides toward the subject without leaving the picture
  let fc = clamp(u.focus, s * 0.5, vec2f(1.0) - s * 0.5);
  let ctr = select(vec2f(0.5), fc, s < vec2f(1.0));
  // clip motion: undo the move, rotation (in square pixels) and scale before looking up the picture
  var m = uv - 0.5 - u.mpos;
  m.x = m.x * g.aspect;
  let cr = cos(u.mrot); let sr = sin(u.mrot);
  m = vec2f(m.x * cr + m.y * sr, -m.x * sr + m.y * cr);
  m.x = m.x / g.aspect;
  m = m / max(u.mscale, 0.001);
  var q = m * s + ctr;
  if (u.flip > 0.5) { q.x = 1.0 - q.x; }
  if (q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0) { return vec4f(0.0); }
  let c = textureSampleLevel(vid, smp, q, 0.0);
  let a = c.a * u.opacity;
  return vec4f(c.rgb * exp2(u.gain) * a, a);
}`,
};

type Motion = { x: number; y: number; s: number; r: number };
function place(c: CookCtx, f: { view: GPUTextureView; w: number; h: number } | null, focus: [number, number] | null = null, mo: Motion | null = null) {
  if (!f) { c.clear(c.out); return; }
  const k = focus ? (c.p.follow ?? 1) : 0, fx = 0.5 + ((focus?.[0] ?? 0.5) - 0.5) * k, fy = 0.5 + ((focus?.[1] ?? 0.5) - 0.5) * k;
  c.run('main', c.out, [f.view], { fit: c.p.fit, opacity: c.p.opacity, gain: c.p.gain, srcSize: [f.w, f.h], flip: c.p.mirror ? 1 : 0, focus: [c.p.mirror ? 1 - fx : fx, fy],
    mpos: mo ? [mo.x / c.w, mo.y / c.h] : [0, 0], mscale: mo ? mo.s / 100 : 1, mrot: mo ? (mo.r * Math.PI) / 180 : 0 });
}

/** The subject's place in a piece of footage at a source time, from Auto-frame. */
export function focusAt(doc: Doc, path: string, t: number): [number, number] | null {
  const f = doc.focus?.[path];
  if (!f || f.xy.length < 2) return null;
  const n = f.xy.length / 2;
  if (n === 1) return [f.xy[0], f.xy[1]];
  const x = Math.max(0, Math.min(n - 1, t * f.rate)), i = Math.min(n - 2, Math.floor(x)), a = x - i;
  return [f.xy[i * 2] * (1 - a) + f.xy[i * 2 + 2] * a, f.xy[i * 2 + 1] * (1 - a) + f.xy[i * 2 + 3] * a];
}

/** The clip under the playhead on a track (later clips win on overlap). */
export function clipAt(doc: Doc, track: number, t: number): Clip | null {
  const tr = doc.tracks[track - 1];
  if (!tr || tr.mute) return null;
  let hit: Clip | null = null;
  for (const cl of tr.clips) if (t >= cl.start && t < cl.start + cl.dur) hit = cl;
  return hit;
}

const layer: OpDef = {
  type: 'layer', label: 'Layer', category: 'IO', inputs: [], output: 'tex',
  help: 'Brings a timeline video track into the graph. Whatever clip is under the playhead on that track comes out here.',
  params: [{ k: 'int', name: 'track', def: 1, min: 1, max: 16, help: 'Timeline video track number (V1 is the bottom layer).' }, ...FIT],
  passes: { main: PLACE },
  hashExtra(doc, time, p) { const cl = clipAt(doc, p.track, time); return cl && hasMotion(cl) ? JSON.stringify(motionAt(cl, time)) : ''; },
  prep(c) {
    const cl = clipAt(c.doc, c.p.track, c.time);
    if (cl && cl.kind === 'video') {
      let st = cl.in + (c.time - cl.start) * cl.speed;
      // a looping clip wraps back to the start of its footage, staying clear of the last frame so seeks never overrun
      if (cl.loop && cl.srcDur > 0.2) st %= cl.srcDur - 0.05;
      c.media.drive(cl.id, cl.path, st, c.playing, cl.speed);
    }
  },
  cook(c) {
    const cl = clipAt(c.doc, c.p.track, c.time);
    if (!cl) { c.clear(c.out); return; }
    if (cl.kind === 'image') {
      const f = c.media.image(c.gpu, cl.path);
      const e = c.media.imageError(cl.path);
      if (e) throw new Error(`${cl.name}: ${e}`);
      return place(c, f, null, hasMotion(cl) ? motionAt(cl, c.time) : null);
    }
    const e = c.media.videoError(cl.id);
    if (e) throw new Error(`${cl.name}: ${e}`);
    let st = cl.in + (c.time - cl.start) * cl.speed;
    if (cl.loop && cl.srcDur > 0.2) st %= cl.srcDur - 0.05;
    place(c, c.media.videoFrame(c.gpu, cl.id), focusAt(c.doc, cl.path, st), hasMotion(cl) ? motionAt(cl, c.time) : null);
  },
};

const movie: OpDef = {
  type: 'movie', label: 'Movie', category: 'IO', inputs: [], output: 'tex',
  help: 'Plays a video file directly, independent of the timeline tracks. Loops by default.',
  params: [
    { k: 'file', name: 'file', def: '', accept: '.mp4,.mov,.webm,.m4v,.mkv' },
    { k: 'float', name: 'speed', def: 1, min: 0, max: 4 },
    { k: 'float', name: 'offset', def: 0, min: 0, max: 600, unit: 's' },
    { k: 'bool', name: 'loop', def: true },
    ...FIT,
  ],
  passes: { main: PLACE },
  prep(c) {
    if (!c.p.file) return;
    const dur = c.media.videoDuration(c.nodeId);
    let t = c.p.offset + c.time * c.p.speed;
    if (dur > 0) t = c.p.loop ? t - Math.floor(t / dur) * dur : Math.min(t, dur - 0.02);
    c.media.drive(c.nodeId, c.p.file, t, c.playing, c.p.speed);
  },
  cook(c) {
    if (!c.p.file) { c.clear(c.out); return; }
    const e = c.media.videoError(c.nodeId);
    if (e) throw new Error(e);
    place(c, c.media.videoFrame(c.gpu, c.nodeId));
  },
};

const image: OpDef = {
  type: 'image', label: 'Image', category: 'IO', inputs: [], output: 'tex', animated: true,
  help: 'A still image file.',
  params: [{ k: 'file', name: 'file', def: '', accept: '.png,.jpg,.jpeg,.webp,.gif,.avif' }, ...FIT],
  passes: { main: PLACE },
  cook(c) {
    if (!c.p.file) { c.clear(c.out); return; }
    const e = c.media.imageError(c.p.file);
    if (e) throw new Error(e);
    place(c, c.media.image(c.gpu, c.p.file));
  },
};

const camera: OpDef = {
  type: 'camera', label: 'Camera', category: 'IO', inputs: [], output: 'tex',
  help: 'Live camera or capture-card input. Turn the feed into anything: run it through Optical Flow, Datamosh, Relief or Time Warp.',
  params: [
    { k: 'int', name: 'device', def: 0, min: 0, max: 8, help: 'Index of the video input (0 is usually the built-in camera).' },
    { k: 'bool', name: 'mirror', def: true },
    ...FIT,
  ],
  passes: { main: PLACE },
  prep(c) { c.media.camera(c.nodeId, c.p.device); },
  cook(c) {
    const e = c.media.videoError(c.nodeId);
    if (e) throw new Error(e);
    place(c, c.media.videoFrame(c.gpu, c.nodeId));
  },
};

export const ops: OpDef[] = [layer, movie, image, camera];
