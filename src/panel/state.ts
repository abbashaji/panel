// Builds the PanelState JSON (docs/panel-contracts.md 3.2). Cell logic is NOT duplicated: status, ready, locked and
// waiting come from computeState(); dependents, waves and graph helpers come from plan.ts.
import type { GitHubApi } from "../api.ts";
import { branchOf, loadPlan, mergedOf, short, type EngineOptions } from "../common.ts";
import { createGitHubApi } from "../github.ts";
import {
  claimsFromBranches,
  computeState,
  directDependents,
  hardGraph,
  inputsOf,
  leaseOf,
  parseRuns,
  slist,
  superseders,
  transitiveDependents,
  waves,
} from "../plan.ts";
import { STEWARD_BRANCH, readTip, stewardStatus, type LeaseTip, type StewardStatus } from "../steward.ts";
import { isFeedback, isRelease, parseTrailers, subjectOf } from "../trailers.ts";
import type { CellType, PanelCell, PanelCounts, PanelDepend, PanelEnv, PanelState, PanelSteward, PanelStatus } from "./types.ts";

export interface PanelDeps {
  api?: GitHubApi;
  opts?: EngineOptions;
}

const TTL_MS = 60_000;
const LOCK_PAGES = 5;
const cache = new Map<string, { key: string; at: number; state: PanelState }>();

export function clearPanelCache(): void {
  cache.clear();
}

function defaultOptions(env: PanelEnv): EngineOptions {
  return {
    mainBranch: env.MAIN_BRANCH || "main",
    historyPages: Math.max(0, Number(env.HISTORY_PAGES ?? 3) || 0),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    uuid: () => crypto.randomUUID(),
  };
}

async function lockSha(api: GitHubApi, repo: string, id: string): Promise<string | null> {
  const re = new RegExp(`^(claim|takeover|adopt)\\(${id}\\):`);
  try {
    for (let page = 1; page <= LOCK_PAGES; page++) {
      const commits = await api.branchCommits(repo, branchOf(id), page, 100);
      if (!commits || commits.length === 0) return null;
      const hit = commits.find((c) => re.test(subjectOf(c.message)));
      if (hit) return short(hit.oid);
    }
  } catch {
    /* the lock sha is optional */
  }
  return null;
}

async function reservedBy(env: PanelEnv, repo: string, id: string): Promise<string | null> {
  try {
    const raw = await env.OAUTH_KV?.get(`reserve:${repo}:${id}`);
    const who = raw ? JSON.parse(raw)?.who : null;
    return typeof who === "string" ? who : null;
  } catch {
    return null;
  }
}

export function toPanelSteward(st: StewardStatus, problems: number): PanelSteward {
  return {
    status: st.state,
    holder: st.state === "none" ? null : st.holder,
    minutesLeft: st.state === "active" ? st.minutesLeft : null,
    expiredMinutesAgo: st.state === "expired" ? st.expiredMinutesAgo : null,
    problems,
  };
}

/** The Steward lease is outside cell/, so it may be missing from the snapshot: read it directly then. Never fails. */
async function stewardOf(api: GitHubApi, repo: string, snap: { branches: Record<string, unknown> }, leaseMinutes: number, now: number, problems: number): Promise<PanelSteward> {
  let tip = (snap.branches?.[STEWARD_BRANCH] as LeaseTip | undefined) ?? null;
  if (!tip) {
    try {
      tip = await readTip(api, repo, STEWARD_BRANCH);
    } catch {
      tip = null;
    }
  }
  const lm = Number.isInteger(leaseMinutes) && leaseMinutes > 0 ? leaseMinutes : 60;
  return toPanelSteward(stewardStatus(tip, now, lm), problems);
}

/** reservedBy and the Steward lease age change without any git change, so they are never served from the cache. */
async function withReservations(env: PanelEnv, repo: string, state: PanelState, steward?: PanelSteward): Promise<PanelState> {
  const cells = await Promise.all(
    state.cells.map(async (c) => ({ ...c, reservedBy: c.status === "done" ? null : await reservedBy(env, repo, c.id) })),
  );
  return { ...state, ...(steward ? { steward } : {}), cells };
}

