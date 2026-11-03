import { STATUS_META, STATUS_ORDER, statusVar } from "../core/status";
import { usePanel, type View } from "../core/store";

const VIEWS: { id: View; label: string }[] = [
  { id: "graph", label: "Graph" },
  { id: "table", label: "Table" },
  { id: "timeline", label: "Timeline" },
];

const btn = "rounded border px-2 py-1 text-sm";

export default function Header({ onSearch }: { onSearch: () => void }) {
  const { state, view, setView, theme, toggleTheme, refresh } = usePanel();
  return (
    <header
      className="flex h-14 shrink-0 items-center gap-4 border-b px-4"
      style={{ background: "var(--surface)", borderColor: "var(--border)" }}
    >
      <strong className="truncate">{state?.project ?? "Blueprint Panel"}</strong>
      {state && (
        <span className="mono text-xs" style={{ color: "var(--muted)" }}>
          main {state.mainSha.slice(0, 7)}
        </span>
      )}
      {state && (
        <ul aria-label="Cell counts" className="flex gap-3 text-xs">
          {STATUS_ORDER.filter((s) => state.counts[s] > 0).map((s) => (
            <li key={s} className="whitespace-nowrap">
              <span aria-hidden="true" style={{ color: statusVar(s) }}>
                {STATUS_META[s].icon}
              </span>{" "}
              {state.counts[s]} {STATUS_META[s].label}
            </li>
          ))}
        </ul>
      )}
      <span className="flex-1" />
      <div role="tablist" aria-label="View" className="flex gap-1">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            role="tab"
            aria-selected={view === v.id}
            onClick={() => setView(v.id)}
            className="rounded px-2 py-1 text-sm"
            style={{ background: view === v.id ? "var(--surface-2)" : "transparent" }}
          >
            {v.label}
          </button>
        ))}
      </div>
      <button type="button" onClick={onSearch} className={btn} style={{ borderColor: "var(--border)" }}>
        Search <kbd className="mono text-xs">Ctrl+K</kbd>
      </button>
      <button type="button" onClick={refresh} className={btn} style={{ borderColor: "var(--border)" }}>
        Refresh
      </button>
      <button type="button" onClick={toggleTheme} aria-label="Toggle theme" className={btn} style={{ borderColor: "var(--border)" }}>
        {theme === "dark" ? "Light" : "Dark"}
      </button>
    </header>
  );
}
