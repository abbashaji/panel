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
