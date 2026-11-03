import type { ReactNode } from "react";
import { STATUS_META } from "../core/status";
import type { PanelCell, PanelStatus } from "../core/types";

/** Length of a cell lease in minutes (next_cell hands out a 60 minute lease). */
export const LEASE_MINUTES = 60;

/** Status chip: icon + text label + accent color, never color alone. */
export function StatusChip({ status }: { status: PanelStatus }) {
  const m = STATUS_META[status];
  return (
    <span
      data-testid="status-chip"
      className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-semibold"
      style={{ color: m.color, border: `1px solid ${m.color}` }}
    >
      <span aria-hidden="true">{m.icon}</span>
      {m.label}
    </span>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mb-2">
      <dt className="text-[11px] uppercase tracking-wide opacity-70">{label}</dt>
      <dd className="m-0 break-words text-sm">{children}</dd>
    </div>
  );
}

export function LeaseBar({ lease }: { lease: PanelCell["lease"] }) {
  if (!lease) return <span>No lease</span>;
  if (lease.expiredMinutesAgo !== null) return <span>Expired {lease.expiredMinutesAgo} min ago</span>;
  const left = Math.max(0, Math.min(LEASE_MINUTES, lease.minutesLeft));
  return (
    <div>
      <div
        role="progressbar"
        aria-label="Lease time left"
        aria-valuemin={0}
        aria-valuemax={LEASE_MINUTES}
        aria-valuenow={left}
        className="h-2 w-full rounded bg-white/10"
      >
        <div className="h-2 rounded" style={{ width: `${Math.round((left / LEASE_MINUTES) * 100)}%`, background: "var(--st-running)" }} />
      </div>
      <span className="text-xs">
        {lease.minutesLeft} min left{lease.ci ? " · CI running" : ""}
      </span>
    </div>
  );
}
