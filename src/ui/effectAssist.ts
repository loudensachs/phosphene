// Effect assistant: turns a sentence into a chain of existing operators. It asks Claude (through the user's own
// `claude` command) for a plan, checks every operator, parameter and expression in it against what the engine really
// has, asks once for corrections if anything is off, and only then builds the chain as a single undo step.
import type { OpDef, ParamDef } from '../nerve/types';
import { allOps, getOp } from '../nerve/registry';
import { compileCached } from '../nerve/expr';
import { engine, project, ui } from './state';
import { host } from './host';

export const MODELS: { id: string; label: string; note: string }[] = [
  { id: 'claude-haiku-5-5', label: 'Haiku', note: 'Fastest. Fine for simple, concrete requests.' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet', note: 'Quick and capable.' },
  { id: 'claude-opus-5-5', label: 'Opus', note: 'Best balance of quality and speed.' },
  { id: 'claude-fable-5-2', label: 'Fable', note: 'Most capable, slowest.' },
];
/** A design plan is short structured output: deep thinking mostly adds waiting. */
const EFFORT = 'low';
const KEY = 'phos.ai.model';
export const getModel = () => { try { const m = localStorage.getItem(KEY); if (m && MODELS.some(x => x.id === m)) return m; } catch { /* storage unavailable */ } return 'claude-opus-5-5'; };
export const setModel = (id: string) => { try { localStorage.setItem(KEY, id); } catch { /* ignore */ } };

interface PlanParam { name: string; value: string; expr: boolean }
interface PlanNode { id: string; type: string; inputs: string[]; params: PlanParam[] }
interface Plan { summary: string; nodes: PlanNode[]; output: string }

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['summary', 'nodes', 'output'],
  properties: {
    summary: { type: 'string', description: 'One or two plain sentences telling the user what was built and which controls to try first.' },
    output: { type: 'string', description: 'id of the node whose result is the finished picture.' },
    nodes: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'type', 'inputs', 'params'],
        properties: {
          id: { type: 'string', description: 'Short unique id you invent, letters and digits.' },
          type: { type: 'string', description: 'Operator type from the catalogue, exactly as written there.' },
          inputs: { type: 'array', items: { type: 'string' }, description: 'One entry per input of the operator, in catalogue order: "SOURCE", another node id, or "" to leave it unconnected.' },
          params: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false, required: ['name', 'value', 'expr'],
              properties: {
                name: { type: 'string' },
                value: { type: 'string', description: 'A JSON literal (0.4, true, 2, [0.5,0.5], "text") or, when expr is true, an expression.' },
                expr: { type: 'boolean', description: 'true when value is an expression evaluated every frame.' },
              },
            },
          },
        },
      },
    },
  },
};

// operators that need files, hardware, a stage setup or code are left out: the assistant works with the picture it is given
const SKIP = new Set(['out', 'layer', 'movie', 'image', 'camera', 'wgsl', 'surface', 'meshwarp', 'edgeblend', 'testpattern', 'object3d', 'midicc', 'midinote', 'oscin', 'null', 'track', 'trackpoint', 'matte']);

