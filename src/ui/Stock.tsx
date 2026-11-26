// Stock footage browser: searches free public-domain / Creative Commons video (Internet Archive, Wikimedia Commons,
// NASA), previews straight from the remote URL, downloads once into the local library and drops the clip on the timeline.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { host, type StockEntry } from './host';
import { media } from './media';
import { ui } from './state';
import { importItems } from './actions';
import { Icon } from './Icon';

type Source = 'archive' | 'commons' | 'nasa';
type SourceSel = 'all' | Source;
type DurSel = 'any' | '30' | '120';

interface Item {
  key: string; source: Source; id: string; title: string; thumb: string; page: string;
  url?: string; preview?: string; ext?: string;
  dur?: number; w?: number; h?: number; size?: number; sizeApprox?: boolean;
  licence: string; licenceUrl?: string; author: string; attrib: boolean; nc?: boolean;
  resolved: boolean; dead?: boolean;
}
interface Job { phase: 'dl' | 'probe' | 'convert' | 'unplayable' | 'warn' | 'error'; got?: number; total?: number; frac?: number; msg?: string; path?: string }

const SRC_LABEL: Record<Source, string> = { archive: 'Archive', commons: 'Commons', nasa: 'NASA' };
const SRC_FULL: Record<Source, string> = { archive: 'Internet Archive', commons: 'Wikimedia Commons', nasa: 'NASA Image and Video Library' };
const STARTERS = ['city night', 'ocean', 'clouds timelapse', 'fire', 'smoke', 'crowd', 'space', 'flowers', 'abstract', 'dance', 'neon', 'traffic', 'forest', 'rain'];
const PAGE = 18;
const BIG = 500e6;

// ---------------- store (module level so searches and downloads survive tab switches) ----------------
interface SState {
  q: string; src: SourceSel; dur: DurSel; view: 'results' | 'library';
  items: Item[]; busy: boolean; notes: Partial<Record<Source, string>>; page: number; more: Partial<Record<Source, boolean>>;
  sel: string | null; jobs: Record<string, Job>; lib: StockEntry[]; searched: boolean;
}
let st: SState = { q: '', src: 'all', dur: 'any', view: 'results', items: [], busy: false, notes: {}, page: 0, more: {}, sel: null, jobs: {}, lib: [], searched: false };
const subs = new Set<() => void>();
const set = (p: Partial<SState>) => { st = { ...st, ...p }; subs.forEach(f => f()); };
const setJob = (k: string, j: Job | null) => { const jobs = { ...st.jobs }; if (j) jobs[k] = j; else delete jobs[k]; set({ jobs }); };
const patchItem = (key: string, p: Partial<Item>) => set({ items: st.items.map(i => (i.key === key ? { ...i, ...p } : i)) });
/** Current browser state, for scripted use. */
export const stockState = () => st;
function useStock() { return useSyncExternalStore(f => { subs.add(f); return () => { subs.delete(f); }; }, () => st); }

