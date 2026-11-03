// ext.ts: Worker side of the usage-limit release (contracts C2, C3) and the usage warning (C5).
// /ext/ping, /ext/release and /ext/warn, guarded by the secret EXT_TOKEN. Pure logic over GitHubApi.
// Trailer handling is reused from trailers.ts; this file never parses or builds trailers itself.
import type { GitHubApi } from "./api.ts";
import { safeEqual } from "./auth.ts";
import { resolveRepo } from "./engine.ts";
import { createGitHubApi } from "./github.ts";
import { ID_RE } from "./plan.ts";
import { carry, isRelease, isFeedback, parseTrailers, subjectOf } from "./trailers.ts";
import type { Env } from "./tools.ts";

export const WORKER_VERSION = "1.0.0";
export const WARN_MIN_PCT = 90;
export const LIMIT_WARNING_TEXT =
  "LIMIT_WARNING: this account is over 90% of its usage cap. Start no new work. Commit the current file group; if the cell is complete call submit_cell, else call cell_signal release with next: and end your turn. Do not call next_cell again in this chat.";

export const RELEASE_NEXT_FALLBACK = "previous chat hit its usage limit; continue from the last commit";
const MAX_BODY = 2048;
const MAX_PAGES = 10;
const PER_PAGE = 100;
const LOCK_KINDS = ["claim", "takeover", "adopt"];

export interface ExtResult {
  status: string;
  detail: string;
}

export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export const warnKey = (repo: string, cellId: string) => `warn:${repo}:${cellId}`;

/** Short, secret-free message: token-like strings are masked and the length is cut. */
export function safeDetail(e: unknown, secrets: (string | undefined)[] = []): string {
  let m = String((e as Error)?.message ?? e);
  for (const s of secrets) if (s && s.length >= 4) m = m.split(s).join("***");
  m = m
    .replace(/(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, "***")
    .replace(/Bearer\s+\S+/gi, "Bearer ***")
    .replace(/[A-Za-z0-9_-]{32,}/g, "***");
  return m.replace(/\s+/g, " ").trim().slice(0, 200);
}

const refused = (detail: string): ExtResult => ({ status: "refused", detail: detail.slice(0, 200) });

function cleanLabel(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 20);
}

export async function limitRelease(
  api: GitHubApi,
  repo: string,
  args: { cell_id: string; base: string; label?: string },
): Promise<ExtResult> {
  try {
    const id = args?.cell_id;
    if (typeof id !== "string" || !ID_RE.test(id)) return refused("cell_id must look like C-001");
    const base = String(args.base ?? "").trim().toLowerCase();
    if (!/^[0-9a-f]{7,40}$/.test(base)) return refused("base must be 7 to 40 hex characters");
    if (args.label !== undefined && typeof args.label !== "string") return refused("label must be a string");
    const label = cleanLabel(args.label);
    const branch = `cell/${id}`;

    let tip: { oid: string; treeOid: string; message: string } | null = null;
    let lock: { oid: string } | null = null;
    for (let page = 1; page <= MAX_PAGES && !lock; page++) {
      const commits = await api.branchCommits(repo, branch, page, PER_PAGE);
      if (commits === null) return { status: "no_branch", detail: `no branch ${branch}` };
      if (page === 1) {
        if (!commits.length) return { status: "no_branch", detail: `no commits on ${branch}` };
        tip = commits[0];
        if (isRelease(tip.message)) return { status: "already_released", detail: `${id} is already released` };
        if (isFeedback(tip.message)) return { status: "needs_human", detail: `${id} waits for a human decision` };
      }
      for (const c of commits) {
        const s = subjectOf(c.message);
        if (LOCK_KINDS.some((k) => s.startsWith(`${k}(${id}):`))) {
          lock = c;
          break;
        }
      }
      if (commits.length < PER_PAGE) break;
    }
    if (!tip || !lock) return { status: "unverifiable", detail: `no lock commit of ${id} found on ${branch}` };
    if (!lock.oid.startsWith(base)) return { status: "not_owner", detail: `${id} was taken by another chat` };

    const pr = await api.findPr(repo, branch);
    if (pr && pr.state === "open" && !pr.merged) return { status: "submitted", detail: `${id} already has an open PR #${pr.number}; nothing written` };

    const subject = `release(${id}): usage limit${label ? ` [${label}]` : ""}`;
    const hasNext = !!parseTrailers(tip.message).next;
    const message = carry(tip.message, subject, { next: hasNext ? undefined : RELEASE_NEXT_FALLBACK });
    const oid = await api.commitEmpty(repo, tip.oid, tip.treeOid, message);
    const moved = await api.fastForward(repo, branch, oid);
    if (moved === "ok") return { status: "released", detail: `released ${id}` };
    if (moved === "missing") return { status: "no_branch", detail: `branch ${branch} vanished` };
    return { status: "moved", detail: `${branch} moved while releasing; nothing was written` };
  } catch (e) {
    return { status: "error", detail: safeDetail(e) };
  }
}

