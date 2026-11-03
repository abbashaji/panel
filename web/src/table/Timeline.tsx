import { useMemo } from "react";
import { statusVar } from "../core/status";
import { usePanel } from "../core/store";
import type { PanelCell } from "../core/types";
import { filterCells } from "../shell/filter";
import { StatusBadge } from "../shell/StatusBadge";

/** Cells grouped by wave, each with its status color, icon and label. */
export default function Timeline() {
  const { state, search, statusFilter, selection, select } = usePanel();
  const waves = useMemo(() => {
    const m = new Map<number, PanelCell[]>();
    for (const c of filterCells(state?.cells ?? [], search, statusFilter)) {
      const list = m.get(c.wave);
      if (list) list.push(c);
      else m.set(c.wave, [c]);
    }
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  }, [state, search, statusFilter]);

  if (waves.length === 0) {
    return (
      <div className="p-6" style={{ color: "var(--muted)" }}>
        No cells match the filters.
      </div>
    );
  }
  return (
    <div className="h-full overflow-y-auto p-4">
      {waves.map(([wave, cells]) => (
        <section key={wave} aria-label={`Wave ${wave}`} className="mb-6">
          <h3 className="mb-2 text-sm font-semibold">Wave {wave}</h3>
          <ul className="flex flex-wrap gap-2">
            {cells.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={(e) => select(c.id, e.ctrlKey || e.metaKey || e.shiftKey)}
                  aria-pressed={selection.includes(c.id)}
                  className="flex w-56 flex-col gap-1 rounded border px-3 py-2 text-left text-sm"
                  style={{
                    background: selection.includes(c.id) ? "var(--surface-2)" : "var(--surface)",
                    borderColor: "var(--border)",
                    borderLeft: `4px solid ${statusVar(c.status)}`,
                  }}
                >
                  <span className="flex items-center justify-between">
                    <span className="mono">{c.id}</span>
                    <StatusBadge status={c.status} />
                  </span>
                  <span className="truncate">{c.title}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
