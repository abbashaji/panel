// signal.ts
//
// cell_signal: heartbeat (renew the lease), release (give the cell up), feedback (ask a human to decide).
// Each signal is ONE empty commit on the cell branch, fenced by base like apply_changes.

import type { GitHubApi } from "./api.ts";
import { ID_RE } from "./plan.ts";
import { branchOf, errText, invalidText, loadPlan, notClaimed, oneLine, short, type EngineOptions } from "./common.ts";
import { carry } from "./trailers.ts";
import { CONFLICT_HINT, movedBySync } from "./apply.ts";

export async function cellSignal(
  api: GitHubApi,
  repo: string,
  opts: EngineOptions,
  a: { cell_id: string; base: string; kind: "heartbeat" | "release" | "feedback"; text?: string; next?: string },
): Promise<string> {
  const id = a.cell_id;
  if (!ID_RE.test(id)) return `BAD_CELL_ID ${id}`;
  if (a.kind !== "heartbeat" && a.kind !== "release" && a.kind !== "feedback") return `BAD_KIND ${String(a.kind)}: use heartbeat, release or feedback`;

  const text = oneLine(a.text ?? "", a.kind === "feedback" ? 300 : 200);
  const next = oneLine(a.next ?? "", 300);
  if (a.kind === "release" && next.length < 3) return "MISSING_NEXT: say what the next step is (next:), it is how a fresh chat resumes";
  if (a.kind === "feedback" && text.length < 3) return "MISSING_TEXT: say what you need a human to decide (text:)";

  const snap = await api.snapshot(repo, opts.mainBranch, 0);
  const plan = loadPlan(repo, snap, opts);
  if (plan.errors.length) return invalidText(plan);
  if (!plan.cells[id]) return `UNKNOWN_CELL ${id}`;
  const branch = snap.branches[branchOf(id)];
  if (!branch) return notClaimed(api, repo, id);
  const base = String(a.base ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(base)) return "MISSING_BASE: pass base = the 7-character sha from the last CLAIMED / RESUME / ok response";
  let bySync = false;
  if (!branch.oid.startsWith(base)) {
    if (await movedBySync(api, repo, id, base)) bySync = true;
    else {
      const tip = oneLine(branch.message.split("\n", 1)[0] ?? "", 120);
      return `CONFLICT ${id}: ${branchOf(id)} is at ${short(branch.oid)}, not ${base.slice(0, 7)}. ${CONFLICT_HINT} Nothing was written. Stop and call next_cell. tip: ${tip}`;
    }
  }

  let subject: string;
  if (a.kind === "heartbeat") subject = `hb(${id}): alive`;
  else if (a.kind === "release") subject = `release(${id}): ${text || "yield"}`;
  else subject = `feedback(${id}): ${text}`;
  const message = carry(branch.message, subject, { next: next.length >= 3 ? next : undefined });

  let oid: string;
  try {
    oid = await api.commitEmpty(repo, branch.oid, branch.treeOid, message);
  } catch (e) {
    return `ERROR: could not create the commit: ${errText(e)}`;
  }
  const moved = await api.fastForward(repo, branchOf(id), oid);
  if (moved === "missing") return notClaimed(api, repo, id);
  if (moved !== "ok") {
    const tip = oneLine(branch.message.split("\n", 1)[0] ?? "", 120);
    return `CONFLICT ${id}: ${branchOf(id)} moved while you were writing (taken over, or another chat is writing). Nothing was written. Stop and call next_cell. tip: ${tip}`;
  }
  const note = bySync ? `\nbase moved by an automatic sync; new base=${short(oid)}` : "";
  if (a.kind === "heartbeat") return `ok ${short(oid)} (next base=${short(oid)})${note}`;
  if (a.kind === "release") return `released ${id}: the lease is over; another chat will adopt it${note}`;
  return `feedback recorded for ${id}: stop now; a human decides${note}`;
}
