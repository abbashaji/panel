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

// ---------------------------------------------------------------- input
const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

/** The fields of one fix cell (never an id), or the rejection text. replace: supersedes is forced to [own cell], goal kept. */
function cleanCell(raw: unknown, n: number, kind: FixKind, orig: Dict, id: string): { fields: Dict } | { error: string } {
  const bad = (why: string): { error: string } => ({ error: `FIX_REJECTED ${id}: cells[${n}] ${why}. Nothing was written and no heal was spent.` });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad("must be an object");
  const src = raw as Dict;
  for (const k of Object.keys(src)) {
    if (k === "id") return bad("must not carry an id: ids are assigned by the engine");
    if (k === "priority" || k === "lease_minutes") return bad(`must not set ${k}: the engine sets it`);
    if (!FIELDS.includes(k)) return bad(`has an unknown key '${oneLine(k, 40)}'`);
  }
  const sup = src.supersedes ?? [];
  if (!Array.isArray(sup)) return bad("supersedes must be a list");
  const foreign = sup.filter((x) => x !== id);
  if (foreign.length) return bad(`may supersede only your own cell ${id}, not ${oneLine(foreign.map(String).join(", "), 60)}`);
  if (kind === "blocker" && sup.length) return bad("a blocker must not supersede anything");

  const f: Dict = {};
  for (const k of FIELDS) if (src[k] !== undefined && src[k] !== null) f[k] = src[k];
  if (kind === "replace") {
    f.supersedes = [id];
    const og = String(orig.goal ?? "");
    if (f.goal === undefined) f.goal = og;
    else if (!norm(String(f.goal)).includes(norm(og))) return bad(`must keep the goal of ${id} (the new goal has to contain it; put corrections in notes or inputs)`);
    if (f.type === undefined && orig.type !== undefined) f.type = orig.type;
    for (const k of ["priority", "lease_minutes"]) if (orig[k] !== undefined) f[k] = orig[k];
  } else {
    if (typeof f.notes !== "string" || !f.notes.trim()) return bad("a blocker must name why in its notes (what is broken or missing)");
    if (Array.isArray(f.outputs) && f.outputs.length > BLOCKER_MAX_OUTPUTS) return bad(`is a blocker with ${f.outputs.length} outputs (at most ${BLOCKER_MAX_OUTPUTS})`);
  }
  for (const [k, v] of Object.entries(f)) {
    let s: string;
    try {
      s = JSON.stringify(v);
    } catch {
      return bad(`field ${k} is not plain data`);
    }
    const max = k === "notes" ? NOTES_MAX : FIELD_MAX;
    if (s === undefined || s.length > max) return bad(`field ${k} is too long (at most ${max} chars)`);
    if (Array.isArray(v) && v.length > LIST_MAX) return bad(`field ${k} has more than ${LIST_MAX} entries`);
  }
  return { fields: f };
}

/** One cell file. JSON values are valid YAML, so no value can break out of its line. */
function toYaml(id: string, f: Dict): string {
  return ORDER.filter((k) => k === "id" || f[k] !== undefined).map((k) => `${k}: ${JSON.stringify(k === "id" ? id : f[k])}`).join("\n") + "\n";
}

// ---------------------------------------------------------------- heal commit
function healMessage(prev: string, cell: string, kind: FixKind, note: string): string {
  const head = carry(prev, `heal(${cell}): ${kind}`);
  const extra = `note: ${note}\nheal: ${kind}`;
  return head.includes("\n") ? `${head}\n${extra}` : `${head}\n\n${extra}`;
}

/**
 * Publish 1 or 2 new cells for the caller's cell. replace: corrected cells that supersede the caller's own cell (goal kept);
 * blocker: small fix cells with at most 3 outputs, notes saying why, priority above every open cell, lease 15 minutes.
 * Ids are assigned here (next free). Costs one heal; the heal trailer is written on the caller's branch.
 */
