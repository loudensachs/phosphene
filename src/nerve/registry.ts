// NERVE — operator registry.
import type { OpDef, ParamDef, PState } from './types';
import { KEYWORDS } from './keywords';

const defs = new Map<string, OpDef>();

export function register(list: OpDef[]) {
  for (const d of list) {
    if (defs.has(d.type)) console.warn(`[NERVE] duplicate op type "${d.type}"`);
    if (KEYWORDS[d.type]) d.keywords = [d.keywords, KEYWORDS[d.type]].filter(Boolean).join(' ');
    defs.set(d.type, d);
  }
}
export const getOp = (type: string) => defs.get(type);
export const allOps = () => [...defs.values()];

export function defaultParam(p: ParamDef): PState {
  const v = p.def as any;
  return { v: Array.isArray(v) ? [...v] : v };
}
export function defaultParams(def: OpDef): Record<string, PState> {
  const o: Record<string, PState> = {};
  for (const p of def.params) o[p.name] = defaultParam(p);
  return o;
}
/** Number of numeric components a param exposes to expressions/modulation. */
export function comps(p: ParamDef): number {
  return p.k === 'float' || p.k === 'int' ? 1 : p.k === 'vec2' ? 2 : 0;
}
