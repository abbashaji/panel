import { test } from "node:test";
import assert from "node:assert/strict";
import { handlePanelAction, type ActionDeps } from "../src/panel/actions.ts";
import { COOKIE, makeSession } from "../src/panel/auth.ts";

const ctx = {} as any;
const REPO = "o/r";

function fakeKv() {
  const m = new Map<string, string>();
  return {
    m,
    get: async (k: string) => m.get(k) ?? null,
    put: async (k: string, v: string) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
  };
}
function mkEnv(kv = fakeKv()): any {
  return { PANEL_TOKEN: "pw", ADMIN_TOKEN: "adm", ALLOWED_REPOS: REPO, GITHUB_TOKEN: "x", OAUTH_KV: kv };
}
async function post(env: any, path: string, body: unknown, deps: ActionDeps, auth = true): Promise<any> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth) headers.cookie = `${COOKIE}=${await makeSession(env)}`;
  const req = new Request(`https://x.test${path}`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
  return handlePanelAction(req, env, ctx, path, deps);
}
const ready: ActionDeps = {
  readiness: async () => ({ ready: true, detail: "ready" }),
  cellInfo: async (_e, _r, cell) => ({ id: cell, status: "ready", resumable: false }),
};

test("unknown paths return null", async () => {
  const req = new Request("https://x.test/panel/api/state");
  assert.equal(await handlePanelAction(req, mkEnv(), ctx, "/panel/api/state"), null);
});

test("no cookie is 401, GET is 405", async () => {
  const env = mkEnv();
  assert.equal((await post(env, "/panel/api/reserve", {}, ready, false))!.status, 401);
  const req = new Request("https://x.test/panel/api/reserve", { headers: { cookie: `${COOKIE}=${await makeSession(env)}` } });
  assert.equal((await handlePanelAction(req, env, ctx, "/panel/api/reserve", ready))!.status, 405);
});

test("reserve: ready cell is reserved, same who refreshes, other who is taken", async () => {
  const kv = fakeKv();
  const env = mkEnv(kv);
  const b = { repo: REPO, cell_id: "C-003", who: "Ann" };
  let res = await post(env, "/panel/api/reserve", b, ready);
  assert.equal(res!.status, 200);
  assert.equal((await res!.json()).status, "reserved");
  assert.ok(kv.m.has(`reserve:${REPO}:C-003`));
  res = await post(env, "/panel/api/reserve", b, ready);
  assert.equal((await res!.json()).status, "reserved");
  res = await post(env, "/panel/api/reserve", { ...b, who: "Bob" }, ready);
  const j = await res!.json();
  assert.equal(j.status, "taken");
  assert.match(j.detail, /Ann/);
});

test("reserve: not ready cell is not_ready and nothing is stored", async () => {
  const kv = fakeKv();
  const deps: ActionDeps = { readiness: async () => ({ ready: false, detail: "waiting for C-001" }) };
  const res = await post(mkEnv(kv), "/panel/api/reserve", { repo: REPO, cell_id: "C-003", who: "Ann" }, deps);
  const j = await res!.json();
  assert.equal(j.status, "not_ready");
  assert.equal(j.detail, "waiting for C-001");
  assert.equal(kv.m.size, 0);
});

test("reserve: validation", async () => {
  const env = mkEnv();
  const bad = [
    { repo: "evil/repo", cell_id: "C-003", who: "Ann" },
    { repo: REPO, cell_id: "C-3", who: "Ann" },
    { repo: REPO, cell_id: "C-003", who: "a<b>" },
    { repo: REPO, cell_id: "C-003", who: "x".repeat(41) },
  ];
  for (const b of bad) assert.equal((await post(env, "/panel/api/reserve", b, ready))!.status, 400);
  assert.equal((await post(env, "/panel/api/reserve", "{nope", ready))!.status, 400);
  assert.equal((await post(env, "/panel/api/reserve", "x".repeat(5000), ready))!.status, 413);
});

test("release: wrong or missing admin_key is 403 and takeover is never called", async () => {
  let calls = 0;
  const deps: ActionDeps = { takeover: async () => (calls++, "RELEASED C-003") };
  const env = mkEnv();
  for (const k of [undefined, "", "nope"]) {
    const res = await post(env, "/panel/api/release", { repo: REPO, cell_id: "C-003", admin_key: k }, deps);
    assert.equal(res!.status, 403);
  }
  assert.equal(calls, 0);
  delete env.ADMIN_TOKEN;
  assert.equal((await post(env, "/panel/api/release", { repo: REPO, cell_id: "C-003", admin_key: "adm" }, deps))!.status, 403);
});

test("release: handoff mode, result truncated to 200, key never echoed", async () => {
  let seen: any;
  const deps: ActionDeps = { takeover: async (_e, repo, cell, key, mode) => ((seen = { repo, cell, key, mode }), "RELEASED C-003: " + "y".repeat(400)), cellInfo: async () => null };
  const res = await post(mkEnv(), "/panel/api/release", { repo: REPO, cell_id: "C-003", admin_key: "adm" }, deps);
  assert.equal(res!.status, 200);
  const text = await res!.text();
  assert.deepEqual(seen, { repo: REPO, cell: "C-003", key: "adm", mode: "release" });
  const j = JSON.parse(text);
  assert.equal(j.ok, true);
  assert.equal(j.result.length, 200);
  assert.ok(!text.includes("adm"));
});

