// Shared types for the Blueprint Panel. Source of truth: docs/panel-contracts.md (section 3.2).
// The Worker (src/panel/*) and the SPA (web/src/*) both import from this file.
import type { Env } from "../tools.ts";

export type PanelStatus =
  | "expired"
  | "done"
  | "running"
  | "ready"
  | "waiting"
  | "needs_human"
  | "needs_split";

export type CellType = "normal" | "skeleton" | "integration";

/** implementation = the provider must be MERGED first; contract = start now against a mock. */
export type DependKind = "implementation" | "contract";

export interface PanelDepend {
  id: string;
  kind: DependKind;
}

export interface PanelCell {
  id: string;
  title: string;
  type: CellType;
  priority: number;
  status: PanelStatus;
  /** direct dependents >= bottleneck_threshold, or chain >= 3, or transitive >= 5 (see computeState) */
  critical: boolean;
  wave: number;
  depends: PanelDepend[];
  blockedBy: string[];
  directDependents: number;
  /** number of transitive dependents of this cell (used for the bottleneck rank) */
  transitiveDependents: number;
  sha: {
    /** newest commit with subject claim(<id>): / takeover(<id>): / adopt(<id>):, 7 chars, null if none */
    lock: string | null;
    /** branch tip, 7 chars, null if there is no branch */
    tip: string | null;
    /** the snapshot has no main commit sha, so this is null until github.ts is extended (see Open points) */
    merged: string | null;
  };
  /** null unless the cell has a branch with a lease (running or expired) */
  lease: {
    minutesLeft: number;
    /** set when the lease is expired */
    expiredMinutesAgo: number | null;
    ci: boolean;
  } | null;
  attempts: number;
  maxAttempts: number;
  lastCommit: { subject: string; next: string | null; at: string } | null;
  /** display name that reserved the cell (KV reserve:<repo>:<cell>), or null */
  reservedBy: string | null;
  pr: { number: number; state: "open" | "merged" | "closed" } | null;
  allowedPaths: string[];
  provides: string[];
  inputs: string[];
  /** true for a ready or expired cell whose branch tip is a release/handoff commit, and for a branch whose lease expired */
  resumable?: boolean;
  /** sorted ids of the cells that replace this one; set only when it never merged. It stays 'waiting' and is left out of counts. */
  supersededBy?: string[];
  /** number of heal commits (subject 'heal(<id>): <kind>' plus trailer 'heal: <kind>') on the cell branch; set only when > 0 */
  heals?: number;
}

export interface PanelCounts {
  done: number;
  running: number;
  ready: number;
  waiting: number;
  expired: number;
  needs_human: number;
  needs_split: number;
}

export type PanelStewardStatus = "none" | "active" | "expired" | "released";

/** The Steward role (lease branch steward/lease), see src/steward.ts stewardStatus. */
export interface PanelSteward {
  status: PanelStewardStatus;
  holder: string | null;
  /** set while active */
  minutesLeft: number | null;
  /** set when expired */
  expiredMinutesAgo: number | null;
  /** number of needs_human + needs_split cells */
  problems: number;
}

export interface PanelState {
  /** owner/name */
  repo: string;
  project: string;
  /** 7 chars */
  mainSha: string;
  /** ISO timestamp */
  generatedAt: string;
  counts: PanelCounts;
  cells: PanelCell[];
  /** not-done cell with the most transitive dependents; null when nothing is blocked */
  bottleneck: { id: string; blocks: number } | null;
  /** optional so older fixtures and an older Worker still compile; the UI treats a missing steward as "none" */
  steward?: PanelSteward;
  /** self-heal events across all cell branches, newest first, at most 20, note cut to 160 chars; set only when there are any */
  healLog?: { cell: string; kind: string; at: string; note: string }[];
}

export interface ReserveResult {
  status: "reserved" | "not_ready" | "taken";
  detail: string;
}

/** Body of POST /panel/api/login */
export interface LoginBody {
  password: string;
}

/** Body of POST /panel/api/reserve */
export interface ReserveBody {
  repo: string;
  cell_id: string;
  who: string;
}

/** Body of POST /panel/api/release and /panel/api/clear-feedback */
export interface AdminActionBody {
  repo: string;
  cell_id: string;
  admin_key: string;
}

/** Body of POST /panel/api/steward-release */
export interface StewardReleaseBody {
  repo: string;
  admin_key: string;
}

/** Answer of POST /panel/api/steward-release */
export interface StewardReleaseResult {
  ok: boolean;
  result: string;
  steward: PanelSteward;
}

export interface PanelEnv extends Env {
  /** secret: password for POST /panel/api/login (new secret) */
  PANEL_TOKEN?: string;
  /** secret: owner key for release / clear-feedback (existing secret) */
  ADMIN_TOKEN?: string;
  /** Workers Static Assets binding for web/dist */
  ASSETS?: Fetcher;
}

/** POST /panel/api/steward-code: mints a one-time Steward start code (admin key required). */
export interface StewardCodeBody {
  repo: string;
  admin_key: string;
}
export interface StewardCodeResult {
  ok: true;
  code: string;
  expires_in: number;
}
