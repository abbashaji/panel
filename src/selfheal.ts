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

/** Heals (newest first) and amendments (oldest first, so a later note overrides an earlier one) of a cell branch. */
export async function scanCell(api: GitHubApi, repo: string, cell: string): Promise<{ heals: Heal[]; amendments: Amendment[] }> {
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
  return { heals, amendments: newestFirst.reverse() };
}

/** Every heal commit of the cell (newest first); heals.length is the budget used. */
export async function healsOf(api: GitHubApi, repo: string, cell: string): Promise<Heal[]> {
  return (await scanCell(api, repo, cell)).heals;
}

/** All heal and steward notes of the cell, oldest first. */
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
