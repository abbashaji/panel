import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "../src/api.ts";
import { createGitHubApi } from "../src/github.ts";
import { FakeGitHub } from "./fakegh.ts";

const TOKEN = "ghp_SECRET_TOKEN_123";

type Call = { url: string; method: string; body: any; auth: string };

/** A fetch that answers from `route` and records every request. */
function mock(route: (c: Call) => { status: number; body?: unknown }) {
  const calls: Call[] = [];
  const fetchImpl = async (input: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: Call = { url: input, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: headers.Authorization ?? "" };
    calls.push(call);
    const r = route(call);
    return new Response(r.status === 204 || r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  };
  return { fetchImpl, calls };
}

async function rejectsApi(p: Promise<unknown>, status: number) {
  await assert.rejects(p, (e: any) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.status, status);
    assert.ok(!e.message.includes(TOKEN), "token leaked into the error");
    return true;
  });
}

// ---------------------------------------------------------------- github.ts against a mocked fetch

test("compare maps ahead_by, behind_by and files; slashes in branch names stay slashes", async () => {
  const { fetchImpl, calls } = mock(() => ({ status: 200, body: { ahead_by: 2, behind_by: 1, files: [{ filename: "a.ts" }, { filename: "b.ts" }] } }));
  const api = createGitHubApi(TOKEN, fetchImpl);
  assert.deepEqual(await api.compare("o/r", "main", "cell/C-001"), { ahead: 2, behind: 1, files: ["a.ts", "b.ts"] });
  assert.equal(calls[0].method, "GET");
  assert.ok(calls[0].url.includes("/repos/o/r/compare/main...cell/C-001?"));
  assert.equal(calls[0].auth, `Bearer ${TOKEN}`);
});

test("compare reads a second page when the first one is full", async () => {
  const { fetchImpl, calls } = mock((c) => ({
    status: 200,
    body: c.url.includes("page=1")
      ? { ahead_by: 101, behind_by: 0, files: Array.from({ length: 100 }, (_, i) => ({ filename: `f${i}.ts` })) }
      : { ahead_by: 101, behind_by: 0, files: [{ filename: "last.ts" }] },
  }));
  const res = await createGitHubApi(TOKEN, fetchImpl).compare("o/r", "main", "cell/C-001");
  assert.equal(res.files.length, 101);
  assert.equal(res.files[100], "last.ts");
  assert.equal(calls.length, 2);
});

test("compare 404 becomes ApiError and the token is not in the message, even if GitHub echoes it", async () => {
  const { fetchImpl } = mock(() => ({ status: 404, body: { message: `Not Found ${TOKEN}` } }));
  await rejectsApi(createGitHubApi(TOKEN, fetchImpl).compare("o/r", "main", "nope"), 404);
});

test("mergeBranch 201 is merged with the new oid, and posts base/head/commit_message", async () => {
  const { fetchImpl, calls } = mock(() => ({ status: 201, body: { sha: "abc1234" } }));
  const res = await createGitHubApi(TOKEN, fetchImpl).mergeBranch("o/r", "cell/C-001", "main", "merge main");
  assert.deepEqual(res, { status: "merged", oid: "abc1234" });
  assert.equal(calls[0].method, "POST");
  assert.ok(calls[0].url.endsWith("/repos/o/r/merges"));
  assert.deepEqual(calls[0].body, { base: "cell/C-001", head: "main", commit_message: "merge main" });
});

test("mergeBranch 204 is up_to_date", async () => {
  const { fetchImpl } = mock(() => ({ status: 204 }));
  assert.deepEqual(await createGitHubApi(TOKEN, fetchImpl).mergeBranch("o/r", "cell/C-001", "main", "m"), { status: "up_to_date" });
});

test("mergeBranch 409 is a conflict naming the files changed on both sides, never a throw", async () => {
  const { fetchImpl } = mock((c) => {
    if (c.method === "POST") return { status: 409, body: { message: "Merge conflict" } };
    // compare(into, from) = what main changed; compare(from, into) = what the cell changed
    const files = c.url.includes("compare/cell/C-001...main") ? ["a", "b", "c"] : ["b", "c", "d"];
    return { status: 200, body: { ahead_by: 1, behind_by: 1, files: files.map((filename) => ({ filename })) } };
  });
  const res = await createGitHubApi(TOKEN, fetchImpl).mergeBranch("o/r", "cell/C-001", "main", "m");
  assert.deepEqual(res, { status: "conflict", files: ["b", "c"] });
});

test("mergeBranch 409 is still a conflict when the files cannot be worked out", async () => {
  const { fetchImpl } = mock((c) => (c.method === "POST" ? { status: 409, body: { message: "Merge conflict" } } : { status: 500, body: { message: "boom" } }));
  const res = await createGitHubApi(TOKEN, fetchImpl).mergeBranch("o/r", "cell/C-001", "main", "m");
  assert.equal(res.status, "conflict");
  assert.equal(res.files, undefined);
});

test("mergeBranch 404 and other failures become ApiError without the token", async () => {
  const notFound = mock(() => ({ status: 404, body: { message: `Not Found ${TOKEN}` } }));
  await rejectsApi(createGitHubApi(TOKEN, notFound.fetchImpl).mergeBranch("o/r", "cell/C-001", "gone", "m"), 404);
  const broken = mock(() => ({ status: 500, body: { message: "server error" } }));
  await rejectsApi(createGitHubApi(TOKEN, broken.fetchImpl).mergeBranch("o/r", "cell/C-001", "main", "m"), 500);
});

