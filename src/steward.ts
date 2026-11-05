// steward.ts
//
// The Steward: a role (not a cell) that any stateless chat can take, resume or release like a cell. It never merges.
// Its lease is the tip of the branch steward/lease, OUTSIDE the cell/ namespace, so every cell/ regex ignores it.
// No tool registration here (the next cell does that).

import type { GitHubApi, Snapshot } from "./api.ts";
import {
  ID_RE,
  RUN_TITLE_RE,
  claimsFromBranches,
  computeState,
  directDependents,
  hardGraph,
  loadConfig,
  parseRuns,
  transitiveDependents,
  type Cell,
  type Config,
} from "./plan.ts";
import { NOT_INIT, branchOf, errText, freshSnapshot, invalidText, loadPlan, mergedOf, oneLine, short, type EngineOptions } from "./common.ts";
import { carry, isFeedback, isRelease, parseTrailers, stateSubject, subjectOf, withHeld } from "./trailers.ts";

export const STEWARD_BRANCH = "steward/lease";
export const NOTE_MAX = 2000;
export const STUCK_READY_MINUTES = 60;
export const CI_FAIL_IDLE_MINUTES = 10; // a chat that just got a red CI is still fixing it

export interface StewardOptions {
  mainBranch: string;
  now: () => number;
  uuid: () => string;
}
function resolveOpts(o?: Partial<StewardOptions>): StewardOptions {
  return {
    mainBranch: o?.mainBranch ?? "main",
    now: o?.now ?? (() => Date.now()),
    uuid: o?.uuid ?? (() => globalThis.crypto.randomUUID()),
  };
}

const cleanWho = (who: string): string => who.replace(/[^\w .-]/g, "").trim().slice(0, 40) || "steward";

// ---------------------------------------------------------------- lease
export interface Tip {
  oid: string;
  treeOid: string;
  committedDate: string;
  message: string;
}
export type LeaseTip = { message: string; committedDate: string };
/** A lease tip, null (no lease), or anything with a branches map that may hold steward/lease. */
export type LeaseSource = LeaseTip | null | undefined | { branches: Record<string, LeaseTip> };

export type StewardStatus =
  | { state: "none" }
  | { state: "active"; holder: string; session: string; minutesLeft: number }
  | { state: "expired"; holder: string; session: string; expiredMinutesAgo: number }
  | { state: "released"; holder: string; session: string };

export interface LeaseTrailers {
  who: string;
  session: string;
  at: string;
  release?: string;
}

export function parseLease(message: string): LeaseTrailers {
  const t: LeaseTrailers = { who: "", session: "", at: "" };
  for (const raw of message.split("\n").slice(1)) {
    const m = /^(steward-who|steward-session|steward-at|release):[ \t]*(.*)$/.exec(raw.trim());
    if (!m) continue;
    const v = m[2].trim();
    if (m[1] === "steward-who") t.who = v;
    else if (m[1] === "steward-session") t.session = v;
    else if (m[1] === "steward-at") t.at = v;
    else t.release = v || "handoff";
  }
  return t;
}

/** none | active | expired | released. The heartbeat is the commit date of the lease tip (steward-at is the fallback). */
export function stewardStatus(src: LeaseSource, now: number, leaseMinutes = 60): StewardStatus {
  const tip = src && typeof src === "object" && "branches" in src ? src.branches[STEWARD_BRANCH] : (src as LeaseTip | null | undefined);
  if (!tip) return { state: "none" };
  const t = parseLease(tip.message);
  const holder = t.who || "unknown";
  if (t.release) return { state: "released", holder, session: t.session };
  let ts = Date.parse(tip.committedDate);
  if (Number.isNaN(ts)) ts = Date.parse(t.at);
  const age = Number.isNaN(ts) ? Infinity : Math.max(0, (now - ts) / 60000);
  if (age < leaseMinutes) return { state: "active", holder, session: t.session, minutesLeft: Math.max(1, Math.ceil(leaseMinutes - age)) };
  return { state: "expired", holder, session: t.session, expiredMinutesAgo: Number.isFinite(age) ? Math.floor(age - leaseMinutes) : 0 };
}

