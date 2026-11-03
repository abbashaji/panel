import { buildMockState, mockClearFeedback, mockRelease, mockReserve } from "./mock";
import type { PanelState, ReserveResult } from "./types";

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

/** Text of an action reply: plain text, or JSON with result / detail. At most 200 chars. */
async function resultText(res: Response): Promise<string> {
  const raw = await res.text();
  try {
    const j = JSON.parse(raw) as { result?: unknown; detail?: unknown; message?: unknown };
    const v = j.result ?? j.detail ?? j.message;
    if (typeof v === "string") return v.slice(0, 200);
  } catch {
    /* plain text */
  }
  return raw.slice(0, 200);
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

export async function reserve(repo: string, cellId: string, who: string): Promise<ReserveResult> {
  if (mock) return mockReserve(cellId, who);
  const res = await post("/reserve", { repo, cell_id: cellId, who });
  return (await res.json()) as ReserveResult;
}

/** Admin action: `adminKey` is typed by the user per action; never store it. */
export async function release(repo: string, cellId: string, adminKey: string): Promise<string> {
  if (mock) return mockRelease(cellId);
  return resultText(await post("/release", { repo, cell_id: cellId, admin_key: adminKey }));
}

export async function clearFeedback(repo: string, cellId: string, adminKey: string): Promise<string> {
  if (mock) return mockClearFeedback(cellId);
  return resultText(await post("/clear-feedback", { repo, cell_id: cellId, admin_key: adminKey }));
}
