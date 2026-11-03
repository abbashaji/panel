// Integration: login -> state -> reserve -> pinned next_cell -> plain next_cell skips reserved -> release needs the admin key.
// Runs against FakeGitHub (never real GitHub). The /panel/api/reserve and /release actions get readiness/takeover from the same fake.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { clearPlanCache } from "../src/common.ts";
import { handlePanelRequest } from "../src/panel/router.ts";
import { handlePanelAction, type ActionDeps } from "../src/panel/actions.ts";
import { buildPanelState, clearPanelCache } from "../src/panel/state.ts";
import { toolHandlers } from "../src/tools.ts";
import { FakeGitHub } from "./fakegh.ts";

const REPO = "o/r";
const ctx = {} as any;

function cellYaml(id: string, after: string[] = []): string {
  return [
    `id: ${id}`, `title: Cell ${id}`, "type: normal", "priority: 0", "goal: |", `  do ${id}`,
    `after: [${after.join(", ")}]`, "provides: []", "read: []", "allowed_paths:", `  - src/${id}.ts`,
    "outputs:", `  - src/${id}.ts`, "acceptance:", "  - cmd: npm test", "notes: ok", "",
  ].join("\n");
}

function fakeKv() {
  const m = new Map<string, string>();
  return {
    m,
    get: async (k: string) => m.get(k) ?? null,
    put: async (k: string, v: string) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
  };
}

// C-000 is merged; C-001 and C-002 are both ready.
function setup() {
  const gh = new FakeGitHub();
  gh.commit(
    "main",
    { "blueprint.yaml": "project: demo\nmain_branch: main\n", "cells/C-000.yaml": cellYaml("C-000"), "cells/C-001.yaml": cellYaml("C-001", ["C-000"]), "cells/C-002.yaml": cellYaml("C-002", ["C-000"]) },
    "plan",
  );
  gh.commit("main", {}, "cell(C-000): done (#1)");
  const kv = fakeKv();
  const env: any = { PANEL_TOKEN: "pw", ADMIN_TOKEN: "adm", ALLOWED_REPOS: REPO, GITHUB_TOKEN: "x", OAUTH_KV: kv };
  const opts = { mainBranch: "main", historyPages: 3, now: () => gh.clock, sleep: async () => {}, uuid: () => `u${gh.commits.size}` };
  const tools = toolHandlers(env, opts, () => gh);
  let takeovers = 0;
  const deps: ActionDeps = {
    readiness: async (e, repo, cell) => {
      const st = await buildPanelState(e, repo, { api: gh, opts });
      const c = st.cells.find((x) => x.id === cell);
      return { ready: c?.status === "ready" || c?.status === "expired", detail: c?.status ?? "unknown cell" };
    },
    takeover: async (_e, repo, cell, key, mode) => {
      takeovers++;
      return tools.takeover({ repo, cell_id: cell, admin_key: key, handoff: mode === "release" });
    },
  };
  return { gh, kv, env, opts, tools, deps, takeovers: () => takeovers };
}

async function login(env: any, opts: any, gh: FakeGitHub): Promise<string> {
  const req = (password: string) =>
    new Request("https://x.test/panel/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
  const bad = await handlePanelRequest(req("nope"), env, ctx, { api: gh, opts });
  assert.ok(bad && bad.status >= 400 && bad.status < 500, "a wrong password is refused");
  assert.equal(bad!.headers.get("set-cookie"), null);
  const ok = await handlePanelRequest(req("pw"), env, ctx, { api: gh, opts });
  assert.equal(ok!.status, 200);
  const m = /bp_panel=[^;]+/.exec(ok!.headers.get("set-cookie") ?? "");
  assert.ok(m, "login sets the bp_panel cookie");
  return m![0];
}

async function api(env: any, deps: ActionDeps, cookie: string, path: string, body: unknown) {
  const req = new Request(`https://x.test${path}`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });
  return handlePanelAction(req, env, ctx, path, deps);
}

beforeEach(() => {
  clearPlanCache();
  clearPanelCache();
});

test("state needs the cookie, then lists both ready cells", async () => {
  const { gh, env, opts } = setup();
  const anon = await handlePanelRequest(new Request(`https://x.test/panel/api/state?repo=${REPO}`), env, ctx, { api: gh, opts });
  assert.equal(anon!.status, 401);
  const cookie = await login(env, opts, gh);
  const res = await handlePanelRequest(new Request(`https://x.test/panel/api/state?repo=${REPO}`, { headers: { cookie } }), env, ctx, { api: gh, opts });
  assert.equal(res!.status, 200);
  const st: any = await res!.json();
  const status = (id: string) => st.cells.find((c: any) => c.id === id)?.status;
  assert.equal(status("C-000"), "done");
  assert.equal(status("C-001"), "ready");
  assert.equal(status("C-002"), "ready");
});

test("reserve C-002, then a pinned next_cell claims exactly C-002", async () => {
  const { gh, kv, env, opts, deps, tools } = setup();
  const cookie = await login(env, opts, gh);
  const r = await api(env, deps, cookie, "/panel/api/reserve", { repo: REPO, cell_id: "C-002", who: "Ann" });
  assert.equal(((await r!.json()) as any).status, "reserved");
  assert.ok(kv.m.has(`reserve:${REPO}:C-002`));
  const reply = await tools.next_cell({ repo: REPO, cell_id: "C-002", who: "Ann" });
  assert.match(reply, /^CLAIMED C-002 base=[0-9a-f]{7} repo=o\/r/);
  assert.ok(gh.refs.has("cell/C-002"));
  assert.ok(!gh.refs.has("cell/C-001"), "no other cell was claimed");
  assert.ok(!kv.m.has(`reserve:${REPO}:C-002`), "the reservation is deleted on CLAIMED");
});

test("a pinned call by someone else gets RESERVED and claims nothing", async () => {
  const { gh, env, opts, deps, tools } = setup();
  const cookie = await login(env, opts, gh);
  await api(env, deps, cookie, "/panel/api/reserve", { repo: REPO, cell_id: "C-002", who: "Ann" });
  const reply = await tools.next_cell({ repo: REPO, cell_id: "C-002", who: "Bob" });
  assert.match(reply, /^RESERVED C-002 by Ann/);
  assert.ok(!gh.refs.has("cell/C-002"));
});

test("a plain next_cell skips a reserved cell", async () => {
  const { gh, env, opts, deps, tools } = setup();
  const cookie = await login(env, opts, gh);
  await api(env, deps, cookie, "/panel/api/reserve", { repo: REPO, cell_id: "C-001", who: "Ann" });
  const reply = await tools.next_cell({ repo: REPO });
  assert.match(reply, /^CLAIMED C-002 /);
  assert.ok(!gh.refs.has("cell/C-001"), "the reserved cell stays free");
});

test("release needs the admin key", async () => {
  const { gh, env, opts, deps, tools, takeovers } = setup();
  const cookie = await login(env, opts, gh);
  await tools.next_cell({ repo: REPO, cell_id: "C-001" });
  const base = { repo: REPO, cell_id: "C-001" };
  assert.equal((await api(env, deps, cookie, "/panel/api/release", base))!.status, 403);
  assert.equal((await api(env, deps, cookie, "/panel/api/release", { ...base, admin_key: "wrong" }))!.status, 403);
  assert.equal(takeovers(), 0, "takeover is never reached without the key");
  const ok = await api(env, deps, cookie, "/panel/api/release", { ...base, admin_key: "adm" });
  assert.equal(ok!.status, 200);
  assert.equal(takeovers(), 1);
});
