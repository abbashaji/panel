// Fake Worker for the full-app integration test: a fetch mock that serves the /panel/api routes with the JSON shapes of
// web/src/core/types.ts and web/src/core/api.ts and keeps a mutable in-memory state, so actions change the next poll.
// No network and no real clock: every time stamp is derived from the fixed NOW below.
import type { PanelCell, PanelCounts, PanelState, PanelStatus, PanelSteward, StewardReleaseResult } from "../core/types";

export const REPO = "abbashaji/panel";
export const ADMIN_KEY = "s3cret-admin-key";
export const PASSWORD = "open-sesame";
/** the launch code the fake hands out for POST /steward-code (matches ^[A-Za-z0-9_-]{16,64}$) */
export const STEWARD_CODE = "fakeStewardCode0123456789";
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

export interface FakeWorker {
  /** the fetch mock to install with vi.stubGlobal("fetch", fake.fetch) */
  fetch: typeof fetch;
  /** the live state the next poll serves; tests change it through the helpers below */
  state: PanelState;
  calls: RecordedCall[];
  /** the recorded calls whose path (without query) equals `path`, e.g. "/reserve" */
  requests(path: string): RecordedCall[];
  setSteward(s: PanelSteward): void;
  setHealLog(log: NonNullable<PanelState["healLog"]>): void;
}

export function createFakeWorker(opts: { requireLogin?: boolean } = {}): FakeWorker {
  const cells = plan();
  const state: PanelState = {
    repo: REPO,
    project: "panel",
    mainSha: "9f8e7d6",
    generatedAt: new Date(NOW).toISOString(),
    counts: countStatuses(cells),
    cells,
    bottleneck: null,
    steward: { ...NO_STEWARD },
    healLog: [{ cell: "C-005", kind: "sync_main", at: ago(5), note: "main merged into the branch" }],
  };
  const calls: RecordedCall[] = [];
  let authed = !opts.requireLogin;

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const text = (body: string, status: number): Response => new Response(body, { status });
  const find = (id: unknown): PanelCell | undefined => state.cells.find((c) => c.id === id);
  const actionCell = (c: PanelCell) => ({ id: c.id, status: c.status, resumable: c.resumable === true });

  function route(method: string, path: string, body: Record<string, unknown> | null): Response {
    if (method === "POST" && path === "/login") {
      if (body?.password !== PASSWORD) return text("Wrong password", 401);
      authed = true;
      return json({ ok: true });
    }
    if (!authed) return text("Login required", 401);

    if (method === "GET" && path === "/state") {
      state.counts = countStatuses(state.cells);
      state.generatedAt = new Date(Date.now()).toISOString();
      return json(state);
    }
    if (method !== "POST" || body === null) return text("Not found", 404);

    if (path === "/reserve") {
      const c = find(body.cell_id);
      const who = String(body.who ?? "");
      if (!c || c.status !== "ready") return json({ status: "not_ready", detail: `${String(body.cell_id)} is not ready.` });
      if (c.reservedBy && c.reservedBy !== who) return json({ status: "taken", detail: `${c.id} is already taken.` });
      c.reservedBy = who;
      return json({ status: "reserved", detail: `${c.id} reserved for ${who}.`, cell: actionCell(c) });
    }

    if (body.admin_key !== ADMIN_KEY) return text("Wrong admin key", 403);

    if (path === "/steward-code") return json({ ok: true, code: STEWARD_CODE, expires_in: 300 });

    if (path === "/steward-release") {
      const steward: PanelSteward = { status: "released", holder: null, minutesLeft: null, expiredMinutesAgo: null, problems: 0 };
      state.steward = steward;
      const out: StewardReleaseResult = { ok: true, result: "Steward released.", steward };
      return json(out);
    }

    if (path === "/release" || path === "/clear-feedback") {
      const c = find(body.cell_id);
      if (!c) return text("No such cell", 404);
      if (path === "/release") {
        if (c.status !== "running" && c.status !== "expired") return text("Cell is not held", 409);
        c.status = "ready";
        c.reservedBy = null;
        c.resumable = true;
        c.lease = null;
        return json({ result: `Released ${c.id}. Ready to resume.`, cell: actionCell(c) });
      }
      if (c.status !== "needs_human") return text("Cell has no feedback", 409);
      c.status = "ready";
      c.resumable = false;
      return json({ result: `Feedback cleared on ${c.id}.`, cell: actionCell(c) });
    }
    return text("Not found", 404);
  }

  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const marker = "/panel/api";
    const at = url.indexOf(marker);
    if (at < 0) return text("Not found", 404);
    const rest = url.slice(at + marker.length);
    const method = (init?.method ?? "GET").toUpperCase();
    let body: Record<string, unknown> | null = null;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        return text("Bad JSON", 400);
      }
    }
    calls.push({ method, path: rest, body });
    return route(method, rest.split("?")[0], body);
  }) as typeof fetch;

  return {
    fetch: fakeFetch,
    state,
    calls,
    requests: (path) => calls.filter((c) => c.path.split("?")[0] === path),
    setSteward: (s) => {
      state.steward = s;
    },
    setHealLog: (log) => {
      state.healLog = log;
    },
  };
}