/** Tip of a branch with its message; null when the branch does not exist. */
export async function readTip(api: GitHubApi, repo: string, branch: string): Promise<Tip | null> {
  for (let i = 0; i < 3; i++) {
    const cs = await api.branchCommits(repo, branch, 1, 1);
    if (!cs || cs.length === 0) return null;
    const tip = await api.branchTip(repo, branch);
    if (!tip) return null;
    if (tip.oid === cs[0].oid) return { oid: tip.oid, treeOid: cs[0].treeOid, committedDate: tip.committedDate, message: cs[0].message };
  }
  throw new Error(`${branch} kept moving while it was read`);
}

/** Lease length in minutes: lease_minutes of blueprint.yaml (60 when missing or invalid). */
export async function leaseMinutesOf(api: GitHubApi, repo: string, mainBranch: string): Promise<number> {
  try {
    const f = await api.readFiles(repo, mainBranch, ["blueprint.yaml"]);
    const n = loadConfig(f["blueprint.yaml"]).cfg.lease_minutes;
    return Number.isInteger(n) && n > 0 ? n : 60;
  } catch {
    return 60;
  }
}

function leaseMessage(kind: string, o: StewardOptions, who: string, session: string, release?: string): string {
  const lines = [`steward-who: ${who}`, `steward-session: ${session}`, `steward-at: ${new Date(o.now()).toISOString()}`];
  if (release) lines.push(`release: ${release}`);
  return `steward(lease): ${kind} ${o.uuid()}\n\n${lines.join("\n")}`;
}

export interface StewardClaim {
  status: "CREATED" | "ADOPTED" | "REFRESHED" | "STEWARD_BUSY" | "STEWARD_FAILED";
  session: string;
  who: string;
  text: string;
}

/**
 * Take, resume or heartbeat the Steward role. No branch: create. Active lease of another session: STEWARD_BUSY.
 * Expired or released: adopt (resume). Same session while active: refresh. Race safe: the branch is created once,
 * and every later move is a non-force fast-forward from the tip that was read (like tryTakeover).
 */
