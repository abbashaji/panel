import { useEffect, useState } from "react";
import { isMock } from "../core/api";
import { Icon } from "../core/Icon";
import { readStore } from "../core/storage";
import { usePanel } from "../core/store";
import { initials, progress } from "./activity";
import RunReadyDialog from "../launch/RunReadyDialog";
import RepoSwitcher from "./RepoSwitcher";
import StewardChip from "./StewardChip";

/** localStorage key of the display name (written by the launch slot and the settings dialog). */
export const WHO_KEY = "bp_who";

function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}

const chip = { background: "var(--surface-2)", border: "1px solid var(--raised-border)", borderRadius: 8 } as const;

export default function Header({ onSearch }: { onSearch: () => void }) {
  const { state, lastUpdated, launcher } = usePanel();
  const [runOpen, setRunOpen] = useState(false);
  const now = useNow();
  const readyCount = (state?.cells ?? []).filter((c) => c.status === "ready").length;
  const p = progress(state?.cells ?? []);
  const who = (readStore(WHO_KEY) ?? "").trim();
  const name = who || "You";
  const secs = lastUpdated ? Math.max(0, Math.round((now - lastUpdated) / 1000)) : null;

  return (
    <header
      className="flex h-14 shrink-0 items-center gap-4 border-b px-5"
      style={{ background: "var(--surface)", borderColor: "var(--border)" }}
    >
      <div className="flex items-center gap-2.5" style={{ font: "700 15px var(--font-sans)" }}>
        <Icon name="logo" size={22} color="var(--accent)" />
        Blueprint
      </div>

      <RepoSwitcher />

      <StewardChip />

      <div className="ml-2 flex items-center gap-2.5" aria-label="Progress">
        <div
          role="img"
          aria-label={`${p.merged} of ${p.total} merged, ${p.running} running, ${p.expired} lease expired`}
          className="flex overflow-hidden"
          style={{ width: 180, height: 8, borderRadius: 99, background: "var(--border)" }}
        >
          <span style={{ width: `${p.pct.merged}%`, background: "var(--st-done)" }} />
          <span style={{ width: `${p.pct.running}%`, background: "var(--st-running)" }} />
          <span style={{ width: `${p.pct.expired}%`, background: "var(--st-expired)" }} />
        </div>
        <span style={{ font: "600 12.5px var(--font-sans)" }}>
          {p.merged} / {p.total} merged
        </span>
      </div>

      <span className="flex-1" />

      {isMock() && (
        <span
          className="flex items-center gap-2"
          style={{ background: "#2a2312", border: "1px solid #6b5620", color: "#ffd98a", borderRadius: 8, padding: "7px 11px", font: "600 12px var(--font-sans)" }}
        >
          <Icon name="warning" size={12} color="var(--danger)" />
          acct-a over 90% of 5h limit · resets 2:40 AM (sample)
        </span>
      )}

      {readyCount > 0 && (
        <>
          <button
            type="button"
            onClick={() => setRunOpen(true)}
            className="shrink-0 whitespace-nowrap"
            style={{ height: 36, padding: "0 14px", borderRadius: 8, background: "var(--accent)", color: "#06142B", font: "700 12.5px var(--font-sans)" }}
          >
            Run ready ({readyCount})
          </button>
          <RunReadyDialog
            open={runOpen}
            onOpenChange={setRunOpen}
            cells={state?.cells ?? []}
            onRun={(ids) => launcher?.startMany?.(ids)}
          />
        </>
      )}

      <button
        type="button"
        onClick={onSearch}
        aria-label="Search cells"
        className="flex items-center gap-2 text-left"
        style={{ ...chip, height: 36, width: 200, padding: "0 10px", color: "var(--muted-2)", font: "500 12.5px var(--font-sans)" }}
      >
        <span>Search cells</span>
        <span className="mono ml-auto" style={{ font: "500 11px var(--font-mono)", color: "var(--muted-3)" }}>
          Ctrl K
        </span>
      </button>

      <span className="flex items-center gap-[7px]" style={{ font: "500 12px var(--font-sans)", color: "var(--muted)" }}>
        <span
          aria-hidden="true"
          style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--st-done)", animation: "pulse 2s infinite" }}
        />
        {secs === null ? "Connecting…" : `Live · ${secs}s`}
      </span>

      <span
        className="flex items-center gap-2"
        style={{ border: "1px solid var(--raised-border)", borderRadius: 99, padding: "4px 12px 4px 4px", font: "600 12px var(--font-sans)" }}
      >
        <span
          aria-hidden="true"
          className="flex items-center justify-center"
          style={{ width: 26, height: 26, borderRadius: "50%", background: "var(--accent)", color: "#06142b", font: "700 11px var(--font-sans)" }}
        >
          {initials(name)}
        </span>
        {name}
      </span>
    </header>
  );
}