export async function buildPanelState(env: PanelEnv, repo: string, deps: PanelDeps = {}): Promise<PanelState> {
  const opts = deps.opts ?? defaultOptions(env);
  let api = deps.api;
  if (!api) {
    if (!env.GITHUB_TOKEN) throw new Error("NOT_CONFIGURED: GITHUB_TOKEN secret is not set");
    api = createGitHubApi(env.GITHUB_TOKEN);
  }
  const now = opts.now();
  const snap = await api.snapshot(repo, opts.mainBranch, opts.historyPages);
  if (snap.blueprint === null) throw new Error("NOT_INITIALIZED: this repository has no Blueprint (blueprint.yaml)");
  const plan = loadPlan(repo, snap, opts);
  if (plan.errors.length) throw new Error(`INVALID_PLAN: ${plan.errors[0]}`);
  const leaseMinutes = Number(plan.cfg.lease_minutes);

  const tips = Object.keys(snap.branches).sort().map((n) => `${n}:${snap.branches[n].oid}`);
  const key = [snap.mainOid, ...tips].join("|");
  const ck = `${repo}@${opts.mainBranch}`;
  const hit = cache.get(ck);
  if (hit && hit.key === key && now - hit.at < TTL_MS) {
    const fresh = await stewardOf(api, repo, snap, leaseMinutes, now, hit.state.steward?.problems ?? 0);
    return withReservations(env, repo, hit.state, fresh);
  }

  const { cells, cfg } = plan;
  const merged = mergedOf(snap);
  const claims = claimsFromBranches(snap.branches, now);
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
  let ci: Record<string, number> = {};
  const compute = () =>
    computeState(cells, merged, claims, cfg.lease_minutes, ci, cfg.max_ci_minutes, cfg.bottleneck_threshold, {
      criticalLeaseMinutes: cfg.critical_lease_minutes,
      criticalChainThreshold: cfg.critical_chain_threshold,
      criticalTransitiveThreshold: cfg.critical_transitive_threshold,
      parkMaxMinutes: cfg.park_max_minutes,
      maxAttempts: cfg.max_attempts,
      released,
      attempts,
      feedback,
    });
  let state = compute();
  if (state.ready.some((r) => r.reclaim)) {
    try {
      ci = parseRuns(await api.activeRuns(repo), now);
      state = compute();
    } catch {
      /* commit lease only */
    }
  }

  const ready = new Map(state.ready.map((r) => [r.id, r]));
  const locked = new Map(state.locked.map((r) => [r.id, r]));
  const waiting = new Map(state.waiting.map((r) => [r.id, r]));
  const split = new Set((state.needs_split ?? []).map((r) => r.id));
  const human = new Set((state.needs_human ?? []).map((r) => r.id));
  const sup = superseders(cells);

  const ids = Object.keys(cells).sort();
  const direct = directDependents(cells);
  const trans = transitiveDependents(cells);
  const graph = hardGraph(cells);
  const wave: Record<string, number> = {};
  for (const [lv, list] of Object.entries(waves(cells))) for (const id of list) wave[id] = Number(lv);
  const dependents: Record<string, string[]> = {};
  for (const id of ids) dependents[id] = [];
  for (const [c, ds] of Object.entries(graph)) for (const d of ds) dependents[d].push(c);
  const depth: Record<string, number> = {};
  const dp = (n: string): number => (depth[n] ??= 1 + Math.max(0, ...dependents[n].map(dp)));
  // Same rule as computeState (which only reports it for ready cells): the panel needs it for every cell.
  const isCritical = (id: string) =>
    direct[id] >= cfg.bottleneck_threshold || dp(id) - 1 >= cfg.critical_chain_threshold || trans[id] >= cfg.critical_transitive_threshold;

  const statusOf = (id: string): PanelStatus => {
    if (merged.has(id)) return "done";
    if (locked.has(id)) return "running";
    if (ready.has(id)) return ready.get(id)!.reclaim ? "expired" : "ready";
    if (human.has(id)) return "needs_human";
    if (split.has(id)) return "needs_split";
    return "waiting";
  };

  const cellsOut: PanelCell[] = await Promise.all(
    ids.map(async (id) => {
      const c = cells[id];
      const status = statusOf(id);
      const b = snap.branches[branchOf(id)];
      const critical = isCritical(id);
      let lease: PanelCell["lease"] = null;
      if (b && locked.has(id)) {
        const l = locked.get(id)!;
        lease = { minutesLeft: l.minutes_left, expiredMinutesAgo: null, ci: !!l.ci };
      } else if (b && (status === "expired" || status === "needs_split" || status === "needs_human")) {
        let len = leaseOf(c, cfg.lease_minutes);
        if (critical) len = Math.min(len, cfg.critical_lease_minutes);
        lease = { minutesLeft: 0, expiredMinutesAgo: Math.max(0, Math.round((claims[id] ?? 0) - len)), ci: false };
      }
      const depends: PanelDepend[] = [];
      for (const i of inputsOf(c)) {
        if (typeof i.from === "string" && i.from in cells && !depends.some((d) => d.id === i.from)) {
          depends.push({ id: i.from, kind: i.kind === "contract" ? "contract" : "implementation" });
        }
      }
      for (const a of slist(c, "after")) if (a in cells && !depends.some((d) => d.id === a)) depends.push({ id: a, kind: "implementation" });

      let pr: PanelCell["pr"] = null;
      let lock: string | null = null;
      if (b) {
        const [p, l] = await Promise.all([
          api.findPr(repo, branchOf(id)).catch(() => null),
          lockSha(api, repo, id),
        ]);
        lock = l;
        if (p) pr = { number: p.number, state: p.merged ? "merged" : p.state === "open" ? "open" : "closed" };
      }
      // Ready again after a release/handoff, or a branch whose lease ran out: the next claim resumes it.
      const resumable = !!b && (status === "expired" || (status === "ready" && released.includes(id)));
      const blockedBy = waiting.get(id)?.blocked_by ?? (status === "waiting" && id in sup ? sup[id].filter((x) => !merged.has(x)) : []);
      return {
        id,
        title: String(c.title ?? id),
        type: (c.type === "skeleton" || c.type === "integration" ? c.type : "normal") as CellType,
        priority: Number.isInteger(c.priority) ? (c.priority as number) : 0,
        status,
        critical,
        wave: wave[id] ?? 0,
        depends,
        blockedBy,
        directDependents: direct[id],
        transitiveDependents: trans[id],
        sha: { lock, tip: b ? short(b.oid) : null, merged: null },
        lease,
        attempts: attempts[id] ?? 0,
        maxAttempts: cfg.max_attempts,
        lastCommit: b ? { subject: subjectOf(b.message), next: parseTrailers(b.message).next ?? null, at: b.committedDate } : null,
        reservedBy: status === "done" ? null : await reservedBy(env, repo, id),
        pr,
        resumable,
        allowedPaths: slist(c, "allowed_paths"),
        provides: slist(c, "provides"),
        inputs: inputsOf(c).map((i) => String(i.from)),
      };
    }),
  );

  const counts: PanelCounts = { done: 0, running: 0, ready: 0, waiting: 0, expired: 0, needs_human: 0, needs_split: 0 };
  for (const c of cellsOut) counts[c.status]++;
  let bottleneck: PanelState["bottleneck"] = null;
  for (const c of cellsOut) {
    if (c.status === "done" || c.transitiveDependents === 0) continue;
    if (!bottleneck || c.transitiveDependents > bottleneck.blocks) bottleneck = { id: c.id, blocks: c.transitiveDependents };
  }

  const out: PanelState = {
    repo,
    project: String(cfg.project ?? repo.split("/")[1] ?? repo),
    mainSha: short(snap.mainOid),
    generatedAt: new Date(now).toISOString(),
    counts,
    cells: cellsOut,
    bottleneck,
    steward: await stewardOf(api, repo, snap, leaseMinutes, now, human.size + split.size),
  };
  cache.set(ck, { key, at: now, state: out });
  return out;
}
