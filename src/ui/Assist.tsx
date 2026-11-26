// The effect assistant's whole interface: a sparkle button, a box to type in, and a model switch. Nothing else.
import { useEffect, useRef, useState } from 'react';
import { Pop } from './Fields';
import { Icon } from './Icon';
import { host } from './host';
import { MODELS, askForEffect, getModel, setModel, type AssistResult } from './effectAssist';

const history: string[] = [];

export function AssistButton() {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  return (
    <>
      <button className={`tool icon-only${at ? ' on' : ''}`} title="Describe an effect and have it built from operators"
        onClick={e => { const r = e.currentTarget.getBoundingClientRect(); setAt(at ? null : { x: r.left, y: r.bottom + 4 }); }}><Icon n="sparkle" /></button>
      {at && <Panel x={at.x} y={at.y} onClose={() => setAt(null)} />}
    </>
  );
}

function Panel({ x, y, onClose }: { x: number; y: number; onClose(): void }) {
  const [text, setText] = useState('');
  const [model, pick] = useState(getModel());
  const [stage, setStage] = useState<string | null>(null);
  const [res, setRes] = useState<AssistResult | null>(null);
  const [secs, setSecs] = useState(0);
  const box = useRef<HTMLTextAreaElement>(null);
  const busy = stage !== null;
  useEffect(() => { const t = setTimeout(() => box.current?.focus(), 30); return () => clearTimeout(t); }, []);
  useEffect(() => { if (!busy) return; const t0 = performance.now(); const id = setInterval(() => setSecs(Math.round((performance.now() - t0) / 1000)), 500); return () => clearInterval(id); }, [busy]);
  const go = async () => {
    const q = text.trim();
    if (!q || busy) return;
    if (history[0] !== q) history.unshift(q);
    setRes(null); setSecs(0); setStage('Starting…');
    const r = await askForEffect(q, model, setStage);
    setStage(null); setRes(r);
    if (r.ok) setText('');
  };
  const available = host.native && host.aiAvailable();
  return (
    <Pop x={x} y={y} onClose={() => { if (!busy) onClose(); }} className="assist">
      <textarea ref={box} value={text} disabled={busy} spellCheck={false} placeholder="Describe an effect…  e.g. glitchy neon trails that pulse on the kick"
        onChange={e => setText(e.target.value)}
        onKeyDown={e => {
          e.stopPropagation();
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void go(); }
          else if (e.key === 'ArrowUp' && !text && history.length) setText(history[0]);
          else if (e.key === 'Escape' && !busy) onClose();
        }} />
      <div className="assist-bar">
        <div className="assist-models" title="Which Claude model answers">
          {MODELS.map(m => <button key={m.id} className={m.id === model ? 'on' : ''} disabled={busy} title={m.note} onClick={() => { pick(m.id); setModel(m.id); }}>{m.label}</button>)}
        </div>
        {busy
          ? <button className="btn sm" onClick={() => host.aiCancel()}>Cancel</button>
          : <button className="btn sm" disabled={!text.trim() || !available} onClick={() => void go()}>Build<span className="kbd">↩</span></button>}
      </div>
      {busy && <div className="assist-note"><i className="assist-spin" />{stage}<span>{secs}s</span></div>}
      {!busy && !available && <div className="assist-note bad">The claude command was not found. Install Claude Code and sign in to use this.</div>}
      {res && <div className={`assist-note${res.ok ? '' : ' bad'}`}><div>{res.text}{res.detail && <em>{res.detail}</em>}</div></div>}
    </Pop>
  );
}
