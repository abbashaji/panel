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

/** Display order for the sidebar status list (as in the mockup). */
export const STATUS_ORDER: PanelStatus[] = [
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
