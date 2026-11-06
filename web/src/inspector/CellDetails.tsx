import { StatusIcon } from "../core/Icon";
import { STATUS_META, STATUS_ORDER, displayMeta, isResumable } from "../core/status";
import { usePanel } from "../core/store";
import type { PanelCell } from "../core/types";
import type { AdminAction } from "./ReleaseDialog";
import { ago, Field, LeaseBar, StatusChip } from "./parts";

const REPO_OK = /^[\w.-]+\/[\w.-]+$/;
const DASH = "\u2014";
const HELP =
  "Click selects. Double-click opens details. Release writes one empty commit so any chat can adopt the cell at once.";

const base =
  "flex h-11 w-full cursor-pointer items-center justify-center rounded-[10px] border text-[13.5px] no-underline disabled:cursor-default disabled:opacity-40";
const primary = `${base} border-[#5B9DFF] bg-[#5B9DFF] font-bold text-[#06142B]`;
const danger = `${base} border-[#FF6B5E] bg-[#FF6B5E] font-semibold text-[#1A0B09]`;
const secondary = `${base} border-[#33405E] bg-[#18213A] font-semibold text-[#E8ECF5]`;

/** Short summary shown when more than one cell is selected. */
export function MultiSummary({ cells }: { cells: PanelCell[] }) {
  return (
    <div data-testid="multi-summary">
      <h2 className="m-0 mb-3 text-[18px] font-bold text-[#E8ECF5]">{cells.length} cells selected</h2>
      <ul className="m-0 mb-3 flex list-none flex-col gap-1.5 p-0 text-[12.5px] font-medium text-[#C6CDDD]">
        {STATUS_ORDER.map((s) => {
          const n = cells.filter((c) => c.status === s).length;
          return n ? (
            <li key={s} className="flex items-center gap-2">
              <StatusIcon status={s} size={12} />
              <span>
                {STATUS_META[s].label}: {n}
              </span>
            </li>
          ) : null;
        })}
      </ul>
      <p className="m-0 font-mono text-[11.5px] text-[#9AA3B8]">{cells.map((c) => c.id).join(", ")}</p>
      <p className="mb-0 mt-3 text-[11.5px] font-medium leading-[1.5] text-[#8A93A8]">
        Select a single cell for details and actions. Esc clears the selection.
      </p>
    </div>
  );
}

export function CellDetails({ cell, repo, onAdmin }: { cell: PanelCell; repo: string; onAdmin(a: AdminAction): void }) {
  const { launcher } = usePanel();
  const branch = `cell/${cell.id}`;
  const gh = REPO_OK.test(repo) ? `https://github.com/${repo}` : null;
  const resumable = isResumable(cell);
  const meta = displayMeta(cell);
  const canOpenChat = (cell.status === "running" || cell.status === "expired") && !resumable;
  const canRelease = cell.status !== "done" && cell.status !== "waiting";
  // a reset cell (ready, not resumable, nobody holding it) has no holder, even if this browser remembers an old start
  const holder = cell.reservedBy ?? (cell.status === "ready" && !resumable ? null : launcher.owner(cell.id)) ?? null;
  const direct = `${cell.directDependents} direct, ${cell.transitiveDependents} total dependents`;
  const subline = cell.critical ? `Critical cell \u00b7 ${direct}` : direct;
  const when = ago(cell.lastCommit?.at);
  const n = cell.allowedPaths.length;

  return (
    <div data-testid="cell-details">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[12px] font-semibold" style={{ color: meta.color }}>
          {cell.id}
        </span>
        {resumable ? (
          <span
            data-testid="resume-chip"
            className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-semibold"
            style={{ color: meta.color, borderColor: meta.color }}
          >
            <span aria-hidden="true">{meta.icon}</span>
            <span>{meta.label}</span>
          </span>
        ) : (
          <StatusChip status={cell.status} />
        )}
      </div>
      <h2 className="mb-1 mt-2 text-[22px] font-bold leading-tight text-[#E8ECF5]">{cell.title}</h2>
      <p className="m-0 text-[12.5px] font-medium text-[#A9B2C6]">{subline}</p>
      {resumable && (
        <p data-testid="resume-note" className="mb-0 mt-2 text-[12.5px] font-semibold text-[#FFC857]">
          Ready to resume, the last chat left a handoff
        </p>
      )}

      <LeaseBar lease={cell.lease} expired={cell.status === "expired"} attempts={cell.attempts} maxAttempts={cell.maxAttempts} />

      <dl className="m-0 mt-3">
        <Field label="Branch" mono>
          {branch}
        </Field>
        <Field label="Lock sha" mono>
          {cell.sha.lock ?? DASH}
        </Field>
        <Field label="Tip sha" mono>
          {cell.sha.tip ?? DASH}
        </Field>
        <Field label="Last commit">
          {cell.lastCommit ? (when ? `${cell.lastCommit.subject} \u00b7 ${when}` : cell.lastCommit.subject) : DASH}
        </Field>
        <Field label="Next step">{cell.lastCommit?.next || DASH}</Field>
        <Field label="Holder">{holder ?? DASH}</Field>
        {cell.pr && gh && (
          <Field label="Pull request">
            <a className="text-[#5B9DFF] underline" href={`${gh}/pull/${cell.pr.number}`} target="_blank" rel="noopener noreferrer">
              #{cell.pr.number} ({cell.pr.state})
            </a>
          </Field>
        )}
        <Field label="Files">{`${n} allowed path${n === 1 ? "" : "s"}`}</Field>
      </dl>

      <div className="mt-[18px] flex flex-col gap-[10px]">
        {canOpenChat && (
          <button type="button" className={primary} onClick={() => launcher.open(cell.id)}>
            Open chat
          </button>
        )}
        {resumable && (
          <button type="button" className={primary} onClick={() => launcher.start(cell.id)}>
            Resume
          </button>
        )}
        {cell.status === "ready" && !resumable && (
          <button type="button" className={primary} onClick={() => launcher.start(cell.id)}>
            Start
          </button>
        )}
        {canRelease && (
          <button type="button" className={danger} onClick={() => onAdmin("release")}>
            Release cell
          </button>
        )}
        {cell.status === "needs_human" && (
          <button type="button" className={secondary} onClick={() => onAdmin("clear-feedback")}>
            Clear feedback
          </button>
        )}
        {gh && cell.sha.tip && (
          <a className={secondary} href={`${gh}/tree/${branch}`} target="_blank" rel="noopener noreferrer">
            Open branch on GitHub
          </a>
        )}
      </div>

      <p className="mb-0 mt-4 text-[11.5px] font-medium leading-[1.5] text-[#8A93A8]">{HELP}</p>
    </div>
  );
}
