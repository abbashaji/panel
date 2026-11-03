import { STATUS_META, STATUS_ORDER } from "../core/status";
import { usePanel } from "../core/store";
import type { PanelCell } from "../core/types";
import type { AdminAction } from "./ReleaseDialog";
import { Field, LeaseBar, StatusChip } from "./parts";

const REPO_OK = /^[\w.-]+\/[\w.-]+$/;
const btn = "rounded border border-white/20 px-3 py-1 text-sm disabled:opacity-40";

/** Short summary shown when more than one cell is selected. */
export function MultiSummary({ cells }: { cells: PanelCell[] }) {
  return (
    <div data-testid="multi-summary">
      <h2 className="m-0 mb-2 text-base font-semibold">{cells.length} cells selected</h2>
      <ul className="m-0 mb-2 list-none p-0 text-sm">
        {STATUS_ORDER.map((s) => {
          const n = cells.filter((c) => c.status === s).length;
          return n ? (
            <li key={s}>
              {STATUS_META[s].icon} {STATUS_META[s].label}: {n}
            </li>
          ) : null;
        })}
      </ul>
      <p className="m-0 text-xs opacity-70">{cells.map((c) => c.id).join(", ")}</p>
      <p className="mt-2 text-xs opacity-70">Select a single cell for details and actions. Esc clears the selection.</p>
    </div>
  );
}

export function CellDetails({ cell, repo, onAdmin }: { cell: PanelCell; repo: string; onAdmin(a: AdminAction): void }) {
  const { launcher } = usePanel();
  const branch = `cell/${cell.id}`;
  const gh = REPO_OK.test(repo) ? `https://github.com/${repo}` : null;
  const canOpenChat = cell.status === "running" || cell.status === "expired";
  const canRelease = cell.status !== "done" && cell.status !== "waiting";
  const holder = launcher.owner(cell.id);

  return (
    <div data-testid="cell-details">
      <div className="mb-1 flex items-center gap-2">
        <span className="font-mono text-sm">{cell.id}</span>
        <StatusChip status={cell.status} />
      </div>
      <h2 className="m-0 mb-3 text-base font-semibold">{cell.title}</h2>

      <div className="mb-3 flex flex-wrap gap-2">
        <button type="button" className={btn} disabled={!canOpenChat} onClick={() => launcher.open(cell.id)}>
          Continue in my chat
        </button>
        {cell.status === "ready" && (
          <button type="button" className={btn} onClick={() => launcher.start(cell.id)}>
            Start
          </button>
        )}
        <button type="button" className={btn} disabled={!canRelease} onClick={() => onAdmin("release")}>
          Release
        </button>
        {cell.status === "needs_human" && (
          <button type="button" className={btn} onClick={() => onAdmin("clear-feedback")}>
            Clear feedback
          </button>
        )}
        {gh && cell.sha.tip ? (
          <a className={btn} href={`${gh}/tree/${branch}`} target="_blank" rel="noopener noreferrer">
            Open branch on GitHub
          </a>
        ) : (
          <button type="button" className={btn} disabled>
            Open branch on GitHub
          </button>
        )}
      </div>

      <dl className="m-0">
        <Field label="Lease">
          <LeaseBar lease={cell.lease} />
        </Field>
        <Field label="Attempts">
          {cell.attempts}/{cell.maxAttempts}
        </Field>
        <Field label="Branch">
          <span className="font-mono">{branch}</span>
        </Field>
        <Field label="Lock / tip sha">
          <span className="font-mono">
            {cell.sha.lock ?? "-"} / {cell.sha.tip ?? "-"}
          </span>
        </Field>
        <Field label="Last commit">{cell.lastCommit ? cell.lastCommit.subject : "-"}</Field>
        <Field label="Next step">{cell.lastCommit?.next ?? "-"}</Field>
        <Field label="Holder">{holder ?? "-"}</Field>
        <Field label="Pull request">
          {cell.pr && gh ? (
            <a className="underline" href={`${gh}/pull/${cell.pr.number}`} target="_blank" rel="noopener noreferrer">
              #{cell.pr.number} ({cell.pr.state})
            </a>
          ) : (
            "-"
          )}
        </Field>
        <Field label="Allowed files">
          {cell.allowedPaths.length ? (
            <ul className="m-0 list-none p-0 font-mono text-xs">
              {cell.allowedPaths.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          ) : (
            "-"
          )}
        </Field>
      </dl>
    </div>
  );
}