export async function cellFix(api: GitHubApi, repo: string, opts: HealOptions, a: { cell_id: string; base: string; kind: string; cells: unknown[] }): Promise<string> {
  return safely(opts, String(a?.cell_id ?? ""), async () => {
    const au = await authorizeFix(api, repo, opts, a);
    if (!au.ok) return au.text;
    const { ctx } = au;
    const id = ctx.id;
    const heals = await healsOf(api, repo, id);
    if (heals.length >= MAX_HEALS) return escalateText(repo, ctx, heals);
    const kind = a.kind;
    if (kind !== "replace" && kind !== "blocker") return `FIX_REJECTED ${id}: kind must be "replace" or "blocker". Nothing was written and no heal was spent.`;
    if (!Array.isArray(a.cells) || a.cells.length === 0) return `FIX_REJECTED ${id}: cells is empty. Nothing was written and no heal was spent.`;
    if (a.cells.length > MAX_FIX_CELLS) return `TOO_MANY_CELLS ${id}: at most ${MAX_FIX_CELLS} cells per call (got ${a.cells.length}). Nothing was written and no heal was spent.`;
    const cleaned: Dict[] = [];
    for (let n = 0; n < a.cells.length; n++) {
      const c = cleanCell(a.cells[n], n, kind, ctx.plan.cells[id], id);
      if ("error" in c) return c.error;
      cleaned.push(c.fields);
    }

    const busy = await acquirePlanLock(api, repo, opts, id);
    if (busy) return busy;
    try {
      return await fixLocked(api, repo, opts, ctx, kind, cleaned, heals.length);
    } finally {
      await releasePlanLock(api, repo, opts, id); // also on error
    }
  });
}

/** Everything that needs the plan lock: fresh state, ids, publish, heal trailer. */
async function fixLocked(api: GitHubApi, repo: string, opts: HealOptions, ctx: Ctx, kind: FixKind, cleaned: Dict[], used: number): Promise<string> {
  const id = ctx.id;
  const snap = await freshSnapshot(api, repo, opts, 0);
  if (typeof snap === "string") return snap;
  if (snap.blueprint === null) return NOT_INIT;
  const plan = loadPlan(repo, snap, opts);
  if (plan.errors.length) return invalidText(plan);
  const tip = snap.branches[branchOf(id)];
  if (!tip || tip.oid !== ctx.branch.oid) return `HEAL_FAILED ${id}: ${branchOf(id)} moved while you were writing (another chat is writing). Nothing was written. Stop and call next_cell.`;
  if (kind === "replace" && superseders(plan.cells)[id]?.length) {
    return `FIX_REJECTED ${id}: already superseded by ${superseders(plan.cells)[id].join(", ")}. Nothing was written and no heal was spent. Release your cell with a handoff.`;
  }

  const merged = mergedOf(snap);
  const open = Object.keys(plan.cells).filter((k) => !merged.has(k));
  const top = Math.max(0, ...open.map((k) => (Number.isInteger(plan.cells[k].priority) ? (plan.cells[k].priority as number) : 0)));
  let next = Math.max(0, ...Object.keys(plan.cells).map((k) => Number(k.slice(2))).filter(Number.isFinite));
  const cells = cleaned.map((f) => {
    const nid = `C-${String(++next).padStart(3, "0")}`;
    if (kind === "blocker") {
      f.priority = top + 1;
      f.lease_minutes = BLOCKER_LEASE_MINUTES;
    }
    return { id: nid, yaml: toYaml(nid, f) };
  });
  if (cells.some((c) => c.yaml.length > YAML_MAX)) return `FIX_REJECTED ${id}: a cell is larger than ${YAML_MAX} bytes. Nothing was written and no heal was spent.`;

  const res = await publishPlan(api, repo, opts, { cells, message: `${kind} fix for ${id}` });
  if (!res.startsWith("OK published")) return `FIX_REJECTED ${id}: the plan was not changed and no heal was spent.\n${res}`;

  const ids = cells.map((c) => c.id);
  const note = cleanNote(redact(kind === "replace" ? `${ids.join(", ")} supersedes this cell` : `${ids.join(", ")} must merge before this cell continues: ${oneLine(String(cleaned[0].notes), 200)}`, opts.secrets));
  const oid = await api.commitEmpty(repo, ctx.branch.oid, ctx.branch.treeOid, healMessage(ctx.branch.message, id, kind, note));
  if ((await api.fastForward(repo, branchOf(id), oid)) !== "ok") {
    return `FIX_PUBLISHED ${id}: ${ids.join(", ")} is in the plan, but ${branchOf(id)} moved before the heal was recorded. Stop and call next_cell.`;
  }
  const base = short(oid);
  const left = Math.max(0, MAX_HEALS - used - 1);
  const release = `cell_signal(repo=${JSON.stringify(repo)}, cell_id=${JSON.stringify(id)}, base=${JSON.stringify(base)}, kind="release", next="<handoff note>")`;
  const what =
    kind === "replace"
      ? `NEXT: do not continue ${id}. Release it with a handoff note: ${release}. The replacement ${ids.join(", ")} is claimed by a fresh chat.`
      : `NEXT: continue ${id} only after ${ids.join(", ")} has merged (ready_cells shows it); until then hand off: ${release}. Do not edit ${id} for the blocker.`;
  return `FIXED ${id}: ${kind} published ${ids.join(", ")} (tip ${base}, next base=${base}). Heals left: ${left} of ${MAX_HEALS}. ${what}`;
}
