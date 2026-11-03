// takeover.ts
//
// takeover_cell: a fresh chat takes a cell from a dead one.

import type { GitHubApi } from "./api.ts";
import { ID_RE, parseRuns } from "./plan.ts";
import { branchOf, errText, invalidText, loadPlan, mergedOf, type EngineOptions } from "./common.ts";
import { resumeText } from "./resume.ts";
import { tryTakeover } from "./claim.ts";
import { carry, isFeedback, subjectOf } from "./trailers.ts";

export async function takeoverCell(
  api: GitHubApi,
  repo: string,
  opts: EngineOptions,
  id: string,
  force: boolean,
  extra: { handoff?: boolean; clear_feedback?: boolean } = {},
): Promise<string> {
  if (!ID_RE.test(id)) return `UNKNOWN_CELL ${id}`;
  const snap = await api.snapshot(repo, opts.mainBranch, opts.historyPages);
  const plan = loadPlan(repo, snap, opts);
  if (plan.errors.length) return invalidText(plan);
  if (!(id in plan.cells)) return `UNKNOWN_CELL ${id}`;
  if (mergedOf(snap).has(id)) return `ALREADY_DONE ${id}`;
  if (!snap.branches[branchOf(id)]) return `NOT_RUNNING ${id}: no branch ${branchOf(id)}; use next_cell`;
  if (!force) {
    let ci: Record<string, number> = {};
    try {
      ci = parseRuns(await api.activeRuns(repo), opts.now());
    } catch {
      /* unknown CI state: do not block a deliberate takeover */
    }
    if (id in ci && ci[id] < plan.cfg.max_ci_minutes) {
      return `CI_RUNNING ${id}: a workflow started ${Math.round(ci[id])}m ago is still active. The chat is probably just waiting for it. Use force=true to take over anyway.`;
    }
  }
  const b = snap.branches[branchOf(id)];
  if (isFeedback(b.message) && extra.clear_feedback !== true) {
    const text = subjectOf(b.message).replace(/^feedback\([^)]*\):\s*/, "");
    return `NEEDS_HUMAN ${id}: ${text}. Resolve it, then call again with clear_feedback=true (or supersede the cell).`;
  }
  if (extra.handoff === true) {
    try {
      const oid = await api.commitEmpty(repo, b.oid, b.treeOid, carry(b.message, `release(${id}): handoff`));
      if ((await api.fastForward(repo, branchOf(id), oid)) === "ok") return `RELEASED ${id}: handed off. Tell a fresh chat to call next_cell.`;
    } catch (e) {
      return `TAKEOVER_FAILED ${id}: ${errText(e)}`;
    }
    return `TAKEOVER_FAILED ${id}: someone else just updated the branch`;
  }
  const tip = await tryTakeover(api, repo, snap, id, opts, "adopt");
  if (!tip) return `TAKEOVER_FAILED ${id}: someone else just updated the branch`;
  return resumeText(api, repo, snap, plan, id, tip);
}
