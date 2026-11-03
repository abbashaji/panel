import type { PanelCell } from "./types";

export type SelectionAction =
  | { type: "select"; id: string; multi?: boolean }
  | { type: "set"; ids: string[] }
  | { type: "clear" }
  /** after every poll: drop ids that no longer exist */
  | { type: "prune"; ids: string[] }
  /** arrow keys: move the (last) selected id along `order` */
  | { type: "move"; dir: 1 | -1; order: string[] };

export function selectionReducer(state: string[], a: SelectionAction): string[] {
  switch (a.type) {
    case "select": {
      if (!a.multi) return state.length === 1 && state[0] === a.id ? state : [a.id];
      return state.includes(a.id) ? state.filter((x) => x !== a.id) : [...state, a.id];
    }
    case "set":
      return [...new Set(a.ids)];
    case "clear":
      return state.length === 0 ? state : [];
    case "prune": {
      const keep = new Set(a.ids);
      const next = state.filter((x) => keep.has(x));
      return next.length === state.length ? state : next;
    }
    case "move": {
      if (a.order.length === 0) return state;
      const cur = state.length ? a.order.indexOf(state[state.length - 1]) : -1;
      let i: number;
      if (cur < 0) i = a.dir === 1 ? 0 : a.order.length - 1;
      else i = Math.min(a.order.length - 1, Math.max(0, cur + a.dir));
      return [a.order[i]];
    }
  }
}

/** Stable reading order: by wave, then id. */
export function orderedIds(cells: PanelCell[]): string[] {
  return [...cells].sort((a, b) => a.wave - b.wave || a.id.localeCompare(b.id)).map((c) => c.id);
}
