import type { PanelCell, PanelStatus } from "../core/types";

/** True when the cell id or title contains the query (case-insensitive). An empty query matches everything. */
export function matchesSearch(c: PanelCell, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || c.id.toLowerCase().includes(q) || c.title.toLowerCase().includes(q);
}

/** Applies the shared filter state from usePanel(): search text and the status filter set (empty = all). */
export function filterCells(cells: PanelCell[], search: string, statuses: PanelStatus[]): PanelCell[] {
  return cells.filter((c) => (statuses.length === 0 || statuses.includes(c.status)) && matchesSearch(c, search));
}
