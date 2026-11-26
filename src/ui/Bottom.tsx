// Bottom pane: clip timeline (video layers, audio, ruler, playhead) and the Shaper modulation editor.
import { useEffect, useRef, useState } from 'react';
import type { Clip, ShaperData, ShaperPoint } from '../nerve/types';
import { shapeAt } from '../nerve/shaper';
import { uid } from '../nerve/project';
import { engine, project, ui, useDoc, useUI } from './state';
import { CtxMenu, Num, Seg, Toggle, type CtxItem } from './Fields';
import { CLIP_BLENDS, CLIP_EFFECTS, CLIP_EFFECT_HELP, CUSTOM_SLOTS, TRANSITIONS, slotEffect } from '../nerve/clipfx';
import { DRAG_TYPE } from './Mod';
import { Icon } from './Icon';
import { addShaper, importMedia, removeAudio, removeMidi } from './actions';
import { Stock } from './Stock';
import { HEAD, tv } from './tlview';
import { LaneArea, LaneTools, keyedCount, showKeyedLanes } from './Lanes';
import { Bands } from './Bands';
import { motionKeyTimes } from '../nerve/motion';

// timeline view + selection live outside React so the canvas loop reads them without re-rendering
const tlSubs = new Set<() => void>();
const tlEmit = () => tlSubs.forEach(f => f());

function findClip(id: string | null): { clip: Clip; ti: number } | null {
  if (!id) return null;
  const tr = project.doc.tracks;
  for (let ti = 0; ti < tr.length; ti++) { const clip = tr[ti].clips.find(c => c.id === id); if (clip) return { clip, ti }; }
  return null;
}
function patchClip(id: string, fn: (c: Clip) => void, key?: string) {
  project.tx(d => { for (const t of d.tracks) { const c = t.clips.find(q => q.id === id); if (c) fn(c); } }, key);
}
export function splitAtPlayhead() {
  const t = engine.time;
  const targets: string[] = [];
  for (const tr of project.doc.tracks) for (const c of tr.clips) if (t > c.start + 0.01 && t < c.start + c.dur - 0.01 && (!tv.sel || tv.sel === c.id)) targets.push(c.id);
  if (!targets.length) return;
  project.tx(d => {
    for (const tr of d.tracks) for (const c of [...tr.clips]) {
      if (!targets.includes(c.id)) continue;
      const cut = t - c.start;
      tr.clips.push({ ...c, id: uid('c'), start: t, in: c.in + cut * c.speed, dur: c.dur - cut });
      c.dur = cut;
    }
  });
}
function deleteClip() {
  if (!tv.sel) return;
  const id = tv.sel; tv.sel = null;
  project.tx(d => { for (const t of d.tracks) t.clips = t.clips.filter(c => c.id !== id); });
  tlEmit();
}

export function Bottom() {
  const tab = useUI(s => s.bottomTab);
  const doc = useDoc();
  const [, bump] = useState(0);
  useEffect(() => { const f = () => bump(n => n + 1); tlSubs.add(f); return () => { tlSubs.delete(f); }; }, []);
  const sel = findClip(tv.sel)?.clip;
  const nLanes = (doc.lanes ?? []).filter(l => doc.nodes.some(n => n.id === l.node)).length, keyed = tab === 'timeline' ? keyedCount() : 0;
  return (
    <div className="pane" style={{ flex: 1 }}>
      <div className="pane-tabs">
        <button className={`ptab${tab === 'timeline' ? ' on' : ''}`} onClick={() => ui.set({ bottomTab: 'timeline' })}><Icon n="film" />Timeline</button>
        <button className={`ptab${tab === 'shapers' ? ' on' : ''}`} onClick={() => ui.set({ bottomTab: 'shapers' })}><Icon n="curve" />Shapers{doc.shapers.length ? <span className="count">{doc.shapers.length}</span> : null}</button>
        <button className={`ptab${tab === 'bands' ? ' on' : ''}`} onClick={() => ui.set({ bottomTab: 'bands' })} title="Frequency bands of the music as modulation sources"><Icon n="bands" />Bands{doc.bands?.length ? <span className="count">{doc.bands.length}</span> : null}</button>
        <button className={`ptab${tab === 'stock' ? ' on' : ''}`} onClick={() => ui.set({ bottomTab: 'stock' })} title="Free stock footage"><Icon n="globe" />Stock</button>
        <div className="pane-tools">
          {tab === 'timeline' ? <>
            {sel && <>
              <span className="mono dim" style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sel.name}</span>
              {sel.kind === 'video' && <span style={{ width: 84, display: 'flex' }} title="Clip speed"><Num axis="Speed" value={sel.speed} min={0.1} max={4} step={0.01} def={1} unit="×"
                onChange={v => patchClip(sel.id, c => { const sp = Math.max(0.05, v); c.dur = c.loop ? c.dur * (c.speed / sp) : Math.min(c.dur * (c.speed / sp), (c.srcDur - c.in) / sp); c.speed = sp; }, `clipspeed:${sel.id}`)} onCommit={() => project.commit()} /></span>}
              {sel.kind === 'video' && <button className={`btn sm${sel.loop ? ' on' : ''}`} title="Loop the footage when the clip is dragged longer than its source" onClick={() => patchClip(sel.id, c => { c.loop = !c.loop; if (!c.loop) c.dur = Math.min(c.dur, (c.srcDur - c.in) / c.speed); })}><Icon n="loop" size={12} />Loop</button>}
              <span className="tsep" style={{ height: 14 }} />
            </>}
            {nLanes > 0 && <><LaneTools /><span className="tsep" style={{ height: 14 }} /></>}
            {keyed > nLanes && <button className="btn sm" onClick={showKeyedLanes} title="Show every automated parameter as a curve lane"><Icon n="curve" size={12} />Show automation ({keyed - nLanes})</button>}
            <button className="btn sm" onClick={importMedia} title="Import clips or audio (⌘I)"><Icon n="import" size={12} />Import</button>
            <button className="btn sm" onClick={() => project.tx(d => { d.tracks.push({ id: uid('t'), name: `V${d.tracks.length + 1}`, clips: [] }); })} title="Add a video layer"><Icon n="layers" size={12} />Add layer</button>
            <button className="btn sm" onClick={splitAtPlayhead} title="Split clips at the playhead (S)"><Icon n="cut" size={12} />Split</button>
            <button className="btn sm" onClick={() => { tv.fit = true; }} title="Fit the whole timeline (F)"><Icon n="frame" size={12} /></button>
            <span style={{ width: 92, display: 'flex' }} title="Project length"><Num axis="Length" value={doc.settings.duration} min={1} max={3600} step={1} unit="s" onChange={v => project.tx(d => { d.settings.duration = Math.max(1, v); }, 'dur')} onCommit={() => project.commit()} /></span>
          </> : tab === 'shapers' ? <button className="btn sm" onClick={addShaper}><Icon n="plus" size={12} />New shaper</button> : null}
        </div>
      </div>
      {tab === 'timeline' ? <Timeline lanes={nLanes} /> : tab === 'stock' ? <Stock /> : tab === 'bands' ? <Bands /> : <Shapers />}
    </div>
  );
}

// ---------------- timeline ----------------
const RULER = 26, ROW = 42;
const peakCache = new Map<string, Float32Array>();
type Row = { k: 'v'; i: number } | { k: 'a'; i: number } | { k: 'm'; i: number };
const rows = (): Row[] => {
  const d = project.doc;
  return [...d.tracks.map((_, i) => ({ k: 'v' as const, i })).reverse(), ...d.audio.map((_, i) => ({ k: 'a' as const, i })), ...d.midi.map((_, i) => ({ k: 'm' as const, i }))];
};
const tcShort = (t: number) => { const m = Math.floor(t / 60), s = t - m * 60; return `${m}:${s < 10 ? '0' : ''}${s.toFixed(s % 1 ? 1 : 0)}`; };

