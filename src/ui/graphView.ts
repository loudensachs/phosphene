// What the network editor shows: grouped nodes fold into one box per group, and wires into or out of a group are
// redrawn to that box. Inside a group only its own nodes are shown.
import type { Conn, Doc, Group, NodeData, OpDef } from '../nerve/types';
import { getOp } from '../nerve/registry';
import { uid } from '../nerve/project';
import { project } from './state';
import { slotGate } from '../nerve/clipfx';

export const GROUP_PREFIX = 'g:';
export const isGroupId = (id: string) => id.startsWith(GROUP_PREFIX);
export const groupOf = (id: string): Group | undefined => project.doc.groups?.find(g => GROUP_PREFIX + g.id === id);

export interface GraphView {
  nodes: NodeData[];
  conns: Conn[];
  defOf(id: string): OpDef | undefined;
  /** The real node whose picture represents this box (itself, or the group's output). */
  real(id: string): string;
}

let cache: { rev: number; key: string | null; v: GraphView } | null = null;

export function graphView(doc: Doc, inside: string | null): GraphView {
  if (cache && cache.rev === project.rev && cache.key === inside) return cache.v;
  const groups = doc.groups ?? [], live = new Set(groups.map(g => g.id));
  const groupIdOf = (n: NodeData | undefined) => (n?.group && live.has(n.group) ? n.group : null);
  const byId = new Map(doc.nodes.map(n => [n.id, n]));
  const defs = new Map<string, OpDef | undefined>();
  const real = new Map<string, string>();
  let nodes: NodeData[], conns: Conn[];
  if (inside && live.has(inside)) {
    nodes = doc.nodes.filter(n => n.group === inside);
    const ids = new Set(nodes.map(n => n.id));
    conns = doc.conns.filter(c => ids.has(c.from) && ids.has(c.to));
    for (const n of nodes) { defs.set(n.id, getOp(n.type)); real.set(n.id, n.id); }
  } else {
    nodes = doc.nodes.filter(n => !groupIdOf(n));
    for (const n of nodes) { defs.set(n.id, getOp(n.type)); real.set(n.id, n.id); }
    const vis = (id: string) => { const g = groupIdOf(byId.get(id)); return g ? GROUP_PREFIX + g : id; };
    for (const g of groups) {
      const members = doc.nodes.filter(n => n.group === g.id);
      if (!members.length) continue;
      const ms = new Set(members.map(n => n.id));
      const sources: string[] = [];
      for (const c of doc.conns) if (ms.has(c.to) && !ms.has(c.from)) { const v = vis(c.from); if (!sources.includes(v)) sources.push(v); }
      const outer = doc.conns.find(c => ms.has(c.from) && !ms.has(c.to));
      const outId = outer?.from ?? members.filter(n => getOp(n.type)?.output !== 'sig').pop()?.id ?? members[0].id;
      const vid = GROUP_PREFIX + g.id;
      nodes.push({ id: vid, type: '__group', name: g.name, x: g.x, y: g.y, params: {} });
      defs.set(vid, {
        type: '__group', label: `${members.length} operators`, category: 'Group' as any, output: getOp(byId.get(outId)!.type)?.output ?? 'tex',
        inputs: sources.slice(0, 8).map(s => ({ name: byId.get(s)?.name ?? groups.find(q => GROUP_PREFIX + q.id === s)?.name ?? 'in', type: 'tex' as const })), params: [],
      });
      real.set(vid, outId);
    }
    const seen = new Set<string>();
    conns = [];
    for (const c of doc.conns) {
      const f = vis(c.from), t = vis(c.to);
      if (f === t) continue;
      let slot = c.slot;
      if (isGroupId(t)) { slot = defs.get(t)!.inputs.findIndex(i => i.name === (byId.get(f)?.name ?? groups.find(q => GROUP_PREFIX + q.id === f)?.name)); if (slot < 0) continue; }
      const k = `${f}>${t}:${slot}`;
      if (seen.has(k)) continue;
      seen.add(k); conns.push({ from: f, to: t, slot });
    }
  }
  const v: GraphView = { nodes, conns, defOf: id => defs.get(id), real: id => real.get(id) ?? id };
  cache = { rev: project.rev, key: inside, v };
  return v;
}

