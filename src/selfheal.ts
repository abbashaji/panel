// selfheal.ts
//
// Self-heal core: a chat that hits a problem solves it inside its own context instead of filing feedback and stopping.
// Authority is the same proof apply_changes needs: cell_id plus base (the current tip of cell/<id>), and the cell must
// hold a live lease. No admin key anywhere and no tool registration here (C-052 does that). Every function acts on that
// one cell only, and a heal merge never touches main.

import type { BranchInfo, GitHubApi, Snapshot } from "./api.ts";
import { ID_RE, RUN_TITLE_RE, hardGraph, leaseOf } from "./plan.ts";
import { NOT_INIT, branchOf, errText, freshSnapshot, invalidText, loadPlan, mergedOf, oneLine, short, type EngineOptions, type Loaded } from "./common.ts";
import { NOTE_MAX, cleanNote, redact } from "./steward.ts";
import { carry, isFeedback, isRelease, stewardNote, subjectOf } from "./trailers.ts";

export const MAX_HEALS = 3;
export const BRIEFING_MAX_CHARS = 6000; // about 1500 tokens
const SCAN_PAGES = 5;

/** Tool names the briefing quotes (C-052 registers the tools under these names). */
export const HEAL_TOOLS = { note: "cell_note", sync: "cell_sync", clear: "cell_clear" } as const;

export type HealKind = "note" | "sync" | "clear";
export type ProblemClass = "stale_branch" | "spec_gap" | "scope_violation" | "broken_main" | "own_bug" | "unknown";

export interface HealOptions extends EngineOptions {
  /** values that must never appear in an answer or a note (env values) */
  secrets?: string[];
}

export interface Heal {
  oid: string;
  kind: string;
  note?: string;
}

/** A steward or heal note that is part of the cell (binding for every chat that continues it). */
export interface Amendment {
  source: "steward" | "heal";
  text: string;
}

// ---------------------------------------------------------------- reading the branch
/**
 * A heal commit: subject "heal(C-NNN): <what>", trailer "heal: <kind>", and for a note a body line "note: <text>".
 * The "note:" prefix keeps the free text from ever being read as a trailer.
 */
export function parseHeal(message: string, cell: string): { kind: string; note?: string } | null {
  const m = /^heal\((C-\d{3,})\):[ \t]*\S/.exec(subjectOf(message));
  if (!m || m[1] !== cell) return null;
  let kind = "";
  let note: string | undefined;
  for (const raw of message.split("\n").slice(1)) {
    const t = raw.trim();
    const k = /^heal:[ \t]*(\S+)$/.exec(t);
    if (k) kind = k[1];
    const n = /^note:[ \t]*(\S.*)$/.exec(t);
    if (n) note = n[1].trim();
  }
  return kind ? { kind, note } : null;
}

/** The commits of the cell branch that belong to the cell (newest first), up to but excluding its claim lock commit. */
async function ownCommits(api: GitHubApi, repo: string, cell: string): Promise<{ oid: string; message: string }[]> {
  const out: { oid: string; message: string }[] = [];
  const lock = `claim(${cell}):`;
  for (let page = 1; page <= SCAN_PAGES; page++) {
    const cs = await api.branchCommits(repo, branchOf(cell), page, 100);
    if (!cs || cs.length === 0) return out;
    for (const c of cs) {
      if (subjectOf(c.message).startsWith(lock)) return out;
      out.push({ oid: c.oid, message: c.message });
    }
    if (cs.length < 100) return out;
  }
  return out;
}

/**
 * Heals (newest first), amendments and notes (both oldest first, so a later note overrides an earlier one) of a cell branch.
 * Amendments are every heal note plus only the NEWEST steward note (a newer steward note replaces older ones, as in the resume text
 * before heals existed); notes holds every heal and steward note and is only used for the briefing.
 */
