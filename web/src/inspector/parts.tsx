import type { ReactNode } from "react";
import { StatusIcon } from "../core/Icon";
import { STATUS_META } from "../core/status";
import type { PanelCell, PanelStatus } from "../core/types";

/** Length of a cell lease in minutes (next_cell hands out a 60 minute lease). */
export const LEASE_MINUTES = 60;

/** "52m ago", "3h ago", "2d ago"; null when the time is missing or invalid. */
export function ago(iso: string | null | undefined, now: number = Date.now()): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const m = Math.max(0, Math.round((now - t) / 60000));
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Status pill: icon + text label + status-family colors, never color alone. */
export function StatusChip({ status }: { status: PanelStatus }) {
  const m = STATUS_META[status];
  const style =
    status === "expired"
      ? { color: "#FF6B5E", background: "#2B1512", border: "1px solid #7A2E27" }
      : { color: m.color, background: `${m.color}1F`, border: `1px solid ${m.color}66` };
  return (
    <span data-testid="status-chip" className="inline-flex items-center gap-1.5 rounded-full px-[9px] py-1 text-[11px] font-semibold" style={style}>
      <StatusIcon status={status} size={12} />
      {m.label}
    </span>
  );
}

/** One key/value row: 1px top border, key left, value right-aligned. */
export function Field({ label, mono, children }: { label: string; mono?: boolean; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 border-t border-[#1E2740] py-[9px] text-[12.5px] font-medium">
      <dt className="shrink-0 text-[#9AA3B8]">{label}</dt>
      <dd className={`m-0 min-w-0 break-words text-right text-[#E8ECF5]${mono ? " font-mono" : ""}`}>{children}</dd>
    </div>
  );
}

/** 8px lease bar on the line track plus its caption. Nothing is drawn for cells without a lease. */
export function LeaseBar({
  lease,
  expired,
  attempts,
  maxAttempts,
}: {
  lease: PanelCell["lease"];
  expired: boolean;
  attempts: number;
  maxAttempts: number;
}) {
  const isExpired = expired || (lease !== null && lease.expiredMinutesAgo !== null);
  if (!lease && !isExpired) return null;
  const att = `attempt ${attempts} of ${maxAttempts}`;
  const left = isExpired || !lease ? 0 : Math.max(0, Math.min(LEASE_MINUTES, lease.minutesLeft));
  const pct = isExpired ? 100 : Math.round((left / LEASE_MINUTES) * 100);
  const agoTxt = lease && lease.expiredMinutesAgo !== null ? ` ${lease.expiredMinutesAgo} min ago` : "";
  const caption = isExpired
    ? `Lease expired${agoTxt} · ${att}`
    : `${left} min left · ${att}${lease && lease.ci ? " · CI running" : ""}`;
  return (
    <div className="mb-1 mt-3">
      <div
        role="progressbar"
        aria-label="Lease time left"
        aria-valuemin={0}
        aria-valuemax={LEASE_MINUTES}
        aria-valuenow={left}
        className="h-2 w-full overflow-hidden rounded-full bg-[#1E2740]"
      >
        <div className="h-2 rounded-full" style={{ width: `${pct}%`, background: isExpired ? "var(--st-expired)" : "var(--st-running)" }} />
      </div>
      <p className="mb-0 mt-2 text-[11.5px] font-medium" style={{ color: isExpired ? "#FFB4AB" : "#A9B2C6" }}>
        {caption}
      </p>
    </div>
  );
}
