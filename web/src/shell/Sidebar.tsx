import { STATUS_META, STATUS_ORDER, statusVar } from "../core/status";
import { usePanel } from "../core/store";

export default function Sidebar() {
  const { state, search, setSearch, statusFilter, toggleStatusFilter, clearFilters, select } = usePanel();
  const active = search !== "" || statusFilter.length > 0;
  const bottleneck = state?.bottleneck ?? null;
  return (
    <nav
      aria-label="Filters"
      className="flex w-[196px] shrink-0 flex-col gap-3 overflow-y-auto border-r p-3"
      style={{ background: "var(--surface)", borderColor: "var(--border)" }}
    >
      <input
        type="search"
        aria-label="Filter cells"
        placeholder="Filter cells…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full rounded border px-2 py-1 text-sm"
        style={{ background: "var(--surface-2)", borderColor: "var(--border)" }}
      />
      <ul className="flex flex-col gap-1">
        {STATUS_ORDER.map((s) => {
          const on = statusFilter.includes(s);
          return (
            <li key={s}>
              <button
                type="button"
                aria-pressed={on}
                onClick={() => toggleStatusFilter(s)}
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm"
                style={{ background: on ? "var(--surface-2)" : "transparent" }}
              >
                <span aria-hidden="true" style={{ color: statusVar(s) }}>
                  {STATUS_META[s].icon}
                </span>
                <span className="flex-1">{STATUS_META[s].label}</span>
                <span className="mono text-xs" style={{ color: "var(--muted)" }}>
                  {state?.counts[s] ?? 0}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {active && (
        <button type="button" onClick={clearFilters} className="rounded border px-2 py-1 text-sm" style={{ borderColor: "var(--border)" }}>
          Clear filters
        </button>
      )}
      {bottleneck && (
        <button
          type="button"
          onClick={() => select(bottleneck.id)}
          className="rounded border px-2 py-1 text-left text-sm"
          style={{ borderColor: "var(--border)" }}
        >
          Bottleneck: <span className="mono">{bottleneck.id}</span> blocks {bottleneck.blocks}
        </button>
      )}
    </nav>
  );
}