export async function scanCell(api: GitHubApi, repo: string, cell: string): Promise<{ heals: Heal[]; amendments: Amendment[]; notes: Amendment[] }> {
  const heals: Heal[] = [];
  const newestFirst: Amendment[] = [];
  for (const c of await ownCommits(api, repo, cell)) {
    const h = parseHeal(c.message, cell);
    if (h) {
      heals.push({ oid: c.oid, kind: h.kind, note: h.note });
      if (h.note) newestFirst.push({ source: "heal", text: h.note });
      continue;
    }
    const s = stewardNote(c.message);
    if (s !== null) newestFirst.push({ source: "steward", text: s });
  }
  let seenSteward = false;
  const kept = newestFirst.filter((a) => {
    if (a.source === "heal") return true;
    if (seenSteward) return false;
    seenSteward = true;
    return true;
  });
  return { heals, amendments: kept.reverse(), notes: newestFirst.slice().reverse() };
}

/** Every heal commit of the cell (newest first); heals.length is the budget used. */
export async function healsOf(api: GitHubApi, repo: string, cell: string): Promise<Heal[]> {
  return (await scanCell(api, repo, cell)).heals;
}

/** The binding notes of the cell, oldest first: every heal note and the newest steward note. */
export async function amendmentsOf(api: GitHubApi, repo: string, cell: string): Promise<Amendment[]> {
  return (await scanCell(api, repo, cell)).amendments;
}

/** The AMENDMENTS (binding) text for a list of notes; empty when there are none. */
export function amendmentsBlock(list: Amendment[]): string {
  if (list.length === 0) return "";
  return [
    "AMENDMENTS (binding): added after the cell was planned, by the Steward or by chats that healed this cell. They override the goal where they differ; a later entry overrides an earlier one.",
    ...list.map((a) => `- (${a.source}) ${a.text}`),
  ].join("\n");
}

/** The cell text with the AMENDMENTS block right after the goal (unchanged when there are no notes). */
export function withAmendments(yaml: string, list: Amendment[]): string {
  const block = amendmentsBlock(list);
  if (!block) return yaml;
  const lines = yaml.split("\n");
  const g = lines.findIndex((l) => /^goal:/.test(l));
  if (g < 0) return `${block}\n\n${yaml}`;
  let j = g + 1;
  while (j < lines.length && !/^[A-Za-z_][\w-]*:/.test(lines[j])) j++;
  lines.splice(j, 0, "", block, "");
  return lines.join("\n");
}

// ---------------------------------------------------------------- authority
interface Ctx {
  id: string;
  snap: Snapshot;
  plan: Loaded;
  branch: BranchInfo;
}
type Auth = { ok: true; ctx: Ctx } | { ok: false; text: string };

/**
 * cell_id + base (the current tip of cell/<id>) and a live lease: branch exists, not released, not expired.
 * The answer never shows the real tip: the base is the proof of ownership.
 */
async function authorize(api: GitHubApi, repo: string, opts: HealOptions, a: { cell_id?: string; base?: string }, pages: number): Promise<Auth> {
  const deny = (why: string): Auth => ({ ok: false, text: `SELFHEAL_DENIED: ${why}` });
  const id = String(a?.cell_id ?? "").trim();
  if (!ID_RE.test(id)) return deny(`${oneLine(id, 40) || "(none)"} is not a cell id (expected C-NNN)`);
  const base = String(a?.base ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(base)) return deny("missing base: pass base = the current tip of your cell branch (the 7-character sha from the last CLAIMED / RESUME / ok / HEALED answer)");
  const snap = await freshSnapshot(api, repo, opts, pages);
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
  return { ok: true, ctx: { id, snap, plan, branch } };
}

/** Every answer is redacted (tokens, the given secrets) and failures become text. */
async function safely(opts: HealOptions, id: string, run: () => Promise<string>, max?: number): Promise<string> {
  let text: string;
  try {
    text = await run();
  } catch (e) {
    text = `SELFHEAL_FAILED ${id}: ${errText(e)}`;
  }
  text = redact(text, opts.secrets);
  return max !== undefined && text.length > max ? `${text.slice(0, max - 16)}\n[...truncated]` : text;
}