// ---------------- helpers ----------------
const stock = host.stock;
const enc = encodeURIComponent;
const https = (u: string) => u.replace(/^http:\/\//, 'https://');
const clean = (u: string) => u.replace(/\?utm_source=.*$/, '');
const extOf = (u: string) => (/\.(mp4|m4v|mov|webm|mkv|ogv)(?:$|\?)/i.exec(u)?.[1] ?? 'mp4').toLowerCase();
const text = (html: string) => (html ? (new DOMParser().parseFromString(html, 'text/html').body.textContent ?? '').replace(/\s+/g, ' ').trim() : '');
export const fmtDur = (s?: number) => (s === undefined || !isFinite(s) ? '' : s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`);
export const fmtSize = (b?: number) => (!b ? '' : b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${Math.round(b / 1e6)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
function parseTime(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string' || !v) return undefined;
  if (/^[\d.]+$/.test(v)) return +v;
  const s = /^([\d.]+)\s*s/.exec(v); if (s) return +s[1];
  const p = v.split(':').map(Number);
  return p.some(isNaN) ? undefined : p.reduce((a, n) => a * 60 + n, 0);
}
async function getJson(url: string, proxy = false): Promise<any> {
  if (proxy) {
    if (!stock) throw new Error('needs the desktop app');
    const r = await stock.fetchJson(url);
    if (r && typeof r === 'object' && 'error' in r && Object.keys(r).length === 1) throw new Error(r.error);
    return r;
  }
  let res: Response;
  try { res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' }); } catch { throw new Error(navigator.onLine ? 'not reachable' : 'offline'); }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
async function pool<T>(xs: T[], n: number, f: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, async () => { while (i < xs.length) { const x = xs[i++]; try { await f(x); } catch { /* per-item failure */ } } }));
}
function ccLabel(url: string | undefined): { licence: string; nc: boolean; nd: boolean } {
  const u = (url ?? '').toLowerCase();
  if (!u || u.includes('publicdomain/mark') || u.includes('licenses/publicdomain')) return { licence: 'Public domain', nc: false, nd: false };
  if (u.includes('publicdomain/zero')) return { licence: 'CC0', nc: false, nd: false };
  const m = /licenses\/([a-z-]+)\/([\d.]+)/.exec(u);
  if (m) return { licence: `CC ${m[1].toUpperCase()} ${m[2]}`, nc: m[1].includes('nc'), nd: m[1].includes('nd') };
  return { licence: 'See source', nc: false, nd: true };
}
export function credit(i: { title?: string; author?: string; source?: string; licence?: string; page?: string }) {
  const src = SRC_FULL[i.source as Source] ?? i.source ?? '';
  return `"${i.title ?? 'Untitled'}"${i.author ? ` by ${i.author}` : ''}, ${src}${i.licence ? `, ${i.licence}` : ''}${i.page ? ` (${i.page})` : ''}`;
}
async function copy(s: string) {
  try { await navigator.clipboard.writeText(s); } catch {
    const t = document.createElement('textarea'); t.value = s; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove();
  }
  ui.set({ status: 'Credit copied to the clipboard' });
}

// ---------------- sources ----------------
async function searchArchive(q: string, page: number): Promise<{ items: Item[]; more: boolean }> {
  const lic = '(collection:prelinger OR licenseurl:*publicdomain* OR licenseurl:*licenses\\/by*)';
  // match the words in titles and subject tags first: full-text search drags in talk shows that merely mention them
  const ask = async (match: string) => {
    const p = new URLSearchParams({ q: `${match} AND mediatype:movies AND ${lic} AND -licenseurl:*nd* AND -collection:deemphasize`, rows: String(PAGE), page: String(page + 1), output: 'json' });
    for (const f of ['identifier', 'title', 'creator', 'licenseurl', 'collection', 'runtime']) p.append('fl[]', f);
    return getJson(`https://archive.org/advancedsearch.php?${p}`);
  };
  const words = q.replace(/[^\w\s-]/g, ' ').trim();
  let d = await ask(`(title:(${words}) OR subject:(${words}))`);
  if (!(d?.response?.docs?.length) && page === 0) d = await ask(`(${q})`);
  const docs: any[] = d?.response?.docs ?? [];
  const items: Item[] = [];
  for (const x of docs) {
    const c = ccLabel(x.licenseurl);
    if (c.nd) continue; // no-derivatives (or unknown) licences cannot be cut into a video
    const id = String(x.identifier);
    items.push({
      key: `archive:${id}`, source: 'archive', id, title: String(x.title ?? id), thumb: `https://archive.org/services/img/${enc(id)}`,
      page: `https://archive.org/details/${id}`, dur: parseTime(x.runtime), licence: c.licence, licenceUrl: x.licenseurl, nc: c.nc,
      author: String([].concat(x.creator ?? []).join(', ') || 'Unknown'), attrib: c.licence.startsWith('CC BY'), resolved: false,
    });
  }
  return { items, more: (d?.response?.numFound ?? 0) > (page + 1) * PAGE };
}
async function resolveArchive(it: Item): Promise<Partial<Item>> {
  const d = await getJson(`https://archive.org/metadata/${enc(it.id)}`);
  const files: any[] = (d?.files ?? []).filter((f: any) => /\.(mp4|m4v|webm)$/i.test(f.name) && !/thumb/i.test(f.format ?? ''));
  if (!files.length) return { dead: true, resolved: true };
  const h = (f: any) => +f.height || 0;
  const score = (f: any) => (h(f) > 1080 ? -1e6 : 0) + ((+f.size || 0) > BIG ? -1e5 : 0) + h(f) * 10 + (/h\.264/i.test(f.format ?? '') ? 5 : 0) - (+f.size || 0) / 1e9;
  const best = [...files].sort((a, b) => score(b) - score(a))[0];
  const small = [...files].sort((a, b) => (+a.size || 0) - (+b.size || 0))[0];
  const url = (f: any) => `https://archive.org/download/${enc(it.id)}/${String(f.name).split('/').map(enc).join('/')}`;
  return { url: url(best), preview: url(small), ext: extOf(best.name), size: +best.size || undefined, w: +best.width || undefined, h: h(best) || undefined, dur: parseTime(best.length) ?? it.dur, resolved: true };
}

