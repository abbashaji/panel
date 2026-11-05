// tools.ts: MCP tool registration. Schemas and handlers for all tools live here (index.ts only wires the Worker).
// toolHandlers() returns plain text per tool so the admin gate and repo policy are unit-testable without MCP.
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { GitHubApi } from "./api.ts";
import * as engine from "./engine.ts";
import { createGitHubApi } from "./github.ts";
import { LIMIT_WARNING_TEXT, warnKey, type KvLike } from "./ext.ts";
import { ID_RE } from "./plan.ts";
import { nextCellWait } from "./longpoll.ts";
import { SERVER_INSTRUCTIONS } from "./protocol.ts";
import { cellSignal } from "./signal.ts";
import { claimSteward, gatherBriefing, leaseMinutesOf, noteCell, redact, releaseSteward } from "./steward.ts";
import type { ClaimOptions, ReserveKv } from "./claim.ts";

export interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: any;
  MCP_AUTH_TOKEN: string;
  ADMIN_TOKEN?: string; // owner key for takeover / publish_plan; unset = those tools are off
  GITHUB_TOKEN: string;
  DEFAULT_REPO?: string;
  ALLOWED_REPOS?: string;
  MAIN_BRANCH?: string;
  HISTORY_PAGES?: string;
  EXT_TOKEN?: string; // secret of the browser extension (/ext/*); unset = those endpoints answer 404
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

type ApiFactory = (token: string) => GitHubApi;

/** Wraps a handler: GITHUB_TOKEN check, repo allow-list, and every failure turned into short text. */
function makeRun(env: Env, apiFactory: ApiFactory) {
  return (fn: (api: GitHubApi, repo: string, a: any) => Promise<string>) => async (a: any): Promise<string> => {
    try {
      if (!env.GITHUB_TOKEN) return "NOT_CONFIGURED: GITHUB_TOKEN secret is not set";
      const r = engine.resolveRepo(env, a?.repo);
      if ("error" in r) return r.error;
      return await fn(apiFactory(env.GITHUB_TOKEN), r.repo, a);
    } catch (e) {
      return `ERROR: ${String((e as Error)?.message ?? e).slice(0, 400)}`;
    }
  };
}

export function engineOptions(env: Env): engine.EngineOptions {
  return {
    mainBranch: env.MAIN_BRANCH || "main",
    historyPages: Math.max(0, Number(env.HISTORY_PAGES ?? 3) || 0),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    uuid: () => crypto.randomUUID(),
  };
}

/** Per tool name: the text the tool answers. Every tool resolves the repo against the allow-list and turns failures into short text. */
export function toolHandlers(env: Env, opts: engine.EngineOptions, apiFactory: ApiFactory = createGitHubApi): Record<string, (args: any) => Promise<string>> {
  const run = makeRun(env, apiFactory);
  const raw = {
    next_cell: run((api, r, a) => {
      const kv = env.OAUTH_KV as unknown as ReserveKv | undefined;
      const who = typeof a.who === "string" && a.who.trim() ? a.who.trim().slice(0, 40) : undefined;
      if (a.cell_id !== undefined && a.cell_id !== null) {
        // Pinned: exactly this cell or NOT_READY / RESERVED. Never falls back to another cell, never waits.
        const pinned: ClaimOptions = { ...opts, claim: { kv, who, pin: String(a.cell_id) } };
        return engine.nextCell(api, r, pinned, "claim");
      }
      const plain: ClaimOptions = { ...opts, claim: { kv, who } };
      return nextCellWait(api, r, plain, a.wait_seconds ?? 0);
    }),
    ready_cells: run((api, r) => engine.nextCell(api, r, opts, "peek")),
    read_files: run((api, r, a) => engine.readFiles(api, r, opts, a)),
    apply_changes: run((api, r, a) => engine.applyChanges(api, r, opts, a)),
    submit_cell: run((api, r, a) => engine.submitCell(api, r, opts, a)),
    preflight: run((api, r, a) => engine.preflight(api, r, opts, a.cell_id)),
    ci_result: run((api, r, a) => engine.ciResult(api, r, opts, a)),
    init_blueprint: run((api, r, a) => engine.initBlueprint(api, r, opts, a)),
    publish_plan: run(async (api, r, a) => (await engine.checkAdmin(env.ADMIN_TOKEN, a.admin_key)) ?? engine.publishPlan(api, r, opts, a)),
    takeover: run(async (api, r, a) => (await engine.checkAdmin(env.ADMIN_TOKEN, a.admin_key)) ?? engine.takeoverCell(api, r, opts, a.cell_id, !!a.force, { handoff: !!a.handoff, clear_feedback: !!a.clear_feedback })),
    cell_signal: run((api, r, a) => cellSignal(api, r, opts, a)),
  };
  return withWarning(env, raw);
}

