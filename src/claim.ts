// claim.ts
//
// Claiming and taking over cells, and next_cell / ready_cells.

import type { GitHubApi, Snapshot } from "./api.ts";
import { claimsFromBranches, computeState, leaseOf, parseRuns, render, type State } from "./plan.ts";
import { RULES } from "./protocol.ts";
import { NOT_INIT, branchOf, cellYaml, errText, freshSnapshot, invalidText, loadPlan, mergedOf, short, type EngineOptions, type Loaded } from "./common.ts";
import { resumeText } from "./resume.ts";
import { carry, isFeedback, isRelease, parseTrailers } from "./trailers.ts";

// ---------------------------------------------------------------- claim / takeover primitives
export async function tryClaim(api: GitHubApi, repo: string, snap: Snapshot, id: string, opts: EngineOptions): Promise<string | null> {
  // Each claimer makes its OWN lock commit, then creates the branch: GitHub refuses a second creation of the
  // same branch, so exactly one claimer wins. A losing claimer leaves one unreferenced commit (harmless).
  const oid = await api.commitEmpty(repo, snap.mainOid, snap.mainTreeOid, `claim(${id}): lock ${opts.uuid()}`);
  return (await api.createBranch(repo, branchOf(id), oid)) === "created" ? oid : null;
}

export async function tryTakeover(api: GitHubApi, repo: string, snap: Snapshot, id: string, opts: EngineOptions, kind: "takeover" | "adopt" = "takeover"): Promise<string | null> {
  // One new commit on the OLD tip, then a non-force ref update: only a fast-forward from the tip we read is
  // accepted, so two chats racing for the same dead cell cannot both win. The returned oid is the new owner's
  // fencing token: apply_changes must present the tip it believes is current (base), so a previous owner that
  // wakes up later is refused instead of writing on top of the new owner's work.
  const b = snap.branches[branchOf(id)];
  if (!b) return null;
  // next: and attempt: are carried forward from the old tip; only a takeover of an expired lease counts as an attempt.
  const message = carry(b.message, `${kind}(${id}): lock ${opts.uuid()}`, kind === "takeover" ? { attempt: parseTrailers(b.message).attempt + 1 } : {});
  const oid = await api.commitEmpty(repo, b.oid, b.treeOid, message);
  return (await api.fastForward(repo, branchOf(id), oid)) === "ok" ? oid : null;
}

export function claimedText(plan: Loaded, repo: string, id: string, tip: string, critical = false): string {
  let lease = leaseOf(plan.cells[id], plan.cfg.lease_minutes);
  if (critical) lease = Math.min(lease, plan.cfg.critical_lease_minutes);
  return `CLAIMED ${id} base=${short(tip)} repo=${repo} (lease ${lease} min, renewed by every apply_changes)\n\n${cellYaml(plan.cells[id])}\n\n${RULES}`;
}

// ---------------------------------------------------------------- next_cell / ready_cells
export async function nextCell(api: GitHubApi, repo: string, opts: EngineOptions, mode: "claim" | "peek"): Promise<string> {
  let snap: Snapshot;
  if (mode === "claim") {
    const f = await freshSnapshot(api, repo, opts, opts.historyPages);
    if (typeof f === "string") return f;
    snap = f;
  } else {
    snap = await api.snapshot(repo, opts.mainBranch, opts.historyPages);
  }
  if (snap.blueprint === null) return NOT_INIT;
  const plan = loadPlan(repo, snap, opts);
  if (Object.keys(plan.cells).length === 0 && Object.keys(snap.cellFiles).filter((f) => !f.startsWith("_")).length === 0) {
    return "NO_PLAN: Blueprint is installed but cells/ has no cells yet. A human (or a planning chat) must add cells/C-000.yaml ... (see cells/_TEMPLATE.yaml).";
  }
  if (plan.errors.length) return invalidText(plan);

  const now = opts.now();
  const merged = mergedOf(snap);
  const claims = claimsFromBranches(snap.branches, now);
  let ci: Record<string, number> = {};
  let warn = "";
  // Release / attempt / feedback state comes from the tip commit of each cell/C-NNN branch.
  const released: string[] = [];
  const feedback: string[] = [];
  const attempts: Record<string, number> = {};
  for (const [name, b] of Object.entries(snap.branches)) {
    const m = /^cell\/(C-\d+)$/.exec(name);
    if (!m) continue;
    if (isRelease(b.message)) released.push(m[1]);
    if (isFeedback(b.message)) feedback.push(m[1]);
    attempts[m[1]] = parseTrailers(b.message).attempt;
  }
  const compute = () =>
    computeState(plan.cells, merged, claims, plan.cfg.lease_minutes, ci, plan.cfg.max_ci_minutes, plan.cfg.bottleneck_threshold, {
      criticalLeaseMinutes: plan.cfg.critical_lease_minutes,
      criticalChainThreshold: plan.cfg.critical_chain_threshold,
      criticalTransitiveThreshold: plan.cfg.critical_transitive_threshold,
      parkMaxMinutes: plan.cfg.park_max_minutes,
      maxAttempts: plan.cfg.max_attempts,
      released,
      attempts,
      feedback,
    });

  let state: State = compute();
  // The CI signal only matters when an expired lease could otherwise be handed out: ask GitHub only then.
  if (state.ready.some((r) => r.reclaim)) {
    try {
      ci = parseRuns(await api.activeRuns(repo), now);
      state = compute();
    } catch (e) {
      warn = `\nWARN: could not read workflow runs (${errText(e)}); using the commit lease only.`;
    }
  }

  if (mode === "peek" || state.status !== "ready") {
    const note = !snap.historyComplete && state.status === "ready"
      ? `\nNOTE: merge history is longer than ${opts.historyPages * 100} commits; next_cell double-checks before it claims.`
      : "";
    return render(state) + warn + note;
  }

  const tried = new Set<string>();
  for (let guard = 0; guard < 100; guard++) {
    const r = state.ready.find((x) => !tried.has(x.id));
    if (!r) break;
    tried.add(r.id);
    if (!snap.historyComplete && snap.mergedIds === undefined) {
      // An old merge may be beyond the history window: confirm through the cell's PR before handing it out.
      const pr = await api.findPr(repo, branchOf(r.id));
      if (pr?.merged) {
        merged.add(r.id);
        state = compute();
        continue;
      }
    }
    if (r.reclaim) {
      const old = snap.branches[branchOf(r.id)];
      const kind = old && isRelease(old.message) ? "adopt" : "takeover";
      const tip = await tryTakeover(api, repo, snap, r.id, opts, kind);
      if (tip) return (await resumeText(api, repo, snap, plan, r.id, tip, (old ? parseTrailers(old.message).attempt : 0) + (kind === "takeover" ? 1 : 0))) + warn;
      continue;
    }
    const tip = await tryClaim(api, repo, snap, r.id, opts);
    if (tip) return claimedText(plan, repo, r.id, tip, r.critical) + warn;
  }
  return state.ready.length
    ? "CLAIM_FAILED: every ready cell was taken by someone else just now. Ask again."
    : render(state) + warn;
}