/** Seconds the advisory warning flag lives: until resets_at + 300, clamped to 1800..21600; 10800 without a reset time. */
export function warnTtl(resetsAt: string | undefined, nowMs: number): number {
  const t = resetsAt ? Date.parse(resetsAt) : NaN;
  if (!Number.isFinite(t)) return 10800;
  return Math.min(21600, Math.max(1800, Math.ceil((t - nowMs) / 1000) + 300));
}

/** C5: store an advisory flag in KV. Never writes to git (a commit would move the tip and fence out the live chat). */
export async function warnFlag(
  api: GitHubApi,
  kv: KvLike,
  repo: string,
  args: { cell_id: string; resets_at?: string },
  now: () => number = Date.now,
): Promise<ExtResult> {
  try {
    const id = args?.cell_id;
    if (typeof id !== "string" || !ID_RE.test(id)) return refused("cell_id must look like C-001");
    let resets: string | undefined;
    if (args.resets_at !== undefined && args.resets_at !== null) {
      if (typeof args.resets_at !== "string" || !Number.isFinite(Date.parse(args.resets_at))) return refused("resets_at must be an ISO time");
      resets = args.resets_at;
    }
    const commits = await api.branchCommits(repo, `cell/${id}`, 1, 1);
    if (!commits || !commits.length) return { status: "not_running", detail: `no branch cell/${id}` };
    if (isRelease(commits[0].message)) return { status: "already_released", detail: `${id} is already released` };
    const at = now();
    await kv.put(warnKey(repo, id), JSON.stringify({ at: new Date(at).toISOString(), resets_at: resets ?? null }), { expirationTtl: warnTtl(resets, at) });
    return { status: "warned", detail: `warning stored for ${id}` };
  } catch (e) {
    return { status: "error", detail: safeDetail(e) };
  }
}

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

/** Every /ext/* request. Order: EXT_TOKEN unset -> 404; bearer -> 401; routing (404 / 405); body limits; repo policy. No CORS, no OPTIONS. */
export async function extFetch(request: Request, env: Env, apiFactory: (token: string) => GitHubApi = createGitHubApi): Promise<Response> {
  const secrets = [env.EXT_TOKEN, env.GITHUB_TOKEN, env.ADMIN_TOKEN, env.MCP_AUTH_TOKEN];
  try {
    if (!env.EXT_TOKEN) return new Response("Not found", { status: 404 });
    const m = /^Bearer (.+)$/.exec(request.headers.get("Authorization") ?? "");
    if (!m || !(await safeEqual(m[1].trim(), env.EXT_TOKEN))) return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": "Bearer" } });

    const path = new URL(request.url).pathname;
    if (path === "/ext/ping") {
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET" } });
      return json({ ok: true, version: WORKER_VERSION });
    }
    if (path !== "/ext/release" && path !== "/ext/warn") return new Response("Not found", { status: 404 });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });

    const declared = Number(request.headers.get("Content-Length") ?? 0);
    if (declared > MAX_BODY) return json({ status: "refused", detail: "body too large (2 KB max)" }, 400);
    const raw = new Uint8Array(await request.arrayBuffer());
    if (raw.byteLength > MAX_BODY) return json({ status: "refused", detail: "body too large (2 KB max)" }, 400);
    let body: any;
    try {
      body = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return json({ status: "refused", detail: "body must be JSON" }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({ status: "refused", detail: "body must be a JSON object" }, 400);
    if (typeof body.repo !== "string" || !body.repo.trim()) return json({ status: "refused", detail: "repo is required (owner/name)" }, 400);
    const r = resolveRepo(env, body.repo);
    if ("error" in r) return json({ status: "refused", detail: r.error.slice(0, 200) }, 400);

    if (!env.GITHUB_TOKEN) return json({ status: "error", detail: "NOT_CONFIGURED" });
    const api = apiFactory(env.GITHUB_TOKEN);

    let res: ExtResult;
    if (path === "/ext/release") {
      res = await limitRelease(api, r.repo, { cell_id: body.cell_id, base: body.base, label: body.label });
    } else {
      if (!env.OAUTH_KV) return json({ status: "error", detail: "NOT_CONFIGURED" });
      res = await warnFlag(api, env.OAUTH_KV as unknown as KvLike, r.repo, { cell_id: body.cell_id, resets_at: body.resets_at });
    }
    if (res.status === "refused") return json(res, 400);
    return json({ status: res.status, detail: safeDetail(res.detail, secrets) });
  } catch (e) {
    return json({ status: "error", detail: safeDetail(e, secrets) });
  }
}
