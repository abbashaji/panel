import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { GitHubApi, Snapshot } from "../src/api.ts";
import { clearPlanCache } from "../src/common.ts";
import { claimsFromBranches, computeState, loadCells, loadConfig } from "../src/plan.ts";
import { buildPanelState, clearPanelCache } from "../src/panel/state.ts";
import { handlePanelAction } from "../src/panel/actions.ts";
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

// C-000 done; C-001 ready; C-002 running; C-003 expired; C-004 <- C-001; C-005, C-006, C-007 <- C-004; C-008 <- C-005
const DEPS: Record<string, string[]> = {
  "C-000": [], "C-001": ["C-000"], "C-002": ["C-000"], "C-003": ["C-000"],
  "C-004": ["C-001"], "C-005": ["C-004"], "C-006": ["C-004"], "C-007": ["C-004"], "C-008": ["C-005"],
};

function snapshot(mergedIds: string[] = ["C-000"]): Snapshot {
  const cellFiles: Record<string, string> = {};
  for (const [id, after] of Object.entries(DEPS)) cellFiles[`${id}.yaml`] = cellYaml(id, after);
  return {
    mainOid: oid("a"), mainTreeOid: oid("b"), cellFiles, blueprint: "project: demo\nmain_branch: main\n",
    branches: {
      "cell/C-002": { oid: oid("c"), treeOid: oid("d"), committedDate: iso(10), message: "cell: wip\n\nnext: write tests" },
      "cell/C-003": { oid: oid("e"), treeOid: oid("f"), committedDate: iso(200), message: "cell: wip\n\nnext: continue" },
    },
    subjects: mergedIds.map((m) => `cell(${m}): done`), historyComplete: true,
  };
}

function fakeApi(snap: Snapshot): GitHubApi {
  const commits: Record<string, { oid: string; treeOid: string; message: string }[]> = {
    "cell/C-002": [
      { oid: oid("c"), treeOid: oid("d"), message: "cell: wip\n\nnext: write tests" },
      { oid: "7d3e1b0" + "0".repeat(33), treeOid: oid("d"), message: "claim(C-002): lock x" },
    ],
    "cell/C-003": [{ oid: oid("e"), treeOid: oid("f"), message: "takeover(C-003): lock y" }],
  };
  return {
    snapshot: async () => snap,
    branchCommits: async (_r: string, b: string, page: number) => (page === 1 ? (commits[b] ?? null) : []),
    findPr: async (_r: string, b: string) => (b === "cell/C-002" ? { number: 12, state: "open", merged: false, url: "" } : null),
    activeRuns: async () => [],
  } as unknown as GitHubApi;
}

const kv = { get: async (k: string) => (k === "reserve:o/r:C-001" ? JSON.stringify({ who: "Ann", at: NOW }) : null) };
const env = { OAUTH_KV: kv, GITHUB_TOKEN: "t" } as any;

beforeEach(() => {
  clearPlanCache();
  clearPanelCache();
});

test("statuses, counts, waves and critical", async () => {
  const s = await buildPanelState(env, "o/r", { api: fakeApi(snapshot()), opts });
  const st = Object.fromEntries(s.cells.map((c) => [c.id, c.status]));
  assert.equal(st["C-000"], "done");
  assert.equal(st["C-001"], "ready");
  assert.equal(st["C-002"], "running");
  assert.equal(st["C-003"], "expired");
  for (const id of ["C-004", "C-005", "C-006", "C-007", "C-008"]) assert.equal(st[id], "waiting");
  assert.deepEqual(s.counts, { done: 1, running: 1, ready: 1, waiting: 5, expired: 1, needs_human: 0, needs_split: 0 });
  const by = Object.fromEntries(s.cells.map((c) => [c.id, c]));
  assert.equal(by["C-000"].wave, 0);
  assert.equal(by["C-004"].wave, 2);
  assert.equal(by["C-001"].critical, true);
  assert.equal(by["C-004"].critical, false);
  assert.deepEqual(by["C-004"].blockedBy, ["C-001"]);
  assert.deepEqual(by["C-004"].depends, [{ id: "C-001", kind: "implementation" }]);
  assert.equal(by["C-000"].directDependents, 3);
  assert.equal(s.mainSha, "aaaaaaa");
  assert.equal(s.project, "demo");
  assert.equal(s.cells[0].sha.merged, null);
});