// The Steward tools are not bound to one pinned cell (steward_note names a cell but never holds it): no limit warning, no flag.
const STEWARD_TOOLS = new Set(["steward_next", "steward_note", "steward_release"]);
const sessionOf = (s: unknown): string | undefined => (typeof s === "string" && /^[\w.-]{1,80}$/.test(s.trim()) ? s.trim() : undefined);
const PROBLEM_LINE = /^\d+\. (C-\d+) /gm;

/**
 * The Steward tools: steward_next, steward_note, steward_release. All three need the owner's admin_key (checked first, in
 * constant time, fails closed without ADMIN_TOKEN) and no answer ever contains a secret. Kept apart from toolHandlers, whose
 * tool list (the 11 cell tools) is asserted exactly by test/tools.test.ts; buildServer registers both sets.
 */
export function stewardToolHandlers(env: Env, opts: engine.EngineOptions, apiFactory: ApiFactory = createGitHubApi): Record<string, (args: any) => Promise<string>> {
  const run = makeRun(env, apiFactory);
  const secretsOf = (a: any): string[] =>
    [env.ADMIN_TOKEN, env.GITHUB_TOKEN, env.MCP_AUTH_TOKEN, env.EXT_TOKEN, a?.admin_key].filter((s): s is string => typeof s === "string" && s.length > 0);
  const sopts = { mainBranch: opts.mainBranch, now: opts.now, uuid: opts.uuid };
  const guard = (fn: (a: any) => Promise<string>) => async (a: any): Promise<string> => redact(await fn(a), secretsOf(a));
  const admin = (a: any) => engine.checkAdmin(env.ADMIN_TOKEN, a?.admin_key);

  const raw = {
    steward_next: guard(run(async (api, r, a) => {
      const denied = await admin(a);
      if (denied) return denied;
      const claim = await claimSteward(api, r, typeof a.who === "string" ? a.who : "steward", sessionOf(a.session), sopts);
      if (claim.status === "STEWARD_BUSY" || claim.status === "STEWARD_FAILED") return claim.text;
      const lm = await leaseMinutesOf(api, r, opts.mainBranch);
      const head = claim.status === "CREATED" ? "STEWARD_STARTED" : claim.status === "ADOPTED" ? "STEWARD_RESUMED" : "STEWARD_REFRESHED";
      const briefing = await gatherBriefing(api, r, opts, {
        secrets: secretsOf(a),
        status: { state: "active", holder: claim.who, session: claim.session, minutesLeft: lm },
      });
      // What changed since the last call of this Steward: advisory, kept in KV (no KV or any KV error = no change lines).
      let changes = "";
      if (briefing.startsWith("STEWARD BRIEFING")) {
        const ids = [...briefing.matchAll(PROBLEM_LINE)].map((m) => m[1]);
        const kv = env.OAUTH_KV as unknown as { get(k: string): Promise<string | null>; put(k: string, v: string, o?: { expirationTtl: number }): Promise<void> } | undefined;
        const key = `steward-seen:${r}`;
        try {
          if (kv) {
            const prev = claim.status === "REFRESHED" ? await kv.get(key) : null;
            if (prev) {
              const before = JSON.parse(prev) as string[];
              const added = ids.filter((x) => !before.includes(x));
              const gone = before.filter((x) => !ids.includes(x));
              changes = `CHANGES since your last steward_next: new problems: ${added.join(", ") || "none"}; gone: ${gone.join(", ") || "none"}.`;
            }
            await kv.put(key, JSON.stringify(ids), { expirationTtl: 86400 });
          }
        } catch {
          changes = "";
        }
      }
      const lines = [
        `${head} session=${claim.session} repo=${r} (lease ${lm} min, renewed by every steward call)`,
        `Pass session=${claim.session} on every later steward call (steward_next, steward_note, steward_release).`,
      ];
      if (changes) lines.push(changes);
      return [...lines, "", briefing].join("\n");
    })),
    steward_note: guard(run(async (api, r, a) => {
      const denied = await admin(a);
      if (denied) return denied;
      if (typeof a.cell_id !== "string" || typeof a.note !== "string") return "BAD_ARGS: steward_note needs cell_id and note";
      return noteCell(api, r, a.cell_id, redact(a.note, secretsOf(a)));
    })),
    steward_release: guard(run(async (api, r, a) => {
      const denied = await admin(a);
      if (denied) return denied;
      const session = sessionOf(a.session);
      if (!session) return "NOT_STEWARD: pass the session you got from steward_next";
      return (await releaseSteward(api, r, session, !!a.handoff, sopts)).text;
    })),
  };
  return withWarning(env, raw);
}

