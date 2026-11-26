// App singletons and UI-only state (selection, view transforms, pane sizes). Not part of the document.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Project } from '../nerve/project';
import { Engine } from '../nerve/engine';

export const project = new Project();
export const engine = new Engine(project);

export interface MenuState {
  /** Screen position of the popup. */
  x: number; y: number;
  /** Graph position where the node will be created. */
  gx: number; gy: number;
  /** Pending wire to attach to the new node. */
  from?: string;
  to?: { id: string; slot: number };
}

export interface UIState {
  sel: string[];
  view: { x: number; y: number; k: number };
  viewer: { exposure: number; mode: number; tonemap: boolean };
  menu: MenuState | null;
  /** Group open in the network editor, or null for the whole network. */
  groupView: string | null;
  bottomTab: 'timeline' | 'shapers' | 'stock' | 'bands';
  shaper: string | null;
  sizes: { right: number; bottom: number; viewer: number };
  status: string;
}

function createStore<T extends object>(init: T) {
  let state = init;
  const subs = new Set<() => void>();
  return {
    get: () => state,
    set(patch: Partial<T> | ((s: T) => Partial<T>)) {
      const p = typeof patch === 'function' ? patch(state) : patch;
      state = { ...state, ...p };
      subs.forEach(f => f());
    },
    subscribe(f: () => void) { subs.add(f); return () => { subs.delete(f); }; },
  };
}

export const ui = createStore<UIState>({
  sel: [],
  view: { x: 60, y: 60, k: 1 },
  viewer: { exposure: 0, mode: 0, tonemap: false },
  menu: null,
  groupView: null,
  bottomTab: 'timeline',
  shaper: null,
  sizes: { right: 400, bottom: 250, viewer: 300 },
  status: '',
});

export function useUI<R>(sel: (s: UIState) => R): R {
  return useSyncExternalStore(ui.subscribe, () => sel(ui.get()));
}
/** Re-render on any document change; read `project.doc` directly afterwards. */
export function useDoc() {
  useSyncExternalStore(project.subscribe, project.getRev);
  return project.doc;
}
/** Re-render at a fixed interval for live readouts. */
export function useTick(ms = 100) {
  const [, set] = useState(0);
  useEffect(() => { const id = setInterval(() => set(n => n + 1), ms); return () => clearInterval(id); }, [ms]);
}

export const CAT_COLOR: Record<string, string> = {
  Generate: '#7fb069', Filter: '#5a9bd8', Distort: '#b58bd6', Color: '#d9a05b', Composite: '#c9c9cf',
  Time: '#58b8b0', Glitch: '#e0706a', Simulate: '#d87fa9', Field: '#d98a4e', Spectral: '#8f9be8',
  Group: '#e8c27a', Signal: '#6cc08b', Audio: '#c7c25a', IO: '#8a8a94', Stage: '#e6b450',
};
export const TYPE_COLOR = { tex: '#5a9bd8', field: '#d98a4e', sig: '#6cc08b' } as const;

export function fmt(v: number, step?: number): string {
  if (!Number.isFinite(v)) return '0';
  const a = Math.abs(v);
  const d = step !== undefined ? Math.max(0, Math.min(4, Math.ceil(-Math.log10(step)))) : a >= 100 ? 1 : a >= 10 ? 2 : 3;
  return v.toFixed(d);
}