test("parity with computeState on the same fixture", async () => {
  const snap = snapshot();
  const s = await buildPanelState(env, "o/r", { api: fakeApi(snap), opts });
  const cells = loadCells(snap.cellFiles).cells;
  const { cfg } = loadConfig(snap.blueprint);
  const st = computeState(cells, ["C-000"], claimsFromBranches(snap.branches, NOW), cfg.lease_minutes, {}, cfg.max_ci_minutes, cfg.bottleneck_threshold, {
    criticalLeaseMinutes: cfg.critical_lease_minutes, criticalChainThreshold: cfg.critical_chain_threshold,
    criticalTransitiveThreshold: cfg.critical_transitive_threshold, parkMaxMinutes: cfg.park_max_minutes, maxAttempts: cfg.max_attempts,
  });
  const ids = (status: string[]) => s.cells.filter((c) => status.includes(c.status)).map((c) => c.id).sort();
  assert.deepEqual(ids(["ready", "expired"]), st.ready.map((r) => r.id).sort());
  assert.deepEqual(ids(["running"]), st.locked.map((r) => r.id).sort());
  assert.deepEqual(ids(["waiting"]), st.waiting.map((r) => r.id).sort());
});

test("bottleneck is the not-done cell with most transitive dependents", async () => {
  const s = await buildPanelState(env, "o/r", { api: fakeApi(snapshot()), opts });
  assert.deepEqual(s.bottleneck, { id: "C-001", blocks: 5 });
  clearPanelCache();
  clearPlanCache();
  const all = await buildPanelState(env, "o/r", { api: fakeApi(snapshot(Object.keys(DEPS))), opts });
  assert.equal(all.bottleneck, null);
  assert.equal(all.counts.done, 9);
});

test("lease, shas, last commit, pr and reservation", async () => {
  const s = await buildPanelState(env, "o/r", { api: fakeApi(snapshot()), opts });
  const by = Object.fromEntries(s.cells.map((c) => [c.id, c]));
  assert.deepEqual(by["C-002"].lease, { minutesLeft: 50, expiredMinutesAgo: null, ci: false });
  assert.equal(by["C-002"].sha.lock, "7d3e1b0");
  assert.equal(by["C-002"].sha.tip, "ccccccc");
  assert.equal(by["C-002"].lastCommit?.next, "write tests");
  assert.deepEqual(by["C-002"].pr, { number: 12, state: "open" });
  assert.deepEqual(by["C-003"].lease, { minutesLeft: 0, expiredMinutesAgo: 140, ci: false });
  assert.equal(by["C-003"].sha.lock, "eeeeeee");
  assert.equal(by["C-001"].lease, null);
  assert.equal(by["C-001"].lastCommit, null);
  assert.equal(by["C-001"].pr, null);
  assert.equal(by["C-001"].reservedBy, "Ann");
  assert.equal(by["C-000"].reservedBy, null);
});

function liveKv() {
  const m = new Map<string, string>();
  return { m, get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => void m.set(k, v), delete: async (k: string) => void m.delete(k) };
}
const reservedOf = (s: any, id: string) => s.cells.find((c: any) => c.id === id).reservedBy;

test("reservedBy is read outside the cache: reserve and release show at once", async () => {
  const k = liveKv();
  const e = { OAUTH_KV: k, GITHUB_TOKEN: "t" } as any;
  const api = fakeApi(snapshot());
  assert.equal(reservedOf(await buildPanelState(e, "o/r", { api, opts }), "C-001"), null);
  k.m.set("reserve:o/r:C-001", JSON.stringify({ who: "Bob", at: NOW }));
  assert.equal(reservedOf(await buildPanelState(e, "o/r", { api, opts }), "C-001"), "Bob");
  k.m.delete("reserve:o/r:C-001");
  assert.equal(reservedOf(await buildPanelState(e, "o/r", { api, opts }), "C-001"), null);
});

test("resumable: expired and released cells are resumable, running and fresh ready are not", async () => {
  const snap = snapshot();
  snap.branches["cell/C-001"] = { oid: oid("1"), treeOid: oid("2"), committedDate: iso(5), message: "release(C-001): handoff\n\nnext: continue" };
  const s = await buildPanelState(env, "o/r", { api: fakeApi(snap), opts });
  const by = Object.fromEntries(s.cells.map((c) => [c.id, c]));
  assert.ok(["ready", "expired"].includes(by["C-001"].status));
  assert.equal(by["C-001"].resumable, true);
  assert.equal(by["C-003"].resumable, true);
  assert.equal(by["C-002"].resumable, false);
  assert.equal(by["C-000"].resumable, false);
  assert.equal(by["C-005"].resumable, false);
  clearPanelCache();
  clearPlanCache();
  const plain = await buildPanelState(env, "o/r", { api: fakeApi(snapshot()), opts });
  assert.equal(plain.cells.find((c) => c.id === "C-001")!.resumable, false);
});