// ---------------------------------------------------------------- the in-memory fake

/** main and cell/C-001 share one commit with a.txt and b.txt. */
function forked() {
  const gh = new FakeGitHub();
  gh.commit("main", { "a.txt": "1", "b.txt": "1" }, "base");
  gh.commit("cell/C-001", {}, "claim");
  return gh;
}

test("fake compare counts ahead and behind and lists the files the head changed", async () => {
  const gh = forked();
  gh.commit("cell/C-001", { "x.txt": "1" }, "c1");
  gh.commit("cell/C-001", { "y.txt": "1" }, "c2");
  gh.commit("main", { "m.txt": "1" }, "m1");
  const res = await gh.compare("o/r", "main", "cell/C-001");
  assert.equal(res.ahead, 3); // claim, c1, c2
  assert.equal(res.behind, 1);
  assert.deepEqual(res.files, ["x.txt", "y.txt"]); // m.txt is main's change, not the cell's
  assert.deepEqual(await gh.compare("o/r", "main", "main"), { ahead: 0, behind: 0, files: [] });
});

test("fake compare and mergeBranch throw ApiError 404 for a missing branch", async () => {
  const gh = forked();
  await rejectsApi(gh.compare("o/r", "main", "cell/C-404"), 404);
  await rejectsApi(gh.mergeBranch("o/r", "cell/C-404", "main", "m"), 404);
  await rejectsApi(gh.mergeBranch("o/r", "cell/C-001", "nope", "m"), 404);
});

test("fake merge of diverged branches makes a two-parent commit holding both sides' files", async () => {
  const gh = forked();
  const cellTip = gh.commit("cell/C-001", { "x.txt": "cell" }, "c1");
  const mainTip = gh.commit("main", { "m.txt": "main" }, "m1");
  const res = await gh.mergeBranch("o/r", "cell/C-001", "main", "merge main");
  assert.equal(res.status, "merged");
  const c = gh.commits.get(res.oid!)!;
  assert.equal(c.parent, cellTip);
  assert.equal(c.parent2, mainTip);
  assert.equal(c.message, "merge main");
  assert.equal(gh.refs.get("cell/C-001"), res.oid);
  assert.equal(gh.refs.get("main"), mainTip); // main is never touched
  assert.equal(gh.file("cell/C-001", "x.txt"), "cell");
  assert.equal(gh.file("cell/C-001", "m.txt"), "main");
  assert.equal((await gh.compare("o/r", "main", "cell/C-001")).behind, 0);
});

test("fake merge is up_to_date when there is nothing to merge", async () => {
  const gh = forked();
  assert.deepEqual(await gh.mergeBranch("o/r", "cell/C-001", "main", "m"), { status: "up_to_date" });
  gh.commit("main", { "m.txt": "1" }, "m1");
  gh.commit("cell/C-001", { "x.txt": "1" }, "c1");
  await gh.mergeBranch("o/r", "cell/C-001", "main", "merge main");
  const tip = gh.refs.get("cell/C-001");
  assert.deepEqual(await gh.mergeBranch("o/r", "cell/C-001", "main", "again"), { status: "up_to_date" });
  assert.equal(gh.refs.get("cell/C-001"), tip);
});

test("fake merge fast-forwards a branch that is only behind (no merge commit)", async () => {
  const gh = forked();
  const mainTip = gh.commit("main", { "m.txt": "1" }, "m1");
  const res = await gh.mergeBranch("o/r", "cell/C-001", "main", "m");
  assert.deepEqual(res, { status: "merged", oid: mainTip });
  assert.equal(gh.refs.get("cell/C-001"), mainTip);
});

test("fake merge: both sides changing the same file differently is a conflict and writes nothing", async () => {
  const gh = forked();
  gh.commit("cell/C-001", { "a.txt": "cell", "x.txt": "1" }, "c1");
  gh.commit("main", { "a.txt": "main", "m.txt": "1" }, "m1");
  const before = gh.refs.get("cell/C-001");
  const size = gh.commits.size;
  assert.deepEqual(await gh.mergeBranch("o/r", "cell/C-001", "main", "m"), { status: "conflict", files: ["a.txt"] });
  assert.equal(gh.refs.get("cell/C-001"), before);
  assert.equal(gh.commits.size, size);
});

test("fake merge: the same change on both sides is not a conflict; delete versus edit is", async () => {
  const same = forked();
  same.commit("cell/C-001", { "b.txt": "same", "x.txt": "1" }, "c1");
  same.commit("main", { "b.txt": "same", "m.txt": "1" }, "m1");
  assert.equal((await same.mergeBranch("o/r", "cell/C-001", "main", "m")).status, "merged");
  assert.equal(same.file("cell/C-001", "b.txt"), "same");

  const del = forked();
  del.commit("cell/C-001", { "a.txt": "edited" }, "c1");
  del.commit("main", { "a.txt": null }, "m1");
  assert.deepEqual(await del.mergeBranch("o/r", "cell/C-001", "main", "m"), { status: "conflict", files: ["a.txt"] });
});
