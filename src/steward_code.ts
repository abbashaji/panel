// steward_code.ts
//
// The one-time code that starts a Steward chat without the owner's admin key, and the single authorization gate
// (authorizeSteward) for every tool the Steward uses. A code is random, lives 10 minutes and works once; only its SHA-256
// is stored in KV. A steward_session is the session of the live lease of that repo and nothing else. No secret, code or
// key is ever put into an answer or a log.

import type { GitHubApi } from "./api.ts";
import { checkAdmin } from "./engine.ts";
import { STEWARD_BRANCH, leaseMinutesOf, readTip, stewardStatus, type StewardOptions } from "./steward.ts";

export const STEWARD_CODE_TTL = 600; // seconds
const CODE_RE = /^[A-Za-z0-9_-]{32}$/;

export interface StewardCodeKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

const enc = new TextEncoder();
async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}
const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

/** Constant-time equality of two strings (compared through their SHA-256). */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

async function codeKey(repo: string, code: string): Promise<string> {
  return `stewardcode:${repo}:${hex(await sha256(code))}`;
}

/** A random 32 character base64url code (24 random bytes). Only its hash is stored, for 10 minutes. */
export async function mintStewardCode(kv: StewardCodeKv, repo: string): Promise<string> {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const code = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  await kv.put(await codeKey(repo, code), "1", { expirationTtl: STEWARD_CODE_TTL });
  return code;
}

/** true exactly once for a live code of this repo; false for unknown, used, expired, malformed or other-repo codes (and on any KV error). */
export async function consumeStewardCode(kv: StewardCodeKv, repo: string, code: unknown): Promise<boolean> {
  if (typeof code !== "string" || !CODE_RE.test(code)) return false;
  try {
    const key = await codeKey(repo, code);
    if ((await kv.get(key)) === null) return false;
    await kv.delete(key);
    return true;
  } catch {
    return false;
  }
}

export interface StewardCreds {
  admin_key?: unknown;
  steward_session?: unknown;
}

/**
 * null = allowed; otherwise the error text. Allowed with the right admin key (constant-time check, as before) OR with a
 * steward_session equal to the session of the live lease of THIS repo (active, not expired, not released).
 */
export async function authorizeSteward(
  env: { ADMIN_TOKEN?: string; MAIN_BRANCH?: string },
  api: GitHubApi,
  repo: string,
  creds: StewardCreds,
  o: Partial<Pick<StewardOptions, "mainBranch" | "now">> = {},
): Promise<string | null> {
  const key = typeof creds.admin_key === "string" && creds.admin_key ? creds.admin_key : undefined;
  const session = typeof creds.steward_session === "string" ? creds.steward_session.trim() : "";
  let denied: string | null = null;
  if (key !== undefined) {
    denied = await checkAdmin(env.ADMIN_TOKEN, key);
    if (denied === null) return null;
  }
  if (!session) return denied ?? (await checkAdmin(env.ADMIN_TOKEN, undefined));
  try {
    const tip = await readTip(api, repo, STEWARD_BRANCH);
    if (tip) {
      const lm = await leaseMinutesOf(api, repo, o.mainBranch ?? (env.MAIN_BRANCH || "main"));
      const st = stewardStatus(tip, (o.now ?? (() => Date.now()))(), lm);
      if (st.state === "active" && st.session && (await sameSecret(st.session, session))) return null;
    }
  } catch {
    /* fail closed */
  }
  return "NOT_STEWARD: this session does not hold a live Steward lease of this repo (expired, released or unknown). Ask the owner for a new one-time code.";
}
