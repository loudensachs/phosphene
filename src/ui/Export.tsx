// Export dialog: offline full-quality render piped into ffmpeg.
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { mixdown, prepareFootage, render, type RenderHandle } from '../nerve/export';
import { engine, project, ui } from './state';
import { ml } from '../nerve/ml';
import { Num, Seg, Toggle } from './Fields';
import { Icon } from './Icon';
import { host } from './host';

const FORMATS = [
  { k: 'h264', label: 'H.264 · MP4', ext: 'mp4', deep: false, note: '8-bit 4:2:0. Plays everywhere; best for social uploads.' },
  { k: 'h265', label: 'H.265 10-bit · MP4', ext: 'mp4', deep: true, note: '10-bit 4:2:0. Smaller files, smoother gradients.' },
  { k: 'prores422hq', label: 'ProRes 422 HQ · MOV', ext: 'mov', deep: true, note: '10-bit 4:2:2 intermediate for editing and playback servers.' },
  { k: 'prores4444', label: 'ProRes 4444 · MOV', ext: 'mov', deep: true, note: '10-bit 4:4:4 mastering quality. Very large files.' },
];

export function ExportDialog({ onClose }: { onClose(): void }) {
  const s = project.doc.settings;
  const [fmt, setFmt] = useState(0);
  const [scale, setScale] = useState(1);
  const [crf, setCrf] = useState(16);
  const [ss, setSs] = useState(0);
  const [mb, setMb] = useState(0);
  const [shutter, setShutter] = useState(0.5);
  const [audio, setAudio] = useState(true);
  const [rateSel, setRateSel] = useState(0);
  const [vision, setVision] = useState(() => { try { return localStorage.getItem('phos.exportVision') === 'live' ? 1 : 0; } catch { return 0; } });
  const pickVision = (v: number) => { setVision(v); try { localStorage.setItem('phos.exportVision', v ? 'live' : 'exact'); } catch { /* storage unavailable */ } };
  const visionNodes = project.doc.nodes.filter(n => n.type === 'depth' || n.type === 'matte' || n.type === 'track').length;
  const region = project.doc.region && project.doc.region[1] - project.doc.region[0] > 0.05 ? project.doc.region : null;
  const [range, setRange] = useState(region ? 2 : 0);
  const [written, setWritten] = useState(0);
  const [state, setState] = useState<{ frame: number; total: number; t0: number } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; path?: string } | null>(null);
  const handle = useRef<RenderHandle | null>(null);
  const f = FORMATS[fmt];
  const scales = [0.5, 1, 2];
  const W = Math.round((s.width * scales[scale]) / 2) * 2, H = Math.round((s.height * scales[scale]) / 2) * 2;
  const MB = [1, 4, 8, 16][mb];
  // export frame rate: the project's, or a lower one (fewer frames to render)
  const RATES = [s.fps, ...[30, 24].filter(r => r < s.fps)];
  const fps = RATES[Math.min(rateSel, RATES.length - 1)];
  const start = range === 2 && region ? region[0] : range === 1 ? Math.min(engine.time, s.duration - 1 / s.fps) : 0, end = range === 2 && region ? Math.min(region[1], s.duration) : s.duration;
  // size estimate: constant-quality encoders spend bits per pixel, so this scales with frame size, rate and length.
  // Real files run from about half this (still, clean pictures) to several times it (grain, glitch, fast motion).
  const px = W * H * fps, secs = Math.max(0, end - start);
  const vbps = f.k === 'prores422hq' ? 220e6 * (px / (1920 * 1080 * 30)) : f.k === 'prores4444' ? 330e6 * (px / (1920 * 1080 * 30)) : px * 0.1 * Math.pow(2, (23 - crf) / 6) * (f.k === 'h265' ? 0.6 : 1);
  const estBytes = ((vbps + (audio && project.doc.audio.length ? (f.ext === 'mov' ? 2304e3 : 320e3) : 0)) * secs) / 8;
  const size = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(b >= 1e10 ? 0 : 1)} GB` : b >= 1e6 ? `${Math.round(b / 1e6)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
  const tc = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
  const frames = Math.max(1, Math.round((end - start) * fps));
  const busy = !!state;
  // render time: learned from the last render of this kind (ms per megapixel-frame), else a rough guess from the preview's
  // cook time scaled to the export size, plus the model's time per frame when Exact waits for it
  const mode = vision && visionNodes ? 'live' : 'exact';
  const work = (W * H / 1e6) * MB * (ss ? 4 : 1);
  const learned = (() => { try { return JSON.parse(localStorage.getItem('phos.renderRate') ?? '{}')[mode] as number | undefined; } catch { return undefined; } })();
  const [pw, ph] = engine.resolution();
  const guess = Math.max(6, engine.cookMs) / Math.max(0.05, (pw * ph) / 1e6) + (mode === 'exact' ? (ml.models.depth.ms || 45) * visionNodes / Math.max(0.5, work) : 0) + 4;
  const estSecs = (frames * work * (learned ?? guess)) / 1000;
  const dur = (x: number) => (x < 90 ? `${Math.max(1, Math.round(x))} s` : x < 5400 ? `${Math.round(x / 60)} min` : `${(x / 3600).toFixed(1)} h`);

  const go = async () => {
    setMsg(null);
    if (!host.native) { setMsg({ ok: false, text: 'Export needs the desktop app: ffmpeg cannot be reached from a browser tab.' }); return; }
    const path = await host.saveDialog(`${project.doc.name}.${f.ext}`, f.ext);
    if (!path) return;
    let audioPath: string | undefined;
    try {
      if (audio) {
        const wav = await mixdown(engine, start, end);
        if (wav) { audioPath = await host.tempPath('mix.wav'); await host.writeFile(audioPath, wav); }
      }
      setWritten(0); setState({ frame: 0, total: frames, t0: performance.now() });
      await prepareFootage(engine, start, end, (d, n, name) => ui.set({ status: n ? `Preparing footage ${Math.min(n, Math.floor(d) + 1)} of ${n}: ${name}` : 'Rendering' }));
      const enc = await host.encoder({ path, width: W, height: H, fps, codec: f.k, pixfmt: f.deep ? 'rgba64le' : 'rgba', audioPath, crf });
      if ('error' in enc) { setMsg({ ok: false, text: enc.error }); return; }
      const t0 = performance.now();
      setState({ frame: 0, total: frames, t0 });
      const h = render(engine, { width: W, height: H, fps, start, end, supersample: ss ? 2 : 1, mbSamples: MB, shutter, deep: f.deep, vision: mode },
        fr => enc.write(fr), (frame, total) => { setState(st => st && { ...st, frame, total }); if (frame % 15 === 0) setWritten(host.fileSize(path)); });
      handle.current = h;
      let res;
      try { res = await h.done; } catch (e: any) { enc.cancel(); throw e; }
      if (res.cancelled) { enc.cancel(); setMsg({ ok: false, text: 'Export cancelled.' }); }
      else {
        const r = await enc.finish();
        // remember this machine's speed for the next estimate
        if (res.frames > 30) { try { const rates = JSON.parse(localStorage.getItem('phos.renderRate') ?? '{}'); rates[mode] = (performance.now() - t0) / res.frames / Math.max(0.05, work); localStorage.setItem('phos.renderRate', JSON.stringify(rates)); } catch { /* storage unavailable */ } }
        setMsg(r.ok ? { ok: true, text: `Exported ${res.frames} frames.`, path } : { ok: false, text: r.log.trim().split('\n').slice(-4).join('\n') || 'ffmpeg failed.' });
        if (r.ok) ui.set({ status: `Exported ${path}` });
      }
    } catch (e: any) { setMsg({ ok: false, text: String(e.message ?? e) }); }
    setState(null); handle.current = null;
  };

  const pct = state ? state.frame / state.total : 0;
  const el = state ? (performance.now() - state.t0) / 1000 : 0;
  const eta = state && state.frame > 3 ? (el / state.frame) * (state.total - state.frame) : 0;
  const row = (label: string, ctl: React.ReactNode, help?: string) => (
    <div className="row" style={{ gridTemplateColumns: '120px 1fr', paddingRight: 14 }} title={help}><span className="lbl">{label}</span><div className="ctl">{ctl}</div></div>
  );

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(4,4,6,0.6)', display: 'grid', placeItems: 'center' }} onPointerDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="pop" style={{ position: 'static', width: 470 }}>
        <div className="pane-tabs" style={{ height: 34, alignItems: 'center', padding: '0 12px', gap: 8 }}>
          <Icon n="export" /><b style={{ fontSize: 12.5 }}>Export Video</b>
          <span className="mono dim" style={{ marginLeft: 'auto' }}>{W} × {H} · {fps} fps · {frames} frames</span>
        </div>
        <div style={{ padding: '8px 0 4px', opacity: busy ? 0.45 : 1, pointerEvents: busy ? 'none' : undefined }}>
          {row('Format', <select className="sel" style={{ flex: 1 }} value={fmt} onChange={e => setFmt(+e.target.value)}>{FORMATS.map((x, i) => <option key={x.k} value={i}>{x.label}</option>)}</select>)}
          <div className="dim" style={{ padding: '0 14px 6px 138px', fontSize: 10.5 }}>{f.note}</div>
          {row('Size', <Seg options={['Half', 'Project', 'Double']} value={scale} onChange={setScale} />)}
          {RATES.length > 1 && row('Frame rate', <Seg options={RATES.map((r, i) => i ? `${r} fps` : `${r} fps (project)`)} value={Math.min(rateSel, RATES.length - 1)} onChange={setRateSel} />, 'Rendering at a lower frame rate renders fewer frames: 30 fps from a 60 fps project takes about half as long. Animation, cuts and audio stay in time.')}
          {row('Range', <Seg options={region ? ['Whole project', 'From playhead', 'Region'] : ['Whole project', 'From playhead']} value={Math.min(range, region ? 2 : 1)} onChange={setRange} />, 'Right-drag across the timeline to mark a region; a plain right-click clears it.')}
          <div className="dim mono" style={{ padding: '0 14px 6px 138px', fontSize: 10.5 }}>{tc(start)} to {tc(end)} · {secs.toFixed(1)} s{!region ? ' · right-drag on the timeline to mark a region' : ''}</div>
          {f.k.startsWith('h26') && row('Quality', <Num value={crf} min={0} max={40} step={1} int axis="CRF" onChange={setCrf} />, 'Constant rate factor: lower is higher quality and larger files. 14–18 is visually lossless for most material.')}
          {row('Supersampling', <Seg options={['Off', '2×']} value={ss} onChange={setSs} />, 'Render every operator at twice the output size and filter down. Cleans edges and fine detail at about four times the render cost.')}
          {row('Motion blur', <Seg options={['Off', '4', '8', '16']} value={mb} onChange={setMb} />, 'Averages this many sub-frame renders per output frame for true temporal blur.')}
          {MB > 1 && row('Shutter', <Num value={shutter} min={0.05} max={1} step={0.01} onChange={setShutter} />, 'Fraction of each frame the shutter stays open. 0.5 is the film-standard 180°.')}
          {row('Audio', <><Toggle on={audio} onChange={setAudio} /><span className="dim">{project.doc.audio.length ? `Mix ${project.doc.audio.filter(a => !a.mute).length} track(s)` : 'No audio in project'}</span></>)}
          {visionNodes > 0 && row('Depth & tracking', <Seg options={['Exact', 'Like preview']} value={vision} onChange={pickVision} />, 'Exact waits for depth, mattes and tracking on every frame: edges sit right on the subject, and the render is the same every time. Like preview keeps rendering while those catch up, as the live preview does: faster, and mattes and cut-out edges trail the motion by a few frames. Matte lag on Depth Estimate gives a trail that is the same in every render.')}
          {row('Render time', <span className="mono">≈ {dur(estSecs)}<span className="dim" style={{ fontFamily: 'inherit' }}>{learned ? '  from your last render' : '  rough guess; sharper after one render'}</span></span>, 'Estimated from frame size, length, motion blur, supersampling and how long each frame took last time.')}
          {row('File size', <span className="mono">≈ {size(estBytes)}<span className="dim" style={{ fontFamily: 'inherit' }}>{f.k.startsWith('h26') ? `  typical · ${size(estBytes * 0.5)} to ${size(estBytes * 5)} depending on detail` : '  fixed-rate codec'}</span></span>, 'Estimated from frame size, frame rate, length and quality. Grain, glitch and fast motion make H.264 and H.265 files several times larger; lower the quality (raise CRF) or use Half size to shrink them.')}
        </div>
        {state && <div style={{ padding: '6px 14px 10px' }}>
          <div style={{ height: 6, background: 'var(--bg0)', borderRadius: 3, overflow: 'hidden', border: '1px solid #000' }}><div style={{ width: `${pct * 100}%`, height: '100%', background: 'var(--accent)' }} /></div>
          <div className="mono dim" style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 10.5 }}>
            <span>frame {state.frame} / {state.total}{written > 2e5 && state.frame > 30 ? ` · ${size(written)} so far, about ${size((written / state.frame) * state.total)} when done` : ''}</span><span>{(state.frame / Math.max(0.1, el)).toFixed(1)} fps · {eta ? `${Math.ceil(eta)} s left` : 'estimating'}</span>
          </div>
        </div>}
        {msg && <div style={{ padding: '4px 14px 10px', color: msg.ok ? 'var(--ok)' : 'var(--err)', whiteSpace: 'pre-wrap', fontSize: 11.5, userSelect: 'text' }}>{msg.text}
          {msg.path && <button className="btn sm ghost" style={{ marginLeft: 8 }} onClick={() => host.reveal(msg.path!)}>Show in Finder</button>}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, padding: '10px 12px', borderTop: '1px solid var(--line)', background: 'var(--bg0)' }}>
          {busy ? <button className="btn" onClick={() => handle.current?.cancel()}>Cancel render</button>
            : <><button className="btn ghost" onClick={onClose}>Close</button><button className="tool primary" onClick={go}><Icon n="export" />Render</button></>}
        </div>
      </div>
    </div>, document.body);
}