// ---------------- actions ----------------
export function makeGroup(ids: string[], name?: string, exposed: Group['exposed'] = []): string | null {
  const nodes = project.doc.nodes.filter(n => ids.includes(n.id) && !n.group);
  if (nodes.length < 1) return null;
  const gid = uid('grp');
  const x = Math.round(nodes.reduce((a, n) => a + n.x, 0) / nodes.length), y = Math.round(nodes.reduce((a, n) => a + n.y, 0) / nodes.length);
  const taken = new Set((project.doc.groups ?? []).map(g => g.name));
  let nm = name ?? 'group1', k = 1; while (taken.has(nm)) nm = `${name ?? 'group'}${++k}`;
  project.tx(d => {
    (d.groups ??= []).push({ id: gid, name: nm, x, y, exposed });
    for (const n of d.nodes) if (nodes.some(q => q.id === n.id)) n.group = gid;
  }, undefined, true);
  return GROUP_PREFIX + gid;
}
export function ungroup(vid: string) {
  const g = groupOf(vid);
  if (!g) return;
  project.tx(d => { d.groups = (d.groups ?? []).filter(q => q.id !== g.id); for (const n of d.nodes) if (n.group === g.id) delete n.group; }, undefined, true);
}
export function exposeParam(nodeId: string, param: string, on = true) {
  const n = project.node(nodeId);
  if (!n?.group) return;
  project.tx(d => {
    const g = d.groups?.find(q => q.id === n.group);
    if (!g) return;
    g.exposed = g.exposed.filter(e => !(e.node === n.name && e.param === param));
    if (on) g.exposed.push({ node: n.name, param });
  });
}

/** Lay out what is on screen left to right by data flow: each operator one column after the furthest thing feeding it. */
export function tidy(inside: string | null) {
  const gv = graphView(project.doc, inside);
  const ids = gv.nodes.map(n => n.id), into = new Map<string, string[]>(), outOf = new Map<string, string[]>();
  for (const c of gv.conns) { (into.get(c.to) ?? into.set(c.to, []).get(c.to)!).push(c.from); (outOf.get(c.from) ?? outOf.set(c.from, []).get(c.from)!).push(c.to); }
  const col = new Map<string, number>();
  const depth = (id: string, seen = new Set<string>()): number => {
    if (col.has(id)) return col.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const d = Math.max(-1, ...(into.get(id) ?? []).map(f => depth(f, seen))) + 1;
    col.set(id, d); return d;
  };
  for (const id of ids) depth(id);
  // loose signal operators (read by name, not wired) stack up in their own column on the left
  const loose = gv.nodes.filter(n => !into.has(n.id) && !outOf.has(n.id) && gv.defOf(n.id)?.output === 'sig');
  const cols = new Map<number, string[]>();
  for (const n of gv.nodes) { if (loose.includes(n)) continue; const c = col.get(n.id)!; (cols.get(c) ?? cols.set(c, []).get(c)!).push(n.id); }
  // order each column by the average row of what feeds it, so wires cross less
  const row = new Map<string, number>();
  const moves: { id: string; x: number; y: number }[] = [];
  const maxCol = Math.max(0, ...cols.keys());
  for (let c = 0; c <= maxCol; c++) {
    const list = cols.get(c) ?? [];
    list.sort((a, b) => avg(a) - avg(b));
    list.forEach((id, r) => { row.set(id, r); moves.push({ id, x: 220 + c * 210, y: r * 190 - (list.length - 1) * 95 }); });
  }
  function avg(id: string) { const f = (into.get(id) ?? []).map(q => row.get(q) ?? 0); return f.length ? f.reduce((a, b) => a + b, 0) / f.length : 0; }
  loose.forEach((n, i) => moves.push({ id: n.id, x: -40, y: 260 + i * 70 }));
  project.moveNodes(moves, 'tidy');
  project.commit();
}

/**
 * Turns an operator's outgoing wires into a Global: the operator moves aside and feeds a new Global, and a Get Global
 * takes its old place with every connection it had. Nothing has to be wired across the network any more.
 */
export function makeGlobal(id: string): string | null {
  const n = project.node(id);
  if (!n || isGroupId(id) || n.type === 'global' || n.type === 'getglobal') return null;
  const outs = project.doc.conns.filter(c => c.from === id);
  const taken = new Set(project.doc.nodes.map(q => q.name));
  let gname = `${n.name}_global`, k = 2; while (taken.has(gname)) gname = `${n.name}_global${k++}`;
  const P = { x: n.x, y: n.y };
  let gid: string | null = null;
  project.batch(() => {
    // the operator moves down into clear space below everything in its column, its Global beside it
    const hOf = (q: NodeData) => (q.type === 'global' || q.type === 'getglobal' ? 26 : getOp(q.type)?.output === 'sig' ? 56 : 125);
    const below = project.doc.nodes.filter(q => q.id !== id && !q.group === !n.group && q.x < P.x + 400 && q.x + 152 > P.x - 20 && q.y + hOf(q) > P.y);
    const newY = Math.max(P.y + 250, ...below.map(q => q.y + hOf(q) + 70));
    if (outs.length) project.moveNodes([{ id, x: P.x, y: newY }], 'mkglobal');
    // pills sit level with the operator's output port (card body centre)
    const g = project.addNode('global', P.x + 190, (outs.length ? newY : P.y) + 49)!;
    project.rename(g.id, gname);
    project.connect(id, g.id, 0);
    gid = g.id;
    if (outs.length) {
      const get = project.addNode('getglobal', P.x + 24, P.y + 49)!;
      let rn = `get_${gname}`, j = 2; while (project.doc.nodes.some(q => q.name === rn && q.id !== get.id)) rn = `get_${gname}${j++}`;
      project.rename(get.id, rn);
      project.setParam(get.id, 'global', gname, false);
      for (const c of outs) { project.disconnect(c.to, c.slot); project.connect(get.id, c.to, c.slot); }
      if (project.doc.display === id) project.setDisplay(id);
    }
    if (n.group) project.tx(d => { for (const q of d.nodes) if (q.id === gid || (outs.length && q.name.startsWith('get_' + gname))) q.group = n.group; });
  });
  return gid;
}

