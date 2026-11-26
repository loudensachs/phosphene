// NERVE — document model, mutations and undo. The engine reads `doc` directly every frame.
import type { Conn, Doc, NodeData, PState, ShaperData } from './types';
import { defaultParams, getOp } from './registry';

let idSeq = 0;
export const uid = (p = 'n') => `${p}${Date.now().toString(36)}${(idSeq++).toString(36)}`;

export function emptyDoc(): Doc {
  return {
    version: 1, name: 'Untitled',
    settings: { width: 1920, height: 1080, fps: 60, bpm: 120, duration: 60 },
    nodes: [], conns: [], shapers: [], audio: [], tracks: [], display: null, midi: [], take: { cc: {}, notes: [] }, sections: [],
  };
}

export function defaultShaper(n: number): ShaperData {
  return {
    id: uid('s'), name: `s${n}`,
    points: [{ x: 0, y: 1, c: 0.6 }, { x: 1, y: 0, c: 0 }],
    length: 1, mode: 'sync', trig: 'kick', threshold: 0.5, phase: 0, smooth: 0, bipolar: false,
  };
}

type Listener = () => void;

export class Project {
  doc: Doc = emptyDoc();
  /** Bumped on every change. */
  rev = 0;
  /** Bumped when nodes/connections change (topology cache key). */
  topo = 0;
  dirty = false;
  path: string | null = null;
  private subs = new Set<Listener>();
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private lastKey: string | null = null;
  private lastKeyAt = 0;

  subscribe = (fn: Listener) => { this.subs.add(fn); return () => { this.subs.delete(fn); }; };
  getRev = () => this.rev;
  private emit() { this.rev++; for (const s of this.subs) s(); }

  /**
   * Run a mutation as one undo step. Consecutive calls with the same `coalesce` key within
   * a short window merge into a single step (drags, scrubs, typing).
   */
  /** Undo depth now; pass it to squash() later to fold everything since into one undo step. */
  undoMark() { return this.undoStack.length; }
  squash(mark: number) { if (this.undoStack.length > mark + 1) this.undoStack.splice(mark + 1); this.lastKey = null; }
  /** Run several changes as a single undo step (add a node and wire it, build a whole chain). */
  batch(fn: () => void) {
    if (this.batching) { fn(); return; }
    this.undoStack.push(JSON.stringify(this.doc));
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack.length = 0;
    this.batching = true;
    try { fn(); } finally { this.batching = false; this.lastKey = null; }
  }
  private batching = false;

  tx(fn: (doc: Doc) => void, coalesce?: string, structural = false) {
    const now = performance.now();
    if (!this.batching && !(coalesce && coalesce === this.lastKey && now - this.lastKeyAt < 800)) {
      this.undoStack.push(JSON.stringify(this.doc));
      if (this.undoStack.length > 200) this.undoStack.shift();
      this.redoStack.length = 0;
    }
    this.lastKey = coalesce ?? null;
    this.lastKeyAt = now;
    fn(this.doc);
    if (structural) this.topo++;
    this.dirty = true;
    this.emit();
  }
  /** End a coalescing run so the next change starts a new undo step. */
  commit() { this.lastKey = null; }

  undo() {
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push(JSON.stringify(this.doc));
    this.doc = JSON.parse(s); this.lastKey = null; this.topo++; this.emit();
  }
  redo() {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(JSON.stringify(this.doc));
    this.doc = JSON.parse(s); this.lastKey = null; this.topo++; this.emit();
  }

  load(doc: Doc, path: string | null = null) {
    doc.tracks ??= []; doc.audio ??= []; doc.shapers ??= []; doc.midi ??= []; doc.take ??= { cc: {}, notes: [] }; doc.sections ??= [];
    this.doc = doc; this.path = path; this.undoStack = []; this.redoStack = [];
    this.dirty = false; this.topo++; this.emit();
  }
  serialize() { return JSON.stringify(this.doc, null, 1); }

  // ---- queries ----
  node(id: string) { return this.doc.nodes.find(n => n.id === id); }
  byName(name: string) { return this.doc.nodes.find(n => n.name === name); }
  inputOf(id: string, slot: number) { return this.doc.conns.find(c => c.to === id && c.slot === slot); }

  private uniqueName(base: string) {
    const names = new Set(this.doc.nodes.map(n => n.name));
    let i = 1;
    while (names.has(`${base}${i}`)) i++;
    return `${base}${i}`;
  }

