// NERVE — video and still-image sources. Realtime playback follows the transport; export seeks frame by frame.
import type { Gpu } from './gpu';

interface Vid {
  el: HTMLVideoElement; path: string; target: number; used: number; ready: boolean; err: string | null;
  tex: GPUTexture | null; view: GPUTextureView | null;
}
interface Img { bmp: ImageBitmap | null; tex: GPUTexture | null; view: GPUTextureView | null; loading: boolean; err: string | null }

export interface Frame { view: GPUTextureView; w: number; h: number }

const TEX_USAGE = 0x10 | 0x04 | 0x02; // RENDER_ATTACHMENT | TEXTURE_BINDING | COPY_DST

export class MediaEngine {
  /** Maps a media path to something a <video>/<img> can load. Set by the host layer. */
  resolve: (path: string) => string | null = () => null;
  private vids = new Map<string, Vid>();
  private imgs = new Map<string, Img>();
  private tick = 0;
  /** While true (export), `drive` only records targets; `settle` performs exact seeks. */
  exact = false;

  /** Export cache: source path → all-keyframe copies, each covering source time [t0, t1). Used only while `exact`. */
  proxies = new Map<string, { path: string; t0: number; t1: number }[]>();
  /** Makes such a copy. Set by the host layer; absent in a browser, where export seeks the originals. */
  makeProxy: ((src: string, start: number, dur: number, onProgress: (f: number) => void) => Promise<string | null>) | null = null;

  beginFrame() { this.tick++; }
  /** Pause and release players that no node asked for recently. */
  endFrame() {
    for (const [k, v] of this.vids) {
      if (v.used === this.tick) continue;
      if (v.path.startsWith('camera:')) { if (this.tick - v.used > 120) { (v.el.srcObject as MediaStream | null)?.getTracks().forEach(t => t.stop()); v.tex?.destroy(); this.vids.delete(k); } continue; }
      if (!v.el.paused) v.el.pause();
      if (this.tick - v.used > 600) { v.el.removeAttribute('src'); v.el.load(); v.tex?.destroy(); this.vids.delete(k); }
    }
  }

  private vid(key: string, path: string): Vid | null {
    let v = this.vids.get(key);
    if (v && v.path !== path) { v.el.pause(); v.tex?.destroy(); this.vids.delete(key); v = undefined; }
    if (!v) {
      const url = this.resolve(path);
      if (!url) return null;
      const el = document.createElement('video');
      el.muted = true; el.playsInline = true; el.preload = 'auto'; el.crossOrigin = 'anonymous';
      v = { el, path, target: 0, used: 0, ready: false, err: null, tex: null, view: null };
      const vv = v;
      el.addEventListener('loadeddata', () => { vv.ready = true; });
      el.addEventListener('error', () => { vv.err = el.error?.message || 'Cannot decode this video'; });
      el.src = url;
      this.vids.set(key, v);
    }
    return v;
  }

  /** Cue a player. `key` identifies the consumer (clip or node) so the same file can play at two positions. */
  drive(key: string, path: string, t: number, playing: boolean, rate: number) {
    const px = this.exact ? this.proxies.get(path)?.find(r => t >= r.t0 && t < r.t1) : undefined;
    if (px) { path = px.path; t -= px.t0; }
    const v = this.vid(key, path);
    if (!v) return;
    v.used = this.tick;
    const el = v.el;
    const dur = Number.isFinite(el.duration) ? el.duration : 0;
    const target = Math.max(0, dur ? Math.min(dur - 0.02, t) : t);
    v.target = target;
    if (!v.ready || this.exact) { if (this.exact && !el.paused) el.pause(); return; }
    if (playing) {
      const r = Math.min(8, Math.max(0.1, rate));
      if (el.playbackRate !== r) el.playbackRate = r;
      if (el.paused) { el.currentTime = target; void el.play().catch(() => {}); }
      else if (Math.abs(el.currentTime - target) > 0.18) el.currentTime = target;
    } else {
      if (!el.paused) el.pause();
      if (!el.seeking && Math.abs(el.currentTime - target) > 0.008) el.currentTime = target;
    }
  }

