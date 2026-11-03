// apply_changes: append op, trailers on WIP commits, safe retry after a lost response.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import * as engine from "../src/engine.ts";
import type { EngineOptions } from "../src/engine.ts";
import { parseTrailers } from "../src/trailers.ts";
import { FakeGitHub } from "./fakegh.ts";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = "o/r";

beforeEach(() => engine.clearPlanCache());

function seed(): FakeGitHub {
  const fx = new FakeGitHub();
  const files: Record<string, string> = { "blueprint.yaml": readFileSync(join(here, "example/blueprint.yaml"), "utf-8") };
  for (const f of readdirSync(join(here, "example/cells"))) files[`cells/${f}`] = readFileSync(join(here, "example/cells", f), "utf-8");
  fx.commit("main", files, "plan");
  return fx;
}

function opts(fx: FakeGitHub): EngineOptions {
  let n = 0;
  return { mainBranch: "main", historyPages: 5, now: () => fx.clock, sleep: async (ms) => { fx.tick(ms); }, uuid: () => `u${++n}` };
}

const base7 = (text: string) => /base=([0-9a-f]{7})/.exec(text)![1];
const claim = (fx: FakeGitHub) => engine.nextCell(fx, REPO, opts(fx), "claim");
const apply = (fx: FakeGitHub, base: string, ops: engine.Op[], message = "add files", next = "write the tests") =>
  engine.applyChanges(fx, REPO, opts(fx), { cell_id: "C-000", base, message, next, ops });
const tipOf = (fx: FakeGitHub) => fx.refs.get("cell/C-000")!;

test("append creates a file, then appends to an existing one", async () => {
  const fx = seed();
  let out = await apply(fx, base7(await claim(fx)), [{ path: "pyproject.toml", append: "one\n" }]);
  assert.match(out, /^ok /);
  assert.equal(fx.file("cell/C-000", "pyproject.toml"), "one\n");
  out = await apply(fx, base7(out), [{ path: "pyproject.toml", append: "two\n" }]);
  assert.match(out, /^ok /);
  assert.equal(fx.file("cell/C-000", "pyproject.toml"), "one\ntwo\n");
});

test("two appends on one path in one call accumulate in order", async () => {
  const fx = seed();
  const out = await apply(fx, base7(await claim(fx)), [
    { path: "pyproject.toml", append: "a" },
    { path: "pyproject.toml", append: "b" },
    { path: "pyproject.toml", append: "c" },
  ]);
  assert.match(out, /^ok [0-9a-f]{7} 1 file /);
  assert.equal(fx.file("cell/C-000", "pyproject.toml"), "abc");
});

test("append mixed with content on one op is rejected", async () => {
  const fx = seed();
  const base = base7(await claim(fx));
  const out = await apply(fx, base, [{ path: "pyproject.toml", content: "x", append: "y" }]);
  assert.match(out, /^REJECTED/);
  assert.match(out, /give exactly one of content \| old\+new \| delete \| append/);
  assert.equal(tipOf(fx).startsWith(base), true);
});

test("size limits apply to the final file: 150 KB + 100 KB over two calls works, one 250 KB op is TOO_LARGE", async () => {
  const fx = seed();
  let out = await apply(fx, base7(await claim(fx)), [{ path: "pyproject.toml", append: "a".repeat(150_000) }]);
  assert.match(out, /^ok /);
  const base = base7(out);
  out = await apply(fx, base, [{ path: "pyproject.toml", append: "b".repeat(100_000) }]);
  assert.match(out, /^TOO_LARGE pyproject.toml: 250000 bytes/);
  out = await apply(fx, base, [{ path: "tests/conftest.py", append: "b".repeat(100_000) }]);
  assert.match(out, /^ok /);
  assert.equal(fx.file("cell/C-000", "pyproject.toml")!.length, 150_000);
  const fx2 = seed();
  assert.match(await apply(fx2, base7(await claim(fx2)), [{ path: "pyproject.toml", append: "a".repeat(250_000) }]), /^TOO_LARGE/);
});

test("WIP commits keep attempt: of the previous tip and carry the new next:", async () => {
  const fx = seed();
  const base = base7(await claim(fx));
  // a previous tip that already has attempt: 2
  const prev = fx.commit("cell/C-000", { "tests/__init__.py": "" }, "resume(C-000): lock\n\nnext: old step\nattempt: 2");
  void prev;
  const out = await apply(fx, tipOf(fx).slice(0, 7), [{ path: "pyproject.toml", content: "x" }], "work", "new step");
  assert.match(out, /^ok /);
  const t = parseTrailers(fx.commits.get(tipOf(fx))!.message);
  assert.equal(t.attempt, 2);
  assert.equal(t.next, "new step");
  assert.match(t.req ?? "", /^[0-9a-f]{12}$/);
  void base;
});

test("lost response: the identical call with the old base is 'already applied' and writes nothing", async () => {
  const fx = seed();
  const base = base7(await claim(fx));
  const ops = [{ path: "pyproject.toml", content: "x" }];
  const first = await apply(fx, base, ops);
  assert.match(first, /^ok /);
  const tip = tipOf(fx);
  const commits = fx.commits.size;
  const again = await apply(fx, base, ops);
  assert.equal(again, `ok ${tip.slice(0, 7)} (already applied) (next base=${tip.slice(0, 7)})`);
  assert.equal(tipOf(fx), tip);
  assert.equal(fx.commits.size, commits);
});

test("same old base but different ops after a takeover: CONFLICT with the tip subject", async () => {
  const fx = seed();
  const base = base7(await claim(fx));
  assert.match(await apply(fx, base, [{ path: "pyproject.toml", content: "x" }]), /^ok /);
  fx.commit("cell/C-000", {}, "takeover(C-000): lock u9");
  const out = await apply(fx, base, [{ path: "pyproject.toml", content: "different" }]);
  assert.match(out, /^CONFLICT C-000/);
  assert.match(out, /tip: takeover\(/);
  // even the identical call is a conflict now: the tip is no longer our commit
  assert.match(await apply(fx, base, [{ path: "pyproject.toml", content: "x" }]), /tip: takeover\(/);
});