test("an action clears the panel cache so the next state is rebuilt", async () => {
  const e = { OAUTH_KV: liveKv(), GITHUB_TOKEN: "t", PANEL_TOKEN: "pw", ADMIN_TOKEN: "adm", ALLOWED_REPOS: "o/r" } as any;
  let builds = 0;
  const base: any = fakeApi(snapshot());
  const api = { ...base, findPr: async (...a: any[]) => (builds++, base.findPr(...a)) } as unknown as GitHubApi;
  await buildPanelState(e, "o/r", { api, opts });
  const n1 = builds;
  assert.ok(n1 > 0);
  await buildPanelState(e, "o/r", { api, opts });
  assert.equal(builds, n1);
  const req = new Request("https://x.test/panel/api/release", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `${COOKIE}=${await makeSession(e)}` },
    body: JSON.stringify({ repo: "o/r", cell_id: "C-003", admin_key: "adm" }),
  });
  const res = await handlePanelAction(req, e, {} as any, "/panel/api/release", {
    takeover: async () => "RELEASED C-003",
    cellInfo: async () => ({ id: "C-003", status: "ready", resumable: true }),
  });
  assert.equal(res!.status, 200);
  await buildPanelState(e, "o/r", { api, opts });
  assert.ok(builds > n1);
});

// --- C-047: replaced (superseded, never merged) cells ---
function supSnapshot(mergedIds: string[], defs: Record<string, { after: string[]; supersedes?: string[] }>): Snapshot {
  const cellFiles: Record<string, string> = {};
  for (const [id, d] of Object.entries(defs)) {
    cellFiles[`${id}.yaml`] = cellYaml(id, d.after) + (d.supersedes ? `supersedes:\n${d.supersedes.map((s) => `  - ${s}`).join("\n")}\n` : "");
  }
  return {
    mainOid: oid("a"), mainTreeOid: oid("b"), cellFiles, blueprint: "project: demo\nmain_branch: main\n", branches: {},
    subjects: mergedIds.map((m) => `cell(${m}): done`), historyComplete: true,
  };
}

test("superseded unmerged cell has supersededBy and is not counted", async () => {
  const snap = supSnapshot(["C-000"], {
    "C-000": { after: [] },
    "C-010": { after: ["C-000"] },
    "C-011": { after: ["C-000"], supersedes: ["C-010"] },
    "C-013": { after: ["C-000"], supersedes: ["C-010"] },
    "C-012": { after: ["C-010"] },
  });
  const s = await buildPanelState(env, "o/r", { api: fakeApi(snap), opts });
  const by = Object.fromEntries(s.cells.map((c) => [c.id, c]));
  assert.deepEqual(by["C-010"].supersededBy, ["C-011", "C-013"]);
  assert.equal(by["C-010"].status, "waiting");
  for (const id of ["C-000", "C-011", "C-012", "C-013"]) assert.equal("supersededBy" in by[id], false);
  assert.deepEqual(s.counts, { done: 1, running: 0, ready: 2, waiting: 1, expired: 0, needs_human: 0, needs_split: 0 });
  const live = Object.values(s.counts).reduce((a, b) => a + b, 0);
  assert.equal(live, s.cells.length - 1);
});

test("dependents of a replaced cell wait on its superseders", async () => {
  const snap = supSnapshot(["C-000"], {
    "C-000": { after: [] },
    "C-010": { after: ["C-000"] },
    "C-011": { after: ["C-000"], supersedes: ["C-010"] },
    "C-012": { after: ["C-010"] },
  });
  const s = await buildPanelState(env, "o/r", { api: fakeApi(snap), opts });
  const by = Object.fromEntries(s.cells.map((c) => [c.id, c]));
  assert.equal(by["C-012"].status, "waiting");
  assert.ok(by["C-012"].blockedBy.includes("C-011"));
  assert.equal(by["C-012"].blockedBy.includes("C-010"), false);
  // the replaced cell is not a dependent of C-000
  assert.equal(by["C-000"].directDependents, 1);
});

test("superseded cell that merged first is done without supersededBy", async () => {
  const snap = supSnapshot(["C-000", "C-020"], {
    "C-000": { after: [] },
    "C-020": { after: ["C-000"] },
    "C-021": { after: ["C-000"], supersedes: ["C-020"] },
  });
  const s = await buildPanelState(env, "o/r", { api: fakeApi(snap), opts });
  const by = Object.fromEntries(s.cells.map((c) => [c.id, c]));
  assert.equal(by["C-020"].status, "done");
  assert.equal("supersededBy" in by["C-020"], false);
  assert.equal(s.counts.done, 2);
});

test("a plan without supersedes has no supersededBy and counts every cell", async () => {
  const s = await buildPanelState(env, "o/r", { api: fakeApi(snapshot()), opts });
  assert.equal(s.cells.some((c) => "supersededBy" in c), false);
  assert.equal(Object.values(s.counts).reduce((a, b) => a + b, 0), s.cells.length);
});