const NO_WARN = /^(CONFLICT|NOT_CLAIMED|CELL_DONE)/;
const WARNED_TOOLS = new Set(["apply_changes", "cell_signal", "read_files", "submit_cell", "ci_result", "preflight"]);

/** C5: append LIMIT_WARNING_TEXT while the advisory KV flag of the cell exists; delete the flag on next_cell CLAIMED/RESUME, cell_signal release and takeover. No OAUTH_KV or any KV error = the reply is returned unchanged. */
function withWarning(env: Env, h: Record<string, (args: any) => Promise<string>>): Record<string, (args: any) => Promise<string>> {
  const out: Record<string, (args: any) => Promise<string>> = {};
  for (const [name, fn] of Object.entries(h)) {
    const bound = WARNED_TOOLS.has(name);
    if (STEWARD_TOOLS.has(name) || (!bound && name !== "next_cell" && name !== "takeover")) {
      out[name] = fn;
      continue;
    }
    out[name] = async (a: any) => {
      const reply = await fn(a);
      const kv = env.OAUTH_KV as unknown as KvLike | undefined;
      if (!kv) return reply;
      try {
        const r = engine.resolveRepo(env, a?.repo);
        if ("error" in r) return reply;
        if (name === "next_cell") {
          const m = /^(?:CLAIMED|RESUME) (C-\d+)\b/.exec(reply);
          if (m) await kv.delete(warnKey(r.repo, m[1]));
          return reply;
        }
        const id = a?.cell_id;
        if (typeof id !== "string" || !ID_RE.test(id)) return reply;
        if (name === "takeover") {
          if (/^(?:RESUME|RELEASED) /.test(reply)) await kv.delete(warnKey(r.repo, id));
          return reply;
        }
        if (name === "cell_signal" && a?.kind === "release" && reply.startsWith("released ")) {
          await kv.delete(warnKey(r.repo, id));
          return reply;
        }
        if (NO_WARN.test(reply)) return reply;
        return (await kv.get(warnKey(r.repo, id))) !== null ? `${reply}\n${LIMIT_WARNING_TEXT}` : reply;
      } catch {
        return reply; // the flag is advisory: a KV failure never breaks a tool reply
      }
    };
  }
  return out;
}

