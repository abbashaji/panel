// Panel auth: POST /panel/api/login, signed session cookie bp_panel, failure rate limit.
// The cookie is stateless: "<expiry-seconds>.<hmac-sha256 hex>" keyed by PANEL_TOKEN. No CORS headers anywhere.
import type { PanelEnv } from "./types.ts";

export const COOKIE = "bp_panel";
export const SESSION_SECONDS = 12 * 3600;
export const MAX_BODY = 4096;
const FAIL_LIMIT = 5;
const FAIL_WINDOW_S = 900;
const enc = new TextEncoder();

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

/** Constant-time string comparison (both sides hashed first, so the length does not leak). */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Cookie value for a new session that ends SESSION_SECONDS after nowMs. */
export async function makeSession(env: PanelEnv, nowMs: number = Date.now()): Promise<string> {
  if (!env.PANEL_TOKEN) throw new Error("PANEL_TOKEN is not set");
  const exp = Math.floor(nowMs / 1000) + SESSION_SECONDS;
  return `${exp}.${await hmacHex(env.PANEL_TOKEN, `bp_panel.${exp}`)}`;
}

export async function verifySession(env: PanelEnv, value: string | null, nowMs: number = Date.now()): Promise<boolean> {
  if (!env.PANEL_TOKEN || !value) return false;
  const m = /^(\d{1,12})\.([0-9a-f]{64})$/.exec(value);
  if (!m) return false;
  if (Number(m[1]) * 1000 <= nowMs) return false;
  return timingSafeEqual(m[2], await hmacHex(env.PANEL_TOKEN, `bp_panel.${m[1]}`));
}

export function sessionCookie(value: string): string {
  return `${COOKIE}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/panel; Max-Age=${SESSION_SECONDS}`;
}

function readCookie(req: Request): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
  }
  return null;
}

/** null = authenticated; otherwise the 401 to return. */
export async function requirePanelAuth(req: Request, env: PanelEnv, nowMs: number = Date.now()): Promise<Response | null> {
  return (await verifySession(env, readCookie(req), nowMs)) ? null : json(401, { error: "unauthorized" });
}

/** Body text of at most MAX_BODY bytes, or null when it is larger. */
export async function readBounded(req: Request): Promise<string | null> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_BODY) return null;
  const text = await req.text();
  return enc.encode(text).length > MAX_BODY ? null : text;
}

// ---------------------------------------------------------------- failure rate limit (KV, in-memory fallback)
const memFails = new Map<string, { n: number; until: number }>();

async function failures(env: PanelEnv, key: string, now: number): Promise<number> {
  try {
    if (env.OAUTH_KV) return Number((await env.OAUTH_KV.get(key)) ?? 0) || 0;
  } catch {
    /* fall back to memory */
  }
  const m = memFails.get(key);
  return m && m.until > now ? m.n : 0;
}

async function addFailure(env: PanelEnv, key: string, now: number): Promise<void> {
  const n = (await failures(env, key, now)) + 1;
  try {
    if (env.OAUTH_KV) {
      await env.OAUTH_KV.put(key, String(n), { expirationTtl: FAIL_WINDOW_S });
      return;
    }
  } catch {
    /* fall back to memory */
  }
  memFails.set(key, { n, until: now + FAIL_WINDOW_S * 1000 });
}

async function clearFailures(env: PanelEnv, key: string): Promise<void> {
  memFails.delete(key);
  try {
    await env.OAUTH_KV?.delete(key);
  } catch {
    /* ignore */
  }
}

export function clearLoginLimits(): void {
  memFails.clear();
}

/** POST /panel/api/login {password}. Body size is enforced by the router before this runs. */
export async function handleLogin(req: Request, env: PanelEnv, nowMs: number = Date.now()): Promise<Response> {
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" }, { allow: "POST" });
  if (!env.PANEL_TOKEN) return json(503, { error: "not_configured" });
  const key = `panel-login-fail:${req.headers.get("cf-connecting-ip") ?? "unknown"}`;
  if ((await failures(env, key, nowMs)) >= FAIL_LIMIT) {
    return json(429, { error: "too_many_attempts" }, { "retry-after": String(FAIL_WINDOW_S) });
  }
  let password = "";
  try {
    const b = JSON.parse(await req.text());
    if (typeof b?.password === "string") password = b.password;
  } catch {
    /* treated as a wrong password */
  }
  if (!password || !(await timingSafeEqual(password, env.PANEL_TOKEN))) {
    await addFailure(env, key, nowMs);
    return json(401, { error: "wrong_password" });
  }
  await clearFailures(env, key);
  return json(200, { ok: true }, { "set-cookie": sessionCookie(await makeSession(env, nowMs)) });
}
