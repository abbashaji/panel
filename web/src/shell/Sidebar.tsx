import { SIDEBAR_ORDER, STATUS_META, statusVar } from "../core/status";
import { usePanel, type View } from "../core/store";

const NAV: { id: View; label: string }[] = [
  { id: "graph", label: "Graph" },
  { id: "table", label: "Table" },
  { id: "timeline", label: "Timeline" },
];

const caption = { font: "600 11px var(--font-sans)", letterSpacing: ".08em", color: "var(--muted-3)" } as const;

export default function Sidebar({ onSettings }: { onSettings?: () => void }) {
  const p = usePanel();
  const { state, view, setView, statusFilter, toggleStatusFilter, clearFilters } = p;
  const criticalOnly = !!p.criticalOnly;
  const hideMerged = !!p.hideMerged;
  const anyFilter = (p.search ?? "") !== "" || statusFilter.length > 0 || criticalOnly || hideMerged;

  const navStyle = (on: boolean) => ({
    height: 40,
    padding: "0 12px",
    borderRadius: 8,
    textAlign: "left" as const,
    background: on ? "var(--nav-active)" : "transparent",
    color: on ? "#fff" : "var(--muted)",
    font: `${on ? 600 : 500} 13px var(--font-sans)`,
  });

  return (
    <nav
      aria-label="Sidebar"
      className="flex w-[196px] shrink-0 flex-col overflow-y-auto border-r px-3 py-4"
      style={{ background: "var(--surface)", borderColor: "var(--border)" }}
    >
      <div className="mb-[22px] flex flex-col gap-1">
        {NAV.map((n) => (
          <button key={n.id} type="button" aria-current={view === n.id ? "page" : undefined} onClick={() => setView(n.id)} style={navStyle(view === n.id)}>
            {n.label}
          </button>
        ))}
        <button type="button" onClick={onSettings} style={navStyle(false)}>
          Settings
        </button>
      </div>

      <div style={{ ...caption, padding: "0 8px 6px" }}>STATUS</div>
      <ul className="flex flex-col">
        {SIDEBAR_ORDER.filter((s) => (state?.counts[s] ?? 0) > 0 || statusFilter.includes(s)).map((s) => {
          const on = statusFilter.includes(s);
          return (
            <li key={s}>
              <button
                type="button"
                aria-pressed={on}
                onClick={() => toggleStatusFilter(s)}
                className="flex w-full items-center gap-2 text-left"
                style={{ padding: "7px 8px", borderRadius: 8, font: "500 12.5px var(--font-sans)", color: "#d5dbe8", background: on ? "var(--nav-active)" : "transparent" }}
              >
                <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 3, background: statusVar(s), flexShrink: 0 }} />
                <span>{STATUS_META[s].label}</span>
                <span className="mono ml-auto" style={{ color: "var(--muted)" }}>
                  {state?.counts[s] ?? 0}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <div style={{ ...caption, padding: "20px 8px 6px" }}>FILTERS</div>
      <label className="flex items-center gap-2" style={{ padding: 8, font: "500 12.5px var(--font-sans)", color: "#d5dbe8" }}>
        <input type="checkbox" checked={criticalOnly} onChange={() => p.toggleCriticalOnly?.()} style={{ accentColor: "var(--accent)" }} />
        Critical path only
      </label>
      <label className="flex items-center gap-2" style={{ padding: 8, font: "500 12.5px var(--font-sans)", color: "#d5dbe8" }}>
        <input type="checkbox" checked={hideMerged} onChange={() => p.toggleHideMerged?.()} style={{ accentColor: "var(--accent)" }} />
        Hide merged
      </label>
      {anyFilter && (
        <button type="button" onClick={clearFilters} className="mt-2 text-left" style={{ padding: "6px 8px", borderRadius: 8, font: "500 12px var(--font-sans)", color: "var(--accent)" }}>
          Clear filters
        </button>
      )}
    </nav>
  );
}
