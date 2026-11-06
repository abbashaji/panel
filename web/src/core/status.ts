import type { PanelStatus } from "./types";

export interface StatusMeta {
  /** shown in chips, sidebar and inspector (the mockup says Merged and Lease expired) */
  label: string;
  /** accent color (see theme.css --st-*); never the only signal: icon + label always accompany it */
  color: string;
  /** single-glyph icon (kept for plain-text places); the drawn icons live in Icon.tsx */
  icon: string;
}

export const STATUS_META: Record<PanelStatus, StatusMeta> = {
  done: { label: "Merged", color: "#3DD6A3", icon: "✓" },
  running: { label: "Running", color: "#5B9DFF", icon: "▶" },
  ready: { label: "Ready", color: "#FFC857", icon: "◆" },
  waiting: { label: "Waiting", color: "#9AA3B8", icon: "…" },
  expired: { label: "Lease expired", color: "#FF6B5E", icon: "!" },
  needs_human: { label: "Needs human", color: "#C792FF", icon: "?" },
  needs_split: { label: "Needs split", color: "#FF8FB1", icon: "÷" },
};

/** Urgency order (what needs attention first). The table sort and legends use it. */
export const STATUS_ORDER: PanelStatus[] = [
  "expired",
  "needs_human",
  "needs_split",
  "ready",
  "running",
  "waiting",
  "done",
];

/** Order of the sidebar status list, as in the mockup. */
export const SIDEBAR_ORDER: PanelStatus[] = [
  "done",
  "running",
  "ready",
  "waiting",
  "expired",
  "needs_human",
  "needs_split",
];

/** CSS custom property that holds the color of a status (set in theme.css). */
export const statusVar = (s: PanelStatus): string => `var(--st-${s})`;

/** The part of a cell that decides how its status is shown. resumable (C-030) means the last chat left a handoff. */
export interface DisplayCell {
  status: PanelStatus;
  resumable?: boolean | null;
}

export const RESUME_LABEL = "Ready to resume";
/** single-glyph resume icon for plain-text places */
export const RESUME_ICON = "\u21bb";

/** Only a ready or expired cell can be resumable; a reset cell (resumable false) is plain Ready. */
export const isResumable = (c: DisplayCell): boolean => c.resumable === true && (c.status === "ready" || c.status === "expired");

/** The one label every view shows for a cell. Status ids (filters, sort, counts) stay on cell.status. */
export const displayLabel = (c: DisplayCell): string => (isResumable(c) ? RESUME_LABEL : STATUS_META[c.status].label);

/** Label, color and glyph for a cell. A resumable cell uses the Ready color so it never reads as an alarm. */
export function displayMeta(c: DisplayCell): StatusMeta & { resume: boolean } {
  return isResumable(c)
    ? { ...STATUS_META.ready, label: RESUME_LABEL, icon: RESUME_ICON, resume: true }
    : { ...STATUS_META[c.status], resume: false };
}
