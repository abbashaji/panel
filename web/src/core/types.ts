// Mirror of src/panel/types.ts (the Worker side). It is copied, not imported, because src/panel/types.ts
// imports the Worker Env type, which would pull the whole Worker into the web type-check.
// core/types.test.ts fails when an exported name here drifts from the Worker file.

export type PanelStatus =
  | "expired"
  | "done"
  | "running"
  | "ready"
  | "waiting"
  | "needs_human"
  | "needs_split";

export type CellType = "normal" | "skeleton" | "integration";

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
  critical: boolean;
  wave: number;
  depends: PanelDepend[];
  blockedBy: string[];
  directDependents: number;
  transitiveDependents: number;
  sha: { lock: string | null; tip: string | null; merged: string | null };
  lease: { minutesLeft: number; expiredMinutesAgo: number | null; ci: boolean } | null;
  attempts: number;
  maxAttempts: number;
  lastCommit: { subject: string; next: string | null; at: string } | null;
  reservedBy: string | null;
  pr: { number: number; state: "open" | "merged" | "closed" } | null;
  allowedPaths: string[];
  provides: string[];
  inputs: string[];
  resumable?: boolean;
  supersededBy?: string[];
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

export interface PanelSteward {
  status: PanelStewardStatus;
  holder: string | null;
  minutesLeft: number | null;
  expiredMinutesAgo: number | null;
  problems: number;
}

export interface PanelState {
  repo: string;
  project: string;
  mainSha: string;
  generatedAt: string;
  counts: PanelCounts;
  cells: PanelCell[];
  bottleneck: { id: string; blocks: number } | null;
  steward?: PanelSteward;
  healLog?: { cell: string; kind: string; at: string; note: string }[];
}

export interface ReserveResult {
  status: "reserved" | "not_ready" | "taken";
  detail: string;
}

export interface StewardReleaseBody {
  repo: string;
  admin_key: string;
}

export interface StewardReleaseResult {
  ok: boolean;
  result: string;
  steward: PanelSteward;
}