async function searchCommons(q: string, page: number): Promise<{ items: Item[]; more: boolean }> {
  const p = new URLSearchParams({
    action: 'query', format: 'json', formatversion: '2', origin: '*', generator: 'search', gsrsearch: `filetype:video ${q}`, gsrnamespace: '6',
    gsrlimit: String(PAGE), gsroffset: String(page * PAGE), prop: 'videoinfo', viprop: 'url|size|mime|extmetadata|derivatives', viurlwidth: '320',
    viextmetadatafilter: 'LicenseShortName|Artist|LicenseUrl|AttributionRequired',
  });
  const d = await getJson(`https://commons.wikimedia.org/w/api.php?${p}`);
  const pages: any[] = [...(d?.query?.pages ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const items: Item[] = [];
  for (const pg of pages) {
    const v = pg.videoinfo?.[0];
    if (!v) continue;
    const m = v.extmetadata ?? {};
    const lic = String(m.LicenseShortName?.value ?? 'See source');
    if (/\bND\b|NonCommercial|\bNC\b/i.test(lic)) continue;
    const ders: any[] = (v.derivatives ?? []).filter((x: any) => /webm/.test(x.type ?? '') && (x.height ?? 0) <= 1080);
    const dBest = [...ders].sort((a, b) => (b.height - a.height) || (/vp9/.test(b.type) ? 1 : 0) - (/vp9/.test(a.type) ? 1 : 0))[0];
    const dPrev = ders.find(x => x.height >= 360 && x.height <= 480) ?? ders[0];
    const origOk = /video\/webm/.test(v.mime) && (v.height ?? 0) <= 1080 && (v.size ?? 0) <= BIG;
    const url = origOk || !dBest ? clean(v.url) : dBest.src;
    const viaDer = !(origOk || !dBest);
    const title = String(pg.title).replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, '');
    items.push({
      key: `commons:${pg.pageid}`, source: 'commons', id: String(pg.pageid), title, thumb: v.thumburl ?? '', page: clean(v.descriptionurl ?? ''),
      url, preview: dPrev?.src ?? url, ext: extOf(url), dur: v.duration, w: viaDer ? dBest.width : v.width, h: viaDer ? dBest.height : v.height,
      size: viaDer ? Math.round((dBest.bandwidth ?? 0) * (v.duration ?? 0) / 8) || undefined : v.size, sizeApprox: viaDer,
      licence: lic, licenceUrl: m.LicenseUrl?.value, author: text(m.Artist?.value ?? '') || 'Unknown', attrib: m.AttributionRequired?.value === 'true', resolved: true,
    });
  }
  return { items, more: !!d?.continue };
}

async function searchNasa(q: string, page: number): Promise<{ items: Item[]; more: boolean }> {
  const p = new URLSearchParams({ q, media_type: 'video', page_size: String(PAGE), page: String(page + 1) });
  const d = await getJson(`https://images-api.nasa.gov/search?${p}`);
  const col = d?.collection ?? {};
  const items: Item[] = (col.items ?? []).map((x: any): Item => {
    const m = x.data?.[0] ?? {};
    const thumb = (x.links ?? []).find((l: any) => l.rel === 'preview')?.href ?? '';
    const who = [m.secondary_creator, m.photographer].filter(Boolean).join(', ');
    return {
      key: `nasa:${m.nasa_id}`, source: 'nasa', id: String(m.nasa_id), title: String(m.title ?? m.nasa_id), thumb: https(thumb),
      page: `https://images.nasa.gov/details/${enc(m.nasa_id)}`, licence: 'Public domain', author: who ? `NASA/${m.center ?? ''} (${who})` : `NASA/${m.center ?? ''}`,
      attrib: false, resolved: false, url: x.href, // collection.json, replaced on resolve
    };
  });
  return { items, more: (col.links ?? []).some((l: any) => l.rel === 'next') };
}
async function resolveNasa(it: Item): Promise<Partial<Item>> {
  const list: string[] = (await getJson(it.url!, true)).map(https);
  const pick = (...tags: string[]) => { for (const t of tags) { const f = list.find(u => u.endsWith(`~${t}.mp4`)); if (f) return f; } return list.find(u => /\.mp4$/i.test(u)); };
  const url = pick('large', 'orig', 'medium', 'small', 'mobile');
  if (!url) return { dead: true, resolved: true };
  const preview = pick('preview', 'mobile', 'small') ?? url;
  const out: Partial<Item> = { url, preview, ext: 'mp4', resolved: true };
  const [meta, hd] = await Promise.all([
    getJson(list.find(u => u.endsWith('/metadata.json')) ?? '', true).catch(() => null),
    stock!.head(url),
  ]);
  if (hd.ok) out.size = hd.size;
  if (meta) {
    out.dur = parseTime(meta['QuickTime:Duration'] ?? meta['Composite:Duration'] ?? meta['QuickTime:MediaDuration']);
    const w = +meta['QuickTime:ImageWidth'] || +meta['QuickTime:SourceImageWidth'], h = +meta['QuickTime:ImageHeight'] || +meta['QuickTime:SourceImageHeight'];
    if (w && h) { const s = Math.min(1, 1080 / h); out.w = Math.round(w * s); out.h = Math.round(h * s); }
  }
  return out;
}

// ---------------- actions ----------------
let gen = 0;
export async function stockSearch(q = st.q, page = 0) {
  q = q.trim();
  if (!q) return;
  const my = ++gen;
  // NASA's asset lists send no CORS headers, so they go through the desktop proxy
  const srcs = (st.src === 'all' ? ['archive', 'commons', 'nasa'] as Source[] : [st.src]).filter(s => s !== 'nasa' || !!stock);
  set({ q, page, busy: true, view: 'results', searched: true, notes: {}, ...(page === 0 ? { items: [], sel: null, more: {} } : {}) });
  const fns = { archive: searchArchive, commons: searchCommons, nasa: searchNasa };
  const notes: Partial<Record<Source, string>> = {}, more: Partial<Record<Source, boolean>> = { ...st.more };
  const found: Item[][] = await Promise.all(srcs.map(async s => {
    if (page > 0 && !st.more[s]) return [];
    try { const r = await fns[s](q, page); more[s] = r.more; notes[s] = `${r.items.length}`; return r.items; } catch (e: any) {
      more[s] = false;
      notes[s] = e.message === 'offline' ? 'offline' : 'unavailable';
      return [];
    }
  }));
  if (my !== gen) return;
  // interleave sources so the first screen shows a mix
  const merged: Item[] = [];
  for (let i = 0; found.some(f => i < f.length); i++) for (const f of found) if (i < f.length) merged.push(f[i]);
  const seen = new Set(st.items.map(i => i.key));
  set({ items: [...st.items, ...merged.filter(i => !seen.has(i.key))], notes, more, busy: false });
  await pool(merged.filter(i => !i.resolved), 6, async it => {
    if (my !== gen) return;
    try { patchItem(it.key, await (it.source === 'archive' ? resolveArchive(it) : resolveNasa(it))); } catch { patchItem(it.key, { dead: true, resolved: true }); }
  });
}
export async function refreshLibrary() { if (stock) set({ lib: await stock.list() }); }

function probe(path: string): Promise<boolean> {
  return new Promise(res => {
    const v = document.createElement('video');
    let done = false;
    const end = (ok: boolean) => { if (done) return; done = true; clearTimeout(t); v.removeAttribute('src'); v.load(); res(ok); };
    const t = setTimeout(() => end(false), 20000);
    v.muted = true; v.preload = 'auto';
    v.onloadeddata = () => end(v.videoWidth > 0 && v.videoHeight > 0);
    v.onerror = () => end(false);
    v.src = media.url(path) ?? '';
  });
}
async function bring(key: string, path: string) {
  setJob(key, { phase: 'probe' });
  if (!(await probe(path))) { setJob(key, { phase: 'unplayable', path, msg: stock?.hasFfmpeg() ? 'This clip uses a codec the player cannot decode.' : 'This clip uses a codec the player cannot decode, and ffmpeg was not found to convert it (brew install ffmpeg).' }); return; }
  setJob(key, null);
  await importItems([{ path }]);
}
export async function addItem(it: Item, force = false) {
  if (!stock) { ui.set({ status: 'Downloading stock footage needs the desktop app.' }); return; }
  const have = st.lib.find(e => e.key === it.key);
  if (have) return bring(it.key, have.path);
  if (!it.url || !it.resolved || it.dead) return;
  const j = st.jobs[it.key];
  if (j && (j.phase === 'dl' || j.phase === 'probe' || j.phase === 'convert')) return;
  if (!force && (it.size ?? 0) > BIG) { setJob(it.key, { phase: 'warn', msg: `${fmtSize(it.size)} download. Add anyway?` }); return; }
  const dest = `${it.source}-${it.id.replace(/[^\w.-]+/g, '_').slice(0, 80)}.${it.ext ?? extOf(it.url)}`;
  setJob(it.key, { phase: 'dl', got: 0, total: it.size ?? 0 });
  const meta = { key: it.key, title: it.title, source: it.source, sourceName: SRC_FULL[it.source], page: it.page, licence: it.licence, licenceUrl: it.licenceUrl, author: it.author, attributionRequired: it.attrib, credit: credit(it), duration: it.dur, width: it.w, height: it.h };
  const r = await stock.download(it.url, dest, (got, total) => setJob(it.key, { phase: 'dl', got, total }), meta);
  if ('error' in r) { setJob(it.key, r.error === 'Cancelled.' ? null : { phase: 'error', msg: r.error }); return; }
  await refreshLibrary();
  await bring(it.key, r.path);
}
async function convertItem(key: string, path: string) {
  if (!stock) return;
  setJob(key, { phase: 'convert', frac: 0 });
  const r = await stock.convert(path, f => setJob(key, { phase: 'convert', frac: f }));
  await refreshLibrary();
  if ('error' in r) { setJob(key, { phase: 'error', msg: r.error }); return; }
  await bring(key, r.path);
}
async function removeEntry(e: StockEntry) {
  if (!stock) return;
  await stock.remove(e.file);
  await refreshLibrary();
  ui.set({ status: `Removed ${e.title ?? e.file} from the stock library` });
}

// ---------------- components ----------------
export function Stock() {
  const s = useStock();
  useEffect(() => { refreshLibrary(); }, []);
  const libKeys = new Set(s.lib.map(e => e.key));
  const maxDur = s.dur === 'any' ? Infinity : +s.dur;
  const shown = s.items.filter(i => !i.dead && (i.dur === undefined || i.dur <= maxDur));
  const sel = s.items.find(i => i.key === s.sel) ?? null;
  const pending = s.items.filter(i => !i.resolved).length;
  const libSize = s.lib.reduce((n, e) => n + e.size, 0);
  return (
    <div className="stk">
      <div className="stk-bar">
        <form className="stk-q" onSubmit={e => { e.preventDefault(); stockSearch(); }}>
          <Icon n="search" size={12} />
          <input className="txt" placeholder="Search free footage" value={s.q} onChange={e => set({ q: e.target.value })} spellCheck={false} />
        </form>
        <div className="seg stk-seg" title="Source">
          {(['all', 'archive', 'commons', 'nasa'] as SourceSel[]).map(k => (
            <button key={k} className={s.src === k ? 'on' : ''} onClick={() => { set({ src: k }); if (s.q.trim()) stockSearch(); }}>{k === 'all' ? 'All' : SRC_LABEL[k]}</button>
          ))}
        </div>
        <select className="sel" value={s.dur} onChange={e => set({ dur: e.target.value as DurSel })} title="Duration">
          <option value="any">Any length</option><option value="30">Under 30 s</option><option value="120">Under 2 min</option>
        </select>
        <span className="stk-note mono dim">
          {s.busy ? 'Searching...' : s.view === 'results' && s.searched
            ? <>{shown.length} shown{pending ? ` · resolving ${pending}` : ''}{Object.entries(s.notes).map(([k, v]) => <span key={k} className={/^\d/.test(v!) ? '' : 'stk-bad'}> · {SRC_LABEL[k as Source]} {v}</span>)}</>
            : ''}
        </span>
        <div className="seg stk-seg stk-view">
          <button className={s.view === 'results' ? 'on' : ''} onClick={() => set({ view: 'results' })}>Results</button>
          <button className={s.view === 'library' ? 'on' : ''} onClick={() => { set({ view: 'library' }); refreshLibrary(); }}>Library {s.lib.length || ''}</button>
        </div>
      </div>
      <div className="stk-chips">
        {STARTERS.map(q => <button key={q} className={s.q === q && s.searched ? 'on' : ''} onClick={() => stockSearch(q)}>{q}</button>)}
      </div>
      {s.view === 'library' ? <Library lib={s.lib} size={libSize} /> : (
        <div className="stk-body">
          <div className="stk-grid-wrap">
            {!s.searched ? <div className="empty">Search public-domain and Creative Commons footage from the Internet Archive, Wikimedia Commons and NASA.<br />Pick a starter above or type a query. Clips download once to the library and land on the timeline.</div>
              : !shown.length && !s.busy ? <div className="empty">{Object.values(s.notes).every(v => v && !/^\d/.test(v)) ? 'The footage sources could not be reached. Check your internet connection.' : pending ? 'Resolving files...' : 'No clips found. Try a broader query or another source.'}</div>
              : <div className="stk-grid">
                {shown.map(i => <Tile key={i.key} it={i} on={i.key === s.sel} lib={libKeys.has(i.key)} job={s.jobs[i.key]} />)}
              </div>}
            {s.searched && !s.busy && Object.values(s.more).some(Boolean) && <div className="stk-more"><button className="btn sm" onClick={() => stockSearch(s.q, s.page + 1)}>Load more</button></div>}
          </div>
          <Side it={sel} lib={sel ? libKeys.has(sel.key) : false} job={sel ? s.jobs[sel.key] : undefined} />
        </div>
      )}
    </div>
  );
}

function Tile({ it, on, lib, job }: { it: Item; on: boolean; lib: boolean; job?: Job }) {
  const [hover, setHover] = useState(false);
  const t = useRef(0);
  const res = it.h ? `${it.h}p` : '';
  return (
    <div className={`stk-tile${on ? ' on' : ''}`} onClick={() => set({ sel: it.key })} onDoubleClick={() => addItem(it)}
      onMouseEnter={() => { t.current = window.setTimeout(() => setHover(true), 350); }} onMouseLeave={() => { clearTimeout(t.current); setHover(false); }}
      title={`${it.title}\n${it.author} · ${it.licence}\nDouble-click to add to the project`}>
      <div className="stk-thumb">
        {it.thumb ? <img src={it.thumb} alt="" loading="lazy" draggable={false} referrerPolicy="no-referrer" /> : null}
        {hover && it.preview && <video src={it.preview} autoPlay muted loop playsInline />}
        <span className="stk-src">{SRC_LABEL[it.source]}</span>
        {it.dur !== undefined && <span className="stk-dur mono">{fmtDur(it.dur)}</span>}
        {lib && <span className="stk-lib">In library</span>}
        {job?.phase === 'dl' && <Bar f={job.total ? job.got! / job.total : 0} />}
        {job?.phase === 'convert' && <Bar f={job.frac ?? 0} />}
      </div>
      <div className="stk-title">{it.title}</div>
      <div className="stk-meta mono">
        {!it.resolved ? <span className="dim">...</span> : <>{[res, it.size ? (it.sizeApprox ? '~' : '') + fmtSize(it.size) : ''].filter(Boolean).join(' · ')}</>}
        <span className={`stk-lic${it.nc ? ' nc' : ''}`}>{it.licence}</span>
      </div>
    </div>
  );
}

const Bar = ({ f }: { f: number }) => <div className="stk-bar-p"><i style={{ width: `${Math.max(2, Math.min(100, f * 100))}%` }} /></div>;

function Side({ it, lib, job }: { it: Item | null; lib: boolean; job?: Job }) {
  if (!it) return <div className="stk-side"><div className="empty">Hover a clip to preview it, click to inspect, double-click to add.</div></div>;
  const busy = job && (job.phase === 'dl' || job.phase === 'probe' || job.phase === 'convert');
  const dest = `${it.source}-${it.id.replace(/[^\w.-]+/g, '_').slice(0, 80)}.${it.ext ?? 'mp4'}`;
  return (
    <div className="stk-side">
      <div className="stk-player">{it.preview ? <video key={it.key} src={it.preview} autoPlay muted loop playsInline controls /> : <img src={it.thumb} alt="" />}</div>
      <div className="stk-name" title={it.title}>{it.title}</div>
      <div className="stk-actions">
        <button className="btn on" disabled={!!busy || !it.resolved || it.dead || !stock} onClick={() => addItem(it)}><Icon n="import" size={12} />{lib ? 'Add (in library)' : 'Add to project'}</button>
        <button className="btn" onClick={() => copy(credit(it))} title={credit(it)}>Copy credit</button>
      </div>
      <div className="stk-kv">
        <span>Source</span><span>{SRC_FULL[it.source]}</span>
        <span>Licence</span><span className={it.nc ? 'stk-warn' : ''}>{it.licence}{it.nc ? ' (non-commercial only)' : ''}{it.attrib ? ' · attribution required' : ''}</span>
        <span>Credit</span><span>{it.author}</span>
        <span>File</span><span className="mono">{[it.w && it.h ? `${it.w}×${it.h}` : '', fmtDur(it.dur), it.size ? (it.sizeApprox ? '~' : '') + fmtSize(it.size) : '', it.ext?.toUpperCase()].filter(Boolean).join(' · ') || (it.resolved ? '-' : '...')}</span>
      </div>
      {job?.phase === 'dl' && <div className="stk-prog"><Bar f={job.total ? job.got! / job.total : 0} /><span className="mono dim">{fmtSize(job.got)}{job.total ? ` / ${fmtSize(job.total)}` : ''}</span><button className="btn ghost sm" onClick={() => stock?.cancel(dest)}>Cancel</button></div>}
      {job?.phase === 'probe' && <div className="stk-msg dim">Checking the clip plays...</div>}
      {job?.phase === 'convert' && <div className="stk-prog"><Bar f={job.frac ?? 0} /><span className="mono dim">Converting to H.264 {Math.round((job.frac ?? 0) * 100)}%</span></div>}
      {job?.phase === 'warn' && <div className="stk-msg stk-warn">{job.msg} <button className="btn sm" onClick={() => addItem(it, true)}>Download</button> <button className="btn ghost sm" onClick={() => setJob(it.key, null)}>Cancel</button></div>}
      {job?.phase === 'error' && <div className="stk-msg stk-bad">{job.msg}</div>}
      {job?.phase === 'unplayable' && <div className="stk-msg stk-warn">{job.msg} {stock?.hasFfmpeg() && <button className="btn sm" onClick={() => convertItem(it.key, job.path!)}>Convert to H.264</button>}</div>}
    </div>
  );
}

function Library({ lib, size }: { lib: StockEntry[]; size: number }) {
  const s = useStock();
  if (!stock) return <div className="empty">The stock library needs the desktop app.</div>;
  return (
    <div className="stk-libv">
      <div className="stk-lib-head mono dim">
        <span>{lib.length} clip{lib.length === 1 ? '' : 's'} · {fmtSize(size) || '0 KB'} on disk · {stock.dir}</span>
        <button className="btn ghost sm" onClick={() => host.reveal(lib[0]?.path ?? stock.dir)}>Show in Finder</button>
      </div>
      {!lib.length ? <div className="empty">Nothing downloaded yet. Clips you add from the results are kept here for reuse.</div> : (
        <div className="stk-rows">
          {lib.map(e => {
            const key = e.key ?? e.file, job = s.jobs[key];
            return (
              <div key={e.file} className="stk-row">
                <span className="stk-row-t" title={e.file}>{e.title ?? e.file}</span>
                <span className="dim">{SRC_LABEL[e.source as Source] ?? 'Local'}</span>
                <span className="stk-lic">{e.licence ?? '-'}</span>
                <span className="mono dim">{fmtSize(e.size)}</span>
                <span className="stk-row-a">
                  {job?.phase === 'unplayable' && stock.hasFfmpeg() && <button className="btn sm" onClick={() => convertItem(key, e.path)}>Convert</button>}
                  {job?.phase === 'convert' && <span className="mono dim">{Math.round((job.frac ?? 0) * 100)}%</span>}
                  {job?.phase === 'error' && <span className="stk-bad" title={job.msg}>Error</span>}
                  <button className="btn sm" onClick={() => bring(key, e.path)}><Icon n="import" size={12} />Add</button>
                  <button className="btn ghost sm" onClick={() => copy(String(e.credit ?? credit(e)))}>Copy credit</button>
                  <button className="btn ghost sm" title="Remove from disk" onClick={() => removeEntry(e)}><Icon n="close" size={12} /></button>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
