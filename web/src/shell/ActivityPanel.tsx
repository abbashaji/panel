import { isMock } from "../core/api";
import { Icon, type IconName } from "../core/Icon";
import { usePanel } from "../core/store";
import { deriveActivity, type ActivityKind } from "./activity";
import PanelToggle, { panelId } from "./PanelToggle";

const ICON: Record<ActivityKind, { name: IconName; color: string }> = {
  heartbeat: { name: "clock-running", color: "var(--st-running)" },
  warning: { name: "warning", color: "var(--st-expired)" },
  merged: { name: "check", color: "var(--st-done)" },
};

/** Live activity panel (172 px) under the main view; rows are derived from the state. */
export default function Activity({ visible = true, onToggle }: { visible?: boolean; onToggle?: () => void }) {
  const { state, select } = usePanel();
  const rows = deriveActivity(state?.cells ?? []);
  if (!visible) {
    return (
      <section
        id={panelId("activity")}
        aria-label="Live activity"
        className="flex shrink-0 items-center justify-between"
        style={{ height: 36, margin: "0 16px 16px", padding: "0 4px 0 16px", border: "1px solid var(--border)", borderRadius: 12, background: "var(--surface)" }}
      >
        <span style={{ font: "600 11px var(--font-sans)", letterSpacing: ".08em", color: "var(--muted-3)" }}>{`LIVE ACTIVITY (${rows.length})`}</span>
        <PanelToggle panel="activity" visible={false} onToggle={() => onToggle?.()} />
      </section>
    );
  }
  return (
    <section
      id={panelId("activity")}
      aria-label="Live activity"
      className="flex shrink-0 flex-col overflow-hidden"
      style={{ height: 172, margin: "0 16px 16px", padding: "12px 16px", border: "1px solid var(--border)", borderRadius: 12, background: "var(--surface)" }}
    >
      <div className="flex items-center justify-between" style={{ paddingBottom: 6 }}>
        <div style={{ font: "600 11px var(--font-sans)", letterSpacing: ".08em", color: "var(--muted-3)" }}>
          LIVE ACTIVITY{isMock() ? " · SAMPLE DATA" : ""}
        </div>
        {onToggle && <PanelToggle panel="activity" visible onToggle={onToggle} style={{ marginTop: -8, marginRight: -8 }} />}
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {rows.length === 0 && (
          <li style={{ padding: "6px 0", font: "500 12px var(--font-sans)", color: "var(--muted)" }}>No activity yet</li>
        )}
        {rows.map((r) => (
          <li key={r.key} style={{ borderTop: "1px solid var(--border)" }}>
            <button
              type="button"
              onClick={() => select(r.cellId)}
              className="flex w-full gap-3 text-left"
              style={{ padding: "6px 0", font: "500 12px var(--font-sans)", color: "#c6cddd" }}
            >
              <span className="mono" style={{ color: "var(--muted-3)", width: 44, flexShrink: 0 }}>
                {r.time}
              </span>
              <span className="flex items-center" style={{ width: 14, flexShrink: 0 }}>
                <Icon name={ICON[r.kind].name} size={12} color={ICON[r.kind].color} />
              </span>
              <span className="truncate">{r.text}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
