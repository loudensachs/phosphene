// Modulation sources as things you can see and drag: every source is a live chip, and dropping one on a parameter
// connects it. The parameter then shows a coloured span for how far the source can push it.
import { getOp } from '../nerve/registry';
import { engine, project } from './state';
import { BAND_COLORS } from './Bands';

export interface Source { name: string; kind: 'audio' | 'band' | 'shaper' | 'signal'; color: string; value: number }
export const DRAG_TYPE = 'text/x-phosphene-source';
const AUDIO = ['kick', 'bass', 'mid', 'high', 'level'] as const;

export function modSources(): Source[] {
  const d = project.doc, out: Source[] = [];
  for (const n of AUDIO) out.push({ name: n, kind: 'audio', color: '#6cc08b', value: engine.audio.frame[n] });
  (d.bands ?? []).forEach((b, i) => out.push({ name: b.name, kind: 'band', color: BAND_COLORS[i % BAND_COLORS.length], value: engine.bandValues.get(b.name) ?? 0 }));
  for (const s of d.shapers) out.push({ name: s.name, kind: 'shaper', color: '#e6b450', value: engine.shapers.values.get(s.name) ?? 0 });
  for (const n of d.nodes) if (getOp(n.type)?.output === 'sig') out.push({ name: n.name, kind: 'signal', color: '#5a9bd8', value: engine.sigValue(n.id) });
  return out;
}
export function sourceColor(name: string): string {
  const d = project.doc;
  const bi = (d.bands ?? []).findIndex(b => b.name === name);
  if (bi >= 0) return BAND_COLORS[bi % BAND_COLORS.length];
  if (d.shapers.some(s => s.name === name)) return '#e6b450';
  if ((AUDIO as readonly string[]).includes(name)) return '#6cc08b';
  if (name.startsWith('cc(')) return '#d88aa8';
  return '#5a9bd8';
}
export function sourceValue(name: string): number { try { return engine.env(name); } catch { return 0; } }

const KIND_LABEL: Record<Source['kind'], string> = { audio: 'Audio', band: 'Bands', shaper: 'Shapers', signal: 'Signals' };

/** Strip of every modulation source with a live level. Drag a chip onto any numeric parameter. */
export function SourceStrip() {
  const all = modSources();
  const kinds = (['audio', 'band', 'shaper', 'signal'] as const).filter(k => all.some(s => s.kind === k));
  return (
    <div className="src-strip" title="Drag a source onto a parameter to modulate it">
      {kinds.map(k => (
        <div className="src-group" key={k}>
          <span className="src-kind">{KIND_LABEL[k]}</span>
          {all.filter(s => s.kind === k).map(s => (
            <span key={s.name} className="src-chip" draggable style={{ borderColor: s.color + '99' }}
              onDragStart={e => { e.dataTransfer.setData(DRAG_TYPE, s.name); e.dataTransfer.setData('text/plain', s.name); e.dataTransfer.effectAllowed = 'copy'; }}>
              <i style={{ width: `${Math.min(1, Math.max(0, Math.abs(s.value))) * 100}%`, background: s.color }} />
              <b>{s.name}</b>
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}
