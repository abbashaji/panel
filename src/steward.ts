// steward.ts
//
// The Steward: a role (not a cell) that any stateless chat can take, resume or release like a cell. It never merges.
// Its lease is the tip of the branch steward/lease, OUTSIDE the cell/ namespace, so every cell/ regex ignores it.
// No tool registration here (the next cell does that).

import type { GitHubApi, Snapshot } from "./api.ts";
import {
  ID_RE,
  claimsFromBranches,
  computeState,
  directDependents,
  hardGraph,
  loadConfig,
  transitiveDependents,
  type Cell,
  type Config,
} from "./plan.ts";
import { branchOf, oneLine, short } from "./common.ts";
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
