// common.ts
//
// Shared helpers of the cell engine modules (plan loading, small formatters, fresh reads). Imports no other engine module.

import { stringify } from "yaml";

import type { GitHubApi, Snapshot } from "./api.ts";
import { loadCells, loadConfig, mergedFromSubjects, validate, type Cell, type Config } from "./plan.ts";

export interface EngineOptions {
  mainBranch: string;
  historyPages: number;
  now: () => number; // epoch ms
  sleep: (ms: number) => Promise<void>;
  uuid: () => string;
}

export interface Loaded {
  cells: Record<string, Cell>;
  cfg: Config;
  errors: string[];
  warnings: string[];
}

// ---------------------------------------------------------------- plan loading (cached per main commit)
export const planCache = new Map<string, Loaded>();

export function clearPlanCache(): void {
  planCache.clear();
}

export function loadPlan(repo: string, snap: Snapshot, opts: EngineOptions): Loaded {
  const key = `${repo}@${snap.mainOid}@${opts.mainBranch}`;
  const hit = planCache.get(key);
  if (hit) return hit;
  const { cfg, errors: cfgErrors } = loadConfig(snap.blueprint);
  const { cells, errors: loadErrors } = loadCells(snap.cellFiles);
  const v = validate(cells, cfg);
  const errors = [...cfgErrors, ...loadErrors, ...v.errors];
  if (cfg.main_branch !== opts.mainBranch) {
    errors.unshift(`blueprint.yaml main_branch is '${cfg.main_branch}' but this connector is configured for '${opts.mainBranch}' (MAIN_BRANCH)`);
  }
  const loaded = { cells, cfg, errors, warnings: v.warnings };
  if (planCache.size >= 20) planCache.delete(planCache.keys().next().value as string);
  planCache.set(key, loaded);
  return loaded;
}

export function invalidText(plan: Loaded): string {
  const shown = plan.errors.slice(0, 5).map((e) => ` - ${e}`);
  const more = plan.errors.length > 5 ? [` - (+${plan.errors.length - 5} more; run tools/validate_graph.py)`] : [];
  return ["INVALID_PLAN: fix the plan before running cells", ...shown, ...more].join("\n");
}

export function cellYaml(cell: Cell): string {
  const c: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cell)) if (k !== "priority" && k !== "lease_minutes") c[k] = v;
  return stringify(c, { lineWidth: 0 }).trimEnd();
}

export function branchOf(id: string): string {
  return `cell/${id}`;
}

export function oneLine(s: string, max: number): string {
  return s.replace(/\s+/g, " ").trim().slice(0, max);
}

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function short(oid: string): string {
  return oid.slice(0, 7);
}

// ---------------------------------------------------------------- fresh reads
// GitHub's GraphQL reads can lag a few seconds behind writes (seen live: files committed by init_blueprint were
// invisible for a while). A stale main would show a just-merged cell as unmerged, so before any decision that
// writes, the snapshot's main commit is compared with the ref endpoint and re-read until they agree.
export async function freshSnapshot(api: GitHubApi, repo: string, opts: EngineOptions, pages: number): Promise<Snapshot | string> {
  for (let attempt = 0; attempt < 4; attempt++) {
    let snap: Snapshot;
    try {
      snap = await api.snapshot(repo, opts.mainBranch, pages);
    } catch (e) {
      if (/branch .* not found/.test(errText(e))) return `EMPTY_REPO: ${repo} has no ${opts.mainBranch} branch yet. Call init_blueprint (it creates the first commit).`;
      throw e;
    }
    const tip = await api.branchTip(repo, opts.mainBranch);
    if (!tip || tip.oid === snap.mainOid) return snap;
    await opts.sleep(1500);
  }
  return "STALE_READ: GitHub's read replica is behind the latest commit. Retry in a few seconds.";
}

export const NOT_INIT = "NOT_INITIALIZED: this repository has no Blueprint (blueprint.yaml). Call init_blueprint to install it, then add cells.";

// ---------------------------------------------------------------- path safety
export function cleanPath(raw: string): string | null {
  const p = raw.trim().replace(/^\.\//, "");
  if (!p || p.length > 300 || p.startsWith("/") || p.includes("\\") || p.includes("\0")) return null;
  const segs = p.split("/");
  if (segs.some((s) => s === "" || s === "." || s === ".." || s.toLowerCase() === ".git")) return null;
  return p;
}

/** A missing branch usually means the cell was merged while this chat was idle: say so clearly. */
export async function notClaimed(api: GitHubApi, repo: string, id: string): Promise<string> {
  try {
    const pr = await api.findPr(repo, branchOf(id));
    if (pr?.merged) return `CELL_DONE ${id}: already merged (PR #${pr.number}) by this or another chat. Nothing to do and nothing was written. Call next_cell for new work.`;
  } catch {
    /* fall through to the generic message */
  }
  return `NOT_CLAIMED ${id}: there is no branch ${branchOf(id)} (never claimed, or deleted). Call next_cell first.`;
}

/** Cells known to be merged: from the main branch commit subjects, plus ids another source reported (snap.mergedIds). */
export function mergedOf(snap: Snapshot): Set<string> {
  return new Set([...mergedFromSubjects(snap.subjects), ...(snap.mergedIds ?? [])]);
}
