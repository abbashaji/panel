import { useMemo, useState, type KeyboardEvent } from "react";
import { usePanel } from "../core/store";
import type { PanelCell } from "../core/types";
import { filterCells } from "../shell/filter";
import { StatusBadge } from "../shell/StatusBadge";
import { sortCells, type SortDir, type SortKey } from "./sort";

export { default as TimelineView } from "./Timeline";

const COLS: { key: SortKey; label: string }[] = [
  { key: "id", label: "ID" },
  { key: "title", label: "Title" },
  { key: "status", label: "Status" },
  { key: "wave", label: "Wave" },
  { key: "blockedBy", label: "Blocked by" },
  { key: "lease", label: "Lease" },
  { key: "attempts", label: "Attempts" },
];

function leaseText(c: PanelCell): string {
  if (!c.lease) return "—";
  return c.lease.expiredMinutesAgo !== null ? `expired ${c.lease.expiredMinutesAgo}m ago` : `${c.lease.minutesLeft}m left`;
}

export default function TableView() {
  const { state, search, statusFilter, selection, select, clearFilters } = usePanel();
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "wave", dir: "asc" });

  const rows = useMemo(
    () => sortCells(filterCells(state?.cells ?? [], search, statusFilter), sort.key, sort.dir),
    [state, search, statusFilter, sort],
  );

  const onHeader = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));

  const onRowKey = (e: KeyboardEvent<HTMLTableRowElement>, id: string) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      select(id, e.ctrlKey || e.metaKey || e.shiftKey);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const el = e.key === "ArrowDown" ? e.currentTarget.nextElementSibling : e.currentTarget.previousElementSibling;
      if (el instanceof HTMLElement) el.focus();
    }
  };

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-start gap-2 p-6" style={{ color: "var(--muted)" }}>
        <span>No cells match the filters.</span>
        <button type="button" onClick={clearFilters} className="rounded border px-2 py-1 text-sm" style={{ borderColor: "var(--border)" }}>
          Clear filters
        </button>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto">
      <table className="w-full border-collapse text-left text-sm">
        <caption className="sr-only">Cells</caption>
        <thead className="sticky top-0" style={{ background: "var(--surface)" }}>
          <tr>
            {COLS.map((col) => (
              <th
                key={col.key}
                scope="col"
                aria-sort={sort.key === col.key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                className="border-b px-3 py-2 font-medium"
                style={{ borderColor: "var(--border)" }}
              >
                <button type="button" onClick={() => onHeader(col.key)}>
                  {col.label}
                  <span aria-hidden="true">{sort.key === col.key ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}</span>
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => {
            const sel = selection.includes(c.id);
            return (
              <tr
                key={c.id}
                tabIndex={0}
                aria-current={sel ? "true" : undefined}
                onClick={(e) => select(c.id, e.ctrlKey || e.metaKey || e.shiftKey)}
                onKeyDown={(e) => onRowKey(e, c.id)}
                className="cursor-pointer border-b"
                style={{ borderColor: "var(--border)", background: sel ? "var(--surface-2)" : "transparent" }}
              >
                <td className="mono px-3 py-2">{c.id}</td>
                <td className="px-3 py-2">{c.title}</td>
                <td className="px-3 py-2">
                  <StatusBadge status={c.status} />
                </td>
                <td className="px-3 py-2">{c.wave}</td>
                <td className="mono px-3 py-2">{c.blockedBy.length > 0 ? c.blockedBy.join(", ") : "—"}</td>
                <td className="px-3 py-2">{leaseText(c)}</td>
                <td className="px-3 py-2">
                  {c.attempts}/{c.maxAttempts}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
