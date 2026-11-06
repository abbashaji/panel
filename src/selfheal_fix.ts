// selfheal_fix.ts
//
// The only plan write a worker chat may do: a corrected cell for its own cell ('replace') or a small fix cell for a broken
// main or a missing shared file ('blocker'). It uses publishPlan WITHOUT the admin gate, wrapped in hard limits: the same
// proof as every heal (cell_id + base + live lease + budget), at most 2 cells per call, ids assigned by the engine, the
// normal plan validation, bounded text, and a plan lock (branch steward/plan-lock, 90 s lease). Only src/tools.ts imports this.

import type { BranchInfo, GitHubApi } from "./api.ts";
import { ID_RE, leaseOf, superseders } from "./plan.ts";
import { NOT_INIT, branchOf, errText, freshSnapshot, invalidText, loadPlan, mergedOf, oneLine, short, type Loaded } from "./common.ts";
import { carry, isFeedback, isRelease } from "./trailers.ts";
import { cleanNote, readTip, redact } from "./steward.ts";
import { HEAL_TOOLS, MAX_HEALS, healsOf, type Heal, type HealOptions } from "./selfheal.ts";
import { publishPlan } from "./engine.ts";

export const PLAN_LOCK_BRANCH = "steward/plan-lock";
export const PLAN_LOCK_SECONDS = 90;
export const MAX_FIX_CELLS = 2;
export const BLOCKER_MAX_OUTPUTS = 3;
export const BLOCKER_LEASE_MINUTES = 15;
const FIELD_MAX = 6000; // chars of one field as JSON
const NOTES_MAX = 2000;
const LIST_MAX = 20;
const YAML_MAX = 12000; // bytes of one cell (publishPlan itself allows 20000)
const ANSWER_MAX = 4000;

export type FixKind = "replace" | "blocker";
type Dict = Record<string, any>;

/** Keys a chat may give, in the order they are written. id, priority and lease_minutes are never given by the chat. */
const FIELDS = ["title", "type", "goal", "inputs", "after", "provides", "read", "allowed_paths", "outputs", "acceptance", "notes", "supersedes"];
const ORDER = ["id", "title", "type", "priority", "lease_minutes", "goal", "inputs", "after", "provides", "read", "allowed_paths", "outputs", "acceptance", "notes", "supersedes"];

interface Ctx {
  id: string;
  plan: Loaded;
  branch: BranchInfo;
}
type Auth = { ok: true; ctx: Ctx } | { ok: false; text: string };

// ---------------------------------------------------------------- authority (mirrors authorize() + prepare() of selfheal.ts, which are private there)
async function authorizeFix(api: GitHubApi, repo: string, opts: HealOptions, a: { cell_id?: string; base?: string }): Promise<Auth> {
  const deny = (why: string): Auth => ({ ok: false, text: `SELFHEAL_DENIED: ${why}` });
  const id = String(a?.cell_id ?? "").trim();
  if (!ID_RE.test(id)) return deny(`${oneLine(id, 40) || "(none)"} is not a cell id (expected C-NNN)`);
  const base = String(a?.base ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(base)) return deny("missing base: pass base = the current tip of your cell branch (the 7-character sha from the last CLAIMED / RESUME / ok / HEALED answer)");
  const snap = await freshSnapshot(api, repo, opts, 0);
  if (typeof snap === "string") return { ok: false, text: snap };
  if (snap.blueprint === null) return { ok: false, text: NOT_INIT };
  const plan = loadPlan(repo, snap, opts);
  if (plan.errors.length) return { ok: false, text: invalidText(plan) };
  if (!(id in plan.cells)) return deny(`unknown cell ${id}`);
  const branch = snap.branches[branchOf(id)];
  if (!branch) return deny(`no live lease: there is no branch ${branchOf(id)} (never claimed, merged or deleted). Call next_cell.`);
  if (!branch.oid.startsWith(base)) return deny(`base ${base.slice(0, 7)} is not the tip of ${branchOf(id)}: the cell was taken over or has moved. Stop and call next_cell.`);
  if (isRelease(branch.message)) return deny(`the lease of ${id} was released. Stop and call next_cell.`);
  const leaseMin = leaseOf(plan.cells[id], plan.cfg.lease_minutes);
  const ts = Date.parse(branch.committedDate);
  const age = Number.isNaN(ts) ? Infinity : Math.max(0, (opts.now() - ts) / 60000);
  if (age >= leaseMin) return deny(`the lease of ${id} expired${Number.isFinite(age) ? ` ${Math.floor(age - leaseMin)} min ago` : ""}. Stop and call next_cell.`);
  if (isFeedback(branch.message)) {
    return deny(`${id} has feedback pending (a human or the Steward decides). Do not change the cell. If the feedback was a mistake: ${HEAL_TOOLS.clear} first.`);
  }
  return { ok: true, ctx: { id, plan, branch } };
}