/** Right-click menu for a clip: what it does while it plays, how it blends with the track above, how it arrives. */
function clipMenu(id: string): CtxItem[] {
  const found = findClip(id);
  if (!found) return [];
  const cl = found.clip, items: CtxItem[] = [];
  const set = (fn: (c: Clip) => void, what: string) => { patchClip(id, fn); project.commit(); ui.set({ status: `${cl.name}: ${what}` }); };
  items.push({ label: 'EFFECT', disabled: true });
  CLIP_EFFECTS.forEach((n, i) => {
    if (CUSTOM_SLOTS.includes(i) && i === CUSTOM_SLOTS[0]) items.push({ sep: true, label: '' });
    const custom = CUSTOM_SLOTS.includes(i), who = custom ? slotEffect(project.doc, i) : null;
    items.push({
      label: custom ? (who ? `${n}: ${who}` : `${n} (empty)`) : n, hint: (cl.fx ?? 0) === i ? '●' : '',
      run: () => { set(c => { c.fx = i; }, `effect ${who ?? n}`); if (custom && !who) ui.set({ status: `${n} is empty: right-click an operator in the network and choose Use as Clip Effect → ${n}. This clip will use it.` }); },
    });
  });
  items.push({ sep: true, label: '' }, { label: 'BLEND WITH TRACK ABOVE', disabled: true });
  CLIP_BLENDS.forEach((n, i) => items.push({ label: n, hint: (cl.blend ?? 0) === i ? '●' : '', run: () => set(c => { c.blend = i; }, `blend ${n}`) }));
  items.push({ sep: true, label: '' }, { label: 'TRANSITION IN', disabled: true });
  TRANSITIONS.forEach((n, i) => items.push({ label: n, hint: (cl.trans ?? 0) === i ? '●' : '', run: () => set(c => { c.trans = i; }, `transition ${n}`) }));
  if ((cl.trans ?? 0) >= 1 && (cl.trans ?? 0) <= 4) for (const [n, v] of [['Short mosh', 0.25], ['Medium mosh', 0.4], ['Long mosh', 0.7]] as [string, number][]) items.push({ label: n, hint: Math.abs((cl.transLen ?? 0.4) - v) < 0.01 ? '●' : '', run: () => set(c => { c.transLen = v; }, n.toLowerCase()) });
  return items;
}
const effectTag = (cl: Clip) => [cl.fx ? (CUSTOM_SLOTS.includes(cl.fx) ? slotEffect(project.doc, cl.fx) ?? CLIP_EFFECTS[cl.fx] : CLIP_EFFECTS[cl.fx]) : '', cl.blend ? CLIP_BLENDS[cl.blend] : ''].filter(Boolean).join(' · ');
const TRANS_COLOR = ['', '#e6b450', '#59c2c0', '#b58bd6', '#e5604f', '#f2f2f2'];

