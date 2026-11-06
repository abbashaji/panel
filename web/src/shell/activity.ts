import type { PanelCell, PanelState } from "../core/types";

export type ActivityKind = "heartbeat" | "warning" | "merged";

export interface ActivityRow {
  key: string;
  /** ms timestamp, used for ordering */
  at: number;
  /** HH:MM, local time */
  time: string;
  kind: ActivityKind;
  text: string;
  cellId: string;
}

const hhmm = (ms: number): string => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

const HEAL_WORDS: Record<string, string> = {
  sync_main: "sync main",
  note_added: "note added",
  feedback_cleared: "feedback cleared",
  fix_cell_published: "fix cell published",
  fix_published: "fix cell published",
  replacement_published: "replacement published",
};

/** Plain words for a heal kind; an unknown kind falls back to itself with separators turned into spaces. */
export function healWords(kind: string): string {
  const k = String(kind ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  return HEAL_WORDS[k] ?? (String(kind ?? "").replace(/[_-]+/g, " ").trim() || "unknown");
}

/**
 * Activity rows derived from the panel state (no separate event feed exists), newest first.
 * healLog (PanelState.healLog) is optional: when missing (old Worker) no heal rows are added.
 */
export function deriveActivity(
  cells: PanelCell[],
  now: number = Date.now(),
  limit = 30,
  healLog?: PanelState["healLog"],
): ActivityRow[] {
  const rows: ActivityRow[] = [];
  const add = (c: PanelCell, at: number, kind: ActivityKind, text: string, tag: string) => {
    if (Number.isNaN(at)) return;
    rows.push({ key: `${c.id}:${tag}`, at, time: hhmm(at), kind, text, cellId: c.id });
  };
  for (const c of cells) {
    const commitAt = c.lastCommit ? Date.parse(c.lastCommit.at) : NaN;
    if (c.status === "expired") {
      const ago = c.lease?.expiredMinutesAgo ?? 0;
      add(c, now - ago * 60_000, "warning", `${c.id} lease expired ${ago} min ago (attempt ${c.attempts} of ${c.maxAttempts})`, "expired");
    } else if (c.status === "needs_human") {
      add(c, commitAt, "warning", `${c.id} needs the steward`, "human");
    } else if (c.status === "needs_split") {
      add(c, commitAt, "warning", `${c.id} needs to be split`, "split");
    } else if (c.status === "running" && c.lastCommit) {
      add(c, commitAt, "heartbeat", `${c.id} ${c.lastCommit.subject}`, "commit");
    } else if (c.status === "done" && c.lastCommit) {
      add(c, commitAt, "merged", `${c.id} merged: ${c.lastCommit.subject}`, "merged");
    }
    // an expired cell also shows its last commit
    if (c.status === "expired" && c.lastCommit) {
      add(c, commitAt, "heartbeat", `${c.id} ${c.lastCommit.subject}`, "commit");
    }
  }
  if (Array.isArray(healLog)) {
    healLog.forEach((h, i) => {
      const at = Date.parse(h?.at);
      if (!h || Number.isNaN(at)) return;
      rows.push({ key: `${h.cell}:heal:${i}`, at, time: hhmm(at), kind: "heartbeat", text: `${h.cell} self-healed: ${healWords(h.kind)}`, cellId: h.cell });
    });
  }
  return rows.sort((a, b) => b.at - a.at).slice(0, limit);
}

export interface Progress {
  total: number;
  merged: number;
  running: number;
  expired: number;
  /** percent of all cells, 0..100 */
  pct: { merged: number; running: number; expired: number };
}

/** Header progress bar: merged, running and expired cells as a share of all cells. */
export function progress(cells: PanelCell[]): Progress {
  const total = cells.length;
  const n = (s: PanelCell["status"]) => cells.filter((c) => c.status === s).length;
  const merged = n("done");
  const running = n("running");
  const expired = n("expired");
  const p = (x: number) => (total === 0 ? 0 : (x / total) * 100);
  return { total, merged, running, expired, pct: { merged: p(merged), running: p(running), expired: p(expired) } };
}

/** Up to two initials for the user chip; "Y" when there is no name. */
export function initials(name: string): string {
  const parts = name.split(/[\s._-]+/).filter(Boolean);
  const a = parts[0] ?? "";
  const b = parts[1] ?? "";
  const s = b ? a.charAt(0) + b.charAt(0) : a.slice(0, 2);
  return (s || "Y").toUpperCase();
}
