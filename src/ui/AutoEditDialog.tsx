// Auto Edit dialog: a few big choices (style, pace, how much happens), then one button. Re-roll keeps the choices
// and draws a different cut.
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { project } from './state';
import { Seg, Toggle } from './Fields';
import { Icon } from './Icon';
import { autoEdit, DEFAULT_OPTIONS, footagePool, STYLES, type EditOptions } from './autoedit';
import { autoFrame } from './reframe';

let saved: EditOptions = { ...DEFAULT_OPTIONS };
const fmtDur = (x: number) => (x >= 60 ? `${Math.floor(x / 60)}:${String(Math.round(x % 60)).padStart(2, '0')}` : `${Math.round(x)} s`);

export function AutoEditDialog({ onClose }: { onClose(): void }) {
  const [o, setO] = useState<EditOptions>(saved);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const set = (p: Partial<EditOptions>) => { const n = { ...o, ...p }; saved = n; setO(n); };
  const pool = footagePool(project.doc), region = project.doc.region;
  const go = async (reroll: boolean) => {
    const opts = reroll ? { ...o, seed: o.seed + 1 } : o;
    if (reroll) set({ seed: opts.seed });
    setBusy(true); setMsg(null);
    try {
      const r = await autoEdit(opts, setStage);
      setMsg(r);
      // a narrow project needs the subjects found so the crop can follow them
      const s = project.doc.settings;
      if (r.ok && s.width / s.height < 1.3) { setStage('Finding the subject in each clip for the vertical crop…'); await autoFrame(); }
    } catch (e: any) { setMsg({ ok: false, text: String(e.message ?? e) }); }
    setBusy(false); setStage('');
  };
  const row = (label: string, ctl: React.ReactNode, help?: string) => (
    <div className="row" style={{ gridTemplateColumns: '120px 1fr', paddingRight: 14 }} title={help}><span className="lbl">{label}</span><div className="ctl">{ctl}</div></div>
  );
  return createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(4,4,6,0.6)', display: 'grid', placeItems: 'center' }} onPointerDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="pop" style={{ position: 'static', width: 470 }}>
        <div className="pane-tabs" style={{ height: 34, alignItems: 'center', padding: '0 12px', gap: 8 }}>
          <Icon n="cut" /><b style={{ fontSize: 12.5 }}>Auto Edit</b>
          <span className="mono dim" style={{ marginLeft: 'auto' }}>{pool.length ? `${pool.length} video${pool.length === 1 ? '' : 's'} · ${fmtDur(pool.reduce((a, p) => a + p.dur, 0))}` : 'no footage yet'}</span>
        </div>
        <div className="dim" style={{ padding: '10px 14px 4px', fontSize: 11, lineHeight: 1.5 }}>
          Cuts your footage to the song: every cut on the beat, short shots where it hits hard, longer ones in the breaks. One long video is enough: it finds the shots inside it and chops it up. Each clip gets an effect, a transition and sometimes a blend, and you can change any of them afterwards by right-clicking the clip.
        </div>
        <div style={{ padding: '6px 0 4px', opacity: busy ? 0.45 : 1, pointerEvents: busy ? 'none' : undefined }}>
          {row('Style', <Seg options={[...STYLES]} value={STYLES.indexOf(o.style)} onChange={i => set({ style: STYLES[i] })} />,
            'Psychedelic: trails, twins and moshes. Glitch: sorting, melts and hard moshes. Dreamy: soft trails and double exposures. Clean: mostly straight cuts.')}
          {row('Pace', <Seg options={['Slow', 'Medium', 'Fast']} value={o.pace} onChange={v => set({ pace: v })} />, 'How long shots last. Loud parts of the song always cut faster than quiet ones.')}
          {row('Effects', <Seg options={['Light', 'Medium', 'Heavy']} value={o.effects} onChange={v => set({ effects: v })} />, 'How many clips get an effect on the subject: twins, echoes, trails, duplicates, background melts.')}
          {row('Transitions', <Seg options={['Few', 'Some', 'Most']} value={o.transitions} onChange={v => set({ transitions: v })} />, 'How many cuts become datamosh transitions instead of straight cuts.')}
          {row('Blends', <><Toggle on={o.blends} onChange={v => set({ blends: v })} /><span className="dim">Mix in a second clip on some longer shots</span></>)}
          {region && row('Range', <><Toggle on={o.regionOnly} onChange={v => set({ regionOnly: v })} /><span className="dim">Only the marked region</span></>)}
        </div>
        <div className="dim" style={{ padding: '2px 14px 8px', fontSize: 10.5 }}>Replaces the timeline and the effects network. ⌘Z brings back what you had.</div>
        {(stage || msg) && <div style={{ padding: '8px 14px', borderTop: '1px solid #1c1c1f', fontSize: 11, color: msg && !msg.ok ? 'var(--err)' : undefined }}>{stage || msg?.text}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', padding: '10px 12px', borderTop: '1px solid #1c1c1f' }}>
          <button className="btn ghost" disabled={busy} onClick={onClose}>Close</button>
          {msg?.ok && <button className="btn" disabled={busy} onClick={() => void go(true)} title="Same settings, a different cut">Re-roll</button>}
          <button className="tool primary" disabled={busy || pool.length < 1} onClick={() => void go(false)}><Icon n="cut" />{msg?.ok ? 'Edit again' : 'Make the edit'}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