function describe(p: ParamDef): string {
  const d = (p as any).def;
  switch (p.k) {
    case 'float': case 'int': return `${p.name}(${p.k} ${p.min ?? '-inf'}..${p.max ?? 'inf'} =${typeof d === 'number' ? +d.toFixed(4) : d}${(p as any).unit ? ' ' + (p as any).unit : ''})`;
    case 'bool': return `${p.name}(bool =${d})`;
    case 'enum': return `${p.name}(enum ${p.options.map((o, i) => `${i}:${o}`).join(' ')} =${d})`;
    case 'vec2': return `${p.name}(vec2 ${p.min ?? -1}..${p.max ?? 1} =[${d}])`;
    case 'color': return `${p.name}(color rgba 0..1 =[${(d as number[]).map(x => +x.toFixed(2))}])`;
    case 'string': return `${p.name}(string)`;
    default: return '';
  }
}
function catalogue(): string {
  const lines: string[] = [];
  for (const d of allOps()) {
    if (SKIP.has(d.type) || d.params.some(p => p.k === 'file')) continue;
    const ins = d.inputs.map(i => `${i.name}:${i.type}${i.optional ? '?' : ''}`).join(', ') || 'none';
    const ps = d.params.map(describe).filter(Boolean).join(' ');
    lines.push(`${d.type} — ${d.label} [${d.category}, out:${d.output}] in(${ins}) ${ps}${d.help ? ` // ${d.help.slice(0, 150)}` : ''}`);
  }
  return lines.join('\n');
}

const SYSTEM = `You design visual effects for Phosphene, a node-based video tool for music visuals. You are given a catalogue of operators and a request. Reply with a plan that wires existing operators into a chain that produces the requested look. You cannot invent operators or parameters: use only what the catalogue lists, spelled exactly.`;

function prompt(request: string, hasSource: boolean, previous?: { plan: Plan; problems: string[] }): string {
  const d = project.doc;
  const bands = (d.bands ?? []).map(b => b.name), shapers = d.shapers.map(s => s.name);
  return `REQUEST
${request}

PROJECT
- Picture source: ${hasSource ? 'there is footage or a picture feeding the output. Refer to it as "SOURCE".' : 'nothing feeds the output yet, so start from a generator operator (category Generate); "SOURCE" is not available.'}
- Tempo ${d.settings.bpm} BPM, ${d.settings.width}x${d.settings.height}, ${d.audio.length ? 'music is loaded' : 'no music loaded (audio names read as 0)'}.

HOW A PLAN WORKS
- nodes are created in the order you list them. Each node's inputs array has one entry per input of that operator, in the catalogue's order: "SOURCE", the id of an EARLIER node, or "" to leave an optional input unconnected. Required inputs (no "?") must be connected.
- Wire types: tex is a picture, field is motion vectors, sig is a number. A tex or field output can feed a tex or field input. sig outputs only feed sig inputs.
- output is the id of the node that produces the finished picture.
- params: only list parameters you change from the default. value is a JSON literal. Numbers are clamped to the range shown. For an enum give the index number.
- To animate a float or int parameter, set expr true and give an expression as value.

EXPRESSIONS
Variables: t (seconds), beat, bar, frame; audio 0..1: kick (decaying pulse on each kick), bass, mid, high, level, onset${bands.length ? `; music bands 0..1: ${bands.join(', ')}` : ''}${shapers.length ? `; shapers 0..1: ${shapers.join(', ')}` : ''}; song structure: energy (0..1 loudness of the current section), drop (1 in the loudest sections), section (index), secphase (0..1 through the section).
Functions: sin cos abs floor fract min max pow sqrt clamp(x,a,b) mix(a,b,t) smoothstep(a,b,x) mod(a,b) tri(x) noise(x). Operators + - * / % < > <= >= == != && || and cond ? a : b.
Keep expressions short, e.g. "0.2 + kick * 0.6", "beat * 15", "sin(t * 0.5) * 0.1".

FEEDBACK LOOPS (trails, tunnels, echoes)
The feedback operator outputs the previous frame of another node. Give it a string parameter source whose value is the id of a LATER node, usually the composite that closes the loop. Typical loop: feedback -> transform (scale a little above 1, slight rotate) -> levels (outWhite 0.85..0.95 so trails fade) -> comp with the incoming picture, then feedback.source = that comp's id. Use comp mode 9 (Lighten) so trails never pile up to white.

TASTE
- Real footage should stay recognisable unless the request asks for something abstract. Prefer four to eight operators. Do not stack several heavy blurs or glows.
- Tie movement to the music where the request mentions it: pulses on kick, slow drift on beat or t, bigger moves when drop is 1.
- Avoid blowing the picture out to white: keep bloom and glow intensities moderate and thresholds around 0.6.
- Feedback loops multiply brightness every frame. Never put bloom, glow, glowedge, neon or exposure inside a loop; put them after the loop's closing comp. Fade the loop with levels outWhite between 0.75 and 0.9.
- End colour-heavy chains with nothing that clips; a vignette or grain is fine.

CATALOGUE (type — Label [Category, output type] in(inputs) parameters // what it does)
${catalogue()}
${previous ? `
YOUR PREVIOUS PLAN
${JSON.stringify(previous.plan)}

It had these problems. Return a complete corrected plan, keeping what was fine:
${previous.problems.map(p => `- ${p}`).join('\n')}` : ''}`;
}

/** Check a plan against the real operators. Returns the problems found; an empty list means it can be built as is. */
function check(plan: Plan, hasSource: boolean): string[] {
  const probs: string[] = [], seen = new Set<string>(), all = new Set(plan.nodes.map(n => n.id));
  if (!plan.nodes.length) return ['The plan has no nodes.'];
  for (const n of plan.nodes) {
    const def = getOp(n.type);
    if (!def || SKIP.has(n.type)) { probs.push(`Node ${n.id}: there is no operator of type "${n.type}".`); seen.add(n.id); continue; }
    def.inputs.forEach((inp, i) => {
      const src = n.inputs[i] ?? '';
      if (!src) { if (!inp.optional) probs.push(`Node ${n.id} (${n.type}): required input "${inp.name}" is not connected.`); return; }
      if (src === 'SOURCE') { if (!hasSource) probs.push(`Node ${n.id}: "SOURCE" is not available in this project; start from a generator.`); return; }
      if (!seen.has(src)) probs.push(`Node ${n.id}: input "${inp.name}" refers to "${src}", which is not an earlier node.`);
      else { const sd = getOp(plan.nodes.find(q => q.id === src)!.type); if (sd && (sd.output === 'sig') !== (inp.type === 'sig')) probs.push(`Node ${n.id}: input "${inp.name}" is ${inp.type} but "${src}" outputs ${sd.output}.`); }
    });
    for (const p of n.params) {
      const pd = def.params.find(q => q.name === p.name);
      if (!pd) { probs.push(`Node ${n.id} (${n.type}): no parameter "${p.name}". It has: ${def.params.map(q => q.name).join(', ')}.`); continue; }
      if (p.expr) {
        if (pd.k !== 'float' && pd.k !== 'int') { probs.push(`Node ${n.id}: "${p.name}" is ${pd.k} and cannot take an expression.`); continue; }
        const c = compileCached(p.value);
        if (c.err || !c.fn) { probs.push(`Node ${n.id}: expression for "${p.name}" does not parse (${c.err}): ${p.value}`); continue; }
        try { c.fn(engine.env); } catch (e: any) { probs.push(`Node ${n.id}: expression for "${p.name}" fails (${e.message}): ${p.value}`); }
      } else if (pd.k === 'string' && p.name === 'source') {
        const v = unquote(p.value);
        if (v && !all.has(v)) probs.push(`Node ${n.id}: source "${v}" is not a node id in the plan.`);
      } else if (pd.k !== 'string') {
        try { JSON.parse(p.value); } catch { probs.push(`Node ${n.id}: value for "${p.name}" is not a JSON literal: ${p.value}`); }
      }
    }
    seen.add(n.id);
  }
  if (!all.has(plan.output)) probs.push(`output "${plan.output}" is not a node id.`);
  else if (getOp(plan.nodes.find(n => n.id === plan.output)!.type)?.output === 'sig') probs.push('output must be a picture, not a signal.');
  return probs;
}
const unquote = (s: string) => { try { const v = JSON.parse(s); return typeof v === 'string' ? v : s; } catch { return s; } };
const num = (v: any, lo?: number, hi?: number) => Math.min(hi ?? Infinity, Math.max(lo ?? -Infinity, +v));

/** Build a checked plan after whatever currently feeds Out. Anything still wrong is skipped rather than guessed. */
function build(plan: Plan): { made: number; skipped: string[] } {
  const skipped: string[] = [];
  let made = 0;
  project.batch(() => {
    const out = project.doc.nodes.find(n => n.type === 'out');
    if (!out) { skipped.push('There is no Out operator.'); return; }
    const source = project.inputOf(out.id, 0)?.from ?? null;
    const anchor = source ? project.node(source)! : out;
    const ids = new Map<string, string>(), names = new Map<string, string>();
    let x = anchor.x + (source ? 210 : -200 * plan.nodes.length - 60);
    const y0 = anchor.y + (source ? 0 : 0);
    plan.nodes.forEach((pn, i) => {
      const def = getOp(pn.type);
      if (!def || SKIP.has(pn.type)) { skipped.push(`${pn.type}: no such operator`); return; }
      // side branches (anything that is not on the main line into the next node) drop to a second row
      const feedsNext = plan.nodes[i + 1]?.inputs[0] === pn.id || pn.id === plan.output;
      const n = project.addNode(pn.type, x, feedsNext ? y0 : y0 + 190);
      if (!n) return;
      let k = 1; while (!project.rename(n.id, `ai_${pn.type}${k}`) && k < 99) k++;
      ids.set(pn.id, n.id); names.set(pn.id, project.node(n.id)!.name);
      x += 195; made++;
    });
    for (const pn of plan.nodes) {
      const id = ids.get(pn.id), def = getOp(pn.type) as OpDef | undefined;
      if (!id || !def) continue;
      def.inputs.forEach((_, i) => {
        const s = pn.inputs[i];
        const from = s === 'SOURCE' ? source : s ? ids.get(s) : null;
        if (from && !project.connect(from, id, i)) skipped.push(`${pn.type}: could not connect input ${i + 1}`);
      });
      for (const p of pn.params) {
        const pd = def.params.find(q => q.name === p.name);
        if (!pd) { skipped.push(`${pn.type}.${p.name}: no such parameter`); continue; }
        try {
          if (p.expr) {
            if ((pd.k === 'float' || pd.k === 'int') && compileCached(p.value).fn) project.patchParam(id, p.name, s => { s.ex = [p.value]; });
            else skipped.push(`${pn.type}.${p.name}: expression not usable`);
            continue;
          }
          if (pd.k === 'string') { const v = unquote(p.value); project.setParam(id, p.name, p.name === 'source' ? names.get(v) ?? '' : v, false); continue; }
          const v = JSON.parse(p.value);
          if (pd.k === 'float') project.setParam(id, p.name, num(v, pd.min, pd.max), false);
          else if (pd.k === 'int') project.setParam(id, p.name, Math.round(num(v, pd.min, pd.max)), false);
          else if (pd.k === 'bool') project.setParam(id, p.name, !!v, false);
          else if (pd.k === 'enum') { const idx = typeof v === 'string' ? pd.options.findIndex(o => o.toLowerCase() === v.toLowerCase()) : Math.round(+v); if (idx >= 0 && idx < pd.options.length) project.setParam(id, p.name, idx, false); else skipped.push(`${pn.type}.${p.name}: no option ${p.value}`); }
          else if (pd.k === 'vec2' && Array.isArray(v) && v.length >= 2) project.setParam(id, p.name, [num(v[0], pd.min, pd.max), num(v[1], pd.min, pd.max)], false);
          else if (pd.k === 'color' && Array.isArray(v) && v.length >= 3) project.setParam(id, p.name, [+v[0], +v[1], +v[2], v[3] === undefined ? 1 : +v[3]], false);
          else skipped.push(`${pn.type}.${p.name}: value not usable`);
        } catch { skipped.push(`${pn.type}.${p.name}: value not usable`); }
      }
    }
    const last = ids.get(plan.output);
    if (last && project.connect(last, out.id, 0)) { project.moveNodes([{ id: out.id, x: x + 10, y: y0 }]); project.setDisplay(out.id); }
    else skipped.push('The finished picture could not be connected to Out.');
    ui.set({ sel: [...ids.values()] });
  });
  return { made, skipped };
}

interface Look { clipped: number; dark: number; mean: number; kept: number }
let probe: { cv: HTMLCanvasElement; ctx: GPUCanvasContext; rd: CanvasRenderingContext2D } | null = null;
/** 48x27 display-referred luma of an operator's output. */
function lumaOf(id: string): Float32Array | null {
  if (!engine.viewOf(id)) return null;
  if (!probe) {
    const cv = document.createElement('canvas'); cv.width = 48; cv.height = 27;
    const rc = document.createElement('canvas'); rc.width = 48; rc.height = 27;
    probe = { cv, ctx: engine.configure(cv), rd: rc.getContext('2d', { willReadFrequently: true })! };
  }
  engine.present(probe.ctx, id, { exposure: 0, mode: 0, tonemap: true });
  probe.rd.clearRect(0, 0, 48, 27); probe.rd.drawImage(probe.cv, 0, 0);
  const px = probe.rd.getImageData(0, 0, 48, 27).data, out = new Float32Array(48 * 27);
  for (let i = 0; i < out.length; i++) out[i] = (0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2]) / 255;
  return out;
}
/** Run the effect for a moment and measure it: how much is blown out or black, and how much of the source's shapes survive. */
async function measure(source: string | null): Promise<Look | null> {
  const out = project.doc.nodes.find(n => n.type === 'out');
  if (!out) return null;
  const was = engine.playing, t0 = engine.time, fps = project.doc.settings.fps;
  engine.pause(); engine.exporting = true;
  const acc: Look[] = [];
  try {
    for (let f = 0; f < 72; f++) {
      const t = t0 + f / fps;
      await engine.prepFrame(t); engine.cookFrame(t, 1 / fps);
      if (f % 12 !== 11) continue;
      await engine.gpu.device.queue.onSubmittedWorkDone();
      const o = lumaOf(out.id), s = source ? lumaOf(source) : null;
      if (!o) continue;
      let clip = 0, dark = 0, mean = 0;
      for (const v of o) { if (v > 0.93) clip++; if (v < 0.04) dark++; mean += v; }
      // shape kept: correlation of local contrast (gradients) between source and result
      let kept = 1;
      if (s) {
        const grad = (a: Float32Array) => { const g = new Float32Array(47 * 26); for (let y = 0; y < 26; y++) for (let x = 0; x < 47; x++) { const i = y * 48 + x; g[y * 47 + x] = Math.abs(a[i + 1] - a[i]) + Math.abs(a[i + 48] - a[i]); } return g; };
        const A = grad(o), B = grad(s); let ma = 0, mb = 0; for (let i = 0; i < A.length; i++) { ma += A[i]; mb += B[i]; } ma /= A.length; mb /= B.length;
        let num = 0, da = 0, db = 0; for (let i = 0; i < A.length; i++) { const x = A[i] - ma, y = B[i] - mb; num += x * y; da += x * x; db += y * y; }
        kept = da > 1e-9 && db > 1e-9 ? num / Math.sqrt(da * db) : 0;
      }
      acc.push({ clipped: clip / o.length, dark: dark / o.length, mean: mean / o.length, kept });
    }
  } finally { engine.exporting = false; engine.seek(t0); if (was) engine.play(); }
  if (!acc.length) return null;
  const avg = (k: keyof Look) => acc.reduce((a, b) => a + b[k], 0) / acc.length;
  return { clipped: avg('clipped'), dark: avg('dark'), mean: avg('mean'), kept: avg('kept') };
}
const keepsFootage = (request: string, hasSource: boolean) => hasSource && !/abstract|kaleido|unrecognis|unrecogniz|fractal|melt everything|destroy|replace the footage/i.test(request);

