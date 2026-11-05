import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { GitHubApi, Snapshot } from "../src/api.ts";
import { clearPlanCache } from "../src/common.ts";
import { buildPanelState, clearPanelCache } from "../src/panel/state.ts";
import { handlePanelAction } from "../src/panel/actions.ts";
import { handlePanelRequest } from "../src/panel/router.ts";
import { COOKIE, makeSession } from "../src/panel/auth.ts";

const NOW = Date.parse("2026-11-04T12:00:00Z");
const opts = { mainBranch: "main", historyPages: 0, now: () => NOW, sleep: async () => {}, uuid: () => "u" };
const iso = (minAgo: number) => new Date(NOW - minAgo * 60000).toISOString();
const oid = (c: string) => c.repeat(40);

function cellYaml(id: string, after: string[] = []): string {
  return [
    `id: ${id}`, `title: Cell ${id}`, "type: normal", "priority: 0", "goal: |", `  do ${id}`,
    `after: [${after.join(", ")}]`, "provides: []", "read: []", "allowed_paths:", `  - src/${id}.ts`,
    "outputs:", `  - src/${id}.ts`, "acceptance:", "  - cmd: npm test", "notes: ok", "",
  ].join("\n");
}

// C-000 done; C-001 ready; C-002 running; C-003 expired
const DEPS: Record<string, string[]> = { "C-000": [], "C-001": ["C-000"], "C-002": ["C-000"], "C-003": ["C-000"] };

function snapshot(extra: Snapshot["branches"] = {}): Snapshot {
  const cellFiles: Record<string, string> = {};
  for (const [id, after] of Object.entries(DEPS)) cellFiles[`${id}.yaml`] = cellYaml(id, after);
  return {
    mainOid: oid("a"), mainTreeOid: oid("b"), cellFiles, blueprint: "project: demo\nmain_branch: main\n",
    branches: {
      "cell/C-002": { oid: oid("c"), treeOid: oid("d"), committedDate: iso(10), message: "cell: wip\n\nnext: write tests" },
      "cell/C-003": { oid: oid("e"), treeOid: oid("f"), committedDate: iso(200), message: "cell: wip\n\nnext: continue" },
      ...extra,
    },
    subjects: ["cell(C-000): done"], historyComplete: true,
  };
}

type Tip = { oid: string; treeOid: string; committedDate: string; message: string };
const leaseTip = (minAgo: number, extra = ""): Tip => ({
  oid: oid("5"), treeOid: oid("6"), committedDate: iso(minAgo),
  message: `steward(lease): create u\n\nsteward-who: Ann\nsteward-session: s1\nsteward-at: ${iso(minAgo)}${extra}`,
});

/** A fake GitHub whose steward/lease branch is mutable (commitEmpty + fastForward move it). */
function makeApi(snap: Snapshot, lease: Tip | null) {
  const st: { lease: Tip | null; next: Tip | null } = { lease, next: null };
  const api = {
    snapshot: async () => snap,
    branchCommits: async (_r: string, b: string, page: number) => {
      const t = b === "steward/lease" ? st.lease : snap.branches[b];
      return page === 1 && t ? [{ oid: t.oid, treeOid: t.treeOid, message: t.message }] : null;
    },
    branchTip: async (_r: string, b: string) => (b === "steward/lease" ? st.lease : null),
    commitEmpty: async (_r: string, _parent: string, tree: string, message: string) => {
      st.next = { oid: oid("9"), treeOid: tree, committedDate: iso(0), message };
      return oid("9");
    },
    fastForward: async () => ((st.lease = st.next), "ok"),
    findPr: async () => null,
    activeRuns: async () => [],
  } as unknown as GitHubApi;
  return { api, st };
}

const env = { OAUTH_KV: { get: async () => null }, GITHUB_TOKEN: "gh-secret-token", PANEL_TOKEN: "pw", ADMIN_TOKEN: "adm-secret-key", ALLOWED_REPOS: "o/r" } as any;

beforeEach(() => {
  clearPlanCache();
  clearPanelCache();
});

const stewardOf = async (api: GitHubApi) => (await buildPanelState(env, "o/r", { api, opts })).steward;

test("status none: the repository has no steward branch and the state is still valid", async () => {
  const s = await buildPanelState(env, "o/r", { api: makeApi(snapshot(), null).api, opts });
  assert.deepEqual(s.steward, { status: "none", holder: null, minutesLeft: null, expiredMinutesAgo: null, problems: 0 });
  assert.equal(s.cells.length, 4);
  assert.equal(s.counts.done, 1);
});

