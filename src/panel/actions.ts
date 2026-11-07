// Panel actions: POST /panel/api/reserve, /release, /clear-feedback (docs/panel-contracts.md sections 3.3 and 3.4).
// Returns null for every path this module does not own, so the router answers 404.
// admin_key is compared to ADMIN_TOKEN timing-safe; it is never stored, logged or echoed.
import { clearReservation, getReservation, setReservation, type ReserveKv } from "../claim.ts";
import type { GitHubApi } from "../api.ts";
import { claimsFromBranches, computeState, parseRuns } from "../plan.ts";
import { loadPlan, mergedOf, type EngineOptions } from "../common.ts";
import { resolveRepo } from "../engine.ts";
import { createGitHubApi } from "../github.ts";
import { isFeedback, isRelease, parseTrailers } from "../trailers.ts";
import { engineOptions, toolHandlers } from "../tools.ts";
import { json, readBounded, requirePanelAuth, timingSafeEqual } from "./auth.ts";
import { STEWARD_BRANCH, parseLease, readTip, releaseSteward, stewardStatus } from "../steward.ts";
import { buildPanelState, clearPanelCache, toPanelSteward } from "./state.ts";
import { STEWARD_CODE_TTL, mintStewardCode, type StewardCodeKv } from "../steward_code.ts";
import type { PanelEnv, PanelStatus, PanelSteward, ReserveResult, StewardCodeResult } from "./types.ts";

const CELL_RE = /^C-\d{3,5}$/;
const WHO_RE = /^[\w .-]{1,40}$/;
const OWNED = new Set(["/panel/api/reserve", "/panel/api/release", "/panel/api/clear-feedback", "/panel/api/steward-release", "/panel/api/steward-code"]);
const CODE_RATE_MAX = 5; // codes per minute per repo

/** The cell after the write, computed by the same logic as GET /panel/api/state. */
export interface CellInfo {
  id: string;
  status: PanelStatus;
  resumable: boolean;
}
export interface Readiness {
  ready: boolean;
  detail: string;
}
/** Injectable for tests; the defaults use the real engine. */
export interface ActionDeps {
  readiness?: (env: PanelEnv, repo: string, cell: string) => Promise<Readiness>;
  takeover?: (env: PanelEnv, repo: string, cell: string, adminKey: string, mode: "release" | "clear") => Promise<string>;
  cellInfo?: (env: PanelEnv, repo: string, cell: string, deps: ActionDeps) => Promise<CellInfo | null>;
  /** used by the default cellInfo (tests) */
  api?: GitHubApi;
  opts?: EngineOptions;
}

async function defaultReadiness(env: PanelEnv, repo: string, id: string): Promise<Readiness> {
  const opts = engineOptions(env);
  const api = createGitHubApi(env.GITHUB_TOKEN);
  const snap = await api.snapshot(repo, opts.mainBranch, opts.historyPages);
  if (snap.blueprint === null) return { ready: false, detail: "Blueprint is not installed" };
  const plan = loadPlan(repo, snap, opts);
  if (plan.errors.length) return { ready: false, detail: "the plan is invalid" };
  if (!plan.cells[id]) return { ready: false, detail: "unknown cell" };
  const merged = mergedOf(snap);
  if (merged.has(id)) return { ready: false, detail: "done (already merged)" };
  const now = opts.now();
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
  let state: any = compute();
  if (state.ready.some((r: any) => r.reclaim)) {
    try {
      ci = parseRuns(await api.activeRuns(repo), now);
      state = compute();
    } catch {
      /* commit lease only */
    }
  }
  if (state.ready.some((r: any) => r.id === id)) return { ready: true, detail: "ready" };
  const has = (l: any) => Array.isArray(l) && l.some((x: any) => x === id || x?.id === id);
  const lk = (state.locked ?? []).find((x: any) => x?.id === id);
  if (lk) return { ready: false, detail: "running" };
  const w = (state.waiting ?? []).find((x: any) => x?.id === id);
  if (w) return { ready: false, detail: Array.isArray(w.blocked_by) && w.blocked_by.length ? `waiting for ${w.blocked_by.join(", ")}` : "waiting for other cells" };
  if (has(state.needs_human)) return { ready: false, detail: "needs a human" };
  if (has(state.needs_split)) return { ready: false, detail: "needs to be split" };
  return { ready: false, detail: "not ready" };
}