const cap = (s: string, n: number): string => (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s);
const q = (s: string): string => JSON.stringify(s);
/** The exact call text for a tool of this cell. */
const call = (tool: string, repo: string, id: string, base: string, extra = ""): string => `${tool}(repo=${q(repo)}, cell_id=${q(id)}, base=${q(base)}${extra ? `, ${extra}` : ""})`;

// ---------------------------------------------------------------- classification
const SCOPE_RE = /outside (?:of )?(?:the )?allowed|not in allowed_paths|out of scope|scope violation|not allowed to (?:edit|write|touch)|forbidden path/i;
const FAIL_RE = /\b(?:fail(?:s|ed|ing|ure|ures)?|errors?|exceptions?|broken|red|assert(?:ion|ions)?|typeerror|syntaxerror|cannot|can't|crash(?:es|ed)?|timeout|timed out)\b/i;
const SPEC_RE = /\b(?:contract|spec|specification|ambiguous|unclear|underspecified|contradict(?:s|ion|ory)?|not specified|unspecified|impossible|missing (?:field|input|requirement|detail))\b/i;
const STALE_RE = /\b(?:stale|behind|out of date|outdated|rebase|merge conflict|conflict|diverged|main moved|missing export|not exported|cannot find module|no such file|does not exist|not found)\b/i;
const PATH_RE = /(?:[\w.@-]+\/)+[\w@-]+\.[A-Za-z0-9]{1,5}\b|\b[\w@-]+\.(?:ts|tsx|js|mjs|cjs|json|ya?ml|md|py|css|html|sh|toml|txt|lock)\b/g;

export interface Facts {
  behind: number;
  outside: string[];
  ownMention: boolean;
  mainRed: boolean;
  missingContract: boolean;
}

/** stale_branch, spec_gap, scope_violation, broken_main, own_bug or unknown. First match wins, in this order. */
export function classifyProblem(problem: string, f: Facts): ProblemClass {
  const t = problem.toLowerCase();
  if (f.outside.length > 0 || SCOPE_RE.test(t)) return "scope_violation";
  if (f.mainRed && FAIL_RE.test(t) && !f.ownMention) return "broken_main";
  if ((f.missingContract && !f.ownMention) || SPEC_RE.test(t)) return "spec_gap";
  if (f.behind > 0 && (STALE_RE.test(t) || (FAIL_RE.test(t) && !f.ownMention))) return "stale_branch";
  if (FAIL_RE.test(t) || f.ownMention) return "own_bug";
  return "unknown";
}

/** File paths a problem text mentions (at most 20; urls, node: ids and node_modules are ignored). */
export function mentionedPaths(problem: string): string[] {
  const out: string[] = [];
  for (const m of problem.matchAll(PATH_RE)) {
    const prev = problem[(m.index ?? 0) - 1];
    if (prev === ":" || prev === "/" || prev === "@") continue;
    const p = m[0].replace(/^\.\//, "");
    if (!p || p.startsWith("node_modules/") || out.includes(p)) continue;
    out.push(p);
    if (out.length >= 20) break;
  }
  return out;
}

/** Is a path covered by allowed_paths (exact file, directory prefix, or a * / ** pattern)? */
export function pathAllowed(p: string, patterns: string[]): boolean {
  return patterns.some((pat) => {
    if (pat === p) return true;
    if (pat.endsWith("/")) return p.startsWith(pat);
    if (pat.includes("*")) {
      const re = pat.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*");
      return new RegExp(`^${re}$`).test(p);
    }
    return p.startsWith(`${pat}/`);
  });
}

// ---------------------------------------------------------------- evidence
interface Evidence {
  behind: number;
  ahead: number;
  mainRed: string | null;
  outside: string[];
  ownMention: boolean;
  missingContract: string[];
  unmerged: string[];
  dependents: string[];
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Title of the newest failed gate run that is not a cell run (a run of main), or null. */
async function redMain(api: GitHubApi, repo: string, opts: HealOptions): Promise<string | null> {
  try {
    const runs = (await api.workflowRuns(repo, "cell-gate.yml", 30))
      .filter((r) => r.status === "completed" && r.headBranch === opts.mainBranch && !RUN_TITLE_RE.exec(r.displayTitle || ""))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const r = runs[0];
    return r && (r.conclusion === "failure" || r.conclusion === "timed_out") ? oneLine(r.displayTitle || "gate run", 80) : null;
  } catch {
    return null; // the CI signal is optional
  }
}

/** Facts about why the cell may be blocked. Only ids and titles of other cells; every read is optional. */
async function gather(api: GitHubApi, repo: string, opts: HealOptions, ctx: Ctx, problem: string): Promise<Evidence> {
  const { id, plan, snap } = ctx;
  const c = plan.cells[id] as unknown as Record<string, any>;
  const allowed = strs(c.allowed_paths);
  const paths = mentionedPaths(problem);
  const outside = paths.filter((p) => !pathAllowed(p, allowed));
  const title = (x: string): string => `${x} "${oneLine(String(plan.cells[x]?.title ?? ""), 60)}"`;

  let behind = 0;
  let ahead = 0;
  try {
    const r = await api.compare(repo, opts.mainBranch, branchOf(id));
    behind = r.behind;
    ahead = r.ahead;
  } catch {
    /* unknown: no claim about being behind */
  }

  const inputs: any[] = Array.isArray(c.inputs) ? c.inputs : [];
  const missingContract = inputs.filter((i) => !(i && typeof i.contract === "string" && i.contract.trim())).map((i) => String(i?.from ?? "?"));
  const merged = mergedOf(snap);
  const deps = new Set<string>([...strs(c.after), ...inputs.map((i) => String(i?.from ?? ""))]);
  const unmerged = [...deps].filter((d) => d !== id && d in plan.cells && !merged.has(d)).sort().map(title);
  const dependents = Object.entries(hardGraph(plan.cells))
    .filter(([, ds]) => ds.includes(id))
    .map(([k]) => k)
    .sort()
    .map(title);

  return { behind, ahead, mainRed: await redMain(api, repo, opts), outside, ownMention: paths.length > outside.length, missingContract, unmerged, dependents };
}

// ---------------------------------------------------------------- help
function escalateText(repo: string, ctx: Ctx, heals: Heal[]): string {
  const fb = call("cell_signal", repo, ctx.id, short(ctx.branch.oid), 'kind="feedback", text="<what you tried, what is still wrong, what you propose>"');
  return `ESCALATE ${ctx.id}: the heal budget is used up (${heals.length} of ${MAX_HEALS}: ${heals.map((h) => h.kind).join(", ")}). Heal no more. File feedback now: ${fb}. The Steward takes it from there.`;
}

/** The allowed actions for a class, each with its exact tool call. */
function actionsFor(cls: ProblemClass, repo: string, id: string, base: string, pending: boolean): string[] {
  const sync = call(HEAL_TOOLS.sync, repo, id, base);
  const note = call(HEAL_TOOLS.note, repo, id, base, 'text="<decision or assumption, max 2000 chars>"');
  const fb = call("cell_signal", repo, id, base, 'kind="feedback", text="<what, why, proposed fix>"');
  const pre = `preflight(repo=${q(repo)}, cell_id=${q(id)})`;
  const fix = "apply_changes(repo, cell_id, base, message, next, ops) with paths inside allowed_paths only";
  const by: Record<ProblemClass, string[]> = {
    stale_branch: [
      `${sync}: merges main into your branch (never changes main; one heal; free when already up to date). Continue with the base it returns.`,
      `then ${pre} and fix what is still red with ${fix}.`,
      `if the sync answers CONFLICT: resolve the listed files with ${fix}; files outside allowed_paths need ${fb}.`,
    ],
    spec_gap: [
      `${note}: write the smallest reasonable reading of the gap. It becomes AMENDMENTS (binding) for every chat on this cell; one heal.`,
      "then continue with that reading and name the assumption in your final reply.",
      `if the contract is impossible or contradicts itself, no workaround: ${fb}, then stop.`,
    ],
    scope_violation: [
      "never write outside allowed_paths (apply_changes refuses it); look for a way to finish inside them first.",
      `if the plan of the work changes, record it: ${note}.`,
      `if files outside allowed_paths are truly needed: ${fb} naming the files and why, then stop.`,
    ],
    broken_main: [
      "main itself is red: it is not your bug and main is not yours to fix.",
      `${fb} (say which run is red); the Steward takes it. Or, once main is green: ${sync} then ${pre}.`,
    ],
    own_bug: [
      `fix it with ${fix}, many files per call, then ${pre}.`,
      `if you learned something a later chat needs: ${note} (one heal). Same failure twice: ${fb}.`,
    ],
    unknown: [
      `if the branch is behind main: ${sync}; then ${pre} to see the real failure.`,
      `record what you know with ${note}; if it stays unclear: ${fb}.`,
    ],
  };
  const out = by[cls];
  if (pending) out.push(`feedback is pending on this cell. Only if it was a mistake: ${call(HEAL_TOOLS.clear, repo, id, base)} (one heal); otherwise stop and let the Steward decide.`);
  return out;
}

function briefing(repo: string, ctx: Ctx, problem: string, cls: ProblemClass, ev: Evidence, left: number, amendments: Amendment[]): string {
  const id = ctx.id;
  const c = ctx.plan.cells[id] as unknown as Record<string, any>;
  const base = short(ctx.branch.oid);
  const pending = isFeedback(ctx.branch.message);
  const list = (xs: string[], n: number, chars: number): string => cap(xs.slice(0, n).map((x) => cap(x, 80)).join(", ") + (xs.length > n ? `, ... (+${xs.length - n})` : ""), chars);
  const L: string[] = [];
  L.push(`SELF-HEAL BRIEFING ${id} "${cap(oneLine(String(c.title ?? ""), 80), 80)}" (repo=${repo}, your base=${base})`);
  L.push(`CLASS: ${cls}${pending ? " (feedback is pending on this cell)" : ""}`);
  L.push(`PROBLEM (as you told me): ${cap(problem || "(none given)", 250)}`);
  L.push(`BUDGET: ${left} of ${MAX_HEALS} heals left. ${HEAL_TOOLS.note}, ${HEAL_TOOLS.sync} (when it merges) and ${HEAL_TOOLS.clear} cost one each; up_to_date, CONFLICT and this briefing are free. At 0 the answer is ESCALATE: file cell_signal feedback.`);
  L.push("ALLOWED ACTIONS (nothing else; every call needs your current base):");
  actionsFor(cls, repo, id, base, pending).forEach((a, k) => L.push(`${k + 1}. ${cap(a, 400)}`));

  L.push("WHY IT MAY BE BLOCKED:");
  const ev1: string[] = [];
  if (ev.behind > 0) ev1.push(`your branch is behind main by ${ev.behind} commit(s) (ahead by ${ev.ahead})`);
  if (ev.mainRed) ev1.push(`main CI is red: newest main run "${ev.mainRed}" failed`);
  if (ev.outside.length) ev1.push(`the problem mentions files outside allowed_paths: ${list(ev.outside, 6, 160)}`);
  if (ev.missingContract.length) ev1.push(`no contract text for the input(s) from: ${list(ev.missingContract, 6, 120)}`);
  if (ev.unmerged.length) ev1.push(`a dependency is not merged: ${list(ev.unmerged, 5, 200)}`);
  if (!ev1.length) ev1.push("nothing found beyond what you reported (not behind main, main not red, no unmerged dependency)");
  ev1.forEach((e) => L.push(`- ${cap(e, 220)}`));
  L.push(`DEPENDENTS (cells waiting for this one): ${ev.dependents.length ? list(ev.dependents, 8, 300) : "none"}`);

  L.push("RECENT NOTES (newest first):");
  const notes = amendments.slice().reverse().slice(0, 4);
  if (!notes.length) L.push("- none");
  notes.forEach((n) => L.push(`- (${n.source}) ${cap(n.text, 200)}`));

  const acc = (Array.isArray(c.acceptance) ? c.acceptance : []).map((x: any) => (typeof x === "string" ? x : String(x?.cmd ?? ""))).filter(Boolean);
  L.push(`GOAL: ${cap(oneLine(String(c.goal ?? ""), 500), 500)}`);
  L.push(`ALLOWED_PATHS: ${list(strs(c.allowed_paths), 12, 300)}`);
  L.push(`OUTPUTS: ${list(strs(c.outputs), 12, 250)}`);
  L.push(`ACCEPTANCE: ${list(acc, 6, 250)}`);
  return L.join("\n");
}

/**
 * A focused briefing (at most BRIEFING_MAX_CHARS, about 1500 tokens) for a chat that has a problem: the cell, why it may be
 * blocked, the problem class, the budget and the allowed actions with their exact calls. Over budget: ESCALATE.
 * Read-only: it never writes and costs no heal.
 */
export async function cellHelp(api: GitHubApi, repo: string, opts: HealOptions, a: { cell_id: string; base: string; problem?: string }): Promise<string> {
  return safely(
    opts,
    String(a?.cell_id ?? ""),
    async () => {
      const au = await authorize(api, repo, opts, a, opts.historyPages);
      if (!au.ok) return au.text;
      const { ctx } = au;
      const sc = await scanCell(api, repo, ctx.id);
      const left = MAX_HEALS - sc.heals.length;
      if (left <= 0) return escalateText(repo, ctx, sc.heals);
      const problem = oneLine(String(a.problem ?? ""), 2000);
      const ev = await gather(api, repo, opts, ctx, problem);
      const cls = classifyProblem(problem, { behind: ev.behind, outside: ev.outside, ownMention: ev.ownMention, mainRed: !!ev.mainRed, missingContract: ev.missingContract.length > 0 });
      return briefing(repo, ctx, problem, cls, ev, left, sc.notes);
    },
    BRIEFING_MAX_CHARS,
  );
}

// ---------------------------------------------------------------- heals (each is one commit on the cell branch)
/** "heal(C-NNN): <what>" + optional "note:" body line + "heal: <kind>" trailer; next: and attempt: are carried from the tip. */
function healMessage(prev: string, cell: string, kind: HealKind, what: string, note?: string): string {
  const head = carry(prev, `heal(${cell}): ${what}`);
  const extra = `${note ? `note: ${note}\n` : ""}heal: ${kind}`;
  return head.includes("\n") ? `${head}\n${extra}` : `${head}\n\n${extra}`;
}

/** Authority and budget for a write. feedbackOk: cell_clear may act on a cell whose feedback is pending. */
async function prepare(api: GitHubApi, repo: string, opts: HealOptions, a: { cell_id?: string; base?: string }, feedbackOk: boolean): Promise<{ ctx: Ctx; heals: Heal[] } | string> {
  const au = await authorize(api, repo, opts, a, 0);
  if (!au.ok) return au.text;
  const { ctx } = au;
  if (!feedbackOk && isFeedback(ctx.branch.message)) {
    return `SELFHEAL_DENIED: ${ctx.id} has feedback pending (a human or the Steward decides). Do not change the cell. If the feedback was a mistake: ${HEAL_TOOLS.clear} first.`;
  }
  return { ctx, heals: await healsOf(api, repo, ctx.id) };
}

async function commitHeal(api: GitHubApi, repo: string, ctx: Ctx, message: string): Promise<string | null> {
  const oid = await api.commitEmpty(repo, ctx.branch.oid, ctx.branch.treeOid, message);
  return (await api.fastForward(repo, branchOf(ctx.id), oid)) === "ok" ? oid : null;
}

const moved = (id: string): string => `HEAL_FAILED ${id}: ${branchOf(id)} moved while you were writing (another chat is writing). Nothing was written. Stop and call next_cell.`;
const healed = (id: string, what: string, oid: string, used: number): string =>
  `HEALED ${id}: ${what} (tip ${short(oid)}, next base=${short(oid)}). Heals left: ${Math.max(0, MAX_HEALS - used - 1)} of ${MAX_HEALS}.`;

/**
 * Append a heal commit whose body is the note (cleaned like steward notes, at most NOTE_MAX chars). The note becomes part of
 * the cell: claim and resume texts show it under AMENDMENTS (binding). Costs one heal.
 */
export async function cellNote(api: GitHubApi, repo: string, opts: HealOptions, a: { cell_id: string; base: string; text: string }): Promise<string> {
  return safely(opts, String(a?.cell_id ?? ""), async () => {
    const p = await prepare(api, repo, opts, a, false);
    if (typeof p === "string") return p;
    if (p.heals.length >= MAX_HEALS) return escalateText(repo, p.ctx, p.heals);
    const note = redact(cleanNote(a.text ?? ""), opts.secrets).slice(0, NOTE_MAX);
    if (!note) return `EMPTY_NOTE ${p.ctx.id}: nothing to write (text:). No heal spent.`;
    const oid = await commitHeal(api, repo, p.ctx, healMessage(p.ctx.branch.message, p.ctx.id, "note", "note", note));
    return oid ? healed(p.ctx.id, "note recorded; every chat that continues this cell sees it under AMENDMENTS (binding)", oid, p.heals.length) : moved(p.ctx.id);
  });
}

/**
 * Merge main into cell/<id> (message "heal(C-NNN): sync main"); main itself is never touched. up_to_date costs nothing, a
 * conflict changes nothing and lists the files, a merge costs one heal.
 */
export async function cellSync(api: GitHubApi, repo: string, opts: HealOptions, a: { cell_id: string; base: string }): Promise<string> {
  return safely(opts, String(a?.cell_id ?? ""), async () => {
    const p = await prepare(api, repo, opts, a, false);
    if (typeof p === "string") return p;
    const { ctx, heals } = p;
    const upToDate = `UP_TO_DATE ${ctx.id}: ${branchOf(ctx.id)} already contains ${opts.mainBranch}. Nothing changed, no heal spent. Your base is still ${short(ctx.branch.oid)}.`;
    if (heals.length >= MAX_HEALS) {
      // a merge would be a fourth heal, but being up to date is free to report
      const r = await api.compare(repo, opts.mainBranch, branchOf(ctx.id)).catch(() => null);
      return r && r.behind === 0 ? upToDate : escalateText(repo, ctx, heals);
    }
    const res = await api.mergeBranch(repo, branchOf(ctx.id), opts.mainBranch, healMessage(ctx.branch.message, ctx.id, "sync", "sync main"));
    if (res.status === "up_to_date") return upToDate;
    if (res.status === "conflict") {
      const files = (res.files ?? []).slice(0, 12).join(", ");
      return `CONFLICT ${ctx.id} (sync): ${opts.mainBranch} and your branch changed the same file(s)${files ? `: ${files}` : ""}. This is NOT a takeover: the cell is still yours and nothing was changed (no heal spent). Resolve those files inside allowed_paths with apply_changes, or file cell_signal feedback.`;
    }
    const tip = res.oid ?? (await api.branchTip(repo, branchOf(ctx.id)))?.oid;
    if (!tip) return `HEAL_FAILED ${ctx.id}: the merge answered without a new tip. Call ${HEAL_TOOLS.sync} again.`;
    return healed(ctx.id, `${opts.mainBranch} merged into ${branchOf(ctx.id)}; ${opts.mainBranch} itself was not touched`, tip, heals.length);
  });
}

/** Remove the feedback state of this one cell (like takeover clear_feedback) with a heal commit. Costs one heal. */
export async function cellClear(api: GitHubApi, repo: string, opts: HealOptions, a: { cell_id: string; base: string }): Promise<string> {
  return safely(opts, String(a?.cell_id ?? ""), async () => {
    const p = await prepare(api, repo, opts, a, true);
    if (typeof p === "string") return p;
    const { ctx, heals } = p;
    if (!isFeedback(ctx.branch.message)) return `NO_FEEDBACK ${ctx.id}: there is no feedback state to clear. No heal spent.`;
    if (heals.length >= MAX_HEALS) return escalateText(repo, ctx, heals);
    const oid = await commitHeal(api, repo, ctx, healMessage(ctx.branch.message, ctx.id, "clear", "clear"));
    return oid ? healed(ctx.id, "feedback state cleared; the cell is yours again", oid, heals.length) : moved(ctx.id);
  });
}
