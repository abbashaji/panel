import type { ReactNode } from "react";
import { STATUS_META } from "./status";
import type { PanelStatus } from "./types";

// 14x14 viewBox stroke icons from the approved mockup (docs/panel-design.md section 1). Always aria-hidden:
// the label next to the icon carries the meaning.

export type IconName =
  | "check"
  | "warning"
  | "clock-running"
  | "clock-waiting"
  | "alert-circle"
  | "play"
  | "split"
  | "logo"
  | "lock";

export const STATUS_ICON: Record<PanelStatus, IconName> = {
  done: "check",
  running: "clock-running",
  ready: "play",
  waiting: "clock-waiting",
  expired: "warning",
  needs_human: "alert-circle",
  needs_split: "split",
};

const SHAPES: Record<Exclude<IconName, "logo">, ReactNode> = {
  check: <path d="M3 7.5l3 3 5-6" />,
  warning: (
    <>
      <path d="M7 2.5l5 9H2z" />
      <path d="M7 6v2.5M7 10v.1" />
    </>
  ),
  "clock-running": (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M7 4v3l2 1.5" />
    </>
  ),
  "clock-waiting": (
    <>
      <circle cx="7" cy="7" r="5" />
      <path d="M7 4.5V7h2.5" />
    </>
  ),
  "alert-circle": (
    <>
      <circle cx="7" cy="7" r="5" />
      <path d="M7 4.5v3M7 9.5v.1" />
    </>
  ),
  play: <path d="M3 1.5l9 5.5-9 5.5z" />,
  split: (
    <>
      <path d="M3 7h8" />
      <path d="M7 3.5v.1M7 10.4v.1" />
    </>
  ),
  lock: (
    <>
      <rect x="3" y="6.5" width="8" height="5.5" rx="1.5" />
      <path d="M5 6.5V5a2 2 0 014 0v1.5" />
    </>
  ),
};

export function Icon({ name, size = 12, color = "currentColor" }: { name: IconName; size?: number; color?: string }) {
  if (name === "logo") {
    return (
      <svg width={size} height={size} viewBox="0 0 22 22" fill="none" stroke={color} strokeWidth="1.8" aria-hidden="true">
        <rect x="2" y="2" width="7" height="7" rx="2" />
        <rect x="13" y="2" width="7" height="7" rx="2" />
        <rect x="7.5" y="13" width="7" height="7" rx="2" />
      </svg>
    );
  }
  const filled = name === "play";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill={filled ? color : "none"}
      stroke={filled ? "none" : color}
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {SHAPES[name]}
    </svg>
  );
}

/** The icon of a status in the status color. */
export function StatusIcon({ status, size = 12 }: { status: PanelStatus; size?: number }) {
  return <Icon name={STATUS_ICON[status]} size={size} color={STATUS_META[status].color} />;
}