test("clear-feedback uses clear mode; failures are reported as ok:false", async () => {
  let mode = "";
  const deps: ActionDeps = { takeover: async (_e, _r, _c, _k, m) => ((mode = m), "NOT_RUNNING C-003: no branch") };
  const res = await post(mkEnv(), "/panel/api/clear-feedback", { repo: REPO, cell_id: "C-003", admin_key: "adm" }, deps);
  assert.equal(mode, "clear");
  const j = await res!.json();
  assert.equal(j.ok, false);
  assert.match(j.result, /NOT_RUNNING/);
});

test("release: bad cell id is 400 after the key check", async () => {
  const deps: ActionDeps = { takeover: async () => "RELEASED" };
  assert.equal((await post(mkEnv(), "/panel/api/release", { repo: REPO, cell_id: "nope", admin_key: "adm" }, deps))!.status, 400);
});

test("engine errors become a 502 without details", async () => {
  const deps: ActionDeps = { takeover: async () => { throw new Error("secret detail"); } };
  const res = await post(mkEnv(), "/panel/api/release", { repo: REPO, cell_id: "C-003", admin_key: "adm" }, deps);
  assert.equal(res!.status, 502);
  assert.ok(!(await res!.text()).includes("secret"));
});

const info = (status: any, resumable = true) => async (_e: any, _r: string, cell: string) => ({ id: cell, status, resumable });
const adminBody = { repo: REPO, cell_id: "C-003", admin_key: "adm" };

test("release: answer carries cell {id,status,resumable}, old fields stay, reservation is deleted", async () => {
  const kv = fakeKv();
  kv.m.set(`reserve:${REPO}:C-003`, JSON.stringify({ who: "Ann", at: "x" }));
  const deps: ActionDeps = { takeover: async () => "RELEASED C-003: handed off", cellInfo: info("ready") };
  const res = await post(mkEnv(kv), "/panel/api/release", adminBody, deps);
  const text = await res!.text();
  const j = JSON.parse(text);
  assert.equal(j.ok, true);
  assert.match(j.result, /RELEASED/);
  assert.deepEqual(j.cell, { id: "C-003", status: "ready", resumable: true });
  assert.equal(kv.m.has(`reserve:${REPO}:C-003`), false);
  assert.ok(!text.includes("adm"));
});

test("clear-feedback: RESUME answer deletes the reservation and answers status ready or expired", async () => {
  const kv = fakeKv();
  kv.m.set(`reserve:${REPO}:C-003`, JSON.stringify({ who: "Ann", at: "x" }));
  const deps: ActionDeps = { takeover: async () => "RESUME C-003 base=abc1234", cellInfo: info("expired") };
  const res = await post(mkEnv(kv), "/panel/api/clear-feedback", adminBody, deps);
  const j = await res!.json();
  assert.equal(j.ok, true);
  assert.match(j.cell.status, /^(ready|expired)$/);
  assert.equal(kv.m.has(`reserve:${REPO}:C-003`), false);
});

test("a failed release keeps the reservation and has no cell", async () => {
  const kv = fakeKv();
  kv.m.set(`reserve:${REPO}:C-003`, JSON.stringify({ who: "Ann", at: "x" }));
  const deps: ActionDeps = { takeover: async () => "NOT_RUNNING C-003: no branch", cellInfo: info("ready") };
  const j = await (await post(mkEnv(kv), "/panel/api/release", adminBody, deps))!.json();
  assert.equal(j.ok, false);
  assert.equal(j.cell, undefined);
  assert.equal(kv.m.has(`reserve:${REPO}:C-003`), true);
});

test("KV failure does not fail release or clear-feedback", async () => {
  const kv = fakeKv();
  const broken = { ...kv, get: async () => { throw new Error("kv down"); }, delete: async () => { throw new Error("kv down"); } };
  const deps: ActionDeps = { takeover: async () => "RELEASED C-003", cellInfo: info("ready") };
  for (const p of ["/panel/api/release", "/panel/api/clear-feedback"]) {
    const res = await post(mkEnv(broken as any), p, adminBody, deps);
    assert.equal(res!.status, 200);
    const j = await res!.json();
    assert.equal(j.ok, true);
    assert.equal(j.cell.status, "ready");
  }
});

test("a failing state lookup leaves the answer without cell but still ok", async () => {
  const deps: ActionDeps = { takeover: async () => "RELEASED C-003", cellInfo: async () => { throw new Error("github down"); } };
  const res = await post(mkEnv(), "/panel/api/release", adminBody, deps);
  assert.equal(res!.status, 200);
  const j = await res!.json();
  assert.equal(j.ok, true);
  assert.equal(j.cell, undefined);
});

test("reserve: answer carries cell.status", async () => {
  const deps: ActionDeps = { readiness: async () => ({ ready: true, detail: "ready" }), cellInfo: info("expired", true) };
  const j = await (await post(mkEnv(), "/panel/api/reserve", { repo: REPO, cell_id: "C-003", who: "Ann" }, deps))!.json();
  assert.equal(j.status, "reserved");
  assert.deepEqual(j.cell, { id: "C-003", status: "expired", resumable: true });
});
