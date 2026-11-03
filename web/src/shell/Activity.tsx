import { usePanel } from "../core/store";

function ago(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

/** Bottom strip: the most recent lastCommit lines across all cells. */
export default function Activity() {
  const { state, select } = usePanel();
  const items = (state?.cells ?? [])
    .filter((c) => c.lastCommit !== null)
    .sort((a, b) => Date.parse(b.lastCommit?.at ?? "") - Date.parse(a.lastCommit?.at ?? ""))
    .slice(0, 6);
  return (
    <footer
      aria-label="Recent activity"
      className="flex h-8 shrink-0 items-center gap-4 overflow-x-auto border-t px-4 text-xs"
      style={{ background: "var(--surface)", borderColor: "var(--border)", color: "var(--muted)" }}
    >
      {items.length === 0 && <span>No activity yet</span>}
      {items.map((c) => (
        <button key={c.id} type="button" onClick={() => select(c.id)} className="whitespace-nowrap" title={c.lastCommit?.subject}>
          <span className="mono">{c.id}</span> {c.lastCommit?.subject} <span>{ago(c.lastCommit?.at ?? "")}</span>
        </button>
      ))}
    </footer>
  );
}
