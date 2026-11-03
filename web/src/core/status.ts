import type { PanelStatus } from "./types";

export interface StatusMeta {
  label: string;
  /** accent color (see theme.css --st-*); never the only signal: icon + label always accompany it */
  color: string;
  /** single-glyph icon */
  icon: string;
}

export const STATUS_META: Record<PanelStatus, StatusMeta> = {
  done: { label: "Done", color: "#3DD6A3", icon: "✓" },
  running: { label: "Running", color: "#5B9DFF", icon: "▶" },
  ready: { label: "Ready", color: "#FFC857", icon: "◆" },
  waiting: { label: "Waiting", color: "#9AA3B8", icon: "…" },
  expired: { label: "Expired", color: "#FF6B5E", icon: "!" },
  needs_human: { label: "Needs human", color: "#C792FF", icon: "?" },
  needs_split: { label: "Needs split", color: "#FF8FB1", icon: "÷" },
};

/** Display order for filters and legends: what needs attention first. */
export const STATUS_ORDER: PanelStatus[] = [
  "expired",
  "needs_human",
  "needs_split",
  "ready",
  "running",
  "waiting",
  "done",
];

/** CSS custom property that holds the color of a status (set in theme.css). */
export const statusVar = (s: PanelStatus): string => `var(--st-${s})`;
