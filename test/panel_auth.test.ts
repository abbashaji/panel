import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { GitHubApi, Snapshot } from "../src/api.ts";
import { clearPlanCache } from "../src/common.ts";
import { clearLoginLimits, makeSession, verifySession } from "../src/panel/auth.ts";
import { handlePanelRequest } from "../src/panel/router.ts";
import { clearPanelCache } from "../src/panel/state.ts";

const NOW = Date.now();
const opts = { mainBranch: "main", historyPages: 0, now: () => NOW, sleep: async () => {}, uuid: () => "u" };
const env = { PANEL_TOKEN: "correct horse", ALLOWED_REPOS: "o/*", GITHUB_TOKEN: "t" } as any;
const ctx = {} as ExecutionContext;

const snap: Snapshot = {
  mainOid: "a".repeat(40), mainTreeOid: "b".repeat(40), blueprint: "project: demo\nmain_branch: main\n",
  cellFiles: {
    "C-000.yaml": ["id: C-000", "title: Only", "type: normal", "priority: 0", "goal: |", "  go", "provides: []", "read: []", "allowed_paths:", "  - src/a.ts", "outputs:", "  - src/a.ts", "acceptance:", "  - cmd: npm test", "notes: ok", ""].join("\n"),
  },
  branches: {}, subjects: [], historyComplete: true,
};
const api = { snapshot: async () => snap, activeRuns: async () => [] } as unknown as GitHubApi;

const call = (path: string, init: RequestInit & { ip?: string } = {}) =>
  handlePanelRequest(new Request(`https://w.test${path}`, { ...init, headers: { "cf-connecting-ip": init.ip ?? "1.1.1.1", ...(init.headers as any) } }), env, ctx, { api, opts });
const login = (password: string, ip?: string) => call("/panel/api/login", { method: "POST", body: JSON.stringify({ password }), ip });
const cookieOf = (r: Response) => /bp_panel=([^;]+)/.exec(r.headers.get("set-cookie") ?? "")?.[1] ?? "";

beforeEach(() => {
  clearLoginLimits();
  clearPanelCache();
  clearPlanCache();
});

test("paths outside /panel are not handled", async () => {
  assert.equal(await call("/mcp"), null);
  assert.equal(await call("/panelx"), null);
});

test("401 without a cookie, no CORS headers", async () => {
  const r = (await call("/panel/api/state?repo=o/r"))!;
  assert.equal(r.status, 401);
  assert.equal([...r.headers.keys()].filter((h) => h.startsWith("access-control-")).length, 0);
});

test("wrong password is rejected, right one sets a hardened cookie", async () => {
  assert.equal((await login("nope"))!.status, 401);
  const ok = (await login("correct horse"))!;
  assert.equal(ok.status, 200);
  const sc = ok.headers.get("set-cookie")!;
  for (const flag of ["HttpOnly", "Secure", "SameSite=Strict", "Max-Age=43200"]) assert.ok(sc.includes(flag), flag);
  assert.equal([...ok.headers.keys()].filter((h) => h.startsWith("access-control-")).length, 0);
});

test("failures are rate limited", async () => {
  for (let i = 0; i < 5; i++) assert.equal((await login("bad", "9.9.9.9"))!.status, 401);
  assert.equal((await login("correct horse", "9.9.9.9"))!.status, 429);
  assert.equal((await login("correct horse", "8.8.8.8"))!.status, 200);
});

test("state with a valid cookie; repo must match ALLOWED_REPOS", async () => {
  const cookie = `bp_panel=${cookieOf((await login("correct horse"))!)}`;
  const ok = (await call("/panel/api/state?repo=o/r", { headers: { cookie } }))!;
  assert.equal(ok.status, 200);
  const body: any = await ok.json();
  assert.equal(body.repo, "o/r");
  assert.equal(body.cells[0].status, "ready");
  assert.equal((await call("/panel/api/state?repo=x/y", { headers: { cookie } }))!.status, 403);
  assert.equal((await call("/panel/api/state", { headers: { cookie } }))!.status, 400);
  assert.equal((await call("/panel/api/nothing", { headers: { cookie } }))!.status, 404);
});

test("bodies over 4 KB are rejected", async () => {
  const cookie = `bp_panel=${cookieOf((await login("correct horse"))!)}`;
  const big = JSON.stringify({ password: "x".repeat(5000) });
  assert.equal((await call("/panel/api/login", { method: "POST", body: big }))!.status, 413);
  assert.equal((await call("/panel/api/reserve", { method: "POST", body: big, headers: { cookie } }))!.status, 413);
});

test("tampered or expired sessions are refused", async () => {
  const good = await makeSession(env, NOW);
  assert.equal(await verifySession(env, good, NOW), true);
  assert.equal(await verifySession(env, good.slice(0, -1) + (good.endsWith("0") ? "1" : "0"), NOW), false);
  assert.equal(await verifySession(env, good, NOW + 13 * 3600 * 1000), false);
  assert.equal(await verifySession({ PANEL_TOKEN: "other" } as any, good, NOW), false);
});
