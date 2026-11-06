import { useState } from "react";
import { usePanel } from "../core/store";
import type { PanelSteward } from "../core/types";
import ReleaseDialog from "../inspector/ReleaseDialog";

/** Fixed marker id the release dialog opens with; the steward action needs no cell. */
const STEWARD_MARKER = "steward";

export function stewardText(s: PanelSteward): string {
  switch (s.status) {
    case "active":
      return `Steward active${s.holder ? `, ${s.holder}` : ""}${s.minutesLeft !== null ? `, ${s.minutesLeft}m left` : ""}`;
    case "expired":
      return `Steward expired${s.expiredMinutesAgo !== null ? ` ${s.expiredMinutesAgo}m ago` : ""}`;
    case "released":
      return "Steward released";
    default:
      return "Steward idle";
  }
}

const small = { height: 28, padding: "0 10px", borderRadius: 7, font: "600 12px var(--font-sans)" } as const;

function dotColor(status: PanelSteward["status"]): string {
  if (status === "active") return "var(--st-done)";
  if (status === "expired") return "var(--st-expired)";
  return "var(--muted-3)";
}

/** Header chip for the Steward. Hidden when the Worker sends no steward (old Worker). Collapses to a dot with a tooltip on narrow widths. */
export default function StewardChip() {
  const { state, launcher } = usePanel();
  const [releaseFor, setReleaseFor] = useState<string | null>(null);
  const s = state?.steward;
  if (!s) return null;

  const text = stewardText(s);
  const problems = `${s.problems} ${s.problems === 1 ? "problem" : "problems"}`;
  const start = launcher?.startSteward;
  const canStart = s.status === "none" && typeof start === "function";
  const canResume = (s.status === "expired" || s.status === "released") && typeof start === "function";
  const canRelease = s.status === "active" || s.status === "expired";

  return (
    <div
      className="flex shrink-0 items-center gap-2"
      title={`${text} · ${problems}`}
      style={{ background: "var(--surface-2)", border: "1px solid var(--raised-border)", borderRadius: 8, padding: "3px 4px 3px 10px" }}
    >
      <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: "50%", background: dotColor(s.status) }} />
      <span className="hidden min-[1200px]:inline" style={{ font: "600 12px var(--font-sans)" }}>
        {text}
      </span>
      <span className="hidden min-[1200px]:inline" style={{ font: "500 12px var(--font-sans)", color: "var(--muted)" }}>
        {problems}
      </span>
      {canStart && (
        <button type="button" onClick={() => start?.()} style={{ ...small, background: "var(--accent)", color: "#06142B" }}>
          Start steward
        </button>
      )}
      {canResume && (
        <button type="button" onClick={() => start?.()} style={{ ...small, background: "var(--accent)", color: "#06142B" }}>
          Resume steward
        </button>
      )}
      {canRelease && (
        <button
          type="button"
          onClick={() => setReleaseFor(STEWARD_MARKER)}
          style={{ ...small, background: "var(--surface)", border: "1px solid var(--raised-border)" }}
        >
          Release
        </button>
      )}
      <ReleaseDialog action="steward-release" cellId={releaseFor} onClose={() => setReleaseFor(null)} />
    </div>
  );
}