async function defaultCellInfo(env: PanelEnv, repo: string, id: string, deps: ActionDeps): Promise<CellInfo | null> {
  clearPanelCache();
  const s = await buildPanelState(env, repo, { api: deps.api, opts: deps.opts });
  const c = s.cells.find((x) => x.id === id);
  return c ? { id, status: c.status, resumable: c.resumable === true } : null;
}

/** Never fails the action: when the new state cannot be read the answer simply has no cell. */
async function cellInfoOf(env: PanelEnv, repo: string, id: string, deps: ActionDeps): Promise<CellInfo | null> {
  try {
    return await (deps.cellInfo ?? defaultCellInfo)(env, repo, id, deps);
  } catch {
    return null;
  }
}

async function defaultTakeover(env: PanelEnv, repo: string, cell: string, adminKey: string, mode: "release" | "clear"): Promise<string> {
  const h = toolHandlers(env, engineOptions(env));
  return h.takeover(mode === "release" ? { repo, cell_id: cell, admin_key: adminKey, handoff: true } : { repo, cell_id: cell, admin_key: adminKey, clear_feedback: true });
}

/** Owner override: handoff-release the Steward lease whoever holds it (the holder's own session is read from the lease). */
async function releaseStewardAsOwner(env: PanelEnv, repo: string, deps: ActionDeps, api: GitHubApi): Promise<{ ok: boolean; text: string }> {
  const opts = deps.opts ?? engineOptions(env);
  const tip = await readTip(api, repo, STEWARD_BRANCH);
  if (!tip) return { ok: false, text: "NO_STEWARD: nobody holds the Steward role" };
  const session = parseLease(tip.message).session;
  return releaseSteward(api, repo, session, true, { mainBranch: opts.mainBranch, now: opts.now, uuid: opts.uuid });
}

/** The Steward as the panel state now shows it. Never fails: falls back to the bare lease, then to none. */
async function stewardAfter(env: PanelEnv, repo: string, deps: ActionDeps, api: GitHubApi): Promise<PanelSteward> {
  clearPanelCache();
  try {
    return (await buildPanelState(env, repo, { api, opts: deps.opts })).steward;
  } catch {
    try {
      const opts = deps.opts ?? engineOptions(env);
      return toPanelSteward(stewardStatus(await readTip(api, repo, STEWARD_BRANCH), opts.now()), 0);
    } catch {
      return toPanelSteward({ state: "none" }, 0);
    }
  }
}

