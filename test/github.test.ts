// Request-shape tests for the real GitHub client, against a scripted fetch. They prove we send what the GitHub
// docs say (and map the documented responses); they cannot prove GitHub still behaves that way.
import test from "node:test";
import assert from "node:assert/strict";
import { createGitHubApi } from "../src/github.ts";

type Call = { method: string; url: string; body: any };
function mock(script: (c: Call) => { status?: number; body?: unknown; headers?: Record<string, string> }) {
  const calls: Call[] = [];
  const f = async (url: string, init: any = {}) => {
    const c = { method: init.method ?? "GET", url: String(url), body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(c);
    const r = script(c);
    const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {});
    return new Response(text, { status: r.status ?? 200, headers: r.headers });
  };
  return { api: createGitHubApi("tok", f as any), calls };
}

test("createBranch: 201 created, 422 'already exists' is the lost race, other errors throw", async () => {
  let n = 0;
  const { api, calls } = mock(() => [{ status: 201 }, { status: 422, body: { message: "Reference already exists" } }, { status: 500, body: { message: "boom" } }][n++]);
  assert.equal(await api.createBranch("o/r", "cell/C-001", "abc"), "created");
  assert.equal(await api.createBranch("o/r", "cell/C-001", "abc"), "exists");
  await assert.rejects(api.createBranch("o/r", "cell/C-001", "abc"), /500/);
  assert.deepEqual(calls[0].body, { ref: "refs/heads/cell/C-001", sha: "abc" });
  assert.match(calls[0].url, /\/repos\/o\/r\/git\/refs$/);
});

test("fastForward: never forces; maps 200/404/422", async () => {
  let n = 0;
  const { api, calls } = mock(() => [{ status: 200 }, { status: 404 }, { status: 422, body: { message: "Update is not a fast forward" } }][n++]);
  assert.equal(await api.fastForward("o/r", "cell/C-001", "x"), "ok");
  assert.equal(await api.fastForward("o/r", "cell/C-001", "x"), "missing");
  assert.equal(await api.fastForward("o/r", "cell/C-001", "x"), "not_ff");
  assert.equal(calls[0].method, "PATCH");
  assert.equal(calls[0].body.force, false);
});

test("commitFiles: one tree on the base tree (inline content, null sha for deletes) + one commit", async () => {
  const { api, calls } = mock((c) => (c.url.endsWith("/git/trees") ? { status: 201, body: { sha: "T1" } } : { status: 201, body: { sha: "C1" } }));
  const oid = await api.commitFiles("o/r", "P", "BT", [{ path: "a.py", content: "x" }, { path: "b.py", content: null }], "WIP: m");
  assert.equal(oid, "C1");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.base_tree, "BT");
  assert.deepEqual(calls[0].body.tree[0], { path: "a.py", mode: "100644", type: "blob", content: "x" });
  assert.equal(calls[0].body.tree[1].sha, null);
  assert.deepEqual(calls[1].body, { message: "WIP: m", tree: "T1", parents: ["P"] });
});