  // ---- mutations ----
  addNode(type: string, x: number, y: number): NodeData | null {
    const def = getOp(type);
    if (!def) return null;
    const node: NodeData = { id: uid(), type, name: this.uniqueName(type), x: Math.round(x), y: Math.round(y), params: defaultParams(def) };
    this.tx(d => { d.nodes.push(node); if (!d.display && def.output !== 'sig') d.display = node.id; }, undefined, true);
    return node;
  }

  removeNodes(ids: string[]) {
    // a group box stands for its members
    const groups = ids.filter(i => i.startsWith('g:')).map(i => i.slice(2));
    if (groups.length) { ids = [...ids.filter(i => !i.startsWith('g:')), ...this.doc.nodes.filter(n => n.group && groups.includes(n.group)).map(n => n.id)]; this.tx(d => { d.groups = (d.groups ?? []).filter(g => !groups.includes(g.id)); }); }
    const set = new Set(ids);
    this.tx(d => {
      // splice single-input chains back together so deleting a filter doesn't break the chain
      for (const id of ids) {
        const inn = d.conns.find(c => c.to === id && c.slot === 0);
        if (inn && !set.has(inn.from)) {
          for (const o of d.conns) if (o.from === id && !set.has(o.to)) o.from = inn.from;
        }
      }
      d.nodes = d.nodes.filter(n => !set.has(n.id));
      d.conns = d.conns.filter(c => !set.has(c.from) && !set.has(c.to));
      if (d.display && set.has(d.display)) d.display = d.nodes.find(n => getOp(n.type)?.output !== 'sig')?.id ?? null;
    }, undefined, true);
  }

