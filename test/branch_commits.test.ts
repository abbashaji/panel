import test from "node:test";
import assert from "node:assert/strict";
import { FakeGitHub } from "./fakegh.ts";

test("branchCommits: newest first", async () => {
  const gh = new FakeGitHub();
  gh.commit("main", { "a.txt": "1" }, "second");
  gh.commit("main", { "a.txt": "2" }, "third");
  const r = (await gh.branchCommits("o/r", "main", 1, 100))!;
  assert.deepEqual(r.map((c) => c.message), ["third", "second", "init"]);
  assert.equal(r[0].oid, gh.refs.get("main"));
  assert.ok(r[0].treeOid);
});

test("branchCommits: paging over 250 commits", async () => {
  const gh = new FakeGitHub();
  for (let i = 1; i < 250; i++) gh.commit("main", { "a.txt": String(i) }, `c${i}`);
  const p1 = (await gh.branchCommits("o/r", "main", 1, 100))!;
  const p2 = (await gh.branchCommits("o/r", "main", 2, 100))!;
  const p3 = (await gh.branchCommits("o/r", "main", 3, 100))!;
  assert.equal(p1.length, 100);
  assert.equal(p2.length, 100);
  assert.equal(p3.length, 50);
  assert.equal(p1[0].message, "c249");
  assert.equal(p3[49].message, "init");
  assert.equal(new Set([...p1, ...p2, ...p3].map((c) => c.oid)).size, 250);
  assert.deepEqual(await gh.branchCommits("o/r", "main", 4, 100), []);
});

test("branchCommits: unknown branch -> null", async () => {
  assert.equal(await new FakeGitHub().branchCommits("o/r", "nope", 1, 10), null);
});

test("branchCommits: a branch created from main lists main's older commits after its own", async () => {
  const gh = new FakeGitHub();
  gh.commit("main", { "a.txt": "1" }, "m2");
  gh.commit("cell/C-001", { "b.txt": "1" }, "lock");
  gh.commit("cell/C-001", { "b.txt": "2" }, "work");
  const r = (await gh.branchCommits("o/r", "cell/C-001", 1, 100))!;
  assert.deepEqual(r.map((c) => c.message), ["work", "lock", "m2", "init"]);
});