function escalateText(repo: string, ctx: Ctx, heals: Heal[]): string {
  const fb = `cell_signal(repo=${JSON.stringify(repo)}, cell_id=${JSON.stringify(ctx.id)}, base=${JSON.stringify(short(ctx.branch.oid))}, kind="feedback", text="<what you tried, what is still wrong, what you propose>")`;
  return `ESCALATE ${ctx.id}: the heal budget is used up (${heals.length} of ${MAX_HEALS}: ${heals.map((h) => h.kind).join(", ")}). Heal no more. File feedback now: ${fb}. The Steward takes it from there.`;
}

/** Every answer is redacted and capped; failures become text. */
async function safely(opts: HealOptions, id: string, run: () => Promise<string>): Promise<string> {
  let text: string;
  try {
    text = await run();
  } catch (e) {
    text = `SELFHEAL_FAILED ${id}: ${errText(e)}`;
  }
  text = redact(text, opts.secrets);
  return text.length > ANSWER_MAX ? `${text.slice(0, ANSWER_MAX - 16)}\n[...truncated]` : text;
}

// ---------------------------------------------------------------- plan lock
// The lock is the tip of steward/plan-lock (outside the cell/ namespace). Held = tip without release: trailer younger than
// PLAN_LOCK_SECONDS. Every move is a non-force fast-forward from the tip that was read, so two callers cannot both win.
const lockMessage = (what: string, opts: HealOptions, who: string, release = false): string =>
  `steward(plan-lock): ${what} ${opts.uuid()}\n\nwho: ${who}\nat: ${new Date(opts.now()).toISOString()}${release ? "\nrelease: done" : ""}`;

function lockTrailers(message: string): { who: string; at: string; release: boolean } {
  const t = { who: "", at: "", release: false };
  for (const raw of message.split("\n").slice(1)) {
    const m = /^(who|at|release):[ \t]*(.*)$/.exec(raw.trim());
    if (!m) continue;
    if (m[1] === "who") t.who = m[2].trim();
    else if (m[1] === "at") t.at = m[2].trim();
    else t.release = true;
  }
  return t;
}

const locked = (secs: number): string =>
  `PLAN_LOCKED retry_after=${Math.max(1, Math.ceil(secs))}: another chat is changing the plan right now. Nothing was written and no heal was spent. Wait that many seconds, then call again.`;

/** null when the lock is now ours, else the PLAN_LOCKED answer. */
async function acquirePlanLock(api: GitHubApi, repo: string, opts: HealOptions, who: string): Promise<string | null> {
  const tip = await readTip(api, repo, PLAN_LOCK_BRANCH);
  if (!tip) {
    const main = await api.branchTip(repo, opts.mainBranch);
    if (!main) throw new Error(`no ${opts.mainBranch} branch in ${repo}`);
    const oid = await api.commitEmpty(repo, main.oid, main.treeOid, lockMessage("acquire", opts, who));
    return (await api.createBranch(repo, PLAN_LOCK_BRANCH, oid)) === "created" ? null : locked(PLAN_LOCK_SECONDS);
  }
  const t = lockTrailers(tip.message);
  let ts = Date.parse(tip.committedDate);
  if (Number.isNaN(ts)) ts = Date.parse(t.at);
  const age = Number.isNaN(ts) ? Infinity : Math.max(0, (opts.now() - ts) / 1000);
  if (!t.release && age < PLAN_LOCK_SECONDS) return locked(PLAN_LOCK_SECONDS - age);
  const oid = await api.commitEmpty(repo, tip.oid, tip.treeOid, lockMessage("acquire", opts, who));
  return (await api.fastForward(repo, PLAN_LOCK_BRANCH, oid)) === "ok" ? null : locked(PLAN_LOCK_SECONDS);
}

/** Best effort: an error here must never hide the real answer (the lease runs out by itself). */
async function releasePlanLock(api: GitHubApi, repo: string, opts: HealOptions, who: string): Promise<void> {
  try {
    const tip = await readTip(api, repo, PLAN_LOCK_BRANCH);
    if (!tip) return;
    const t = lockTrailers(tip.message);
    if (t.release || t.who !== who) return; // never release somebody else's lock
    const oid = await api.commitEmpty(repo, tip.oid, tip.treeOid, lockMessage("release", opts, who, true));
    await api.fastForward(repo, PLAN_LOCK_BRANCH, oid);
  } catch {
    /* the lease expires after PLAN_LOCK_SECONDS */
  }
}