test("rate limit is reported plainly", async () => {
  const { api } = mock(() => ({ status: 403, body: { message: "API rate limit exceeded" }, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800000000" } }));
  await assert.rejects(api.branchTip("o/r", "main"), /rate limit/i);
});

test("snapshot: one GraphQL call yields main, cells, config, branches, history", async () => {
  const { api, calls } = mock(() => ({
    body: { data: { repository: {
      ref: { target: { oid: "M1", tree: { oid: "MT" }, history: { nodes: [{ messageHeadline: "cell(C-000): s (#1)" }, { messageHeadline: "init" }], pageInfo: { hasNextPage: false } } } },
      cells: { entries: [{ name: "C-000.yaml", object: { text: "id: C-000\n", isTruncated: false } }] },
      cfg: { text: "project: p\n" },
      branches: { nodes: [{ name: "C-001", target: { oid: "B1", committedDate: "2026-10-30T10:00:00Z", message: "lock", tree: { oid: "BT" } } }], pageInfo: { hasNextPage: false } },
    } } },
  }));
  const s = await api.snapshot("o/r", "main", 3);
  assert.equal(calls.length, 1);
  assert.equal(s.mainOid, "M1");
  assert.deepEqual(Object.keys(s.cellFiles), ["C-000.yaml"]);
  assert.equal(s.blueprint, "project: p\n");
  assert.equal(s.branches["cell/C-001"].oid, "B1");
  assert.deepEqual(s.subjects, ["cell(C-000): s (#1)", "init"]);
});

test("snapshot: a missing branch or repo is a clear error", async () => {
  const a = mock(() => ({ body: { data: { repository: null } } }));
  await assert.rejects(a.api.snapshot("o/r", "main", 0), /not found/);
  const b = mock(() => ({ body: { data: { repository: { ref: null } } } }));
  await assert.rejects(b.api.snapshot("o/r", "main", 0), /branch main not found/);
});

function snapResponse(pullRequests?: unknown) {
  const repository: any = {
    ref: { target: { oid: "M1", tree: { oid: "MT" }, history: { nodes: [{ messageHeadline: "init" }], pageInfo: { hasNextPage: false } } } },
    cells: { entries: [] },
    cfg: { text: "project: p\n" },
    branches: { nodes: [], pageInfo: { hasNextPage: false } },
  };
  if (pullRequests !== undefined) repository.pullRequests = pullRequests;
  return { data: { repository } };
}

test("snapshot: merged pull requests fill mergedIds (branch name or title)", async () => {
  const { api, calls } = mock(() => ({
    body: snapResponse({ nodes: [{ title: "something", headRefName: "cell/C-004" }, { title: "cell(C-007): x (#9)", headRefName: "feature" }, { title: "unrelated", headRefName: "other" }], pageInfo: { hasNextPage: false } }),
  }));
  const s = await api.snapshot("o/r", "main", 3);
  assert.equal(calls.length, 1);
  assert.deepEqual([...(s.mergedIds ?? [])].sort(), ["C-004", "C-007"]);
  assert.match(calls[0].body.query, /pullRequests\(states: MERGED, first: 100, orderBy: \{field: UPDATED_AT, direction: DESC\}\)/);
});

test("snapshot: no merged PRs is an empty array, not undefined", async () => {
  const { api } = mock(() => ({ body: snapResponse({ nodes: [], pageInfo: { hasNextPage: false } }) }));
  assert.deepEqual((await api.snapshot("o/r", "main", 3)).mergedIds, []);
});

test("snapshot: more PR pages are read only while hasNextPage, at most historyPages of them", async () => {
  let pages = 0;
  const mk = (i: number) => ({ nodes: [{ title: `cell(C-${String(100 + i).padStart(3, "0")}): x`, headRefName: "f" }], pageInfo: { hasNextPage: true, endCursor: `c${i}` } });
  const { api, calls } = mock((c) => (c.body.query.includes("after:$after") && !c.body.query.includes("history(")
    && !c.body.query.includes("branches:") ? { body: { data: { repository: { pullRequests: mk(++pages) } } } } : { body: snapResponse(mk(0)) }));
  const s = await api.snapshot("o/r", "main", 2);
  assert.equal(pages, 2); // capped by historyPages
  assert.equal(calls.length, 3);
  assert.equal(s.mergedIds?.length, 3);

  const one = mock(() => ({ body: snapResponse({ nodes: [{ title: "cell(C-001): x", headRefName: "f" }], pageInfo: { hasNextPage: false } }) }));
  await one.api.snapshot("o/r", "main", 5);
  assert.equal(one.calls.length, 1); // no second page without hasNextPage
});

test("snapshot: a response without the PR part leaves mergedIds undefined", async () => {
  const { api } = mock(() => ({ body: snapResponse() }));
  assert.equal((await api.snapshot("o/r", "main", 3)).mergedIds, undefined);
});

test("branchCommits: encoded branch, paging params, mapping, 404/422 -> null, perPage clamp, other errors throw", async () => {
  const item = (s: string) => ({ sha: s, commit: { tree: { sha: "T" + s }, message: "m " + s }, parents: [] });
  let n = 0;
  const { api, calls } = mock(() => [
    { status: 200, body: [item("a"), item("b")] },
    { status: 404 },
    { status: 422, body: { message: "No commit found for SHA" } },
    { status: 200, body: [] },
    { status: 200, body: [] },
    { status: 500, body: { message: "boom" } },
  ][n++]);
  const r = await api.branchCommits("o/r", "cell/C-007", 2, 30);
  assert.deepEqual(r, [{ oid: "a", treeOid: "Ta", message: "m a" }, { oid: "b", treeOid: "Tb", message: "m b" }]);
  assert.equal(calls[0].method, "GET");
  assert.match(calls[0].url, /\/repos\/o\/r\/commits\?sha=cell%2FC-007&per_page=30&page=2$/);
  assert.equal(await api.branchCommits("o/r", "x", 1, 10), null);
  assert.equal(await api.branchCommits("o/r", "x", 1, 10), null);
  await api.branchCommits("o/r", "x", 1, 500);
  await api.branchCommits("o/r", "x", 1, 0);
  assert.match(calls[3].url, /per_page=100&/);
  assert.match(calls[4].url, /per_page=1&/);
  await assert.rejects(api.branchCommits("o/r", "x", 1, 10), /500/);
});
