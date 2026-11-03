// Panel actions: POST /panel/api/reserve, /release, /clear-feedback (docs/panel-contracts.md sections 3.3 and 3.4).
// Returns null for every path this module does not own, so the router answers 404.
// admin_key is compared to ADMIN_TOKEN timing-safe; it is never stored, logged or echoed.
import { getReservation, setReservation, type ReserveKv } from "../claim.ts";
import { claimsFromBranches, computeState, parseRuns } from "../plan.ts";
import { loadPlan, mergedOf } from "../common.ts";
import { resolveRepo } from "../engine.ts";
import { createGitHubApi } from "../github.ts";
import { isFeedback, isRelease, parseTrailers } from "../trailers.ts";
import { engineOptions, toolHandlers } from "../tools.ts";
import { json, readBounded, requirePanelAuth, timingSafeEqual } from "./auth.ts";
import type { PanelEnv, ReserveResult } from "./types.ts";

const CELL_RE = /^C-\d{3,5}$/;
const WHO_RE = /^[\w .-]{1,40}$/;
const OWNED = new Set(["/panel/api/reserve", "/panel/api/release", "/panel/api/clear-feedback"]);

export interface Readiness {
  ready: boolean;
  detail: string;
}
/** Injectable for tests; the defaults use the real engine. */
export interface ActionDeps {
  readiness?: (env: PanelEnv, repo: string, cell: string) => Promise<Readiness>;
  takeover?: (env: PanelEnv, repo: string, cell: string, adminKey: string, mode: "release" | "clear") => Promise<string>;
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

async function defaultTakeover(env: PanelEnv, repo: string, cell: string, adminKey: string, mode: "release" | "clear"): Promise<string> {
  const h = toolHandlers(env, engineOptions(env));
  return h.takeover(mode === "release" ? { repo, cell_id: cell, admin_key: adminKey, handoff: true } : { repo, cell_id: cell, admin_key: adminKey, clear_feedback: true });
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
      return out("reserved", `${cell} reserved for ${who} for 10 minutes`);
    }
    const text = await (deps.takeover ?? defaultTakeover)(env, r.repo, cell, body.admin_key, path === "/panel/api/release" ? "release" : "clear");
    const result = String(text).replace(/\s+/g, " ").slice(0, 200);
    return json(200, { ok: /^(RELEASED|RESUME)\b/.test(text), result });
  } catch {
    return json(502, { error: "upstream_error" });
  }
}