  /** Cue a live camera. Devices are addressed by index into the system's video inputs. */
  camera(key: string, index: number) {
    let v = this.vids.get(key);
    const path = `camera:${index}`;
    if (v && v.path !== path) { (v.el.srcObject as MediaStream | null)?.getTracks().forEach(t => t.stop()); this.vids.delete(key); v = undefined; }
    if (!v) {
      const el = document.createElement('video');
      el.muted = true; el.playsInline = true;
      v = { el, path, target: 0, used: this.tick, ready: false, err: null, tex: null, view: null };
      const vv = v;
      this.vids.set(key, v);
      (async () => {
        try {
          const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
          const dev = devs[Math.min(index, devs.length - 1)];
          const stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: dev?.deviceId ? { exact: dev.deviceId } : undefined, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 } } });
          el.srcObject = stream; await el.play(); vv.ready = true;
        } catch (e: any) { vv.err = `Camera unavailable: ${e.message ?? e}`; }
      })();
    }
    v.used = this.tick;
  }

  /** Export: seek every cued player exactly to its target and wait for the frame to be decodable. */
  async settle() {
    const jobs: Promise<void>[] = [];
    for (const v of this.vids.values()) {
      if (v.used !== this.tick || v.path.startsWith('camera:')) continue;
      jobs.push(new Promise<void>(res => {
        const el = v.el;
        const go = () => {
          if (Math.abs(el.currentTime - v.target) < 1e-4 && !el.seeking && el.readyState >= 2) return res();
          const done = () => { el.removeEventListener('seeked', done); clearTimeout(to); res(); };
          const to = setTimeout(done, 4000);
          el.addEventListener('seeked', done);
          el.currentTime = v.target;
        };
        if (v.ready || v.err) go(); else { const on = () => { el.removeEventListener('loadeddata', on); go(); }; el.addEventListener('loadeddata', on); setTimeout(res, 8000); }
      }));
    }
    await Promise.all(jobs);
  }

  /** Current frame of a cued player as a linear-sampling texture, or null while loading. */
  videoFrame(gpu: Gpu, key: string): Frame | null {
    const v = this.vids.get(key);
    if (!v || !v.ready) return null;
    // mid-seek there is no decodable frame: hold the last one rather than flashing empty
    if (v.el.readyState < 2) return v.tex && v.view ? { view: v.view, w: v.tex.width, h: v.tex.height } : null;
    const w = v.el.videoWidth, h = v.el.videoHeight;
    if (!w || !h) return null;
    if (!v.tex || v.tex.width !== w || v.tex.height !== h) {
      v.tex?.destroy();
      v.tex = gpu.device.createTexture({ size: [w, h], format: 'rgba8unorm-srgb', usage: TEX_USAGE });
      v.view = v.tex.createView();
    }
    try { gpu.device.queue.copyExternalImageToTexture({ source: v.el }, { texture: v.tex }, [w, h]); }
    catch (e: any) { v.err = e.message; return null; }
    return { view: v.view!, w, h };
  }
  videoError(key: string) { return this.vids.get(key)?.err ?? null; }
  videoDuration(key: string) { const d = this.vids.get(key)?.el.duration; return d && Number.isFinite(d) ? d : 0; }

  image(gpu: Gpu, path: string): Frame | null {
    let im = this.imgs.get(path);
    if (!im) {
      im = { bmp: null, tex: null, view: null, loading: true, err: null };
      this.imgs.set(path, im);
      const url = this.resolve(path);
      const cur = im;
      if (!url) { im.err = 'File not found'; im.loading = false; }
      else fetch(url).then(r => r.blob()).then(b => createImageBitmap(b, { colorSpaceConversion: 'default' }))
        .then(bmp => { cur.bmp = bmp; cur.loading = false; }).catch(e => { cur.err = String(e.message ?? e); cur.loading = false; });
    }
    if (!im.bmp) return null;
    if (!im.tex) {
      im.tex = gpu.device.createTexture({ size: [im.bmp.width, im.bmp.height], format: 'rgba8unorm-srgb', usage: TEX_USAGE });
      im.view = im.tex.createView();
      gpu.device.queue.copyExternalImageToTexture({ source: im.bmp }, { texture: im.tex }, [im.bmp.width, im.bmp.height]);
    }
    return { view: im.view!, w: im.bmp.width, h: im.bmp.height };
  }
  imageError(path: string) { return this.imgs.get(path)?.err ?? null; }
  imageLoading(path: string) { return this.imgs.get(path)?.loading ?? false; }

  /** Probe a video file's duration and size without keeping a player around. */
  probe(path: string): Promise<{ dur: number; w: number; h: number }> {
    return new Promise((res, rej) => {
      const url = this.resolve(path);
      if (!url) return rej(new Error('File not found'));
      const el = document.createElement('video');
      el.preload = 'metadata'; el.muted = true; el.crossOrigin = 'anonymous';
      el.onloadedmetadata = () => { res({ dur: el.duration, w: el.videoWidth, h: el.videoHeight }); el.removeAttribute('src'); el.load(); };
      el.onerror = () => rej(new Error(el.error?.message || 'Cannot read this video (unsupported codec?)'));
      el.src = url;
    });
  }
}
