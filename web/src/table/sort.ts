import { STATUS_ORDER } from "../core/status";
import type { PanelCell } from "../core/types";

export type SortKey = "id" | "title" | "status" | "wave" | "blockedBy" | "lease" | "attempts";
export type SortDir = "asc" | "desc";

/** Minutes until the lease ends; expired leases are negative; no lease sorts first. */
export function leaseValue(c: PanelCell): number {
  if (!c.lease) return Number.NEGATIVE_INFINITY;
  return c.lease.expiredMinutesAgo !== null ? -c.lease.expiredMinutesAgo : c.lease.minutesLeft;
}

function value(c: PanelCell, key: SortKey): string | number {
  switch (key) {
    case "id":
      return c.id;
    case "title":
      return c.title.toLowerCase();
    case "status":
      return STATUS_ORDER.indexOf(c.status);
    case "wave":
      return c.wave;
    case "blockedBy":
      return c.blockedBy.join(",");
    case "lease":
      return leaseValue(c);
    case "attempts":
      return c.attempts;
  }
}

const byId = (a: PanelCell, b: PanelCell) => a.id.localeCompare(b.id, undefined, { numeric: true });

/** Stable sort; ties always fall back to id ascending. */
export function sortCells(cells: PanelCell[], key: SortKey, dir: SortDir): PanelCell[] {
  const m = dir === "asc" ? 1 : -1;
  return [...cells].sort((a, b) => {
    const x = value(a, key);
    const y = value(b, key);
    let r: number;
    if (typeof x === "number" && typeof y === "number") r = x === y ? 0 : x < y ? -1 : 1;
    else r = String(x).localeCompare(String(y), undefined, { numeric: true });
    return r * m || byId(a, b);
  });
}
