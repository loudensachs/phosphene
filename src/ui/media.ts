// Resolves media paths to loadable URLs: streamed media:// in the desktop app, blob URLs in a browser tab.
import { host } from './host';

const blobs = new Map<string, Blob>();
const urls = new Map<string, string>();

export const media = {
  /** Keep bytes for a path that has no file on disk behind it (browser picks, small audio files). */
  register(path: string, data: ArrayBuffer | Blob) { blobs.set(path, data instanceof Blob ? data : new Blob([data])); urls.delete(path); },
  async get(path: string): Promise<ArrayBuffer | null> {
    const b = blobs.get(path);
    if (b) return b.arrayBuffer();
    return host.readFile(path);
  },
  url(path: string): string | null {
    if (!path) return null;
    let u = urls.get(path);
    if (u) return u;
    const b = blobs.get(path);
    if (b) u = URL.createObjectURL(b);
    else if (host.native) u = `media://f/${encodeURIComponent(path)}`;
    else return null;
    urls.set(path, u);
    return u;
  },
};
