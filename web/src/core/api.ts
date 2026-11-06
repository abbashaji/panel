import { buildMockState, mockClearFeedback, mockRelease, mockReserve } from "./mock";
import type { PanelState, PanelStatus, ReserveResult, StewardReleaseBody, StewardReleaseResult } from "./types";

// Typed client for the Worker. Same origin, cookie auth (bp_panel), no CORS. See docs/panel-contracts.md section 3.

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

let mock = import.meta.env.VITE_MOCK === "1";

/** True while the built-in sample data is used instead of the Worker. */
export function isMock(): boolean {
  return mock;
}

export function setMockMode(on: boolean): void {
  mock = on;
}

const BASE = "/panel/api";

async function call(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(BASE + path, { credentials: "same-origin", ...init });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = (await res.text()).slice(0, 200) || msg;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, msg);
  }
  return res;
}

const post = (path: string, body: unknown) =>
  call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** The cell as the Worker reports it right after an action. */
export interface ActionCell {
  id: string;
  status: PanelStatus;
  resumable: boolean;
}

/** Parsed answer of release / clear-feedback: text for toasts (max 200 chars) and, from a newer Worker, the new cell state. */
export interface ActionResult {
  text: string;
  cell?: ActionCell;
}

/** Reads the cell object of an answer; undefined for an older Worker that sends none or a malformed one. */
function parseCell(v: unknown): ActionCell | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const c = v as { id?: unknown; status?: unknown; resumable?: unknown };
  if (typeof c.id !== "string" || typeof c.status !== "string") return undefined;
  return { id: c.id, status: c.status as PanelStatus, resumable: c.resumable === true };
}

/** Answer of an action: plain text, or JSON with result / detail / message and optionally cell. */
async function actionResult(res: Response): Promise<ActionResult> {
  const raw = await res.text();
  try {
    const j = JSON.parse(raw) as { result?: unknown; detail?: unknown; message?: unknown; cell?: unknown };
    if (typeof j === "object" && j !== null) {
      const v = j.result ?? j.detail ?? j.message;
      const cell = parseCell(j.cell);
      return { text: typeof v === "string" ? v.slice(0, 200) : "", ...(cell ? { cell } : {}) };
    }
  } catch {
    /* plain text */
  }
  return { text: raw.slice(0, 200) };
}

/** In dev, a network failure (no Worker running) switches to the mock data instead of showing an error. */
function fallBackToMock(e: unknown): boolean {
  if (import.meta.env.DEV && e instanceof TypeError) {
    mock = true;
    return true;
  }
  return false;
}

export async function login(password: string): Promise<void> {
  if (mock) return;
  await post("/login", { password });
}

export async function getState(repo: string): Promise<PanelState> {
  if (!mock) {
    try {
      const res = await call(`/state?repo=${encodeURIComponent(repo)}`);
      return (await res.json()) as PanelState;
    } catch (e) {
      if (!fallBackToMock(e)) throw e;
    }
  }
  return { ...buildMockState(), repo };
}

export async function reserve(repo: string, cellId: string, who: string): Promise<ReserveResult & { cell?: ActionCell }> {
  if (mock) return mockReserve(cellId, who);
  const res = await post("/reserve", { repo, cell_id: cellId, who });
  const raw = (await res.json()) as ReserveResult & { cell?: unknown };
  const cell = parseCell(raw.cell);
  const { cell: _ignored, ...rest } = raw;
  void _ignored;
  return { ...(rest as ReserveResult), ...(cell ? { cell } : {}) };
}

/** Admin action: `adminKey` is typed by the user per action; never store it. */
export async function release(repo: string, cellId: string, adminKey: string): Promise<ActionResult> {
  if (mock) return { text: await mockRelease(cellId) };
  return actionResult(await post("/release", { repo, cell_id: cellId, admin_key: adminKey }));
}

export async function clearFeedback(repo: string, cellId: string, adminKey: string): Promise<ActionResult> {
  if (mock) return { text: await mockClearFeedback(cellId) };
  return actionResult(await post("/clear-feedback", { repo, cell_id: cellId, admin_key: adminKey }));
}

/** Admin action: releases the Steward lease. `adminKey` is typed by the user per action; never store it. 403 gives ApiError status 403. */
export async function stewardRelease(repo: string, adminKey: string): Promise<StewardReleaseResult> {
  if (mock) {
    return {
      ok: true,
      result: "Steward released (sample).",
      steward: { status: "released", holder: null, minutesLeft: null, expiredMinutesAgo: null, problems: 0 },
    };
  }
  const body: StewardReleaseBody = { repo, admin_key: adminKey };
  const res = await post("/steward-release", body);
  return (await res.json()) as StewardReleaseResult;
}