/** The gate composite an operator feeds when it is a clip effect, if any. */
export function clipGateOf(id: string) {
  const outs = project.doc.conns.filter(c => c.from === id && c.slot === 1).map(c => project.node(c.to));
  return outs.find(g => g && g.type === 'comp' && /^clipfx\(\d+\)$/.test((g.params.opacity?.ex?.[0] ?? '').replace(/\s/g, '')) && g.name.endsWith('_clip')) ?? null;
}
/**
 * Makes an operator a clip effect: its picture is mixed over what feeds it only while a clip set to that slot plays,
 * fading in and out with the clip. A Composite named <operator>_clip takes over the operator's outgoing wires.
 * Returns an error message, or null.
 */
export function useAsClipEffect(id: string, k: number): string | null {
  const n = project.node(id);
  if (!n) return 'No such operator.';
  const g0 = clipGateOf(id);
  if (g0) { project.patchParam(g0.id, 'opacity', s => { s.ex = [`clipfx(${k})`]; }); project.commit(); return null; }
  const inc = project.doc.conns.find(c => c.to === id && c.slot === 0);
  if (!inc) return `${n.name} has nothing feeding it. Wire it into the chain first (drop it onto a wire), then make it a clip effect.`;
  const other = slotGate(project.doc, k);
  project.batch(() => {
    // one operator per slot: a slot taken by another operator moves to this one
    if (other) unwrapGate(other.id);
    const outs = project.doc.conns.filter(c => c.from === id);
    const g = project.addNode('comp', n.x + 40, n.y + 175)!;
    let nm = `${n.name}_clip`, j = 2; while (project.doc.nodes.some(q => q.name === nm && q.id !== g.id)) nm = `${n.name}_clip${j++}`;
    project.rename(g.id, nm);
    project.setParam(g.id, 'mode', 0, false);
    project.patchParam(g.id, 'opacity', s => { s.ex = [`clipfx(${k})`]; });
    project.connect(inc.from, g.id, 0);
    project.connect(id, g.id, 1);
    for (const c of outs) { project.disconnect(c.to, c.slot); project.connect(g.id, c.to, c.slot); }
    if (n.group) project.tx(d => { const q = d.nodes.find(x => x.id === g.id); if (q) q.group = n.group; });
    if (project.doc.display === id) project.setDisplay(g.id);
  });
  return null;
}
function unwrapGate(gid: string) {
  const fx = project.doc.conns.find(c => c.to === gid && c.slot === 1)?.from;
  const outs = project.doc.conns.filter(c => c.from === gid);
  project.batch(() => {
    if (fx) for (const c of outs) { project.disconnect(c.to, c.slot); project.connect(fx, c.to, c.slot); }
    project.removeNodes([gid]);
  });
}
/** Puts the operator back in the chain full-time. */
export function stopClipEffect(id: string) { const g = clipGateOf(id); if (g) unwrapGate(g.id); }

/**
 * A wire as drawn can run between group boxes. The real connection behind it runs from the operator that feeds out of
 * the first box to an operator inside the second; inserting or cutting has to use that one.
 */
export function realWire(w: { from: string; to: string; slot: number }): { from: string; to: string; slot: number } | null {
  const doc = project.doc;
  if (!isGroupId(w.from) && !isGroupId(w.to)) return w;
  const members = (id: string) => isGroupId(id) ? new Set(doc.nodes.filter(n => GROUP_PREFIX + n.group === id).map(n => n.id)) : new Set([id]);
  const A = members(w.from), B = members(w.to);
  const cands = doc.conns.filter(c => A.has(c.from) && B.has(c.to));
  if (!cands.length) return null;
  // prefer the operator the box shows (its output) and the main input (slot 0) of the receiving operator
  const out = isGroupId(w.from) ? graphView(doc, null).real(w.from) : w.from;
  cands.sort((a, b) => (Number(b.from === out) - Number(a.from === out)) || (a.slot - b.slot));
  const c = cands[0];
  return { from: c.from, to: c.to, slot: c.slot };
}