function Timeline({ lanes }: { lanes: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: CtxItem[] } | null>(null);
  const menuRef = useRef(setMenu); menuRef.current = setMenu;
  useEffect(() => {
    const cv = ref.current!;
    const c = cv.getContext('2d')!;
    type Drag =
      | { k: 'scrub' }
      | { k: 'move'; id: string; dx: number; ti: number; moved: boolean }
      | { k: 'trimL' | 'trimR'; id: string; orig: Clip }
      | { k: 'audio'; i: number; dx: number }
      | { k: 'midi'; i: number; dx: number }
      | { k: 'region'; a: number; x0: number; y0: number; cx: number; cy: number; moved: boolean };
    let drag: Drag | null = null;
    let hoverEdge = false;
    const X = (t: number) => HEAD + (t - tv.t0) * tv.pps;
    const T = (x: number) => tv.t0 + (x - HEAD) / tv.pps;

    const draw = () => {
      const dpr = devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
      if (!w || !h) return;
      if (cv.width !== Math.round(w * dpr)) cv.width = Math.round(w * dpr);
      if (cv.height !== Math.round(h * dpr)) cv.height = Math.round(h * dpr);
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      const d = project.doc, s = d.settings;
      if (s.duration !== tv.dur) { tv.dur = s.duration; tv.fit = true; }
      if (tv.fit || !tv.pps) { tv.pps = (w - HEAD - 30) / s.duration; tv.t0 = 0; tv.fit = false; }
      if (engine.playing) { const px = X(engine.time); if (px > w - 40 || px < HEAD) tv.t0 = engine.time - 40 / tv.pps; }
      c.fillStyle = '#0e0e10'; c.fillRect(0, 0, w, h);
      const R = rows();

      // row backgrounds
      R.forEach((r, n) => {
        const y = RULER + n * ROW;
        c.fillStyle = n % 2 ? '#111113' : '#131316'; c.fillRect(HEAD, y, w - HEAD, ROW);
        c.fillStyle = '#000'; c.fillRect(0, y + ROW - 1, w, 1);
        if (r.k === 'v' && r.i === 0 && d.audio.length) { c.fillStyle = '#26262a'; c.fillRect(0, y + ROW - 1, w, 2); }
      });
      // out-of-range shading
      const xe = X(s.duration);
      if (xe < w) { c.fillStyle = 'rgba(0,0,0,0.45)'; c.fillRect(Math.max(HEAD, xe), RULER, w - xe, h); }

      // beat / bar grid + ruler
      c.fillStyle = '#18181b'; c.fillRect(0, 0, w, RULER);
      const beatSec = 60 / s.bpm, off = s.offset ?? 0;
      let div = 1;
      while (div * beatSec * tv.pps < 9) div *= 2;
      const b0 = Math.max(0, Math.floor((tv.t0 - off) / beatSec / div) * div);
      c.font = '9.5px "Fragment Mono", ui-monospace, monospace'; c.textBaseline = 'middle'; c.textAlign = 'left';
      let labelEvery = 4; while (labelEvery * beatSec * tv.pps < 54) labelEvery *= 2;
      for (let b = b0; b * beatSec + off <= T(w); b += div) {
        const x = Math.round(X(b * beatSec + off)) + 0.5;
        if (x < HEAD) continue;
        const bar = b % 4 === 0, lab = b % labelEvery === 0;
        c.strokeStyle = lab ? 'rgba(255,255,255,0.09)' : bar ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.022)';
        c.beginPath(); c.moveTo(x, lab ? 12 : RULER - (bar ? 7 : 4)); c.lineTo(x, h); c.stroke();
        if (lab) { c.fillStyle = '#9a9aa3'; c.fillText(String(b / 4 + 1), x + 4, 18); c.fillStyle = '#55555d'; c.fillText(tcShort(b * beatSec + off), x + 4, 7); }
      }
      // song sections along the bottom of the ruler, brighter = louder
      d.sections.forEach((sec, i) => {
        const x0 = Math.max(HEAD, X(sec.t)), x1 = Math.min(w, X(d.sections[i + 1]?.t ?? s.duration));
        if (x1 <= x0) return;
        c.fillStyle = sec.level > 0.75 ? '#e6b450' : sec.level > 0.5 ? '#a8843c' : sec.level > 0.25 ? '#6b5526' : '#3a3324';
        c.fillRect(x0 + 1, RULER - 5, x1 - x0 - 2, 3);
        if (x1 - x0 > 44) {
          c.font = '600 8.5px "Instrument Sans", -apple-system, sans-serif';
          const label = sec.name.toUpperCase(), tw = c.measureText(label).width;
          c.fillStyle = '#18181b'; c.fillRect(x1 - tw - 9, 1, tw + 8, 11);
          c.fillStyle = 'rgba(230,180,80,0.85)'; c.textAlign = 'right'; c.fillText(label, x1 - 5, 7); c.textAlign = 'left';
        }
      });
      // automation: keyframes of the selected operator, and recorded controller moves
      const selNode = ui.get().sel.length === 1 ? d.nodes.find(q => q.id === ui.get().sel[0]) : undefined;
      if (selNode) {
        c.fillStyle = '#d8847a';
        for (const st of Object.values(selNode.params)) for (const ks of st.keys ?? []) for (const k of ks ?? []) { const x = X(k.t); if (x >= HEAD && x <= w) c.fillRect(Math.round(x) - 1, RULER - 9, 2, 3); }
      }
      c.fillStyle = 'rgba(229,96,79,0.8)';
      for (const cv of Object.values(d.take.cc)) for (let i = 0; i < cv.length; i += 2) { const x = X(cv[i]); if (x >= HEAD && x <= w) c.fillRect(Math.round(x), RULER - 12, 1, 2); }
      if (engine.recording) { c.fillStyle = 'rgba(229,96,79,0.10)'; c.fillRect(HEAD, RULER, w - HEAD, h - RULER); }
      c.fillStyle = '#000'; c.fillRect(0, RULER - 1, w, 1);

      // clips
      const clipRect = (cl: Clip, n: number) => ({ x: X(cl.start), y: RULER + n * ROW + 3, w: Math.max(3, cl.dur * tv.pps), h: ROW - 7 });
      R.forEach((r, n) => {
        const y = RULER + n * ROW;
        if (r.k === 'v') {
          const tr = d.tracks[r.i];
          for (const cl of tr.clips) {
            const q = clipRect(cl, n);
            if (q.x > w || q.x + q.w < HEAD) continue;
            const on = tv.sel === cl.id, img = cl.kind === 'image';
            c.save(); c.beginPath(); c.rect(HEAD, y, w - HEAD, ROW); c.clip();
            c.beginPath(); c.roundRect(q.x, q.y, q.w, q.h, 4);
            const gr = c.createLinearGradient(0, q.y, 0, q.y + q.h);
            gr.addColorStop(0, img ? '#3d5a4c' : '#34597c'); gr.addColorStop(1, img ? '#2c4438' : '#27435e');
            c.fillStyle = gr; c.globalAlpha = tr.mute ? 0.35 : 1; c.fill(); c.globalAlpha = 1;
            c.fillStyle = img ? '#7fb069' : '#5a9bd8'; c.fillRect(q.x + 1, q.y + 1, q.w - 2, 2);
            c.strokeStyle = on ? '#e6b450' : 'rgba(0,0,0,0.85)'; c.lineWidth = on ? 1.6 : 1; c.stroke();
            if (q.w > 34) {
              c.save(); c.beginPath(); c.rect(q.x + 4, q.y, q.w - 8, q.h); c.clip();
              c.font = '500 10.5px "Instrument Sans", "Instrument Sans", -apple-system, sans-serif'; c.fillStyle = '#f0f0f2'; c.fillText(cl.name, q.x + 8, q.y + 14);
              c.font = '9px "Fragment Mono", ui-monospace, monospace'; c.fillStyle = 'rgba(255,255,255,0.5)';
              c.fillText(`${cl.dur.toFixed(2)}s${cl.speed !== 1 ? `  ${cl.speed.toFixed(2)}×` : ''}${cl.in > 0.01 ? `  in ${cl.in.toFixed(2)}` : ''}`, q.x + 8, q.y + 27);
              c.restore();
            }
            if (cl.loop && cl.srcDur > 0.2) { c.fillStyle = 'rgba(0,0,0,0.55)'; const per = (cl.srcDur - 0.05) / cl.speed; for (let lt = cl.start + ((cl.srcDur - 0.05) - cl.in) / cl.speed; lt < cl.start + cl.dur - 0.01; lt += per) c.fillRect(X(lt) - 0.5, q.y + 3, 1.5, q.h - 3); }
            // motion keyframes: small diamonds along the clip's lower edge
            for (const kt of motionKeyTimes(cl)) {
              const kx = X(cl.start + kt), ky = q.y + q.h - 5;
              if (kx < q.x || kx > q.x + q.w) continue;
              c.beginPath(); c.moveTo(kx, ky - 4); c.lineTo(kx + 4, ky); c.lineTo(kx, ky + 4); c.lineTo(kx - 4, ky); c.closePath();
              c.fillStyle = '#e6b450'; c.fill(); c.strokeStyle = 'rgba(0,0,0,0.8)'; c.lineWidth = 1; c.stroke();
            }
            const tag = effectTag(cl);
            if (tag && q.w > 60) {
              c.save(); c.beginPath(); c.rect(q.x + 4, q.y, q.w - 8, q.h); c.clip();
              c.font = '600 9px "Instrument Sans", -apple-system, sans-serif'; const tw = c.measureText(tag).width + 10;
              c.fillStyle = 'rgba(10,10,12,0.72)'; c.beginPath(); c.roundRect(q.x + q.w - tw - 5, q.y + q.h - 15, tw, 12, 3); c.fill();
              c.fillStyle = '#e8c27a'; c.textAlign = 'left'; c.fillText(tag, q.x + q.w - tw, q.y + q.h - 8.5); c.restore();
            }
            if ((cl.trans ?? 0) > 0) {
              // transition marker: a wedge on the clip's leading edge, as long as the mosh
              const col = TRANS_COLOR[cl.trans!] ?? '#fff', wl = cl.trans === 5 ? 5 : Math.max(5, (cl.transLen ?? 0.4) * tv.pps);
              const g2 = c.createLinearGradient(q.x, 0, q.x + wl, 0); g2.addColorStop(0, col + 'cc'); g2.addColorStop(1, col + '00');
              c.fillStyle = g2; c.fillRect(q.x, q.y + 3, wl, q.h - 3);
              c.fillStyle = col; c.beginPath(); c.moveTo(q.x - 4, q.y); c.lineTo(q.x + 4, q.y); c.lineTo(q.x, q.y + 6); c.fill();
            }
            if (on) { c.fillStyle = '#e6b450'; c.fillRect(q.x, q.y + 6, 3, q.h - 12); c.fillRect(q.x + q.w - 3, q.y + 6, 3, q.h - 12); }
            c.restore();
          }
        } else if (r.k === 'm') {
          const m = d.midi[r.i], md = engine.midiData.get(m.id);
          if (md) {
            const x0 = X(m.start), ww = Math.max(4, md.dur * tv.pps);
            c.save(); c.beginPath(); c.rect(HEAD, y, w - HEAD, ROW); c.clip();
            c.beginPath(); c.roundRect(x0, y + 3, ww, ROW - 7, 4); c.fillStyle = '#2a2433'; c.fill(); c.strokeStyle = 'rgba(0,0,0,0.85)'; c.lineWidth = 1; c.stroke();
            let lo = 127, hi = 0;
            for (let i = 0; i < md.notes.length; i += 4) { lo = Math.min(lo, md.notes[i + 2]); hi = Math.max(hi, md.notes[i + 2]); }
            const span = Math.max(1, hi - lo);
            c.fillStyle = m.mute ? '#5a5466' : '#b58bd6';
            for (let i = 0; i < md.notes.length; i += 4) {
              const nx = x0 + md.notes[i] * tv.pps;
              if (nx > w || nx + md.notes[i + 1] * tv.pps < HEAD) continue;
              c.globalAlpha = 0.45 + 0.55 * md.notes[i + 3];
              c.fillRect(nx, y + ROW - 8 - ((md.notes[i + 2] - lo) / span) * (ROW - 16), Math.max(1.5, md.notes[i + 1] * tv.pps - 0.5), 2.5);
            }
            c.globalAlpha = 1; c.restore();
          }
        } else {
          const a = d.audio[r.i], tr = engine.audio.tracks.get(a.id);
          if (tr) {
            const dur = tr.buffer.duration, x0 = X(a.start), ww = dur * tv.pps;
            c.save(); c.beginPath(); c.rect(HEAD, y, w - HEAD, ROW); c.clip();
            c.beginPath(); c.roundRect(x0, y + 3, ww, ROW - 7, 4); c.fillStyle = '#1b2a24'; c.fill();
            c.strokeStyle = 'rgba(0,0,0,0.85)'; c.lineWidth = 1; c.stroke();
            const n2 = Math.max(2, Math.min(6000, Math.round(ww)));
            const key = `${a.id}:${n2}`;
            let pk = peakCache.get(key);
            if (!pk) { pk = engine.audio.peaks(a.id, n2)!; if (peakCache.size > 16) peakCache.clear(); peakCache.set(key, pk); }
            c.fillStyle = a.mute ? '#3a4a42' : '#6cc08b';
            const mid = y + ROW / 2 - 0.5, amp = (ROW / 2 - 6) * Math.min(1.5, a.gain);
            const k0 = Math.max(0, Math.floor(((HEAD - x0) / ww) * n2)), k1 = Math.min(n2, Math.ceil(((w - x0) / ww) * n2));
            for (let k = k0; k < k1; k++) { const lo = pk[k * 2], hi = pk[k * 2 + 1]; c.fillRect(x0 + (k / n2) * ww, mid - hi * amp, Math.max(1, ww / n2), Math.max(1, (hi - lo) * amp)); }
            c.restore();
          }
        }
      });

      // headers
      c.fillStyle = '#18181b'; c.fillRect(0, RULER, HEAD, h - RULER);
      c.fillStyle = '#000'; c.fillRect(HEAD - 1, 0, 1, h);
      R.forEach((r, n) => {
        const y = RULER + n * ROW;
        const name = r.k === 'v' ? d.tracks[r.i].name : r.k === 'a' ? d.audio[r.i].name : d.midi[r.i].name;
        const mute = r.k === 'v' ? d.tracks[r.i].mute : r.k === 'a' ? d.audio[r.i].mute : d.midi[r.i].mute;
        c.fillStyle = r.k === 'v' ? '#5a9bd8' : r.k === 'a' ? '#6cc08b' : '#b58bd6'; c.fillRect(0, y, 3, ROW - 1);
        c.font = '600 11px "Instrument Sans", "Instrument Sans", -apple-system, sans-serif'; c.fillStyle = mute ? '#6a6a72' : '#e4e4e8'; c.textAlign = 'left';
        c.save(); c.beginPath(); c.rect(0, y, HEAD - 58, ROW); c.clip(); c.fillText(name, 12, y + 15); c.restore();
        c.font = '9.5px "Instrument Sans", -apple-system, sans-serif'; c.fillStyle = '#6a6a72';
        c.fillText(r.k === 'v' ? `Video layer · ${d.tracks[r.i].clips.length} clip${d.tracks[r.i].clips.length === 1 ? '' : 's'}` : r.k === 'a' ? `Audio · gain ${d.audio[r.i].gain.toFixed(2)}` : `MIDI · ${(engine.midiData.get(d.midi[r.i].id)?.notes.length ?? 0) / 4} notes`, 12, y + 29);
        const btn = (bx: number, label: string, on: boolean, col: string) => {
          c.beginPath(); c.roundRect(bx, y + 11, 20, 18, 3); c.fillStyle = on ? col : '#26262a'; c.fill();
          c.strokeStyle = 'rgba(0,0,0,0.7)'; c.lineWidth = 1; c.stroke();
          c.font = '600 9.5px "Instrument Sans", -apple-system, sans-serif'; c.fillStyle = on ? '#111' : '#9a9aa3'; c.textAlign = 'center'; c.fillText(label, bx + 10, y + 20.5); c.textAlign = 'left';
        };
        btn(HEAD - 52, 'M', !!mute, '#e6b450');
        btn(HEAD - 28, '×', false, '#e5604f');
      });
      c.fillStyle = '#18181b'; c.fillRect(0, 0, HEAD - 1, RULER - 1);
      c.font = '9.5px "Instrument Sans", -apple-system, sans-serif'; c.fillStyle = '#6a6a72'; c.textAlign = 'left'; c.fillText('LAYERS', 12, RULER / 2);
      if (!R.length || (!d.audio.length && !d.tracks.some(t => t.clips.length))) {
        c.font = '12px "Instrument Sans", "Instrument Sans", -apple-system, sans-serif'; c.fillStyle = '#55555d'; c.textAlign = 'center';
        c.fillText('Drop video, images and music here, or press ⌘I to import', HEAD + (w - HEAD) / 2, RULER + Math.max(ROW * 1.5, (h - RULER) / 2));
        c.textAlign = 'left';
      }

      // export region
      if (d.region) {
        const xa = Math.max(HEAD, X(d.region[0])), xb = Math.min(w, X(d.region[1]));
        if (xb > xa) {
          c.fillStyle = 'rgba(230,180,80,0.07)'; c.fillRect(xa, RULER, xb - xa, h - RULER);
          c.fillStyle = 'rgba(230,180,80,0.30)'; c.fillRect(xa, 0, xb - xa, RULER - 1);
          c.fillStyle = '#e6b450'; c.fillRect(xa, 0, 1.5, h); c.fillRect(xb - 1.5, 0, 1.5, h);
          if (xb - xa > 70) { c.font = '600 9.5px "Instrument Sans", -apple-system, sans-serif'; c.fillStyle = '#16130a'; c.textAlign = 'center'; c.fillText(`EXPORT ${(d.region[1] - d.region[0]).toFixed(1)} s`, (xa + xb) / 2, RULER / 2); c.textAlign = 'left'; }
        }
      }
      // playhead
      const px = Math.round(X(engine.time)) + 0.5;
      if (px >= HEAD) {
        c.strokeStyle = '#e6b450'; c.lineWidth = 1; c.beginPath(); c.moveTo(px, 10); c.lineTo(px, h); c.stroke();
        c.fillStyle = '#e6b450'; c.beginPath(); c.moveTo(px - 5.5, 0); c.lineTo(px + 5.5, 0); c.lineTo(px + 5.5, 7); c.lineTo(px, 13); c.lineTo(px - 5.5, 7); c.fill();
      }
    };
    const off = engine.onFrame(draw);

    // ----- interaction -----
    const pos = (e: MouseEvent) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const snapT = (t: number, e: MouseEvent, skip?: string) => {
      if (e.shiftKey) return t;
      const d = project.doc, pts = [0, engine.time];
      for (const tr of d.tracks) for (const cl of tr.clips) if (cl.id !== skip) pts.push(cl.start, cl.start + cl.dur);
      for (const a of d.audio) pts.push(a.start);
      const beat = 60 / d.settings.bpm, bo = d.settings.offset ?? 0; pts.push(Math.round((t - bo) / beat) * beat + bo);
      let best = t, bd = 7 / tv.pps;
      for (const p of pts) if (Math.abs(p - t) < bd) { bd = Math.abs(p - t); best = p; }
      const f = d.settings.fps; return Math.max(0, Math.round(best * f) / f);
    };
    const hitClip = (x: number, y: number) => {
      const R = rows(), n = Math.floor((y - RULER) / ROW), r = R[n];
      if (!r || y < RULER || x < HEAD) return null;
      const t = T(x);
      if (r.k === 'v') {
        const cls = project.doc.tracks[r.i].clips;
        for (let i = cls.length - 1; i >= 0; i--) { const cl = cls[i]; if (t >= cl.start && t <= cl.start + cl.dur) { const xl = X(cl.start), xr = X(cl.start + cl.dur); return { r, cl, edge: x - xl < 7 ? 'L' : xr - x < 7 ? 'R' : '' }; } }
      }
      return { r, cl: null as Clip | null, edge: '' };
    };
    const seek = (e: MouseEvent) => { const d = project.doc.settings; const t = T(pos(e).x); engine.seek(Math.min(d.duration, Math.max(0, e.shiftKey ? t : Math.round(t * d.fps) / d.fps))); };

    const down = (e: PointerEvent) => {
      cv.focus();
      const { x, y } = pos(e); const R = rows();
      // right-drag anywhere over the timeline marks the region to export; a plain right-click clears it
      if (e.button === 2) { if (x >= HEAD) { try { cv.setPointerCapture(e.pointerId); } catch { /* synthetic */ } drag = { k: 'region', a: snapT(T(x), e), x0: x, y0: y, cx: e.clientX, cy: e.clientY, moved: false }; } return; }
      if (e.button !== 0) return;
      if (x < HEAD) {
        const n = Math.floor((y - RULER) / ROW), r = R[n];
        if (!r || y < RULER) return;
        if (x > HEAD - 54 && x < HEAD - 30) {
          if (r.k === 'v') project.tx(d => { d.tracks[r.i].mute = !d.tracks[r.i].mute; });
          else if (r.k === 'm') project.tx(d => { d.midi[r.i].mute = !d.midi[r.i].mute; });
          else { project.tx(d => { d.audio[r.i].mute = !d.audio[r.i].mute; }); if (engine.playing) { engine.pause(); engine.play(); } }
        } else if (x >= HEAD - 30) {
          if (r.k === 'a') removeAudio(project.doc.audio[r.i].id);
          else if (r.k === 'm') removeMidi(project.doc.midi[r.i].id);
          else if (!project.doc.tracks[r.i].clips.length && project.doc.tracks.length > 1 && r.i === project.doc.tracks.length - 1) project.tx(d => { d.tracks.pop(); });
          else ui.set({ status: 'Only the top video layer can be removed, and only when it is empty.' });
        }
        return;
      }
      cv.setPointerCapture(e.pointerId);
      if (y < RULER) { drag = { k: 'scrub' }; seek(e); return; }
      const h = hitClip(x, y);
      if (h?.cl) {
        tv.sel = h.cl.id; tlEmit(); project.commit(); if (ui.get().sel.length) ui.set({ sel: [] });
        if (h.edge === 'L') drag = { k: 'trimL', id: h.cl.id, orig: { ...h.cl } };
        else if (h.edge === 'R') drag = { k: 'trimR', id: h.cl.id, orig: { ...h.cl } };
        else drag = { k: 'move', id: h.cl.id, dx: T(x) - h.cl.start, ti: (h.r as { i: number }).i, moved: false };
        return;
      }
      if (h?.r.k === 'a') { const a = project.doc.audio[h.r.i]; drag = { k: 'audio', i: h.r.i, dx: T(x) - a.start }; project.commit(); return; }
      if (h?.r.k === 'm') { const m = project.doc.midi[h.r.i]; drag = { k: 'midi', i: h.r.i, dx: T(x) - m.start }; project.commit(); return; }
      if (tv.sel) { tv.sel = null; tlEmit(); }
      drag = { k: 'scrub' }; seek(e);
    };
    const move = (e: PointerEvent) => {
      const { x, y } = pos(e);
      if (!drag) { const h = y > RULER ? hitClip(x, y) : null; hoverEdge = !!h?.edge; cv.style.cursor = hoverEdge ? 'ew-resize' : 'default'; return; }
      const d = drag;
      if (d.k === 'region') {
        if (!d.moved && Math.abs(x - d.x0) < 4) return;
        d.moved = true;
        const b = Math.min(project.doc.settings.duration, snapT(T(Math.max(HEAD, x)), e));
        project.tx(doc => { doc.region = [Math.min(d.a, b), Math.max(d.a, b)]; }, 'region');
        return;
      }
      if (d.k === 'scrub') seek(e);
      else if (d.k === 'move') {
        const start = snapT(Math.max(0, T(x) - d.dx), e, d.id);
        const R = rows(), r = R[Math.floor((y - RULER) / ROW)];
        const ti = r && r.k === 'v' ? r.i : d.ti;
        d.moved = true;
        project.tx(doc => {
          let cl: Clip | undefined;
          for (const t of doc.tracks) { const q = t.clips.find(c2 => c2.id === d.id); if (q) { cl = q; if (doc.tracks.indexOf(t) !== ti) { t.clips = t.clips.filter(c2 => c2 !== q); doc.tracks[ti].clips.push(q); } break; } }
          if (cl) cl.start = start;
        }, `clipmove:${d.id}`);
        d.ti = ti;
      } else if (d.k === 'trimL') {
        const o = d.orig, end = o.start + o.dur;
        let st = Math.min(end - 0.04, snapT(T(x), e, d.id));
        if (o.kind === 'video') st = Math.max(st, o.start - o.in / o.speed);
        patchClip(d.id, cl => { cl.start = st; cl.dur = end - st; if (o.kind === 'video') cl.in = o.in + (st - o.start) * o.speed; }, `cliptrim:${d.id}`);
      } else if (d.k === 'trimR') {
        const o = d.orig;
        let end = Math.max(o.start + 0.04, snapT(T(x), e, d.id));
        if (o.kind === 'video' && !o.loop) end = Math.min(end, o.start + (o.srcDur - o.in) / o.speed);
        patchClip(d.id, cl => { cl.dur = end - o.start; }, `cliptrim:${d.id}`);
      } else if (d.k === 'midi') {
        const st = snapT(Math.max(0, T(x) - d.dx), e);
        project.tx(doc => { doc.midi[d.i].start = st; }, `midmove:${d.i}`);
      } else if (d.k === 'audio') {
        const st = snapT(Math.max(0, T(x) - d.dx), e);
        project.tx(doc => { doc.audio[d.i].start = st; }, `audmove:${d.i}`);
      }
    };
    const up = () => { const d = drag; drag = null;
      if (d?.k === 'region' && !d.moved) { const h = hitClip(d.x0, d.y0); if (h?.cl) { tv.sel = h.cl.id; tlEmit(); menuRef.current({ x: d.cx, y: d.cy, items: clipMenu(h.cl.id) }); project.commit(); return; } }
      if (d?.k === 'region') { const r = project.doc.region; if (!d.moved || (r && r[1] - r[0] < 0.05)) { if (r) { project.tx(doc => { doc.region = null; }); ui.set({ status: 'Export region cleared' }); } } else if (r) ui.set({ status: `Export region ${tcShort(r[0])} to ${tcShort(r[1])} (${(r[1] - r[0]).toFixed(1)} s). It is offered in the Export dialog.` }); }
      project.commit(); if (d?.k === 'audio' && engine.playing) { engine.pause(); engine.play(); } };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const { x } = pos(e);
      if (e.ctrlKey || e.metaKey) { const t = T(x); tv.pps = Math.min(2000, Math.max(0.5, tv.pps * Math.exp(-e.deltaY * 0.01))); tv.t0 = t - (x - HEAD) / tv.pps; }
      else tv.t0 += (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) / tv.pps;
      tv.t0 = Math.max(-20 / tv.pps, tv.t0);
    };
    const key = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey) return;
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteClip(); }
      else if (e.key === 's') splitAtPlayhead();
      else if (e.key === 'f') tv.fit = true;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { const f = project.doc.settings.fps; engine.seek(Math.max(0, engine.time + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 10 : 1) / f)); }
    };
    cv.addEventListener('pointerdown', down); cv.addEventListener('pointermove', move); cv.addEventListener('pointerup', up);
    const noMenu = (e: Event) => e.preventDefault();
    cv.addEventListener('contextmenu', noMenu);
    cv.addEventListener('wheel', wheel, { passive: false }); cv.addEventListener('keydown', key);
    return () => { off(); cv.removeEventListener('contextmenu', noMenu); cv.removeEventListener('pointerdown', down); cv.removeEventListener('pointermove', move); cv.removeEventListener('pointerup', up); cv.removeEventListener('wheel', wheel); cv.removeEventListener('keydown', key); };
  }, []);
  // with lanes open the clip tracks keep their natural height and the curves take the rest
  const nRows = project.doc.tracks.length + project.doc.audio.length + project.doc.midi.length;
  return (
    <div className="tl-wrap">
      <div className="tl" style={lanes ? { flex: 'none', height: Math.min(RULER + Math.max(1, nRows) * ROW + 2, 190) } : undefined}><canvas ref={ref} tabIndex={0} /></div>
      {lanes > 0 && <LaneArea />}
      {menu && <CtxMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}

// ---------------- shapers ----------------
const P = (x: number, y: number, c = 0): ShaperPoint => ({ x, y, c });
const PRESETS: { name: string; pts: ShaperPoint[] }[] = [
  { name: 'Saw down', pts: [P(0, 1), P(1, 0)] },
  { name: 'Saw up', pts: [P(0, 0), P(1, 1)] },
  { name: 'Decay', pts: [P(0, 1, -0.7), P(1, 0)] },
  { name: 'Pump', pts: [P(0, 0, -0.6), P(0.45, 1), P(1, 1)] },
  { name: 'Triangle', pts: [P(0, 0), P(0.5, 1), P(1, 0)] },
  { name: 'Sine', pts: [P(0, 0, 0.35), P(0.25, 0.5, -0.35), P(0.5, 1, 0.35), P(0.75, 0.5, -0.35), P(1, 0)] },
  { name: 'Square', pts: [P(0, 1), P(0.5, 1), P(0.5, 0), P(1, 0)] },
  { name: 'Gate 1/4', pts: [P(0, 1), P(0.25, 1), P(0.25, 0), P(1, 0)] },
  { name: 'Stairs', pts: [P(0, 0), P(0.25, 0), P(0.25, 0.33), P(0.5, 0.33), P(0.5, 0.66), P(0.75, 0.66), P(0.75, 1), P(1, 1)] },
  { name: 'Stutter', pts: [P(0, 1, -0.6), P(0.25, 0), P(0.25, 1, -0.6), P(0.5, 0), P(0.5, 1, -0.6), P(0.75, 0), P(0.75, 1, -0.6), P(1, 0)] },
  { name: 'Swell', pts: [P(0, 0, 0.7), P(0.9, 1), P(1, 0)] },
  { name: 'Bounce', pts: [P(0, 1, 0.5), P(0.4, 0, -0.5), P(0.6, 0.5, 0.5), P(0.8, 0, -0.5), P(0.9, 0.2, 0.5), P(1, 0)] },
];
const LENGTHS: [string, number][] = [['1/16', 0.25], ['1/8', 0.5], ['1/8 T', 1 / 3], ['1/4', 1], ['1/4 D', 1.5], ['1/2', 2], ['1 bar', 4], ['2 bars', 8], ['4 bars', 16], ['8 bars', 32]];

function miniCurve(cv: HTMLCanvasElement | null, pts: ShaperPoint[], color: string) {
  if (!cv) return;
  const dpr = devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  cv.width = w * dpr; cv.height = h * dpr;
  const c = cv.getContext('2d')!; c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.beginPath();
  for (let i = 0; i <= w; i++) { const y = h - 2.5 - shapeAt(pts, i / w) * (h - 5); i ? c.lineTo(i, y) : c.moveTo(i, y); }
  c.strokeStyle = color; c.lineWidth = 1.2; c.stroke();
}

function Shapers() {
  const doc = useDoc();
  const cur = useUI(s => s.shaper);
  const [, bumpSh] = useState(0);
  const sh = doc.shapers.find(s => s.id === cur) ?? doc.shapers[0];
  if (!sh) return <div className="empty">Shapers are drawable modulation curves that loop in time with the tempo or fire on audio transients.<br />Create one, then right-click any numeric parameter to modulate it, or type its name (<span className="mono">s1</span>) in an expression.</div>;
  const patch = (fn: (s: ShaperData) => void, key?: string) => project.tx(d => { const s = d.shapers.find(q => q.id === sh.id); if (s) fn(s); }, key);
  return (
    <div className="shp">
      <div className="shp-list">
        {doc.shapers.map(s => (
          <button key={s.id} className={`shp-item${s.id === sh.id ? ' on' : ''}`} onClick={() => ui.set({ shaper: s.id })} draggable title="Drag onto a parameter to modulate it"
            onDragStart={e => { e.dataTransfer.setData(DRAG_TYPE, s.name); e.dataTransfer.setData('text/plain', s.name); e.dataTransfer.effectAllowed = 'copy'; }}>
            {s.name}<canvas ref={el => miniCurve(el, s.points, s.id === sh.id ? '#e6b450' : '#6f6f78')} />
          </button>
        ))}
      </div>
      <ShaperCanvas key={sh.id} id={sh.id} />
      <div className="shp-side">
        <div className="presets">
          {PRESETS.map(p => <button key={p.name} title={p.name} onClick={() => patch(s => { s.points = JSON.parse(JSON.stringify(p.pts)); })}><canvas ref={el => miniCurve(el, p.pts, '#a0a0a8')} /></button>)}
        </div>
        <div className="row"><span className="lbl">Tool</span><div className="ctl"><Seg options={['Edit', 'Draw', 'Steps']} value={['edit', 'draw', 'step'].indexOf(shUI.tool)} onChange={v => { shUI.tool = (['edit', 'draw', 'step'] as ShTool[])[v]; bumpSh(n => n + 1); }} /></div></div>
        <div className="row"><span className="lbl">Shape</span><div className="ctl shp-ops">{SHAPE_OPS.map(([l, t, f]) => <button key={l} className="btn sm" title={t} onClick={() => patch(s => { s.points = f(JSON.parse(JSON.stringify(s.points))); })}>{l}</button>)}</div></div>
        <div className="row"><span className="lbl">Show</span><div className="ctl shp-ops">
          <button className={`btn sm${shUI.wave ? ' on' : ''}`} title="Draw the music under one cycle behind the shape" onClick={() => { shUI.wave = !shUI.wave; bumpSh(n => n + 1); }}>Music</button>
          <button className={`btn sm${shUI.ghosts ? ' on' : ''}`} title="Show the other shapers faintly" onClick={() => { shUI.ghosts = !shUI.ghosts; bumpSh(n => n + 1); }}>Others</button>
          <button className="btn sm" title="Make the editor tall" onClick={() => ui.set(st => ({ sizes: { ...st.sizes, bottom: st.sizes.bottom > 480 ? 300 : 560 } }))}>Expand</button>
        </div></div>
        <div className="row"><span className="lbl">Mode</span><div className="ctl">
          <select className="sel" style={{ flex: 1 }} value={sh.mode} onChange={e => patch(s => { s.mode = e.target.value as ShaperData['mode']; if (s.mode !== 'sync' && sh.mode === 'sync') s.length = 0.5; if (s.mode === 'sync' && sh.mode !== 'sync') s.length = 1; })}>
            <option value="sync">Tempo sync</option><option value="free">Free (seconds)</option><option value="trigger">Audio trigger</option></select></div></div>
        <div className="row"><span className="lbl">Length</span><div className="ctl">
          {sh.mode === 'sync'
            ? <select className="sel" style={{ flex: 1 }} value={sh.length} onChange={e => patch(s => { s.length = +e.target.value; })}>
                {LENGTHS.map(([l, v]) => <option key={l} value={v}>{l}</option>)}{!LENGTHS.some(l => l[1] === sh.length) && <option value={sh.length}>{sh.length} beats</option>}</select>
            : <Num value={sh.length} min={0.02} max={8} step={0.01} unit="s" onChange={v => patch(s => { s.length = v; }, 'shl')} onCommit={() => project.commit()} />}</div></div>
        {sh.mode === 'trigger' && <>
          <div className="row"><span className="lbl">Source</span><div className="ctl"><select className="sel" style={{ flex: 1 }} value={sh.trig} onChange={e => patch(s => { s.trig = e.target.value as ShaperData['trig']; })}>
            {['kick', 'onset', 'bass', 'mid', 'high'].map(t => <option key={t}>{t}</option>)}</select></div></div>
          <div className="row"><span className="lbl">Threshold</span><div className="ctl"><Num value={sh.threshold} min={0} max={1} step={0.01} onChange={v => patch(s => { s.threshold = v; }, 'sht')} onCommit={() => project.commit()} /></div></div>
        </>}
        {sh.mode !== 'trigger' && <div className="row"><span className="lbl">Phase</span><div className="ctl"><Num value={sh.phase} min={0} max={1} step={0.01} onChange={v => patch(s => { s.phase = v; }, 'shp')} onCommit={() => project.commit()} /></div></div>}
        <div className="row"><span className="lbl">Smooth</span><div className="ctl"><Num value={sh.smooth} min={0} max={1} step={0.01} onChange={v => patch(s => { s.smooth = v; }, 'shs')} onCommit={() => project.commit()} /></div></div>
        <div className="row"><span className="lbl">Bipolar</span><div className="ctl"><Toggle on={sh.bipolar} onChange={v => patch(s => { s.bipolar = v; })} /></div></div>
        <div className="row"><span className="lbl"></span><div className="ctl"><button className="btn ghost" onClick={() => { project.tx(d => { d.shapers = d.shapers.filter(q => q.id !== sh.id); }); ui.set({ shaper: null }); }}>Delete shaper</button></div></div>
      </div>
    </div>
  );
}

type ShTool = 'edit' | 'draw' | 'step';
const shUI = { tool: 'edit' as ShTool, ghosts: true, wave: true };
/** Whole-shape edits, as in a hardware shaper: mirror, invert, repeat, randomise. */
const SHAPE_OPS: [string, string, (p: ShaperPoint[]) => ShaperPoint[]][] = [
  ['Flip ↔', 'Mirror in time', p => p.map((q, i) => ({ x: 1 - q.x, y: q.y, c: i > 0 ? -p[i - 1].c : 0 })).reverse().map((q, i, a) => ({ ...q, c: i < a.length - 1 ? a[i + 1].c : 0 }))],
  ['Flip ↕', 'Turn upside down', p => p.map(q => ({ ...q, y: 1 - q.y }))],
  ['×2', 'Play the shape twice per cycle', p => [...p.map(q => ({ ...q, x: q.x / 2 })), ...p.map(q => ({ ...q, x: 0.5 + q.x / 2 }))]],
  ['Random', 'Random steps on the grid', () => { const out: ShaperPoint[] = []; for (let i = 0; i < 8; i++) { const y = Math.round(Math.random() * 8) / 8; out.push({ x: i / 8, y, c: 0 }, { x: (i + 1) / 8, y, c: 0 }); } return out; }],
];

function ShaperCanvas({ id }: { id: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current!;
    const c = cv.getContext('2d')!;
    const PAD = 12;
    let drag: { k: 'pt'; i: number } | { k: 'bend'; i: number; y: number; c0: number } | { k: 'pen'; cells: Map<number, number>; last: number; orig: ShaperPoint[] } | null = null;
    let hover = -1;
    let wave: Float32Array | null = null, waveKey = '';
    const GRID = 16;
    /** Rebuild the shape from a pen stroke: painted grid cells replace what was there, the rest is kept. */
    const pen = (d: { cells: Map<number, number>; orig: ShaperPoint[] }) => mut(s => {
      const cs = [...d.cells.keys()].sort((a, b) => a - b), a = cs[0] / GRID, b = (cs[cs.length - 1] + 1) / GRID, out: ShaperPoint[] = d.orig.filter(p => p.x < a - 1e-6);
      if (!out.length || out[0].x > 0) out.unshift({ x: 0, y: shapeAt(d.orig, 0), c: 0 });
      for (const cn of cs) { const y = d.cells.get(cn)!; out.push({ x: cn / GRID, y, c: 0 }); if (shUI.tool === 'step') out.push({ x: (cn + 1) / GRID, y, c: 0 }); }
      if (shUI.tool === 'draw') out.push({ x: b, y: d.cells.get(cs[cs.length - 1])!, c: 0 });
      out.push(...d.orig.filter(p => p.x > b + 1e-6));
      if (out[out.length - 1].x < 1) out.push({ x: 1, y: shapeAt(d.orig, 1), c: 0 });
      out[0].x = 0; out[out.length - 1].x = 1;
      s.points = out.sort((p, q) => p.x - q.x);
    });
    const get = () => project.doc.shapers.find(s => s.id === id);
    const size = () => ({ w: cv.clientWidth - PAD * 2, h: cv.clientHeight - PAD * 2 });
    const toPx = (p: { x: number; y: number }) => { const { w, h } = size(); return { x: PAD + p.x * w, y: PAD + (1 - p.y) * h }; };
    const fromEv = (e: MouseEvent) => { const r = cv.getBoundingClientRect(); const { w, h } = size(); return { px: e.clientX - r.left, py: e.clientY - r.top, x: (e.clientX - r.left - PAD) / w, y: 1 - (e.clientY - r.top - PAD) / h }; };
    const hitPt = (px: number, py: number) => { const s = get(); if (!s) return -1; return s.points.findIndex(p => { const q = toPx(p); return Math.hypot(q.x - px, q.y - py) < 8; }); };
    const snap = (x: number, e: MouseEvent) => (e.shiftKey ? x : Math.round(x * 16) / 16);
    const snapY = (y: number, e: MouseEvent) => (e.shiftKey ? y : Math.round(y * 8) / 8);

    const draw = () => {
      const s = get(); if (!s) return;
      const dpr = devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
      if (!W || !H) return;
      if (cv.width !== Math.round(W * dpr)) cv.width = Math.round(W * dpr);
      if (cv.height !== Math.round(H * dpr)) cv.height = Math.round(H * dpr);
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.fillStyle = '#0b0b0d'; c.fillRect(0, 0, W, H);
      const { w, h } = size();
      for (let i = 0; i <= 16; i++) { const x = Math.round(PAD + (i / 16) * w) + 0.5; c.strokeStyle = i % 4 === 0 ? '#2a2a2f' : '#18181b'; c.beginPath(); c.moveTo(x, PAD); c.lineTo(x, PAD + h); c.stroke(); }
      for (let i = 0; i <= 4; i++) { const y = Math.round(PAD + (i / 4) * h) + 0.5; c.strokeStyle = i % 2 === 0 ? '#2a2a2f' : '#18181b'; c.beginPath(); c.moveTo(PAD, y); c.lineTo(PAD + w, y); c.stroke(); }
      // the music under one cycle, so the shape can be drawn against what it will hit
      if (shUI.wave && s.mode !== 'trigger') {
        const d = project.doc, a = d.audio.find(q => !q.clip) ?? d.audio[0], tr = a && engine.audio.tracks.get(a.id);
        if (tr) {
          const lenSec = s.mode === 'sync' ? (s.length * 60) / d.settings.bpm : s.length;
          const t = engine.time, cyc = s.mode === 'sync' ? Math.floor(((t - (d.settings.offset ?? 0)) * d.settings.bpm) / 60 / s.length - s.phase) : Math.floor(t / s.length - s.phase);
          const start = (s.mode === 'sync' ? (d.settings.offset ?? 0) : 0) + (cyc + s.phase) * lenSec - a.start;
          const key = `${a.id}:${cyc}:${w}:${s.length}:${s.mode}`;
          if (waveKey !== key) {
            waveKey = key; wave = new Float32Array(w * 2);
            const n = Math.max(1, Math.floor((lenSec * tr.sr) / w)), step = Math.max(1, Math.floor(n / 64));
            for (let i = 0; i < w; i++) { let lo = 0, hi = 0; const o = Math.floor((start + (i / w) * lenSec) * tr.sr); for (let k = 0; k < n; k += step) { const v = tr.mono[o + k] ?? 0; if (v < lo) lo = v; if (v > hi) hi = v; } wave[i * 2] = lo; wave[i * 2 + 1] = hi; }
          }
          c.fillStyle = 'rgba(108,192,139,0.22)';
          for (let i = 0; i < w; i++) { const lo = wave![i * 2], hi = wave![i * 2 + 1]; c.fillRect(PAD + i, PAD + h / 2 - hi * h * 0.48, 1, Math.max(1, (hi - lo) * h * 0.48)); }
        }
      }
      // the other shapers, faint, to line shapes up against each other
      if (shUI.ghosts) for (const o of project.doc.shapers) {
        if (o.id === s.id) continue;
        c.beginPath(); for (let i = 0; i <= w; i += 2) { const y = PAD + (1 - shapeAt(o.points, i / w)) * h; i ? c.lineTo(PAD + i, y) : c.moveTo(PAD, y); }
        c.strokeStyle = 'rgba(160,160,172,0.28)'; c.lineWidth = 1; c.stroke();
      }
      // filled curve
      c.beginPath(); c.moveTo(PAD, PAD + h);
      for (let i = 0; i <= w; i++) c.lineTo(PAD + i, PAD + (1 - shapeAt(s.points, i / w)) * h);
      c.lineTo(PAD + w, PAD + h); c.closePath(); c.fillStyle = 'rgba(230,180,80,0.09)'; c.fill();
      c.beginPath();
      for (let i = 0; i <= w; i++) { const y = PAD + (1 - shapeAt(s.points, i / w)) * h; i ? c.lineTo(PAD + i, y) : c.moveTo(PAD, y); }
      c.strokeStyle = '#e6b450'; c.lineWidth = 1.5; c.stroke();
      s.points.forEach((p, i) => { const q = toPx(p); c.fillStyle = i === hover ? '#fff' : '#0e0e10'; c.strokeStyle = '#e6b450'; c.lineWidth = 1.5; c.beginPath(); c.rect(q.x - 3.5, q.y - 3.5, 7, 7); c.fill(); c.stroke(); });
      // playhead + current value
      const ph = engine.shapers.phases.get(s.id) ?? 0;
      const x = PAD + ph * w, y = PAD + (1 - shapeAt(s.points, ph)) * h;
      c.strokeStyle = 'rgba(255,255,255,0.35)'; c.lineWidth = 1; c.beginPath(); c.moveTo(x + 0.5, PAD); c.lineTo(x + 0.5, PAD + h); c.stroke();
      c.fillStyle = '#fff'; c.beginPath(); c.arc(x, y, 3, 0, 7); c.fill();
      c.fillStyle = '#6f6f78'; c.font = '9.5px "Fragment Mono", ui-monospace, monospace'; c.textBaseline = 'top'; c.textAlign = 'right';
      c.fillText(`${s.name} = ${(engine.shapers.values.get(s.name) ?? 0).toFixed(3)}`, PAD + w - 4, PAD + 4);
      c.textAlign = 'left'; c.fillStyle = '#4c4c54';
      c.fillText(shUI.tool === 'edit' ? 'drag points · double-click add / remove · drag a segment to bend · shift = no snap' : shUI.tool === 'draw' ? 'drag to draw the shape on the 1/16 grid' : 'drag to paint held steps on the 1/16 grid', PAD + 4, PAD + 4);
    };
    const off = engine.onFrame(draw);
    const mut = (fn: (s: ShaperData) => void) => project.tx(d => { const s = d.shapers.find(q => q.id === id); if (s) fn(s); }, `shape:${id}`);

    const down = (e: PointerEvent) => {
      const s = get(); if (!s) return;
      const m = fromEv(e); try { cv.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ } project.commit();
      if (shUI.tool !== 'edit') { const cn = Math.min(GRID - 1, Math.max(0, Math.floor(m.x * GRID))), y = Math.min(1, Math.max(0, snapY(m.y, e))); drag = { k: 'pen', cells: new Map([[cn, y]]), last: cn, orig: JSON.parse(JSON.stringify(s.points)) }; pen(drag); return; }
      const i = hitPt(m.px, m.py);
      if (i >= 0) { drag = { k: 'pt', i }; return; }
      const seg = s.points.findIndex((p, k) => k < s.points.length - 1 && m.x >= p.x && m.x <= s.points[k + 1].x);
      if (seg >= 0) drag = { k: 'bend', i: seg, y: m.py, c0: s.points[seg].c };
    };
    const move = (e: PointerEvent) => {
      const m = fromEv(e);
      if (!drag) { hover = shUI.tool === 'edit' ? hitPt(m.px, m.py) : -1; cv.style.cursor = shUI.tool !== 'edit' ? 'cell' : hover >= 0 ? 'move' : 'ns-resize'; return; }
      const d = drag;
      if (d.k === 'pen') {
        const cn = Math.min(GRID - 1, Math.max(0, Math.floor(m.x * GRID))), y = Math.min(1, Math.max(0, snapY(m.y, e))), y0 = d.cells.get(d.last) ?? y, n = Math.abs(cn - d.last);
        for (let q = 0; q <= n; q++) d.cells.set(d.last + Math.sign(cn - d.last) * q, n ? y0 + (y - y0) * (q / n) : y);
        d.last = cn; pen(d); return;
      }
      if (d.k === 'pt') mut(s => {
        const p = s.points[d.i], last = s.points.length - 1;
        const lo = d.i === 0 ? 0 : s.points[d.i - 1].x, hi = d.i === last ? 1 : s.points[d.i + 1].x;
        p.x = d.i === 0 ? 0 : d.i === last ? 1 : Math.min(hi, Math.max(lo, snap(m.x, e)));
        p.y = Math.min(1, Math.max(0, snapY(m.y, e)));
      });
      else if (d.k === 'bend') mut(s => {
        const a = s.points[d.i], b = s.points[d.i + 1];
        const dir = b.y >= a.y ? 1 : -1;
        a.c = Math.min(1, Math.max(-1, d.c0 + ((m.py - d.y) / 90) * dir));
      });
    };
    const up = () => { drag = null; project.commit(); };
    const dbl = (e: MouseEvent) => {
      const s = get(); if (!s) return;
      const m = fromEv(e); const i = hitPt(m.px, m.py);
      project.commit();
      if (i > 0 && i < s.points.length - 1) mut(q => { q.points.splice(i, 1); });
      else if (i < 0 && m.x > 0 && m.x < 1) mut(q => { q.points.push({ x: snap(m.x, e), y: Math.min(1, Math.max(0, snapY(m.y, e))), c: 0 }); q.points.sort((a, b) => a.x - b.x); });
      project.commit();
    };
    cv.addEventListener('pointerdown', down); cv.addEventListener('pointermove', move); cv.addEventListener('pointerup', up); cv.addEventListener('dblclick', dbl);
    return () => { off(); cv.removeEventListener('pointerdown', down); cv.removeEventListener('pointermove', move); cv.removeEventListener('pointerup', up); cv.removeEventListener('dblclick', dbl); };
  }, [id]);
  return <div className="shp-edit"><canvas ref={ref} /></div>;
}
