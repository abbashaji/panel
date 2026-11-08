import { test } from "node:test";
import assert from "node:assert/strict";
import { handlePanelAction } from "../src/panel/actions.ts";
import { COOKIE, makeSession } from "../src/panel/auth.ts";

const PATH = "/panel/api/steward-code";
const REPO = "o/r";
const KEY = "s3cret-admin-key";
const ctx = {} as any;

function fakeKv() {
  const m = new Map<string, string>();
  return {
    m,
    get: async (k: string) => m.get(k) ?? null,
    put: async (k: string, v: string) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
  };
}
function mkEnv(kv: unknown): any {
  return { PANEL_TOKEN: "pw", ADMIN_TOKEN: KEY, ALLOWED_REPOS: REPO, GITHUB_TOKEN: "x", OAUTH_KV: kv };
}
async function call(env: any, body: unknown, cookie = true): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = `${COOKIE}=${await makeSession(env)}`;
  const req = new Request(`https://x.test${PATH}`, { method: "POST", headers, body: JSON.stringify(body) });
  return (await handlePanelAction(req, env, ctx, PATH))!;
}
const codeKeys = (kv: { m: Map<string, string> }) => [...kv.m.keys()].filter((k) => k.startsWith("stewardcode:"));

test("steward-code: mints a code with the right key", async () => {
  const kv = fakeKv();
  const res = await call(mkEnv(kv), { repo: REPO, admin_key: KEY });
  assert.equal(res.status, 200);
  const out: any = await res.json();
  assert.equal(out.ok, true);
  assert.equal(out.expires_in, 600);
  assert.match(out.code, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(codeKeys(kv).length, 1);
});

test("steward-code: wrong key is 403 and mints nothing", async () => {
  const kv = fakeKv();
  const res = await call(mkEnv(kv), { repo: REPO, admin_key: "nope" });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "forbidden" });
  assert.equal(kv.m.size, 0);
});

test("steward-code: no cookie is 401 and mints nothing", async () => {
  const kv = fakeKv();
  const res = await call(mkEnv(kv), { repo: REPO, admin_key: KEY }, false);
  assert.equal(res.status, 401);
  assert.equal(kv.m.size, 0);
});

test("steward-code: 5 codes per minute per repo, then 429", async () => {
  const kv = fakeKv();
  const env = mkEnv(kv);
  for (let i = 0; i < 5; i++) assert.equal((await call(env, { repo: REPO, admin_key: KEY })).status, 200);
  const res = await call(env, { repo: REPO, admin_key: KEY });
  assert.equal(res.status, 429);
  assert.equal(codeKeys(kv).length, 5);
});

test("steward-code: KV missing is 503 without leaking key or code", async () => {
  const res = await call(mkEnv(undefined), { repo: REPO, admin_key: KEY });
  assert.equal(res.status, 503);
  const text = await res.text();
  assert.ok(!text.includes(KEY));
  assert.doesNotMatch(text, /[A-Za-z0-9_-]{32}/);
});

test("steward-code: a failing KV is 503 without leaking", async () => {
  const kv = {
    get: async () => {
      throw new Error(`boom ${KEY}`);
    },
    put: async () => {},
    delete: async () => {},
  };
  const res = await call(mkEnv(kv), { repo: REPO, admin_key: KEY });
  assert.equal(res.status, 503);
  assert.ok(!(await res.text()).includes(KEY));
});
