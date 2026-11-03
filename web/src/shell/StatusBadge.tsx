import { STATUS_META, statusVar } from "../core/status";
import type { PanelStatus } from "../core/types";

/** Status as icon + label + color, so color is never the only signal. */
export function StatusBadge({ status }: { status: PanelStatus }) {
  const m = STATUS_META[status];
  return (
    <span className="inline-flex items-center gap-1 text-xs" style={{ color: statusVar(status) }}>
      <span aria-hidden="true">{m.icon}</span>
      <span>{m.label}</span>
    </span>
  );
}