/** Put the built chain under one Amount control: a blend of the effect over the untouched footage. */
function wrapInMix(): string | null {
  const out = project.doc.nodes.find(n => n.type === 'out');
  const last = out && project.inputOf(out.id, 0)?.from;
  const ai = project.doc.nodes.filter(n => n.name.startsWith('ai_'));
  if (!out || !last || !ai.length) return null;
  // the footage is whatever feeds the first ai_ operator from outside the chain
  const aiIds = new Set(ai.map(n => n.id));
  const feed = project.doc.conns.find(c => aiIds.has(c.to) && !aiIds.has(c.from));
  if (!feed) return null;
  let id: string | null = null;
  project.batch(() => {
    const m = project.addNode('comp', out.x, out.y + 150);
    if (!m) return;
    let k = 1; while (!project.rename(m.id, k === 1 ? 'ai_amount' : `ai_amount${k}`) && k < 20) k++;
    project.connect(feed.from, m.id, 0); project.connect(last, m.id, 1); project.connect(m.id, out.id, 0);
    project.setParam(m.id, 'mode', 0, false); project.setParam(m.id, 'opacity', 1, false);
    project.moveNodes([{ id: m.id, x: out.x, y: out.y }, { id: out.id, x: out.x + 195, y: out.y }]);
    id = m.id;
  });
  return id;
}