  /** Would connecting from → to create a cycle? */
  wouldCycle(from: string, to: string) {
    if (from === to) return true;
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length) {
      const id = stack.pop()!;
      if (id === to) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const c of this.doc.conns) if (c.to === id) stack.push(c.from);
    }
    return false;
  }

  canConnect(from: string, to: string, slot: number) {
    const a = this.node(from), b = this.node(to);
    if (!a || !b) return false;
    const da = getOp(a.type), db = getOp(b.type);
    const inp = db?.inputs[slot];
    if (!da || !inp) return false;
    const sigA = da.output === 'sig', sigB = inp.type === 'sig';
    if (sigA !== sigB) return false; // tex and field interconvert; signals don't
    return !this.wouldCycle(from, to);
  }

  connect(from: string, to: string, slot: number) {
    if (!this.canConnect(from, to, slot)) return false;
    this.tx(d => {
      d.conns = d.conns.filter(c => !(c.to === to && c.slot === slot));
      d.conns.push({ from, to, slot });
    }, undefined, true);
    return true;
  }
  /** The input of `id` that could take `from`'s output, preferring one that is free. */
  slotFor(from: string, id: string): number {
    const def = getOp(this.node(id)?.type ?? '');
    if (!def) return -1;
    const free = def.inputs.findIndex((_, i) => !this.inputOf(id, i) && this.canConnect(from, id, i));
    return free >= 0 ? free : def.inputs.findIndex((_, i) => this.canConnect(from, id, i));
  }
  /** Whether `id` could sit on the wire from → to.slot. */
  canInsert(id: string, wire: { from: string; to: string; slot: number }) {
    if (id === wire.from || id === wire.to) return false;
    const def = getOp(this.node(id)?.type ?? ''), toDef = getOp(this.node(wire.to)?.type ?? '');
    if (!def || !toDef?.inputs[wire.slot]) return false;
    if ((def.output === 'sig') !== (toDef.inputs[wire.slot].type === 'sig')) return false;
    return this.slotFor(wire.from, id) >= 0 && !this.wouldCycle(id, wire.to);
  }
  /** Slot a node into an existing connection as one undo step, nudging what follows to the right if it is cramped. */
  insertOnWire(id: string, wire: { from: string; to: string; slot: number }, width = 152, gap = 44): boolean {
    if (!this.canInsert(id, wire)) return false;
    const slot = this.slotFor(wire.from, id);
    this.tx(d => {
      d.conns = d.conns.filter(c => !(c.to === wire.to && c.slot === wire.slot) && !(c.to === id && c.slot === slot) && !(c.from === id && c.to === wire.to));
      d.conns.push({ from: wire.from, to: id, slot }, { from: id, to: wire.to, slot: wire.slot });
      const a = d.nodes.find(n => n.id === wire.from), b = d.nodes.find(n => n.id === wire.to), m = d.nodes.find(n => n.id === id);
      if (!a || !b || !m) return;
      const need = a.x + width + gap + width + gap - b.x;
      // positions inside a group are in that group's own view: only make room when all three share one view
      if (need > 0 && b.x >= a.x && a.group === m.group && b.group === m.group) {
        // everything at or downstream of the target moves over
        const down = new Set<string>([b.id]);
        for (let grew = true; grew;) { grew = false; for (const c of d.conns) if (down.has(c.from) && !down.has(c.to) && c.to !== id) { down.add(c.to); grew = true; } }
        for (const n of d.nodes) if (down.has(n.id)) n.x += need;
      }
    }, undefined, true);
    return true;
  }
  disconnect(to: string, slot: number) {
    this.tx(d => { d.conns = d.conns.filter(c => !(c.to === to && c.slot === slot)); }, undefined, true);
  }

  moveNodes(moves: { id: string; x: number; y: number }[], key = 'move') {
    this.tx(d => { for (const m of moves) { const n = d.nodes.find(q => q.id === m.id); if (n) { n.x = m.x; n.y = m.y; } else { const g = d.groups?.find(q => 'g:' + q.id === m.id); if (g) { g.x = m.x; g.y = m.y; } } } }, key);
  }

  /** Automation hook: return a transport time to have edits written as keyframes at that time. */
  keyTime: ((hasKeys: boolean) => number | null) | null = null;

  setParam(id: string, name: string, v: any, coalesce = true) {
    this.tx(d => {
      const n = d.nodes.find(q => q.id === id); if (!n) return;
      const st = (n.params[name] ??= { v });
      st.v = v;
      const comps: number[] | null = typeof v === 'number' ? [v] : Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' ? v : null;
      const t = comps && this.keyTime ? this.keyTime(!!st.keys?.some(k => k?.length)) : null;
      if (t === null || !comps) return;
      // write-through automation: replace whatever lies just ahead of the playhead with the new move
      st.keys ??= [];
      comps.forEach((val, i) => {
        const ks = (st.keys![i] ?? []).filter(k => k.t < t - 1e-4 || k.t > t + 0.2);
        ks.push({ t, v: val });
        ks.sort((a, b) => a.t - b.t);
        st.keys![i] = ks;
      });
    }, coalesce ? `p:${id}:${name}` : undefined);
  }
  patchParam(id: string, name: string, fn: (p: PState) => void, key?: string) {
    this.tx(d => { const n = d.nodes.find(q => q.id === id); if (n && n.params[name]) fn(n.params[name]); }, key);
  }
  rename(id: string, name: string) {
    name = name.trim().replace(/[^\w]/g, '_');
    if (!name || /^\d/.test(name) || this.doc.nodes.some(n => n.name === name && n.id !== id)) return false;
    this.tx(d => {
      const n = d.nodes.find(q => q.id === id); if (!n) return;
      const old = n.name; n.name = name;
      // anything reading this operator by name follows the rename
      for (const q of d.nodes) if (q.type === 'getglobal' && q.params.global?.v === old) q.params.global.v = name;
    });
    return true;
  }
  setBypass(ids: string[], on?: boolean) {
    this.tx(d => { for (const n of d.nodes) if (ids.includes(n.id)) n.bypass = on ?? !n.bypass; });
  }
  setDisplay(id: string) {
    if (id.startsWith('g:')) {
      // a group displays the member that feeds out of it
      const gid = id.slice(2), ms = new Set(this.doc.nodes.filter(n => n.group === gid).map(n => n.id));
      id = this.doc.conns.find(c => ms.has(c.from) && !ms.has(c.to))?.from ?? [...ms].pop() ?? id;
    }
    this.tx(d => { d.display = id; });
  }

  /** Paste a set of nodes + their internal connections at an offset. Returns new ids. */
  paste(nodes: NodeData[], conns: Conn[], dx: number, dy: number): string[] {
    const map = new Map<string, string>();
    const fresh: NodeData[] = [];
    this.tx(d => {
      for (const n of nodes) {
        const c: NodeData = JSON.parse(JSON.stringify(n));
        c.id = uid(); map.set(n.id, c.id);
        const names = new Set([...d.nodes, ...fresh].map(q => q.name));
        if (names.has(c.name)) { let i = 1; while (names.has(`${c.type}${i}`)) i++; c.name = `${c.type}${i}`; }
        c.x += dx; c.y += dy;
        fresh.push(c);
      }
      d.nodes.push(...fresh);
      for (const c of conns) {
        // keep links to outside sources, remap internal ones
        const from = map.get(c.from) ?? c.from;
        const to = map.get(c.to);
        if (to && d.nodes.some(n => n.id === from)) d.conns.push({ from, to, slot: c.slot });
      }
    }, undefined, true);
    return fresh.map(n => n.id);
  }
}