export async function claimSteward(api: GitHubApi, repo: string, who: string, session?: string, o?: Partial<StewardOptions>): Promise<StewardClaim> {
  const op = resolveOpts(o);
  const name = cleanWho(who);
  const fail = (status: StewardClaim["status"], text: string): StewardClaim => ({ status, session: session ?? "", who: name, text });
  try {
    const lease = await readTip(api, repo, STEWARD_BRANCH);
    const lm = await leaseMinutesOf(api, repo, op.mainBranch);
    const sid = session || `steward-${op.uuid().replace(/-/g, "")}`;
    const done = (status: StewardClaim["status"], what: string): StewardClaim => ({
      status,
      session: sid,
      who: name,
      text: `STEWARD ${what} session=${sid} repo=${repo} (lease ${lm} min, renewed by every steward call)`,
    });
    if (!lease) {
      const main = await api.branchTip(repo, op.mainBranch);
      if (!main) return fail("STEWARD_FAILED", `STEWARD_FAILED: no ${op.mainBranch} branch in ${repo}`);
      const oid = await api.commitEmpty(repo, main.oid, main.treeOid, leaseMessage("create", op, name, sid));
      if ((await api.createBranch(repo, STEWARD_BRANCH, oid)) !== "created") return fail("STEWARD_BUSY", "STEWARD_BUSY: another chat became the Steward just now");
      return done("CREATED", "CREATED");
    }
    const st = stewardStatus(lease, op.now(), lm);
    const mine = !!session && st.state !== "none" && st.session === session;
    if (st.state === "active" && !mine) {
      return fail("STEWARD_BUSY", `STEWARD_BUSY: ${st.holder} is the Steward (${st.minutesLeft} min of lease left). Do not work as Steward; end your turn.`);
    }
    const kind = st.state === "active" ? "heartbeat" : "adopt";
    const oid = await api.commitEmpty(repo, lease.oid, lease.treeOid, leaseMessage(kind, op, name, sid));
    if ((await api.fastForward(repo, STEWARD_BRANCH, oid)) !== "ok") return fail("STEWARD_BUSY", "STEWARD_BUSY: another chat updated the lease just now");
    return kind === "heartbeat" ? done("REFRESHED", "REFRESHED") : done("ADOPTED", `ADOPTED (${st.state})`);
  } catch (e) {
    return fail("STEWARD_FAILED", `STEWARD_FAILED: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Hand the Steward role off: a commit that marks the lease released. Only the holding session may do it. */
export async function releaseSteward(api: GitHubApi, repo: string, session: string, handoff: boolean, o?: Partial<StewardOptions>): Promise<{ ok: boolean; text: string }> {
  const op = resolveOpts(o);
  try {
    const lease = await readTip(api, repo, STEWARD_BRANCH);
    if (!lease) return { ok: false, text: "NO_STEWARD: nobody holds the Steward role" };
    const t = parseLease(lease.message);
    if (!session || t.session !== session) return { ok: false, text: "NOT_STEWARD: this session does not hold the Steward lease" };
    if (t.release) return { ok: true, text: "ALREADY_RELEASED: the Steward lease is already released" };
    const oid = await api.commitEmpty(repo, lease.oid, lease.treeOid, leaseMessage("release", op, t.who || "steward", session, handoff ? "handoff" : "done"));
    if ((await api.fastForward(repo, STEWARD_BRANCH, oid)) !== "ok") return { ok: false, text: "RELEASE_FAILED: the lease moved just now; call again" };
    return { ok: true, text: handoff ? "STEWARD_RELEASED: handed off. A fresh chat may take the role." : "STEWARD_RELEASED: done." };
  } catch (e) {
    return { ok: false, text: `RELEASE_FAILED: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ---------------------------------------------------------------- notes
/** Control characters stripped, whitespace collapsed to one line, at most NOTE_MAX chars. */
export function cleanNote(text: string): string {
  return String(text)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NOTE_MAX);
}

/**
 * Append an empty commit "steward(C-NNN): <text>" on cell/C-NNN. The next chat that resumes the cell sees the note at the
 * top of its resume text. A note moves the branch tip, so it fences out a live owner: write notes for cells that are
 * dead, released or waiting on feedback, not for a chat that is working. A feedback or release state is kept (held:).
 */
export async function noteCell(api: GitHubApi, repo: string, cell: string, text: string): Promise<string> {
  if (!ID_RE.test(cell)) return `UNKNOWN_CELL ${cell}`;
  const note = cleanNote(text);
  if (!note) return `EMPTY_NOTE ${cell}: nothing to write`;
  try {
    const tip = await readTip(api, repo, branchOf(cell));
    if (!tip) return `NOT_RUNNING ${cell}: no branch ${branchOf(cell)}`;
    const state = stateSubject(tip.message);
    const held = /^(feedback|release)\(/.test(state) ? state.slice(0, NOTE_MAX) : undefined;
    const oid = await api.commitEmpty(repo, tip.oid, tip.treeOid, withHeld(carry(tip.message, `steward(${cell}): ${note}`), held));
    if ((await api.fastForward(repo, branchOf(cell), oid)) !== "ok") return `NOTE_FAILED ${cell}: someone else just updated the branch`;
    return `NOTED ${cell} (tip ${short(oid)}): the next chat that resumes it sees the note first.`;
  } catch (e) {
    return `NOTE_FAILED ${cell}: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ---------------------------------------------------------------- problems
export type ProblemKind = "needs_human" | "needs_split" | "expired" | "ci_failed" | "stuck_ready";
export interface Problem {
  id: string;
  title: string;
  kind: ProblemKind;
  why: string;
  attempts: number;
  lastCommit: string;
  dependents: number; // cells waiting for this one, directly or not
  critical: boolean;
  ageMinutes: number;
  actions: string[];
}

export interface ProblemInput {
  cells: Record<string, Cell>;
  cfg: Config;
  snap: Snapshot;
  merged: Set<string>;
  now: number;
  /** minutes since each cell's newest active workflow run started */
  ci?: Record<string, number>;
  /** cells whose newest gate run failed */
  failedCi?: Iterable<string>;
  /** minutes since the last commit on main: a lower bound for how long a ready cell has been ready */
  mainAgeMinutes?: number;
}

const KIND_RANK: Record<ProblemKind, number> = { needs_human: 0, needs_split: 1, expired: 2, ci_failed: 3, stuck_ready: 4 };

export const ACTIONS: Record<ProblemKind, string[]> = {
  needs_human: [
    "answer the feedback yourself (read the cell and the feedback), write the answer as a note on the cell (noteCell), then takeover(cell_id, clear_feedback=true, handoff=true) so a fresh chat resumes with your note",
    "if the cell itself is wrong or too big: publish_plan a superseding cell (supersedes: [the old id]) instead",
  ],
  needs_split: [
    "publish_plan a superseding cell or cells (supersedes: [the old id]) that cut the work smaller, with the same provides",
    "or write a note with a sharper hint and takeover(cell_id, force=true, handoff=true) once, if a hint alone can unblock it",
  ],
  expired: [
    "write a note with what the dead chats got stuck on (noteCell), then takeover(cell_id, force=true, handoff=true) to release it for a fresh chat",
    "if the branch already holds good work but is broken: fix it with apply_changes on the cell branch (takeover first so you hold the base)",
  ],
  ci_failed: [
    "read the failure, fix the branch with apply_changes (takeover first so you hold the base), or write a note and release it with takeover(handoff=true)",
  ],
  stuck_ready: [
    "check that the cell is not reserved for a person or blocked by a plan mistake; if it is fine, a fresh chat must call next_cell: report it and move on",
    "if the plan is wrong, publish_plan a replacement cell",
  ],
};

function longestChain(down: Record<string, string[]>, id: string, memo: Record<string, number>): number {
  if (id in memo) return memo[id];
  memo[id] = 0; // cycle guard
  let best = 0;
  for (const d of down[id] ?? []) best = Math.max(best, 1 + longestChain(down, d, memo));
  return (memo[id] = best);
}

/** Open problems, most impactful first: transitive dependents descending, then critical, then age (oldest first), then id. */
export function findProblems(inp: ProblemInput): Problem[] {
  const { cells, cfg, snap, merged, now } = inp;
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
  const state = computeState(cells, merged, claims, cfg.lease_minutes, inp.ci ?? {}, cfg.max_ci_minutes, cfg.bottleneck_threshold, {
    criticalLeaseMinutes: cfg.critical_lease_minutes,
    criticalChainThreshold: cfg.critical_chain_threshold,
    criticalTransitiveThreshold: cfg.critical_transitive_threshold,
    parkMaxMinutes: cfg.park_max_minutes,
    maxAttempts: cfg.max_attempts,
    released,
    attempts,
    feedback,
  });

  const trans = transitiveDependents(cells);
  const direct = directDependents(cells);
  const down: Record<string, string[]> = {};
  for (const c of Object.keys(cells)) down[c] = [];
  for (const [c, deps] of Object.entries(hardGraph(cells))) for (const d of deps) down[d].push(c);
  const memo: Record<string, number> = {};
  const isCritical = (id: string): boolean =>
    direct[id] >= cfg.bottleneck_threshold || trans[id] >= cfg.critical_transitive_threshold || longestChain(down, id, memo) >= cfg.critical_chain_threshold;

  const found = new Map<string, { kind: ProblemKind; whys: string[] }>();
  const add = (id: string, kind: ProblemKind, why: string) => {
    if (!(id in cells) || merged.has(id)) return;
    const cur = found.get(id);
    if (!cur) found.set(id, { kind, whys: [why] });
    else {
      if (KIND_RANK[kind] < KIND_RANK[cur.kind]) cur.kind = kind;
      if (!cur.whys.includes(why)) cur.whys.push(why);
    }
  };

  for (const x of state.needs_human ?? []) {
    const b = snap.branches[branchOf(x.id)];
    const text = b ? stateSubject(b.message).replace(/^feedback\([^)]*\):\s*/, "") : "";
    add(x.id, "needs_human", `a chat asked for a decision: ${oneLine(text, 400) || "(no text)"}`);
  }
  for (const x of state.needs_split ?? []) add(x.id, "needs_split", `the lease died ${x.attempts} times: the cell is too big or unclear`);
  for (const r of state.ready) {
    if (r.reclaim && (attempts[r.id] ?? 0) >= 2) add(r.id, "expired", `lease expired after ${attempts[r.id]} dead attempts${r.released ? " (released)" : ""}`);
    if (!r.reclaim && (inp.mainAgeMinutes ?? 0) > STUCK_READY_MINUTES) {
      add(r.id, "stuck_ready", `ready and unclaimed for at least ${Math.floor(inp.mainAgeMinutes ?? 0)} min (main has not moved since)`);
    }
  }
  for (const id of inp.failedCi ?? []) {
    if (snap.branches[branchOf(id)] && (claims[id] ?? 0) >= CI_FAIL_IDLE_MINUTES) add(id, "ci_failed", "the newest CI gate run of its PR failed and the chat has not pushed since");
  }

  const out: Problem[] = [];
  for (const [id, f] of found) {
    const b = snap.branches[branchOf(id)];
    out.push({
      id,
      title: oneLine(String(cells[id].title ?? ""), 120),
      kind: f.kind,
      why: f.whys.join("; "),
      attempts: attempts[id] ?? 0,
      lastCommit: b ? oneLine(subjectOf(b.message), 160) : "(no branch yet)",
      dependents: trans[id] ?? 0,
      critical: isCritical(id),
      ageMinutes: Math.round(b ? (claims[id] ?? 0) : (inp.mainAgeMinutes ?? 0)),
      actions: ACTIONS[f.kind],
    });
  }
  out.sort((a, b) => b.dependents - a.dependents || Number(b.critical) - Number(a.critical) || b.ageMinutes - a.ageMinutes || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

// ---------------------------------------------------------------- briefing
export const MAX_PROBLEMS_SHOWN = 12;
const DOC_MAX = 800;
const BLUEPRINT_MAX = 2500;
const DOCS_TOTAL_MAX = 6000;

/** Remove secrets: the given values (an env, for instance) and anything shaped like a GitHub token or a token assignment. */
export function redact(text: string, secrets: string[] = []): string {
  let out = text;
  for (const s of secrets) if (typeof s === "string" && s.length >= 4) out = out.split(s).join("[redacted]");
  out = out.replace(/\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g, "[redacted]");
  out = out.replace(/\b(GITHUB_TOKEN|ADMIN_TOKEN|ADMIN_KEY)\b(\s*[=:]\s*)\S+/g, "$1$2[redacted]");
  return out;
}

function excerpt(text: string, max: number): string {
  const t = text.replace(/\r/g, "").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const nl = cut.lastIndexOf("\n");
  return (nl > max * 0.6 ? cut.slice(0, nl) : cut) + "\n[...truncated]";
}

export interface BriefingInput extends ProblemInput {
  repo: string;
  project?: string;
  docs?: { path: string; text: string }[];
  /** values that must never appear in the text (env values) */
  secrets?: string[];
  status?: StewardStatus;
}

export const WORKING_RULES = [
  "WORKING RULES",
  "1. Always take the first problem on the list, resolve it with the actions above, then take the next one. Do not skip ahead.",
  "2. You are not a cell: never merge, never open a PR for yourself, never edit cells/*.yaml in place (cells are immutable). Fix problems through a note, takeover, a superseding cell (publish_plan) or a fix on the branch (apply_changes).",
  "3. Never write a note on a cell whose chat is alive (its lease is running): a note moves the branch and would fence its owner out.",
  "4. Keep every note short and concrete: what failed and what to do differently (at most 2000 characters).",
  "5. Never print, store or repeat any secret (tokens, keys).",
  "6. When the list is empty, say so, and call steward_next again in 45 seconds (at most 8 times in a row), then stop.",
].join("\n");

/** The text a chat gets first when it takes the Steward role. Bounded, and redacted at the end. */
export function buildBriefing(inp: BriefingInput): string {
  const problems = findProblems(inp);
  const total = Object.keys(inp.cells).length;
  const mergedCount = Object.keys(inp.cells).filter((id) => inp.merged.has(id)).length;
  const inFlight = Object.keys(inp.snap.branches).filter((n) => {
    const m = /^cell\/(C-\d+)$/.exec(n);
    return !!m && !inp.merged.has(m[1]);
  }).length;

  const L: string[] = [];
  L.push(`STEWARD BRIEFING for ${inp.project || inp.cfg.project || inp.repo} (repo=${inp.repo})`);
  L.push("You are the Steward: a role, not a cell. You hold the admin tools and solve the problems of other cells so that no human is needed. You never merge.");
  if (inp.status && inp.status.state === "active") L.push(`Your lease: ${inp.status.minutesLeft} min left (renewed by every steward call).`);

  L.push("", "PROJECT RULES (excerpts)");
  let budget = DOCS_TOTAL_MAX;
  const docs = inp.docs ?? [];
  if (!docs.length) L.push("(no BLUEPRINT.md or docs/*.md found)");
  for (const d of docs) {
    if (budget <= 0) break;
    const max = Math.min(d.path === "BLUEPRINT.md" ? BLUEPRINT_MAX : DOC_MAX, budget);
    const text = excerpt(d.text, max);
    budget -= text.length;
    L.push(`--- ${d.path}`, text);
  }

  L.push("", `COUNTS: ${total} cells, ${mergedCount} merged, ${inFlight} with a branch, ${total - mergedCount} open, ${problems.length} problems`);

  L.push("", "PROBLEM LIST (most impact first: cells waiting behind it, then critical, then age)");
  if (!problems.length) L.push("EMPTY: no open problems.");
  problems.slice(0, MAX_PROBLEMS_SHOWN).forEach((p, i) => {
    L.push(`${i + 1}. ${p.id} "${p.title}"${p.critical ? " [critical]" : ""} (${p.kind})`);
    L.push(`   why: ${p.why}`);
    L.push(`   attempts: ${p.attempts}; last commit: ${p.lastCommit}; dependents: ${p.dependents}; age: ${p.ageMinutes} min`);
    for (const a of p.actions) L.push(`   allowed: ${a}`);
  });
  if (problems.length > MAX_PROBLEMS_SHOWN) L.push(`(+${problems.length - MAX_PROBLEMS_SHOWN} more; they are listed again after you resolve these)`);

  L.push("", "TOOLS YOU MAY USE: note a cell (an empty commit steward(C-NNN): text that the next chat sees first), takeover (clear_feedback, handoff, force), publish_plan (a superseding cell), apply_changes (fix a branch you hold).");
  L.push("", WORKING_RULES);
  return redact(L.join("\n"), inp.secrets);
}

/** Read everything buildBriefing needs from GitHub and build it. Returns an engine message (NOT_INITIALIZED, ...) when no briefing can be made. */
export async function gatherBriefing(api: GitHubApi, repo: string, opts: EngineOptions, extra: { secrets?: string[]; status?: StewardStatus } = {}): Promise<string> {
  const snap = await freshSnapshot(api, repo, opts, opts.historyPages);
  if (typeof snap === "string") return snap;
  if (snap.blueprint === null) return NOT_INIT;
  const plan = loadPlan(repo, snap, opts);
  if (plan.errors.length) return invalidText(plan);
  const now = opts.now();

  let ci: Record<string, number> = {};
  try {
    ci = parseRuns(await api.activeRuns(repo), now);
  } catch {
    /* the CI signal is optional */
  }
  const failedCi = new Set<string>();
  try {
    const seen = new Set<string>();
    const runs = (await api.workflowRuns(repo, "cell-gate.yml", 50)).slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    for (const r of runs) {
      const id = RUN_TITLE_RE.exec(r.displayTitle || "")?.[1];
      if (!id || seen.has(id)) continue;
      seen.add(id);
      if (r.status === "completed" && (r.conclusion === "failure" || r.conclusion === "timed_out")) failedCi.add(id);
    }
  } catch {
    /* the CI signal is optional */
  }
  let mainAgeMinutes: number | undefined;
  try {
    const tip = await api.branchTip(repo, opts.mainBranch);
    const ts = tip ? Date.parse(tip.committedDate) : NaN;
    if (!Number.isNaN(ts)) mainAgeMinutes = Math.max(0, (now - ts) / 60000);
  } catch {
    /* optional */
  }
  const docs: { path: string; text: string }[] = [];
  try {
    const names = ((await api.listDir(repo, opts.mainBranch, "docs")) ?? [])
      .filter((n) => n.endsWith(".md"))
      .sort()
      .slice(0, 6)
      .map((n) => `docs/${n}`);
    const files = await api.readFiles(repo, opts.mainBranch, ["BLUEPRINT.md", ...names]);
    for (const p of ["BLUEPRINT.md", ...names]) if (files[p]) docs.push({ path: p, text: files[p] as string });
  } catch (e) {
    docs.push({ path: "docs", text: `(could not read the docs: ${errText(e)})` });
  }
  return buildBriefing({ cells: plan.cells, cfg: plan.cfg, snap, merged: mergedOf(snap), now, ci, failedCi, mainAgeMinutes, repo, docs, secrets: extra.secrets, status: extra.status });
}