function lookProblems(l: Look, request: string, hasSource: boolean, mixed = false): string[] {
  const p: string[] = [];
  const keep = keepsFootage(request, hasSource);
  if (l.clipped > 0.12) p.push(`When rendered, ${Math.round(l.clipped * 100)}% of the frame is blown out to white. Bring brightness down: lower glow, bloom and feedback gain, raise thresholds, fade trails faster.`);
  if (l.dark > 0.7) p.push(`When rendered, ${Math.round(l.dark * 100)}% of the frame is black. The effect is hiding the picture; brighten it or blend the source back in.`);
  if (keep && l.kept < 0.3 && !mixed) p.push(`When rendered, the shapes of the original footage are mostly gone (match ${l.kept.toFixed(2)} on a 0 to 1 scale, aim for above 0.4). Keep the footage recognisable: blend the effect over the source rather than replacing it, or reduce distortion.`);
  return p;
}

export interface AssistResult { ok: boolean; text: string; detail?: string }
/** Ask for an effect and build it. `onStage` reports progress in plain words. */
export async function askForEffect(request: string, model: string, onStage: (s: string) => void): Promise<AssistResult> {
  if (!host.native) return { ok: false, text: 'The assistant needs the desktop app.' };
  const out = project.doc.nodes.find(n => n.type === 'out');
  if (!out) return { ok: false, text: 'Add an Out operator first.' };
  const hasSource = !!project.inputOf(out.id, 0);
  const label = MODELS.find(m => m.id === model)?.label ?? model;
  onStage(`Asking ${label}…`);
  let r = await host.aiRun({ model, effort: EFFORT, system: SYSTEM, prompt: prompt(request, hasSource), schema: SCHEMA });
  if (!r.ok || !r.data) return { ok: false, text: r.error ?? 'No answer came back.' };
  let plan = r.data as Plan;
  let problems = check(plan, hasSource);
  if (problems.length) {
    onStage(`Checking the plan: fixing ${problems.length} problem${problems.length > 1 ? 's' : ''}…`);
    const r2 = await host.aiRun({ model, effort: EFFORT, system: SYSTEM, prompt: prompt(request, hasSource, { plan, problems }), schema: SCHEMA });
    if (r2.ok && r2.data) { const p2 = r2.data as Plan, pr2 = check(p2, hasSource); if (pr2.length <= problems.length) { plan = p2; problems = pr2; } }
  }
  if (!plan.nodes.some(n => getOp(n.type))) return { ok: false, text: 'The plan used operators that do not exist, so nothing was built.', detail: problems.join('\n') };
  onStage('Building…');
  const mark = project.undoMark();
  const source = project.inputOf(out.id, 0)?.from ?? null;
  let b = build(plan);
  if (!b.made) return { ok: false, text: 'Nothing could be built from the plan.', detail: b.skipped.join('\n') };
  // look at what was built: if it is blown out, black or has lost the footage, say so with numbers and rebuild once
  onStage('Looking at the result…');
  let look = await measure(source), lp = look ? lookProblems(look, request, hasSource) : [];
  let revised = false;
  if (lp.length) {
    onStage('Adjusting what it saw…');
    const r3 = await host.aiRun({ model, effort: EFFORT, system: SYSTEM, prompt: prompt(request, hasSource, { plan, problems: lp }), schema: SCHEMA });
    if (r3.ok && r3.data && !check(r3.data as Plan, hasSource).length) {
      project.undo();
      const b2 = build(r3.data as Plan);
      const look2 = b2.made ? await measure(source) : null;
      const worse = (l: Look) => lookProblems(l, request, hasSource).length * 10 + l.clipped * 5 + (hasSource ? Math.max(0, 0.4 - l.kept) : 0);
      if (b2.made && look2 && worse(look2) < worse(look!)) { plan = r3.data as Plan; b = b2; look = look2; lp = lookProblems(look2, request, hasSource); revised = true; }
      else { project.undo(); b = build(plan); }
    }
  }
  // keep the footage readable: blend the effect back toward the clean picture until its shapes come through
  let amount = 1;
  if (look && keepsFootage(request, hasSource) && look.kept < 0.4) {
    onStage('Balancing the effect against the footage…');
    const mix = wrapInMix();
    if (mix) {
      let best = { a: 1, look: look! };
      for (const a of [0.7, 0.55, 0.42, 0.32]) {
        project.setParam(mix, 'opacity', a, false);
        const l = await measure(source);
        if (!l) break;
        best = { a, look: l };
        if (l.kept >= 0.4) break;
      }
      project.setParam(mix, 'opacity', best.a, false); project.commit();
      amount = best.a; look = best.look; lp = lookProblems(best.look, request, hasSource, true);
    }
  }
  project.squash(mark);
  const notes = [...new Set(b.skipped)];
  ui.set({ status: `Assistant built ${b.made} operator${b.made > 1 ? 's' : ''}. Undo removes them in one step.` });
  const seen = look ? `\nRendered: ${Math.round(look.clipped * 100)}% blown out${hasSource ? `, footage match ${look.kept.toFixed(2)}` : ''}${revised ? ' (adjusted once after looking)' : ''}${amount < 1 ? `. Effect amount set to ${Math.round(amount * 100)}% on ai_amount so the footage shows through; raise its opacity for more` : ''}${lp.length ? `. Still: ${lp[0].split('.')[0].toLowerCase()}` : ''}` : '';
  return { ok: true, text: plan.summary, detail: `${b.made} operators · ${label}${seen}${notes.length ? `\nLeft out: ${notes.slice(0, 5).join('; ')}` : ''}` };
}
