import { describe, it, expect, vi } from "vitest";

// The cookie check itself belongs to auth.ts; here a stand-in reads a header so the route's order of gates is what is tested.
vi.mock("../src/panel/auth.ts", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    requirePanelAuth: async (req: Request) => (req.headers.get("x-test-cookie") === "ok" ? null : real.json(401, { error: "unauthorized" })),
  };
});

import { handlePanelAction } from "../src/panel/actions.ts";

const REPO = "owner/name";
const KEY = "s3cret-admin-key";
const ctx = {} as ExecutionContext;

function fakeKv() {
  const m = new Map<string, string>();
  return {
    m,
    get: async (k: string) => m.get(k) ?? null,
    put: async (k: string, v: string) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
  };
}
function env(kv: unknown) {
  return { ADMIN_TOKEN: KEY, OAUTH_KV: kv, GITHUB_REPO: REPO, ALLOWED_REPOS: REPO } as any;
}
function post(body: unknown, cookie = true) {
  return new Request("https://x.test/panel/api/steward-code", {
    method: "POST",
    headers: cookie ? { "x-test-cookie": "ok", "content-type": "application/json" } : { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const call = (e: any, body: unknown, cookie = true) => handlePanelAction(post(body, cookie), e, ctx, "/panel/api/steward-code");
const codeKeys = (kv: { m: Map<string, string> }) => [...kv.m.keys()].filter((k) => k.startsWith("stewardcode:"));

describe("POST /panel/api/steward-code", () => {
  it("mints a code with the right key", async () => {
    const kv = fakeKv();
    const res = (await call(env(kv), { repo: REPO, admin_key: KEY }))!;
    expect(res.status).toBe(200);
    const out: any = await res.json();
    expect(out.ok).toBe(true);
    expect(out.expires_in).toBe(600);
    expect(out.code).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(codeKeys(kv)).toHaveLength(1);
  });

  it("wrong key is 403 and mints nothing", async () => {
    const kv = fakeKv();
    const res = (await call(env(kv), { repo: REPO, admin_key: "nope" }))!;
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    expect(kv.m.size).toBe(0);
  });

  it("no cookie is 401 and mints nothing", async () => {
    const kv = fakeKv();
    const res = (await call(env(kv), { repo: REPO, admin_key: KEY }, false))!;
    expect(res.status).toBe(401);
    expect(kv.m.size).toBe(0);
  });

  it("allows 5 codes per minute per repo, then 429", async () => {
    const kv = fakeKv();
    for (let i = 0; i < 5; i++) expect((await call(env(kv), { repo: REPO, admin_key: KEY }))!.status).toBe(200);
    const res = (await call(env(kv), { repo: REPO, admin_key: KEY }))!;
    expect(res.status).toBe(429);
    expect(codeKeys(kv)).toHaveLength(5);
  });

  it("KV missing is 503 without leaking key or code", async () => {
    const res = (await call(env(undefined), { repo: REPO, admin_key: KEY }))!;
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).not.toContain(KEY);
    expect(text).not.toMatch(/[A-Za-z0-9_-]{32}/);
  });

  it("a failing KV is 503 without leaking", async () => {
    const kv = { get: async () => { throw new Error(`boom ${KEY}`); }, put: async () => {}, delete: async () => {} };
    const res = (await call(env(kv), { repo: REPO, admin_key: KEY }))!;
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain(KEY);
  });
});