export async function handlePanelAction(
  req: Request,
  env: PanelEnv,
  _ctx: ExecutionContext,
  path: string,
  deps: ActionDeps = {},
): Promise<Response | null> {
  if (!OWNED.has(path)) return null;
  const denied = await requirePanelAuth(req, env);
  if (denied) return denied;
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" }, { allow: "POST" });

  const raw = await readBounded(req);
  if (raw === null) return json(413, { error: "body_too_large" });
  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: "bad_json" });
  }
  if (!body || typeof body !== "object") return json(400, { error: "bad_body" });

  const isReserve = path === "/panel/api/reserve";
  if (!isReserve) {
    // Admin gate first: a missing or wrong key is 403 whatever else the body holds.
    const key = typeof body.admin_key === "string" ? body.admin_key : "";
    if (!env.ADMIN_TOKEN || !key || !(await timingSafeEqual(key, env.ADMIN_TOKEN))) return json(403, { error: "forbidden" });
  }
  if (typeof body.repo !== "string" || !body.repo) return json(400, { error: "bad_repo" });
  const r = resolveRepo(env, body.repo);
  if ("error" in r) return json(400, { error: "bad_repo" });
  if (path === "/panel/api/steward-code") {
    // The admin gate above already ran: nothing below is reached without the right key. The code and the key are never logged or echoed.
    const kv = env.OAUTH_KV as unknown as StewardCodeKv | undefined;
    if (!kv) return json(503, { error: "kv_unavailable" });
    try {
      const rateKey = `stewardcode-rate:${r.repo}:${Math.floor(Date.now() / 60000)}`;
      const used = Number.parseInt((await kv.get(rateKey)) ?? "0", 10) || 0;
      if (used >= CODE_RATE_MAX) return json(429, { error: "rate_limited" }, { "retry-after": "60" });
      await kv.put(rateKey, String(used + 1), { expirationTtl: 120 });
      const code = await mintStewardCode(kv, r.repo);
      return json(200, { ok: true, code, expires_in: STEWARD_CODE_TTL } satisfies StewardCodeResult);
    } catch {
      return json(503, { error: "kv_unavailable" });
    }
  }
  if (path === "/panel/api/steward-release") {
    try {
      const api = deps.api ?? createGitHubApi(env.GITHUB_TOKEN);
      const out = await releaseStewardAsOwner(env, r.repo, deps, api);
      const steward = await stewardAfter(env, r.repo, deps, api);
      return json(200, { ok: out.ok, result: String(out.text).replace(/\s+/g, " ").slice(0, 200), steward });
    } catch {
      return json(502, { error: "upstream_error" });
    }
  }
  const cell = body.cell_id;
  if (typeof cell !== "string" || !CELL_RE.test(cell)) return json(400, { error: "bad_cell_id" });

  try {
    if (isReserve) {
      const who = body.who;
      if (typeof who !== "string" || !WHO_RE.test(who)) return json(400, { error: "bad_who" });
      const state = await (deps.readiness ?? defaultReadiness)(env, r.repo, cell);
      const out = (status: ReserveResult["status"], detail: string) => json(200, { status, detail } satisfies ReserveResult);
      if (!state.ready) return out("not_ready", state.detail.slice(0, 200));
      const kv = env.OAUTH_KV as unknown as ReserveKv | undefined;
      if (kv) {
        let held = null;
        try {
          held = await getReservation(kv, r.repo, cell);
        } catch {
          /* advisory only */
        }
        if (held && held.who !== who) return out("taken", `reserved by ${held.who}`);
        try {
          await setReservation(kv, r.repo, cell, who);
        } catch {
          return json(503, { error: "kv_unavailable" });
        }
      }
      clearPanelCache();
      const info = await cellInfoOf(env, r.repo, cell, deps);
      return json(200, { status: "reserved", detail: `${cell} reserved for ${who} for 10 minutes`, ...(info ? { cell: info } : {}) });
    }
    const text = await (deps.takeover ?? defaultTakeover)(env, r.repo, cell, body.admin_key, path === "/panel/api/release" ? "release" : "clear");
    const result = String(text).replace(/\s+/g, " ").slice(0, 200);
    const ok = /^(RELEASED|RESUME)\b/.test(text);
    // The cell is free again: the old reservation must not keep the old name on it (advisory, errors ignored).
    // A reserved cell that was never claimed has no branch, so the takeover answers 'nothing to release':
    // the reservation is deleted anyway and the answer says UNRESERVED.
    const rkv = env.OAUTH_KV as unknown as ReserveKv | undefined;
    let held = false;
    if (rkv) {
      try {
        held = (await getReservation(rkv, r.repo, cell)) !== null;
      } catch {
        /* advisory only */
      }
      if (ok || held) {
        try {
          await clearReservation(rkv, r.repo, cell);
        } catch {
          /* advisory only */
        }
      }
    }
    if (!ok && !held) return json(200, { ok, result });
    clearPanelCache();
    const info = await cellInfoOf(env, r.repo, cell, deps);
    if (!ok) return json(200, { ok: true, result: `UNRESERVED ${cell}`, cell: info ?? undefined });
    return json(200, { ok, result, ...(info ? { cell: info } : {}) });
  } catch {
    return json(502, { error: "upstream_error" });
  }
}
