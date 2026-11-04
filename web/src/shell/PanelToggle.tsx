import type { CSSProperties } from "react";
import { Icon, type IconName } from "../core/Icon";
import type { PanelName } from "./usePanelVisibility";

const META: Record<PanelName, { label: string; shortcut: string; open: IconName; closed: IconName }> = {
  sidebar: { label: "sidebar", shortcut: "Ctrl+B", open: "chevron-left", closed: "chevron-right" },
  inspector: { label: "inspector", shortcut: "Ctrl+Alt+I", open: "chevron-right", closed: "chevron-left" },
  activity: { label: "activity", shortcut: "Ctrl+J", open: "chevron-down", closed: "chevron-up" },
};

/** DOM id of a panel (or of its collapsed rail / bar), used by aria-controls. */
export const panelId = (panel: PanelName) => `panel-${panel}`;

/** Chevron button that hides a visible panel or shows a hidden one. `visible` is the panel's current state. */
export default function PanelToggle({
  panel,
  visible,
  onToggle,
  className = "",
  style,
}: {
  panel: PanelName;
  visible: boolean;
  onToggle: () => void;
  className?: string;
  style?: CSSProperties;
}) {
  const m = META[panel];
  const label = `${visible ? "Hide" : "Show"} ${m.label}`;
  return (
    <button
      type="button"
      aria-label={label}
      aria-expanded={visible}
      aria-controls={panelId(panel)}
      title={`${label} (${m.shortcut})`}
      onClick={onToggle}
      className={`flex shrink-0 items-center justify-center transition-colors duration-150 hover:bg-[var(--nav-active)] motion-reduce:transition-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--accent)] ${className}`}
      style={{ width: 28, height: 28, borderRadius: 8, color: "var(--muted)", ...style }}
    >
      <Icon name={visible ? m.open : m.closed} size={14} />
    </button>
  );
}