test("status active, expired and released", async () => {
  assert.deepEqual(await stewardOf(makeApi(snapshot(), leaseTip(20)).api), { status: "active", holder: "Ann", minutesLeft: 40, expiredMinutesAgo: null, problems: 0 });
  clearPanelCache();
  assert.deepEqual(await stewardOf(makeApi(snapshot(), leaseTip(90)).api), { status: "expired", holder: "Ann", minutesLeft: null, expiredMinutesAgo: 30, problems: 0 });
  clearPanelCache();
  assert.deepEqual(await stewardOf(makeApi(snapshot(), leaseTip(5, "\nrelease: handoff")).api), { status: "released", holder: "Ann", minutesLeft: null, expiredMinutesAgo: null, problems: 0 });
});

test("the steward lease is read outside the cache", async () => {
  const { api, st } = makeApi(snapshot(), leaseTip(20));
  assert.equal((await stewardOf(api)).status, "active");
  st.lease = leaseTip(5, "\nrelease: handoff");
  assert.equal((await stewardOf(api)).status, "released");
});

test("problems counts needs_human and needs_split cells", async () => {
  const snap = snapshot({
    "cell/C-001": { oid: oid("1"), treeOid: oid("2"), committedDate: iso(5), message: "feedback(C-001): which database?\n\nnext: wait" },
    "cell/C-003": { oid: oid("e"), treeOid: oid("f"), committedDate: iso(200), message: "takeover(C-003): lock y\n\nattempt: 9\nnext: continue" },
  });
  const s = await buildPanelState(env, "o/r", { api: makeApi(snap, leaseTip(20)).api, opts });
  const by = Object.fromEntries(s.cells.map((c) => [c.id, c.status]));
  assert.equal(by["C-001"], "needs_human");
  assert.equal(by["C-003"], "needs_split");
  assert.equal(s.steward.problems, s.counts.needs_human + s.counts.needs_split);
  assert.equal(s.steward.problems, 2);
});

async function post(path: string, body: unknown, deps: any, cookie = true) {
  const req = new Request(`https://x.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie: `${COOKIE}=${await makeSession(env)}` } : {}) },
    body: JSON.stringify(body),
  });
  return handlePanelAction(req, env, {} as any, path, deps);
}

test("steward-release without the admin key is 403", async () => {
  const { api, st } = makeApi(snapshot(), leaseTip(20));
  const before = st.lease;
  assert.equal((await post("/panel/api/steward-release", { repo: "o/r" }, { api, opts }))!.status, 403);
  assert.equal((await post("/panel/api/steward-release", { repo: "o/r", admin_key: "wrong" }, { api, opts }))!.status, 403);
  assert.equal(st.lease, before);
});

test("steward-release hands the lease off whoever holds it, and the state shows released", async () => {
  const { api, st } = makeApi(snapshot(), leaseTip(20));
  const res = (await post("/panel/api/steward-release", { repo: "o/r", admin_key: "adm-secret-key" }, { api, opts }))!;
  assert.equal(res.status, 200);
  const text = await res.text();
  const out = JSON.parse(text);
  assert.equal(out.ok, true);
  assert.match(out.result, /^STEWARD_RELEASED/);
  assert.equal(out.steward.status, "released");
  assert.equal(out.steward.holder, "Ann");
  assert.match(st.lease!.message, /release: handoff/);
  assert.equal((await stewardOf(api)).status, "released");
  assert.ok(!text.includes("adm-secret-key") && !text.includes("gh-secret-token"));
  assert.ok(!JSON.stringify(await buildPanelState(env, "o/r", { api, opts })).includes("adm-secret-key"));
});

test("steward-release with no steward answers ok:false and none; the router serves the route", async () => {
  const { api } = makeApi(snapshot(), null);
  const out = await (await post("/panel/api/steward-release", { repo: "o/r", admin_key: "adm-secret-key" }, { api, opts }))!.json();
  assert.equal(out.ok, false);
  assert.match(out.result, /^NO_STEWARD/);
  assert.equal(out.steward.status, "none");
  const lease = makeApi(snapshot(), leaseTip(20));
  const req = new Request("https://x.test/panel/api/steward-release", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `${COOKIE}=${await makeSession(env)}` },
    body: JSON.stringify({ repo: "o/r", admin_key: "adm-secret-key" }),
  });
  const res = (await handlePanelRequest(req, env, {} as any, { api: lease.api, opts }))!;
  assert.equal(res.status, 200);
  assert.equal((await res.json()).steward.status, "released");
});
