// Host bridge: native file access and ffmpeg in Electron, graceful fallbacks in a plain browser.

export interface PickedFile { path: string; data: ArrayBuffer }
export interface Encoder { write(frame: Uint8Array): Promise<void>; finish(): Promise<{ ok: boolean; log: string }>; cancel(): void }
export interface EncodeOpts { path: string; width: number; height: number; fps: number; codec: string; pixfmt: 'rgba' | 'rgba64le'; audioPath?: string; crf?: number }

/** Stock library entry: a downloaded clip plus the licence sidecar written next to it. */
export interface StockEntry { file: string; path: string; size: number; mtime: number; key?: string; title?: string; source?: string; licence?: string; author?: string; credit?: string; page?: string; [k: string]: unknown }
export interface StockNative {
  dir: string;
  download(url: string, destName: string, onProgress: (got: number, total: number) => void, meta?: Record<string, unknown>): Promise<{ path: string; size: number } | { error: string }>;
  cancel(destName: string): void;
  list(): Promise<StockEntry[]>;
  remove(name: string): Promise<boolean>;
  convert(name: string, onProgress?: (f: number) => void): Promise<{ path: string } | { error: string }>;
  fetchJson(url: string): Promise<any>;
  head(url: string): Promise<{ ok: boolean; size: number; type: string; error?: string }>;
  hasFfmpeg(): boolean;
}

