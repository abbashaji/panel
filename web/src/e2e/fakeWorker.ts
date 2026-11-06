// Fake Worker for the full-app integration test: a fetch mock that serves the /panel/api routes with the JSON shapes of
// web/src/core/types.ts and web/src/core/api.ts and keeps a mutable in-memory state, so actions change the next poll.
// No network and no real clock: every time stamp is derived from the fixed NOW below.
import type { PanelCell, PanelCounts, PanelState, PanelStatus, PanelSteward, StewardReleaseResult } from "../core/types";

export const REPO = "abbashaji/panel";
export const ADMIN_KEY = "s3cret-admin-key";
export const PASSWORD = "open-sesame";
/** The fixed 'now' of the fake: tests call vi.setSystemTime(NOW). */
export const NOW = Date.parse("2026-01-01T12:00:00Z");

const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

function cell(id: string, title: string, status: PanelStatus, over: Partial<PanelCell> = {}): PanelCell {
  return {
    id,
    title,
    type: "normal",
    priority: 50,
    status,
    critical: false,
    wave: 2,
    depends: [],
    blockedBy: [],
    directDependents: 0,
    transitiveDependents: 0,
    sha: { lock: null, tip: null, merged: null },
    lease: null,
    attempts: 0,
    maxAttempts: 3,
    lastCommit: null,
    reservedBy: null,
    pr: null,
    allowedPaths: [`web/src/${id.toLowerCase()}.ts`],
    provides: [],
    inputs: [],
    ...over,
  };
}

const dep = (id: string) => ({ id, kind: "implementation" as const });

/** Nine cells; the panel hides C-009 because C-004 replaced it, so the app shows eight. */
function plan(): PanelCell[] {
  return [
    cell("C-001", "Core types", "done", {
      wave: 1,
      directDependents: 4,
      transitiveDependents: 6,
      sha: { lock: "a1b2c3d", tip: "e4f5a6b", merged: "e4f5a6b" },
      lastCommit: { subject: "merge core types", next: null, at: ago(120) },
      pr: { number: 1, state: "merged" },
    }),
    cell("C-002", "Graph view", "running", {
      depends: [dep("C-001")],
      directDependents: 1,
      transitiveDependents: 1,
      sha: { lock: "b2c3d4e", tip: "c3d4e5f", merged: null },
      lease: { minutesLeft: 25, expiredMinutesAgo: null, ci: false },
      attempts: 1,
      lastCommit: { subject: "graph layout", next: "wire the cards", at: ago(3) },
      reservedBy: "Ana",
    }),
    cell("C-003", "Inspector panel", "ready", { depends: [dep("C-001")] }),
    cell("C-004", "Table view", "ready", { depends: [dep("C-001")] }),
    cell("C-005", "Shell header", "expired", {
      depends: [dep("C-001")],
      sha: { lock: "d4e5f6a", tip: "f6a7b8c", merged: null },
      lease: { minutesLeft: 0, expiredMinutesAgo: 12, ci: false },
      attempts: 2,
      lastCommit: { subject: "header skeleton", next: "add the search button", at: ago(40) },
      reservedBy: "Ben",
    }),
    cell("C-006", "Launch dialogs", "ready", {
      depends: [dep("C-001")],
      resumable: true,
      lastCommit: { subject: "release(C-006): handoff", next: "write the dialog tests", at: ago(30) },
    }),
    cell("C-007", "Activity feed", "needs_human", {
      wave: 3,
      attempts: 3,
      lastCommit: { subject: "feedback: contract is wrong", next: null, at: ago(20) },
    }),
    cell("C-008", "Final integration", "waiting", {
      wave: 3,
      depends: [dep("C-002"), dep("C-007")],
      blockedBy: ["C-002", "C-007"],
    }),
    cell("C-009", "Old table plan", "ready", { supersededBy: ["C-004"] }),
  ];
}

export function countStatuses(cells: PanelCell[]): PanelCounts {
  const c: PanelCounts = { done: 0, running: 0, ready: 0, waiting: 0, expired: 0, needs_human: 0, needs_split: 0 };
  for (const x of cells) c[x.status] += 1;
  return c;
}

export const NO_STEWARD: PanelSteward = { status: "none", holder: null, minutesLeft: null, expiredMinutesAgo: null, problems: 0 };

export interface RecordedCall {
  method: string;
  /** path after /panel/api, with the query string */
  path: string;
  body: Record<string, unknown> | null;
}
