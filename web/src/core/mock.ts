import type { DependKind, PanelCell, PanelCounts, PanelState, PanelStatus, ReserveResult } from "./types";

// Sample data: 14 cells, one expired bottleneck (C-004 blocks 6). Used when VITE_MOCK=1 or the API is unreachable in dev.

interface Spec {
  id: string;
  title: string;
  status: PanelStatus;
  /** "C-001" = implementation dependency, "C-001~" = contract dependency */
  deps?: string[];
  type?: PanelCell["type"];
  reservedBy?: string;
}

const SPECS: Spec[] = [
  { id: "C-000", title: "Contracts and shared types", status: "done", type: "skeleton" },
  { id: "C-001", title: "Pinned claim and reservation", status: "done", deps: ["C-000"] },
  { id: "C-002", title: "State API and login", status: "done", deps: ["C-000"] },
  { id: "C-003", title: "Reserve and release routes", status: "running", deps: ["C-001", "C-002"] },
  { id: "C-004", title: "SPA scaffold and API client", status: "expired", deps: ["C-000"], type: "skeleton" },
  { id: "C-005", title: "Graph view", status: "waiting", deps: ["C-004"] },
  { id: "C-006", title: "Inspector and actions", status: "waiting", deps: ["C-004", "C-005", "C-003~"] },
  { id: "C-007", title: "Shell, filters and table", status: "waiting", deps: ["C-004", "C-005"] },
  { id: "C-008", title: "Launcher core library", status: "ready", deps: ["C-000"], reservedBy: "Sara" },
  { id: "C-009", title: "Launcher windows and install", status: "waiting", deps: ["C-008"] },
  { id: "C-010", title: "Panel and launcher integration", status: "waiting", deps: ["C-006", "C-007", "C-009"] },
  { id: "C-011", title: "Integration tests and README", status: "waiting", deps: ["C-010", "C-003"], type: "integration" },
  { id: "C-012", title: "Usage notes for teammates", status: "needs_human", deps: ["C-000"] },
  { id: "C-013", title: "Live updates over SSE", status: "needs_split", deps: ["C-003"] },
];

/** Cells reserved through the mock API during this page session. */
const reserved = new Map<string, string>();

function sha(seed: string, n: number): string {
  let h = 2166136261;
  for (const ch of seed + n) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h.toString(16).padStart(8, "0").slice(0, 7);
}

export function buildMockState(now: number = Date.now()): PanelState {
  const parsed = new Map<string, { id: string; kind: DependKind }[]>();
  const children = new Map<string, string[]>();
  for (const s of SPECS) {
    const deps = (s.deps ?? []).map((d) =>
      d.endsWith("~") ? { id: d.slice(0, -1), kind: "contract" as const } : { id: d, kind: "implementation" as const },
    );
    parsed.set(s.id, deps);
    for (const d of deps) children.set(d.id, [...(children.get(d.id) ?? []), s.id]);
  }
  const transitive = (id: string, seen = new Set<string>()): Set<string> => {
    for (const c of children.get(id) ?? []) if (!seen.has(c)) (seen.add(c), transitive(c, seen));
    return seen;
  };
  const depthDown = (id: string): number => Math.max(0, ...(children.get(id) ?? []).map((c) => 1 + depthDown(c)));
  const waveOf = (id: string): number =>
    Math.max(0, ...(parsed.get(id) ?? []).filter((d) => d.kind === "implementation").map((d) => 1 + waveOf(d.id)));
  const statusOf = new Map(SPECS.map((s) => [s.id, s.status]));

  const cells: PanelCell[] = SPECS.map((s, i) => {
    const deps = parsed.get(s.id) ?? [];
    const direct = (children.get(s.id) ?? []).length;
    const trans = transitive(s.id).size;
    const live = s.status === "running" || s.status === "expired";
    const reservedBy = reserved.get(s.id) ?? s.reservedBy ?? null;
    return {
      id: s.id,
      title: s.title,
      type: s.type ?? "normal",
      priority: 0,
      status: s.status,
      critical: direct >= 4 || trans >= 5 || depthDown(s.id) >= 3,
      wave: waveOf(s.id),
      depends: deps,
      blockedBy:
        s.status === "done" ? [] : deps.filter((d) => d.kind === "implementation" && statusOf.get(d.id) !== "done").map((d) => d.id),
      directDependents: direct,
      transitiveDependents: trans,
      sha: {
        lock: live ? sha(s.id, 1) : null,
        tip: live ? sha(s.id, 2) : null,
        merged: null,
      },
      lease:
        s.status === "running"
          ? { minutesLeft: 34, expiredMinutesAgo: null, ci: false }
          : s.status === "expired"
            ? { minutesLeft: 0, expiredMinutesAgo: 22, ci: false }
            : null,
      attempts: s.status === "expired" ? 2 : s.status === "needs_split" ? 3 : 0,
      maxAttempts: 3,
      lastCommit: live
        ? {
            subject: `cell(${s.id}): work in progress`,
            next: "finish the remaining files, then submit",
            at: new Date(now - (s.status === "expired" ? 82 : 26) * 60_000).toISOString(),
          }
        : null,
      reservedBy,
      pr: s.status === "done" ? { number: 10 + i, state: "merged" } : null,
      allowedPaths: [`web/src/${s.id.toLowerCase()}/**`],
      provides: [],
      inputs: deps.map((d) => d.id),
    };
  });

  const counts: PanelCounts = { done: 0, running: 0, ready: 0, waiting: 0, expired: 0, needs_human: 0, needs_split: 0 };
  for (const c of cells) counts[c.status] += 1;

  let bottleneck: PanelState["bottleneck"] = null;
  for (const c of cells) {
    if (c.status === "done" || c.transitiveDependents === 0) continue;
    if (!bottleneck || c.transitiveDependents > bottleneck.blocks) bottleneck = { id: c.id, blocks: c.transitiveDependents };
  }

  return {
    repo: "demo/panel",
    project: "panel",
    mainSha: "a1b2c3d",
    generatedAt: new Date(now).toISOString(),
    counts,
    cells,
    bottleneck,
  };
}

export function mockReserve(cellId: string, who: string): ReserveResult {
  const cell = buildMockState().cells.find((c) => c.id === cellId);
  if (!cell) return { status: "not_ready", detail: `unknown cell ${cellId}` };
  if (cell.status !== "ready" && cell.status !== "expired") {
    return { status: "not_ready", detail: `${cellId} is ${cell.status}` };
  }
  if (cell.reservedBy && cell.reservedBy !== who) return { status: "taken", detail: `reserved by ${cell.reservedBy}` };
  reserved.set(cellId, who);
  return { status: "reserved", detail: `${cellId} reserved for ${who} (600 s)` };
}

export function mockRelease(cellId: string): string {
  return `OK mock: released ${cellId} (handoff)`;
}

export function mockClearFeedback(cellId: string): string {
  return `OK mock: feedback cleared on ${cellId}`;
}

/** Test helper. */
export function resetMock(): void {
  reserved.clear();
}