export function buildServer(env: Env, apiFactory: ApiFactory = createGitHubApi): McpServer {
  const server = new McpServer({ name: "blueprint-mcp", version: "1.0.0" }, { instructions: SERVER_INSTRUCTIONS } as any);
  const h = { ...toolHandlers(env, engineOptions(env), apiFactory), ...stewardToolHandlers(env, engineOptions(env), apiFactory) };
  const repo = z.string().optional().describe("owner/name; omit to use the default repository");

  server.registerTool("next_cell", {
    description: "Claim the next ready cell (or resume an abandoned one). Always your first call. With cell_id: claim exactly that cell, or reply NOT_READY / RESERVED (never another cell).",
    inputSchema: { repo, wait_seconds: z.number().int().optional(), cell_id: z.string().optional(), who: z.string().optional() },
  }, async (a) => text(await h.next_cell(a)));

  server.registerTool("ready_cells", {
    description: "Read-only: list what is ready, running, blocked. Claims nothing.",
    inputSchema: { repo },
  }, async (a) => text(await h.ready_cells(a)));

  server.registerTool("read_files", {
    description: "Read files or line ranges (max 12 files, ~600 lines). Reads your cell's branch, else main. The Steward uses it too.",
    inputSchema: {
      repo,
      cell_id: z.string().optional(),
      files: z.array(z.object({ path: z.string(), start: z.number().int().optional(), end: z.number().int().optional() })),
      max_lines: z.number().int().optional(),
    },
  }, async (a) => text(await h.read_files(a)));

  server.registerTool("apply_changes", {
    description: "Commit many file changes at once to your cell branch. ops: {path,content} | {path,old,new} | {path,append} | {path,delete:true}. The Steward uses it to fix a branch it holds after takeover.",
    inputSchema: {
      repo,
      cell_id: z.string(),
      base: z.string().describe("7-char sha from your last CLAIMED/RESUME/ok"),
      message: z.string(),
      next: z.string().describe("the exact next step"),
      ops: z.array(z.object({ path: z.string(), content: z.string().optional(), old: z.string().optional(), new: z.string().optional(), append: z.string().optional(), delete: z.boolean().optional() })),
    },
  }, async (a) => text(await h.apply_changes(a)));

  server.registerTool("submit_cell", {
    description: "Open the PR for your finished cell; CI checks and merges it.",
    inputSchema: { repo, cell_id: z.string(), summary: z.string() },
  }, async (a) => text(await h.submit_cell(a)));

  server.registerTool("preflight", {
    description: "Dry-run the cell's acceptance checks in CI on your current branch; merges nothing.",
    inputSchema: { repo, cell_id: z.string() },
  }, async (a) => text(await h.preflight(a)));

  server.registerTool("ci_result", {
    description: "Result of CI for your cell (waits up to wait_seconds). Call once, never in a loop. The Steward uses it to read a failed gate.",
    inputSchema: { repo, cell_id: z.string(), wait_seconds: z.number().int().optional() },
  }, async (a) => text(await h.ci_result(a)));

  server.registerTool("init_blueprint", {
    description: "Install Blueprint into a repo that has none, or update its workflows/tools with upgrade:true. Never touches cells.",
    inputSchema: { repo, upgrade: z.boolean().optional() },
  }, async (a) => text(await h.init_blueprint(a)));

  server.registerTool("publish_plan", {
    description: "OWNER or STEWARD ONLY (needs admin_key): add NEW cells (cells/C-NNN.yaml) to main, e.g. a superseding cell. Validated as a whole; existing cells are never changed.",
    inputSchema: { repo, admin_key: z.string().optional(), cells: z.array(z.object({ id: z.string(), yaml: z.string() })), message: z.string().optional() },
  }, async (a) => text(await h.publish_plan(a)));

  server.registerTool("takeover", {
    description: "OWNER or STEWARD ONLY (needs admin_key): take over a running cell whose chat died (force, handoff, clear_feedback). Cell agents never call this; expired cells come back through next_cell.",
    inputSchema: { repo, admin_key: z.string().optional(), cell_id: z.string(), force: z.boolean().optional(), handoff: z.boolean().optional(), clear_feedback: z.boolean().optional() },
  }, async (a) => text(await h.takeover(a)));

  server.registerTool("cell_signal", {
    description: "Heartbeat, release (hand the cell to another chat) or feedback for your cell.",
    inputSchema: { repo, cell_id: z.string(), base: z.string(), kind: z.enum(["heartbeat", "release", "feedback"]), text: z.string().optional(), next: z.string().optional() },
  }, async (a) => text(await h.cell_signal(a)));

  server.registerTool("steward_next", {
    description: "STEWARD ONLY (needs admin_key): the first call of a chat the owner told 'you are the Steward' (every other chat starts with next_cell). First call returns STEWARD_STARTED with a session to pass on every later call, plus the briefing; later calls with the session refresh the lease and return the new briefing and what changed; a dead Steward is resumed (STEWARD_RESUMED); a live one gives STEWARD_BUSY.",
    inputSchema: { repo, admin_key: z.string().optional(), who: z.string().optional(), session: z.string().optional() },
  }, async (a) => text(await h.steward_next(a)));

  server.registerTool("steward_note", {
    description: "STEWARD ONLY (needs admin_key): leave a short note on a cell that has a branch; the next chat that resumes it sees the note first. Only for dead, released or feedback cells, never a live one.",
    inputSchema: { repo, admin_key: z.string().optional(), cell_id: z.string(), note: z.string() },
  }, async (a) => text(await h.steward_note(a)));

  server.registerTool("steward_release", {
    description: "STEWARD ONLY (needs admin_key): give up the Steward role (handoff: true when a fresh chat should take over). Needs the session of steward_next.",
    inputSchema: { repo, admin_key: z.string().optional(), session: z.string(), handoff: z.boolean().optional() },
  }, async (a) => text(await h.steward_release(a)));

  return server;
}