interface Native {
  platform: string;
  pickFile(filters: { name: string; extensions: string[] }[]): Promise<PickedFile | null>;
  readFile(path: string): Promise<ArrayBuffer | null>;
  pickPaths(filters: { name: string; extensions: string[] }[]): Promise<string[]>;
  stemsSeparate(path: string, onProgress: (p: { stage: string; fraction: number }) => void): Promise<{ stems?: Record<string, string>; error?: string }>;
  oscListen(port: number, cb: (msgs: [string, number[]][]) => void): Promise<string | null>;
  stock?: StockNative;
  pathFor(file: File): string;
  saveDialog(defaultName: string, filters: { name: string; extensions: string[] }[]): Promise<string | null>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  openDialog(filters: { name: string; extensions: string[] }[]): Promise<string | null>;
  tempPath(name: string): Promise<string>;
  confirmSave(name: string): Promise<'save' | 'discard' | 'cancel'>;
  ask(o: { message: string; detail?: string; buttons: string[]; type?: string }): Promise<number>;
  fileSize(path: string): number;
  aiRun(o: { model: string; effort?: string; system: string; prompt: string; schema: unknown }): Promise<{ ok: boolean; data?: unknown; error?: string; cost?: number; ms?: number; model?: string; tokens?: number; outTokens?: number }>;
  aiCancel(): void;
  aiAvailable(): boolean;
  footageScenes(file: string): Promise<{ cuts?: number[]; error?: string }>;
  footageFrames(file: string, dur: number): Promise<{ rate?: number; w?: number; h?: number; n?: number; data?: Uint8Array; error?: string }>;
  footageStats(file: string, rate: number): Promise<{ rate?: number; motion?: number[]; luma?: number[]; error?: string }>;
  closeNow(): void;
  onCloseRequest(cb: () => void): void;
  onOpenFile(cb: (path: string) => void): void;
  takePendingOpen(): Promise<string | null>;
  docState(st: { name: string; dirty: boolean; path: string | null }): void;
  addRecent(path: string): void;
  clearRecent(): void;
  setMenu(spec: unknown): void;
  onMenu(cb: (id: string) => void): void;
  userPath(name: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  unlink(path: string): Promise<void>;
  footageProxy(src: string, start: number, dur: number, out: string, onProgress?: (f: number) => void): Promise<{ ok: boolean; log: string }>;
  ffmpegStart(o: EncodeOpts): Promise<{ id: number } | { error: string }>;
  ffmpegWrite(id: number, frame: Uint8Array): Promise<void>;
  ffmpegFinish(id: number): Promise<{ ok: boolean; log: string }>;
  ffmpegCancel(id: number): void;
  openOutput(): void;
  reveal(path: string): void;
}

const native: Native | undefined = (window as any).phosphene;

function browserPick(accept: string): Promise<PickedFile | null> {
  return new Promise(res => {
    const i = document.createElement('input');
    i.type = 'file'; i.accept = accept;
    i.onchange = async () => { const f = i.files?.[0]; res(f ? { path: f.name, data: await f.arrayBuffer() } : null); };
    i.oncancel = () => res(null);
    i.click();
  });
}

const exts = (accept: string) => accept.split(',').map(s => s.trim().replace(/^\./, '')).filter(Boolean);

export const host = {
  native: !!native,
  mac: native ? native.platform === 'darwin' : false,
  async pickFile(accept: string, name = 'Files'): Promise<PickedFile | null> {
    return native ? native.pickFile([{ name, extensions: accept === '*' ? ['*'] : exts(accept) }]) : browserPick(accept);
  },
  readFile: (path: string) => (native ? native.readFile(path) : Promise.resolve(null)),
  /** Multi-select media picker. Natively returns paths only (files are streamed, not loaded). */
  async pickMedia(extensions: string[]): Promise<{ path: string; file?: File }[]> {
    if (native) return (await native.pickPaths([{ name: 'Media', extensions }])).map(path => ({ path }));
    return new Promise(res => {
      const i = document.createElement('input');
      i.type = 'file'; i.multiple = true; i.accept = extensions.map(e => '.' + e).join(',');
      i.onchange = () => res([...(i.files ?? [])].map(file => ({ path: file.name, file })));
      i.oncancel = () => res([]);
      i.click();
    });
  },
  pathFor: (file: File) => (native ? native.pathFor(file) : file.name),
  async saveProject(json: string, path: string | null, name: string): Promise<string | null> {
    if (native) {
      const p = path ?? (await native.saveDialog(`${name}.phos`, [{ name: 'Phosphene Project', extensions: ['phos'] }]));
      if (p) await native.writeFile(p, json);
      return p;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    a.download = `${name}.phos`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    return null;
  },
  async openProject(): Promise<{ path: string | null; json: string } | null> {
    if (native) {
      const p = await native.openDialog([{ name: 'Phosphene Project', extensions: ['phos', 'json'] }]);
      const d = p && (await native.readFile(p));
      return d ? { path: p, json: new TextDecoder().decode(d) } : null;
    }
    const f = await browserPick('.phos,.json');
    return f ? { path: null, json: new TextDecoder().decode(f.data) } : null;
  },
  /** Ask what to do with unsaved changes. In a browser there is no native sheet, so fall back to confirm(). */
  confirmSave: (name: string): Promise<'save' | 'discard' | 'cancel'> => (native ? native.confirmSave(name) : Promise.resolve(window.confirm(`Discard unsaved changes to ${name}?`) ? 'discard' : 'cancel')),
  ask: (o: { message: string; detail?: string; buttons: string[]; type?: string }): Promise<number> => (native ? native.ask(o) : Promise.resolve(window.confirm(o.message) ? 0 : o.buttons.length - 1)),
  locateFile: (): Promise<string | null> => (native ? native.openDialog([]) : Promise.resolve(null)),
  fileSize: (path: string): number => (native ? native.fileSize(path) : 0),
  aiRun: (o: { model: string; effort?: string; system: string; prompt: string; schema: unknown }) => native!.aiRun(o),
  aiCancel: () => native?.aiCancel(),
  aiAvailable: () => !!native?.aiAvailable(),
  footageScenes: (file: string) => (native ? native.footageScenes(file) : Promise.resolve({ error: 'Needs the desktop app' })),
  footageFrames: (file: string, dur: number) => (native ? native.footageFrames(file, dur) : Promise.resolve({ error: 'Needs the desktop app' })),
  footageStats: (file: string, rate: number) => (native ? native.footageStats(file, rate) : Promise.resolve({ error: 'Needs the desktop app' })),
  closeNow: () => native?.closeNow(),
  onCloseRequest: (cb: () => void) => native?.onCloseRequest(cb),
  onOpenFile: (cb: (path: string) => void) => native?.onOpenFile(cb),
  takePendingOpen: (): Promise<string | null> => (native ? native.takePendingOpen() : Promise.resolve(null)),
  docState: (st: { name: string; dirty: boolean; path: string | null }) => native?.docState(st),
  addRecent: (path: string) => native?.addRecent(path),
  clearRecent: () => native?.clearRecent(),
  setMenu: (spec: unknown) => native?.setMenu(spec),
  onMenu: (cb: (id: string) => void) => native?.onMenu(cb),
  userPath: (name: string): Promise<string | null> => (native ? native.userPath(name) : Promise.resolve(null)),
  exists: (path: string): Promise<boolean> => (native ? native.exists(path) : Promise.resolve(false)),
  unlink: (path: string): Promise<void> => (native ? native.unlink(path) : Promise.resolve()),
  async readText(path: string): Promise<string | null> { const d = native && (await native.readFile(path)); return d ? new TextDecoder().decode(d) : null; },
  saveDialog: (name: string, ext: string) => (native ? native.saveDialog(name, [{ name: ext.toUpperCase(), extensions: [ext] }]) : Promise.resolve(null)),
  tempPath: (name: string) => native!.tempPath(name),
  footageProxy: (src: string, start: number, dur: number, out: string, onProgress?: (f: number) => void): Promise<{ ok: boolean; log: string }> => native!.footageProxy(src, start, dur, out, onProgress),
  writeFile: (path: string, data: string | Uint8Array) => native!.writeFile(path, data),
  async encoder(o: EncodeOpts): Promise<Encoder | { error: string }> {
    if (!native) return { error: 'Encoding needs the desktop app (ffmpeg is not reachable from a browser tab).' };
    const r = await native.ffmpegStart(o);
    if ('error' in r) return r;
    return { write: f => native.ffmpegWrite(r.id, f), finish: () => native.ffmpegFinish(r.id), cancel: () => native.ffmpegCancel(r.id) };
  },
  reveal: (p: string) => native?.reveal(p),
  stemsSeparate: (path: string, onProgress: (p: { stage: string; fraction: number }) => void) =>
    (native ? native.stemsSeparate(path, onProgress) : Promise.resolve({ error: 'Stem separation needs the desktop app.' } as { stems?: Record<string, string>; error?: string })),
  oscListen: (port: number, cb: (msgs: [string, number[]][]) => void) => (native ? native.oscListen(port, cb) : Promise.resolve('OSC needs the desktop app')),
  /** Stock footage library (desktop only): downloads, sidecars, ffmpeg conversion. */
  stock: native?.stock,
};
