import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { GitHubApi, Snapshot } from "../src/api.ts";
import { clearPlanCache } from "../src/common.ts";
import { buildPanelState, clearPanelCache, parseHeal } from "../src/panel/state.ts";

const NOW = Date.parse("2026-11-04T12:00:00Z");
const opts = { mainBranch: "main", historyPages: 0, now: () => NOW, sleep: async () => {}, uuid: () => "u" };
const iso = (minAgo: number) => new Date(NOW - minAgo * 60000).toISOString();
const oid = (c: string) => c.repeat(40);
const env = { OAUTH_KV: { get: async () => null }, GITHUB_TOKEN: "t" } as any;

type Commit = { oid: string; treeOid: string; message: string; committedDate?: string };

function heal(cell: string, kind: string, minAgo: number, note = "", trailer = kind): Commit {
  return { oid: oid("a"), treeOid: oid("b"), message: `heal(${cell}): ${kind}\n\n${note ? note + "\n\n" : ""}heal: ${trailer}`, committedDate: iso(minAgo) };
}
function claim(cell: string): Commit {
  return { oid: "7d3e1b0" + "0".repeat(33), treeOid: oid("b"), message: `claim(${cell}): lock x` };
}

function cellYaml(id: string, after: string[]): string {
  return [
    `id: ${id}`, `title: Cell ${id}`, "type: normal", "priority: 0", "goal: |", `  do ${id}`,
    `after: [${after.join(", ")}]`, "provides: []", "read: []", "allowed_paths:", `  - src/${id}.ts`,
    "outputs:", `  - src/${id}.ts`, "acceptance:", "  - cmd: npm test", "notes: ok", "",
  ].join("\n");
}

/** commits: cell id -> its branch commits, newest first (the first one is the branch tip). */
async function stateWith(commits: Record<string, Commit[]>) {
  const cellFiles: Record<string, string> = {};
  for (const id of ["C-000", "C-001", "C-002", "C-003"]) cellFiles[`${id}.yaml`] = cellYaml(id, id === "C-000" ? [] : ["C-000"]);
  const branches: Record<string, { oid: string; treeOid: string; committedDate: string; message: string }> = {};
  for (const [id, list] of Object.entries(commits)) {
    const tip = list[0];
    branches[`cell/${id}`] = { oid: tip.oid, treeOid: tip.treeOid, committedDate: tip.committedDate ?? iso(5), message: tip.message };
  }
  const snap = {
    mainOid: oid("c"), mainTreeOid: oid("d"), cellFiles, blueprint: "project: demo\nmain_branch: main\n", branches,
    subjects: ["cell(C-000): done"], historyComplete: true,
  } as Snapshot;
  const api = {
    snapshot: async () => snap,
    branchCommits: async (_r: string, b: string, page: number) => (page === 1 ? (commits[b.replace("cell/", "")] ?? null) : []),
    findPr: async () => null,
    activeRuns: async () => [],
  } as unknown as GitHubApi;
  return buildPanelState(env, "o/r", { api, opts });
}

beforeEach(() => {
  clearPlanCache();
  clearPanelCache();
});

test("counts heals per cell and merges them into the log newest first", async () => {
  const s = await stateWith({
    "C-001": [claim("C-001")],
    "C-002": [heal("C-002", "lint", 5, "Fixed lint."), heal("C-002", "ci", 20), claim("C-002")],
    "C-003": [heal("C-003", "conflict", 10), claim("C-003")],
  });
  const by = Object.fromEntries(s.cells.map((c) => [c.id, c]));
  assert.equal(by["C-002"].heals, 2);
  assert.equal(by["C-003"].heals, 1);
  assert.deepEqual(s.healLog?.map((h) => h.kind), ["lint", "conflict", "ci"]);
  assert.deepEqual(s.healLog?.map((h) => h.cell), ["C-002", "C-003", "C-002"]);
  assert.equal(s.healLog?.[0].at, iso(5));
  assert.equal(s.healLog?.[0].note, "Fixed lint.");
  assert.equal(s.healLog?.[1].note, "");
});

test("a branch without heals has no heals field, and no heals anywhere leaves healLog out", async () => {
  const s = await stateWith({ "C-001": [claim("C-001")], "C-002": [claim("C-002")] });
  for (const c of s.cells) assert.equal("heals" in c, false);
  assert.equal("healLog" in s, false);
  assert.equal(s.cells.find((c) => c.id === "C-001")?.sha.lock, "7d3e1b0");
});

test("the log is capped at 20 while the cell keeps the full count", async () => {
  const list: Commit[] = [];
  for (let i = 0; i < 25; i++) list.push(heal("C-002", `k${i}`, i + 1));
  list.push(claim("C-002"));
  const s = await stateWith({ "C-002": list });
  assert.equal(s.cells.find((c) => c.id === "C-002")?.heals, 25);
  assert.equal(s.healLog?.length, 20);
  assert.equal(s.healLog?.[0].kind, "k0");
  assert.equal(s.healLog?.[19].kind, "k19");
});

test("corrupt trailers, other cells and plain commits are ignored", async () => {
  const s = await stateWith({
    "C-002": [
      heal("C-002", "lint", 1, "", ""),
      heal("C-002", "ci", 2, "", "lint"),
      heal("C-009", "x", 3),
      { oid: oid("a"), treeOid: oid("b"), message: "heal(C-002): conflict\n\nno trailer here" },
      heal("C-002", "deps", 4),
      claim("C-002"),
    ],
  });
  assert.equal(s.cells.find((c) => c.id === "C-002")?.heals, 1);
  assert.deepEqual(s.healLog?.map((h) => h.kind), ["deps"]);
});

test("the note is cut to 160 chars and leaves the trailers out", async () => {
  const s = await stateWith({ "C-002": [heal("C-002", "lint", 1, "x".repeat(300)), claim("C-002")] });
  assert.equal(s.healLog?.[0].note, "x".repeat(160));
});

test("parseHeal uses the fallback time when the commit has no date", () => {
  const h = parseHeal("C-002", { message: "heal(C-002): ci\n\nheal: ci" }, "FALLBACK");
  assert.deepEqual(h, { cell: "C-002", kind: "ci", at: "FALLBACK", note: "" });
  assert.equal(parseHeal("C-002", { message: "cell: wip\n\nnext: x" }), null);
});
