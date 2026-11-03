// Engine tests against an in-memory GitHub that enforces GitHub's atomicity rules (see fakegh.ts).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import * as engine from "../src/engine.ts";
import type { EngineOptions } from "../src/engine.ts";
import { ApiError } from "../src/api.ts";
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

function opts(fx: FakeGitHub, over: Partial<EngineOptions> = {}): EngineOptions {
  let n = 0;
  return {
    mainBranch: "main",
    historyPages: 5,
    now: () => fx.clock,
    sleep: async (ms) => {
      fx.tick(ms);
    },
    uuid: () => `u${++n}`,
    ...over,
  };
}

const base7 = (text: string) => /base=([0-9a-f]{7})/.exec(text)![1];
const claim = (fx: FakeGitHub, o = opts(fx)) => engine.nextCell(fx, REPO, o, "claim");
const apply = (fx: FakeGitHub, id: string, base: string, ops: engine.Op[], extra: Record<string, string> = {}) =>
  engine.applyChanges(fx, REPO, opts(fx), { cell_id: id, base, message: "add files", next: "write the tests", ops, ...extra });

// =============================================================== next_cell
test("a fresh project hands out the skeleton cell with its rules and a lock branch", async () => {
  const fx = seed();
  const out = await claim(fx);
  assert.match(out, /^CLAIMED C-000 base=[0-9a-f]{7} repo=o\/r \(lease 15 min/);
  assert.match(out, /id: C-000/);
  assert.match(out, /allowed_paths:/);
  assert.match(out, /\nRULES\n/);
  assert.doesNotMatch(out, /lease_minutes|priority/); // trimmed
  const branch = fx.refs.get("cell/C-000")!;
  assert.equal(base7(out), branch.slice(0, 7));
  assert.equal(fx.commits.get(branch)!.tree, fx.commits.get(fx.refs.get("main")!)!.tree); // lock commit changes nothing
  assert.equal(fx.commits.get(branch)!.parent, fx.refs.get("main"));
});

test("while the skeleton runs, nobody else gets anything and the reason is explained", async () => {
  const fx = seed();
  await claim(fx);
  const out = await claim(fx);
  assert.match(out, /^NONE_READY/);
  assert.match(out, /running: C-000\(15m\)/); // rule changed (task 01c): the skeleton is critical, so its lease is 15 min
  assert.match(out, /waiting: .*C-001<-C-000/);
});

test("after the skeleton merges, independent cells are handed to different chats in parallel", async () => {
  const fx = seed();
  const first = await claim(fx);
  assert.match(first, /CLAIMED C-000/);
  fx.commit("cell/C-000", { "pyproject.toml": "x" }, "WIP");
  fx.mergeCell("C-000");
  const a = await claim(fx);
  const b = await claim(fx);
  const c = await claim(fx);
  assert.match(a, /CLAIMED C-001/);
  assert.match(b, /CLAIMED C-002/);
  assert.match(c, /^NONE_READY/);
  assert.match(c, /running: C-001\(60m\), C-002\(60m\)/);
});

test("ready_cells (peek) never creates a branch", async () => {
  const fx = seed();
  const out = await engine.nextCell(fx, REPO, opts(fx), "peek");
  assert.equal(out, "READY C-000[critical]\n(take the first)"); // rule changed (task 01c): skeletons are critical like any cell
  assert.equal([...fx.refs.keys()].filter((k) => k.startsWith("cell/")).length, 0);
});

test("two chats asking at the same instant: exactly one wins the cell", async () => {
  const fx = seed();
  const [a, b] = await Promise.all([claim(fx), claim(fx)]);
  const results = [a, b];
  assert.equal(results.filter((r) => r.startsWith("CLAIMED C-000")).length, 1, results.join("\n---\n"));
  assert.equal(results.filter((r) => r.startsWith("CLAIM_FAILED")).length, 1, results.join("\n---\n"));
  assert.equal([...fx.refs.keys()].filter((k) => k.startsWith("cell/")).length, 1);
});

test("a dead chat's cell is resumed from its last commit after the lease expires", async () => {
  const fx = seed();
  const first = await claim(fx);
  const ok = await apply(fx, "C-000", base7(first), [{ path: "pyproject.toml", content: "[project]\n" }], { next: "write tests/conftest.py" });
  assert.match(ok, /^ok [0-9a-f]{7} 1 file/);
  fx.tick(14 * 60000); // rule changed (task 01c): the skeleton is critical, lease 15 min instead of 60
  assert.match(await claim(fx), /^NONE_READY/); // still alive
  fx.tick(2 * 60000);
  const resumed = await claim(fx);
  assert.match(resumed, /^RESUME C-000 base=[0-9a-f]{7} repo=o\/r on cell\/C-000/);
  assert.match(resumed, /next: write tests\/conftest\.py/);
  assert.match(resumed, /Files already changed \(1\): pyproject\.toml/);
  assert.match(resumed, /\nRULES\n/);
  assert.notEqual(base7(resumed), base7(first));
});

test("two chats racing for the same dead cell: exactly one takes it over", async () => {
  const fx = seed();
  await claim(fx);
  fx.tick(61 * 60000);
  const [a, b] = await Promise.all([claim(fx), claim(fx)]);
  const results = [a, b];
  assert.equal(results.filter((r) => r.startsWith("RESUME C-000")).length, 1, results.join("\n---\n"));
  assert.equal(results.filter((r) => /^(CLAIM_FAILED|NONE_READY)/.test(r)).length, 1, results.join("\n---\n"));
});

test("a chat that is only waiting for CI keeps its cell, a hung run does not", async () => {
  const fx = seed();
  await claim(fx);
  fx.tick(61 * 60000);
  const tip = fx.refs.get("cell/C-000");
  fx.addRun("cell-gate.yml", "gate cell/C-000", "in_progress", null, 5);
  const waiting = await claim(fx);
  assert.match(waiting, /^NONE_READY/);
  assert.match(waiting, /C-000\(CI<=40m\)/);
  assert.equal(fx.refs.get("cell/C-000"), tip); // nothing was taken over
  fx.runs.length = 0;
  fx.addRun("cell-gate.yml", "gate cell/C-000", "in_progress", null, 50);
  assert.match(await claim(fx), /^RESUME C-000/);
});

test("if workflow runs cannot be read, the commit lease decides and the agent is told", async () => {
  const fx = seed();
  await claim(fx);
  fx.tick(61 * 60000);
  fx.failNext.activeRuns = new ApiError("boom", 500);
  const out = await claim(fx);
  assert.match(out, /^RESUME C-000/);
  assert.match(out, /WARN: could not read workflow runs \(boom\)/);
});

test("workflow runs are only requested when an expired lease could be handed out", async () => {
  const fx = seed();
  await claim(fx);
  fx.calls.length = 0;
  await claim(fx); // lease alive
  assert.ok(!fx.calls.includes("activeRuns"));
  fx.tick(61 * 60000);
  fx.calls.length = 0;
  await claim(fx);
  assert.ok(fx.calls.includes("activeRuns"));
});

test("a cell merged beyond the history window is never handed out again", async () => {
  const fx = seed();
  await claim(fx);
  fx.commit("cell/C-000", { "pyproject.toml": "x" }, "WIP");
  await fx.createPr(REPO, { title: "cell(C-000): s", head: "cell/C-000", base: "main", body: "" });
  fx.mergeCell("C-000");
  for (let i = 0; i < 130; i++) fx.commit("main", { [`filler${i}.txt`]: "x" }, `filler ${i}`);
  const out = await claim(fx, opts(fx, { historyPages: 1 }));
  assert.match(out, /^CLAIMED C-001/, out);
});

test("an invalid plan stops everything with a short list of reasons", async () => {
  const fx = seed();
  fx.commit("main", { "cells/C-003.yaml": "id: C-003\ntitle: x\n" }, "break");
  const out = await claim(fx);
  assert.match(out, /^INVALID_PLAN/);
  assert.match(out, /C-003: missing 'goal'/);
  assert.equal([...fx.refs.keys()].filter((k) => k.startsWith("cell/")).length, 0);
});

test("a connector configured for another main branch refuses to run", async () => {
  const fx = seed();
  fx.commit("main", { "blueprint.yaml": "main_branch: trunk\n" }, "cfg");
  const out = await claim(fx);
  assert.match(out, /main_branch is 'trunk' but this connector is configured for 'main'/);
});

test("when everything is merged: ALL_DONE", async () => {
  const fx = seed();
  for (const id of ["C-000", "C-001", "C-002", "C-003", "C-004", "C-005"]) fx.commit("main", { [`d/${id}`]: "x" }, `cell(${id}): done (#1)`);
  assert.equal(await claim(fx), "ALL_DONE: every cell is merged.");
});

test("the parsed plan is cached per main commit", async () => {
  const fx = seed();
  const o = opts(fx);
  const s1 = await fx.snapshot(REPO, "main", 1);
  const s2 = await fx.snapshot(REPO, "main", 1);
  assert.equal(engine.loadPlan(REPO, s1, o), engine.loadPlan(REPO, s2, o));
  fx.commit("main", { "docs/x": "y" }, "other");
  assert.notEqual(engine.loadPlan(REPO, await fx.snapshot(REPO, "main", 1), o), engine.loadPlan(REPO, s1, o));
});

// =============================================================== takeover
test("takeover: unknown, not running, done", async () => {
  const fx = seed();
  const o = opts(fx);
  assert.equal(await engine.takeoverCell(fx, REPO, o, "C-077", false), "UNKNOWN_CELL C-077");
  assert.match(await engine.takeoverCell(fx, REPO, o, "C-000", false), /^NOT_RUNNING C-000/);
  fx.commit("main", { x: "y" }, "cell(C-000): done (#1)");
  assert.equal(await engine.takeoverCell(fx, REPO, o, "C-000", false), "ALREADY_DONE C-000");
});

test("takeover is refused while CI runs unless forced; success returns the cell to resume", async () => {
  const fx = seed();
  await claim(fx);
  fx.addRun("cell-preflight.yml", "preflight C-000", "queued", null, 2);
  const o = opts(fx);
  assert.match(await engine.takeoverCell(fx, REPO, o, "C-000", false), /^CI_RUNNING C-000/);
  const forced = await engine.takeoverCell(fx, REPO, o, "C-000", true);
  assert.match(forced, /^RESUME C-000 base=/);
});

test("takeover without CI is immediate even though the lease is alive", async () => {
  const fx = seed();
  await claim(fx);
  assert.match(await engine.takeoverCell(fx, REPO, opts(fx), "C-000", false), /^RESUME C-000/);
});

// =============================================================== apply_changes
test("apply_changes needs a claimed cell and a valid base", async () => {
  const fx = seed();
  assert.match(await apply(fx, "C-000", "abcdef0", [{ path: "pyproject.toml", content: "x" }]), /^NOT_CLAIMED C-000/);
  await claim(fx);
  assert.match(await apply(fx, "C-000", "", [{ path: "pyproject.toml", content: "x" }]), /^MISSING_BASE/);
  assert.match(await apply(fx, "C-000", "zzzzzzz", [{ path: "pyproject.toml", content: "x" }]), /^MISSING_BASE/);
});

test("several files in one call become ONE commit with WIP: and next:", async () => {
  const fx = seed();
  const base = base7(await claim(fx));
  const before = fx.commits.size;
  const out = await apply(fx, "C-000", base, [
    { path: "pyproject.toml", content: "[project]\n" },
    { path: "src/app/__init__.py", content: "" },
    { path: "tests/conftest.py", content: "# c\n" },
  ], { message: "skeleton files", next: "add tests/__init__.py" });
  assert.match(out, /^ok [0-9a-f]{7} 3 files \(next base=[0-9a-f]{7}\)/);
  const tip = fx.commits.get(fx.refs.get("cell/C-000")!)!;
  assert.ok(tip.message.startsWith("WIP: skeleton files\n\nnext: add tests/__init__.py"));
  assert.equal(parseTrailers(tip.message).next, "add tests/__init__.py");
  assert.equal(fx.file("cell/C-000", "pyproject.toml"), "[project]\n");
  assert.equal(fx.file("main", "pyproject.toml"), undefined); // main is never touched
  assert.equal(fx.commits.size - before, 1); // exactly one commit for the whole call
  assert.equal(base7(out), tip.oid.slice(0, 7));
});

test("each ok returns the base for the next call; chained calls work", async () => {
  const fx = seed();
  let base = base7(await claim(fx));
  for (const [path, body] of [["pyproject.toml", "a"], ["tests/conftest.py", "b"], ["tests/__init__.py", ""]]) {
    const out = await apply(fx, "C-000", base, [{ path, content: body }]);
    assert.match(out, /^ok /);
    base = /next base=([0-9a-f]{7})/.exec(out)![1];
  }
  assert.equal(fx.refs.get("cell/C-000")!.slice(0, 7), base);
});

test("edits replace exactly one occurrence and see earlier ops of the same call", async () => {
  const fx = seed();
  let base = base7(await claim(fx));
  let out = await apply(fx, "C-000", base, [{ path: "pyproject.toml", content: "name = 'a'\nversion = '1'\n" }]);
  base = /next base=([0-9a-f]{7})/.exec(out)![1];
  out = await apply(fx, "C-000", base, [
    { path: "pyproject.toml", old: "name = 'a'", new: "name = 'b'" },
    { path: "pyproject.toml", old: "name = 'b'\nversion", new: "name = 'c'\nversion" },
  ]);
  assert.match(out, /^ok /);
  assert.equal(fx.file("cell/C-000", "pyproject.toml"), "name = 'c'\nversion = '1'\n");
  base = /next base=([0-9a-f]{7})/.exec(out)![1];
  const tip = fx.refs.get("cell/C-000");
  assert.match(await apply(fx, "C-000", base, [{ path: "pyproject.toml", old: "zzz", new: "y" }]), /^EDIT_FAILED pyproject\.toml: old text not found/);
  assert.match(await apply(fx, "C-000", base, [{ path: "pyproject.toml", old: "'", new: "\"" }]), /occurs 4 times/);
  assert.match(await apply(fx, "C-000", base, [{ path: "tests/conftest.py", old: "a", new: "b" }]), /file does not exist/);
  assert.equal(fx.refs.get("cell/C-000"), tip); // failed edits commit nothing
});

test("replacement text is inserted literally ($& and friends are not special)", async () => {
  const fx = seed();
  let base = base7(await claim(fx));
  const out = await apply(fx, "C-000", base, [{ path: "pyproject.toml", content: "price = X\n" }]);
  base = /next base=([0-9a-f]{7})/.exec(out)![1];
  await apply(fx, "C-000", base, [{ path: "pyproject.toml", old: "X", new: "$& $1 $$" }]);
  assert.equal(fx.file("cell/C-000", "pyproject.toml"), "price = $& $1 $$\n");
});

test("files can be deleted inside allowed paths", async () => {
  const fx = seed();
  let base = base7(await claim(fx));
  let out = await apply(fx, "C-000", base, [{ path: "tests/conftest.py", content: "x" }]);
  base = /next base=([0-9a-f]{7})/.exec(out)![1];
  out = await apply(fx, "C-000", base, [{ path: "tests/conftest.py", delete: true }]);
  assert.match(out, /^ok /);
  assert.equal(fx.file("cell/C-000", "tests/conftest.py"), undefined);
});

test("paths outside the cell, protected files and sneaky paths are rejected without writing anything", async () => {
  const fx = seed();
  const base = base7(await claim(fx));
  const tip = fx.refs.get("cell/C-000");
  const bad: [string, RegExp][] = [
    ["src/app/db/users.py", /outside allowed_paths: src\/app\/db\/users\.py/],
    ["cells/C-000.yaml", /protected: cells\/C-000\.yaml/],
    [".github/workflows/cell-gate.yml", /protected: \.github\/workflows\/cell-gate\.yml/],
    ["tools/x.py", /protected: tools\/x\.py/],
    ["blueprint.yaml", /protected: blueprint\.yaml/],
    ["../etc/passwd", /bad path/],
    ["src/../cells/C-000.yaml", /bad path/],
    ["/abs/path", /bad path/],
    [".git/config", /bad path/],
    ["a\\b", /bad path/],
    ["", /bad path/],
  ];
  for (const [path, re] of bad) {
    const out = await apply(fx, "C-000", base, [{ path: "pyproject.toml", content: "ok" }, { path, content: "x" }]);
    assert.match(out, /^REJECTED \(nothing committed\)/, path);
    assert.match(out, re, path);
    assert.match(out, /allowed_paths: pyproject\.toml/);
  }
  assert.equal(fx.refs.get("cell/C-000"), tip);
});

test("ambiguous or malformed operations are rejected", async () => {
  const fx = seed();
  const base = base7(await claim(fx));
  assert.match(await apply(fx, "C-000", base, [{ path: "pyproject.toml", content: "a", delete: true }]), /exactly one of content \| old\+new \| delete/);
  assert.match(await apply(fx, "C-000", base, [{ path: "pyproject.toml" }]), /exactly one of/);
  assert.match(await apply(fx, "C-000", base, [{ path: "pyproject.toml", old: "", new: "x" }]), /non-empty old and new/);
  assert.match(await apply(fx, "C-000", base, []), /^NOTHING_TO_COMMIT/);
  assert.match(await apply(fx, "C-000", base, Array.from({ length: 31 }, (_, i) => ({ path: `tests/f${i}.py`, content: "x" }))), /^TOO_MANY_OPS/);
  assert.match(await apply(fx, "C-000", base, [{ path: "pyproject.toml", content: "x" }], { next: "" }), /^MISSING_NEXT/);
  assert.match(await apply(fx, "C-000", base, [{ path: "pyproject.toml", content: "x" }], { message: "  " }), /^MISSING_MESSAGE/);
  assert.match(await apply(fx, "C-0", base, [{ path: "pyproject.toml", content: "x" }]), /^BAD_CELL_ID/);
});

test("size limits protect the API and the context", async () => {
  const fx = seed();
  const base = base7(await claim(fx));
  assert.match(await apply(fx, "C-000", base, [{ path: "pyproject.toml", content: "x".repeat(200_001) }]), /^TOO_LARGE pyproject\.toml/);
  const out = await apply(fx, "C-000", base, ["pyproject.toml", "tests/__init__.py", "tests/conftest.py"].map((path) => ({ path, content: "x".repeat(150_000) })));
  assert.match(out, /^TOO_LARGE: 450000 bytes in one call/);
});

test("multi-line commit messages and next: are collapsed to one line each", async () => {
  const fx = seed();
  const base = base7(await claim(fx));
  await apply(fx, "C-000", base, [{ path: "pyproject.toml", content: "x" }], { message: "first\nsecond   line", next: "step one\n\nstep two" });
  const msg = fx.commits.get(fx.refs.get("cell/C-000")!)!.message;
  assert.ok(msg.startsWith("WIP: first second line\n\nnext: step one step two"));
  assert.equal(parseTrailers(msg).next, "step one step two");
});

test("FENCING: after a takeover the previous owner cannot write, the new owner can", async () => {
  const fx = seed();
  const a = await claim(fx); // chat A
  const baseA = base7(a);
  let out = await apply(fx, "C-000", baseA, [{ path: "pyproject.toml", content: "from A" }]);
  const baseA2 = /next base=([0-9a-f]{7})/.exec(out)![1];
  fx.tick(61 * 60000);
  const b = await claim(fx); // chat B takes over
  assert.match(b, /^RESUME C-000/);
  const baseB = base7(b);
  const tipB = fx.refs.get("cell/C-000");

  out = await apply(fx, "C-000", baseA2, [{ path: "pyproject.toml", content: "A is back and overwrites" }]);
  assert.match(out, /^CONFLICT C-000/);
  assert.match(out, /taken over/);
  assert.equal(fx.refs.get("cell/C-000"), tipB);
  assert.equal(fx.file("cell/C-000", "pyproject.toml"), "from A"); // B's starting point is intact

  out = await apply(fx, "C-000", baseB, [{ path: "pyproject.toml", content: "from B" }]);
  assert.match(out, /^ok /);
  assert.equal(fx.file("cell/C-000", "pyproject.toml"), "from B");
});

test("a write racing with a takeover that lands between read and update is refused by the non-force update", async () => {
  const fx = seed();
  const base = base7(await claim(fx));
  // move the branch after apply_changes has read the snapshot but before it updates the ref
  const original = fx.commitFiles.bind(fx);
  fx.commitFiles = async (...args) => {
    const oid = await original(...args);
    fx.commit("cell/C-000", { "tests/other.py": "intruder" }, "intruder");
    return oid;
  };
  const out = await apply(fx, "C-000", base, [{ path: "pyproject.toml", content: "mine" }]);
  assert.match(out, /^CONFLICT C-000: .* moved while you were writing/);
  assert.equal(fx.file("cell/C-000", "pyproject.toml"), undefined);
});

test("a merged-and-deleted branch is reported as NOT_CLAIMED, never silently recreated", async () => {
  const fx = seed();
  const base = base7(await claim(fx));
  fx.commit("cell/C-000", { "pyproject.toml": "x" }, "w");
  fx.mergeCell("C-000");
  assert.match(await apply(fx, "C-000", base, [{ path: "pyproject.toml", content: "y" }]), /^NOT_CLAIMED C-000/);
  assert.equal(fx.refs.has("cell/C-000"), false);
});

test("API errors while committing come back as text, not exceptions", async () => {
  const fx = seed();
  const base = base7(await claim(fx));
  fx.failNext.commitFiles = new ApiError("create tree: 422 invalid", 422);
  assert.match(await apply(fx, "C-000", base, [{ path: "pyproject.toml", content: "x" }]), /^ERROR: could not create the commit: create tree: 422 invalid/);
});

// =============================================================== read_files
async function withConftest(): Promise<FakeGitHub> {
  const fx = seed();
  const base = base7(await claim(fx));
  const body = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n") + "\n";
  await apply(fx, "C-000", base, [{ path: "tests/conftest.py", content: body }]);
  return fx;
}
const read = (fx: FakeGitHub, args: Parameters<typeof engine.readFiles>[3]) => engine.readFiles(fx, REPO, opts(fx), args);

test("read_files: whole file, line ranges, and the line count header", async () => {
  const fx = await withConftest();
  let out = await read(fx, { cell_id: "C-000", files: [{ path: "tests/conftest.py" }] });
  assert.match(out, /^--- tests\/conftest\.py \(10 lines\)\nline1\n/);
  assert.match(out, /line10$/);
  out = await read(fx, { cell_id: "C-000", files: [{ path: "tests/conftest.py", start: 3, end: 4 }] });
  assert.equal(out, "--- tests/conftest.py (10 lines, lines 3-4)\nline3\nline4");
});

test("read_files: max_lines truncates with a clear hint and is shared across files", async () => {
  const fx = await withConftest();
  const out = await read(fx, { cell_id: "C-000", max_lines: 4, files: [{ path: "tests/conftest.py" }, { path: "cells/C-000.yaml" }] });
  assert.match(out, /lines 1-4\)\nline1\nline2\nline3\nline4\n\[TRUNCATED at line 4 of 10/);
  assert.match(out, /--- cells\/C-000\.yaml \(\d+ lines, lines 1-0\)/);
});

test("read_files: falls back to main for files the branch does not have; missing files are named", async () => {
  const fx = await withConftest();
  const out = await read(fx, { cell_id: "C-000", files: [{ path: "README.md" }, { path: "nope.py" }] });
  assert.match(out, /^--- README\.md \(1 lines\)\nx/);
  assert.match(out, /NOT_FOUND nope\.py/);
  const mainOnly = await read(fx, { files: [{ path: "README.md" }] });
  assert.match(mainOnly, /--- README\.md/);
});

test("read_files: directory listings, root listing, and path rejection", async () => {
  const fx = await withConftest();
  let out = await read(fx, { cell_id: "C-000", files: [{ path: "tests/" }] });
  assert.equal(out, "--- tests (1 entries)\nconftest.py");
  out = await read(fx, { cell_id: "C-000", files: [{ path: "" }] });
  assert.match(out, /--- \/ /);
  assert.match(out, /cells\//);
  out = await read(fx, { files: [{ path: "../x" }, { path: "/etc/passwd" }, { path: ".git/HEAD" }] });
  assert.equal(out.split("\n").filter((l) => l.startsWith("REJECTED path")).length, 3);
  assert.match(await read(fx, { files: [{ path: "a" }], cell_id: "nope" }), /^BAD_CELL_ID/);
  assert.match(await read(fx, { files: Array.from({ length: 13 }, (_, i) => ({ path: `f${i}` })) }), /^TOO_MANY_FILES/);
  assert.equal(await read(fx, { files: [] }), "NOTHING_TO_READ");
});

test("read_files: a start beyond the end is explained", async () => {
  const fx = await withConftest();
  const out = await read(fx, { cell_id: "C-000", files: [{ path: "tests/conftest.py", start: 99 }] });
  assert.match(out, /start is beyond the end of the file/);
});

// =============================================================== submit_cell
const submit = (fx: FakeGitHub, id = "C-000", summary = "did it") => engine.submitCell(fx, REPO, opts(fx), { cell_id: id, summary });

test("submit_cell opens the PR with the exact title the gate expects", async () => {
  const fx = await withConftest();
  const out = await submit(fx);
  assert.equal(out, "PR #1 opened (1 files); call ci_result");
  const pr = fx.prs[0];
  assert.equal(pr.title, "cell(C-000): Project skeleton");
  assert.equal(pr.branch, "cell/C-000");
  assert.equal(pr.body, "did it");
});

test("submit_cell is idempotent while the PR is open, and refuses empty or unclaimed work", async () => {
  const fx = await withConftest();
  await submit(fx);
  assert.equal(await submit(fx), "PR #1 already open; call ci_result");
  assert.equal(fx.prs.length, 1);
  assert.match(await submit(fx, "C-001"), /^NOT_CLAIMED C-001/);
  const fx2 = seed();
  await claim(fx2);
  assert.match(await submit(fx2), /^NOTHING_TO_SUBMIT C-000/);
  assert.match(await submit(fx2, "C-077"), /^UNKNOWN_CELL C-077/);
});

test("submit_cell survives a double-submit race", async () => {
  const fx = await withConftest();
  const [a, b] = await Promise.all([submit(fx), submit(fx)]);
  assert.equal(fx.prs.length, 1);
  assert.ok([a, b].every((t) => /^PR #1 (opened|already open)/.test(t)), `${a} | ${b}`);
});

test("submit_cell reports API failures as text", async () => {
  const fx = await withConftest();
  fx.failNext.createPr = new ApiError("create pull request: 403 forbidden", 403);
  assert.match(await submit(fx), /^ERROR: could not open the pull request: create pull request: 403 forbidden/);
});

// =============================================================== preflight
test("preflight dispatches the dry-run workflow on main with the cell id", async () => {
  const fx = await withConftest();
  const out = await engine.preflight(fx, REPO, opts(fx), "C-000");
  assert.match(out, /^started preflight C-000/);
  assert.deepEqual(fx.dispatched, [{ workflow: "cell-preflight.yml", ref: "main", inputs: { cell_id: "C-000" } }]);
  assert.match(await engine.preflight(fx, REPO, opts(fx), "C-001"), /^NOT_CLAIMED/);
  assert.match(await engine.preflight(fx, REPO, opts(fx), "x; rm -rf"), /^BAD_CELL_ID/);
  assert.equal(fx.dispatched.length, 1);
});

// =============================================================== ci_result
const ci = (fx: FakeGitHub, wait: number, o = opts(fx)) => engine.ciResult(fx, REPO, o, { cell_id: "C-000", wait_seconds: wait });

test("ci_result: nothing started", async () => {
  const fx = await withConftest();
  assert.match(await ci(fx, 0), /^NO_RUN C-000/);
});

test("ci_result waits for a run that appears a few seconds after the PR", async () => {
  const fx = await withConftest();
  await submit(fx);
  const t0 = fx.clock;
  let created = false;
  const o = opts(fx, {
    sleep: async (ms) => {
      fx.tick(ms);
      if (!created && fx.clock - t0 >= 10000) {
        created = true;
        fx.addRun("cell-gate.yml", "gate cell/C-000", "completed", "failure", 0, "FAIL C-000\n- acceptance failed (exit 2): pytest");
      }
    },
  });
  assert.equal(await ci(fx, 30, o), "FAIL C-000\n- acceptance failed (exit 2): pytest");
});

test("ci_result: still running -> PENDING with job progress, no endless waiting", async () => {
  const fx = await withConftest();
  await submit(fx);
  fx.tick(5000); // a gate run starts AFTER the commit it checks
  const run = fx.addRun("cell-gate.yml", "gate cell/C-000", "in_progress", null, 0);
  fx.jobs.set(run.id, { done: 3, total: 6 });
  const t0 = fx.clock;
  const out = await ci(fx, 12);
  assert.match(out, /^PENDING C-000 run \d+ \(gate, 3\/6 jobs done\)\. Do not poll in a loop/);
  assert.ok(fx.clock - t0 <= 15000, "waited only as long as asked");
});

test("ci_result: wait_seconds is capped at 90", async () => {
  const fx = await withConftest();
  fx.addRun("cell-gate.yml", "gate cell/C-000", "in_progress", null, 1);
  const t0 = fx.clock;
  await ci(fx, 9999);
  assert.ok(fx.clock - t0 <= 95000);
});

test("ci_result: PASS is reported with the merge state", async () => {
  const fx = await withConftest();
  await submit(fx);
  fx.tick(5000); // a gate run starts AFTER the commit it checks
  const run = fx.addRun("cell-gate.yml", "gate cell/C-000", "completed", "success", 0, "PASS C-000 (acceptance 1/1)\n");
  let out = await ci(fx, 0);
  assert.equal(out, "PASS C-000 (acceptance 1/1)\nMERGE_PENDING: checks passed, GitHub merges within seconds. Call ci_result once more.");
  fx.mergeCell("C-000");
  out = await ci(fx, 0);
  assert.equal(out, "MERGED #1: C-000 is done.");
  assert.ok(run.id);
});

test("ci_result: a run that finishes during the wait is returned in the same call", async () => {
  const fx = await withConftest();
  await submit(fx);
  fx.tick(5000); // a gate run starts AFTER the commit it checks
  const run = fx.addRun("cell-gate.yml", "gate cell/C-000", "in_progress", null, 0);
  const t0 = fx.clock;
  const o = opts(fx, {
    sleep: async (ms) => {
      fx.tick(ms);
      if (fx.clock - t0 >= 10000 && run.status !== "completed") {
        run.status = "completed";
        run.conclusion = "success";
        fx.artifacts.set(run.id, "PASS C-000 (acceptance 2/2)");
        fx.mergeCell("C-000");
      }
    },
  });
  assert.equal(await ci(fx, 30, o), "PASS C-000 (acceptance 2/2)\nMERGED #1");
});

test("ci_result: a finished run without a result artifact is a failure with a link", async () => {
  const fx = await withConftest();
  fx.addRun("cell-gate.yml", "gate cell/C-000", "completed", "cancelled", 1);
  assert.match(await ci(fx, 0), /^FAIL C-000: run \d+ cancelled without a result \(pipeline error\)\. See https:\/\//);
});

test("ci_result: picks the newest of gate and preflight and ignores other cells", async () => {
  const fx = await withConftest();
  fx.addRun("cell-gate.yml", "gate cell/C-000", "completed", "failure", 30, "FAIL C-000 old gate");
  fx.addRun("cell-gate.yml", "gate cell/C-001", "completed", "success", 1, "PASS C-001");
  fx.addRun("cell-preflight.yml", "preflight C-000", "completed", "success", 0, "PASS C-000 (acceptance 1/1)");
  const out = await ci(fx, 0);
  assert.equal(out, "PASS C-000 (acceptance 1/1)\n(preflight only: nothing is merged)");
});

test("ci_result: a preflight older than the last commit is marked STALE", async () => {
  const fx = await withConftest();
  fx.addRun("cell-preflight.yml", "preflight C-000", "completed", "success", 5, "PASS C-000 (acceptance 1/1)");
  fx.tick(60000);
  fx.commit("cell/C-000", { "tests/more.py": "x" }, "WIP: newer");
  const out = await ci(fx, 0);
  assert.match(out, /^STALE: you committed after this preflight started/);
  assert.match(out, /PASS C-000/);
});

// =============================================================== repo policy
test("the connector only touches repositories it was configured for", () => {
  assert.deepEqual(engine.resolveRepo({ DEFAULT_REPO: "me/app" }), { repo: "me/app" });
  assert.deepEqual(engine.resolveRepo({ DEFAULT_REPO: "me/app" }, "ME/App"), { repo: "ME/App" });
  assert.deepEqual(engine.resolveRepo({ DEFAULT_REPO: "me/app", ALLOWED_REPOS: "me/other, me/third" }, "me/third"), { repo: "me/third" });
  assert.deepEqual(engine.resolveRepo({ DEFAULT_REPO: "me/app" }, "evil/repo"), { error: "REPO_NOT_ALLOWED evil/repo" });
  assert.deepEqual(engine.resolveRepo({ ALLOWED_REPOS: "me/*" }, "me/ocr2"), { repo: "me/ocr2" });
  assert.deepEqual(engine.resolveRepo({ ALLOWED_REPOS: "me/*" }, "other/ocr2"), { error: "REPO_NOT_ALLOWED other/ocr2" });
  assert.deepEqual(engine.resolveRepo({ ALLOWED_REPOS: "me/*" }, "mex/ocr2"), { error: "REPO_NOT_ALLOWED mex/ocr2" });
  assert.match((engine.resolveRepo({}, "me/app") as any).error, /^NOT_CONFIGURED/);
  assert.match((engine.resolveRepo({ DEFAULT_REPO: "me/app" }, "me/app/../x") as any).error, /^BAD_REPO/);
  assert.deepEqual(engine.resolveRepo({ ALLOWED_REPOS: "a/b" }), { repo: "a/b" }); // exactly one concrete repo: no need to pass it
  assert.match((engine.resolveRepo({ ALLOWED_REPOS: "a/b,a/c" }) as any).error, /^NO_REPO.*EVERY call/);
  assert.match((engine.resolveRepo({ ALLOWED_REPOS: "a/*" }) as any).error, /^NO_REPO/);
});

// =============================================================== zero-setup per repo
test("a repo without Blueprint: next_cell says so, init_blueprint installs the kit in ONE commit on main", async () => {
  const fx = new FakeGitHub(); // only README.md
  assert.match(await engine.nextCell(fx, "o/ocr2", opts(fx), "claim"), /^NOT_INITIALIZED/);
  const before = fx.commits.size;
  const out = await engine.initBlueprint(fx, "o/ocr2", opts(fx));
  assert.match(out, /^OK installed blueprint kit [0-9a-f]{8} \(13 files\)/);
  assert.equal(fx.commits.size - before, 1);
  assert.match(fx.file("main", "blueprint.yaml")!, /^project: ocr2$/m);
  assert.ok(fx.file("main", ".github/workflows/cell-gate.yml"));
  assert.ok(fx.file("main", "tools/cell_gate.py"));
  assert.equal(fx.file("main", "README.md"), "x\n"); // existing files untouched
  assert.match(await engine.nextCell(fx, "o/ocr2", opts(fx), "claim"), /^NO_PLAN/);
});

test("init_blueprint never overwrites an existing Blueprint", async () => {
  const fx = seed();
  const tip = fx.refs.get("main");
  assert.match(await engine.initBlueprint(fx, "o/r", opts(fx)), /^ALREADY_INITIALIZED/);
  assert.equal(fx.refs.get("main"), tip);
});

test("init_blueprint reports a refused update of main instead of claiming success", async () => {
  const fx = new FakeGitHub();
  const orig = fx.fastForward.bind(fx);
  fx.fastForward = async () => "not_ff" as const;
  assert.match(await engine.initBlueprint(fx, "o/r", opts(fx)), /^INIT_FAILED/);
  fx.fastForward = orig;
});

test("the embedded kit is identical to blueprint-kit (when it is next to this project)", async () => {
  const { KIT_FILES } = await import("../src/kit.ts");
  const kit = join(here, "../../blueprint-kit");
  if (!existsSync(kit)) return;
  for (const [p, c] of Object.entries(KIT_FILES)) assert.equal(readFileSync(join(kit, p), "utf-8"), c, `${p} differs: run python3 scripts/embed_kit.py ../blueprint-kit`);
});

// =============================================================== findings from the first live run
test("EMPTY repo: init_blueprint creates the first commit itself, then installs the kit", async () => {
  const fx = new FakeGitHub(true);
  assert.match(await engine.nextCell(fx, "o/kit", opts(fx), "claim"), /^EMPTY_REPO/);
  assert.match(await engine.initBlueprint(fx, "o/kit", opts(fx)), /^OK installed/);
  assert.ok(fx.file("main", "blueprint.yaml"));
});

test("STALE read: a lagging snapshot is re-read, never acted on", async () => {
  const fx = new FakeGitHub();
  fx.commit("main", { "blueprint.yaml": "project: p\n" }, "plan");
  await fx.snapshot("o/r", "main", 0); // remembered as 'the previous snapshot'
  await engine.initBlueprint(fx, "o/r", opts(fx)); // main moves on
  fx.staleSnapshots = 2;
  // replica still shows the old main for two reads: the second init must NOT reinstall, it must wait for the fresh one
  const before = fx.commits.size;
  assert.match(await engine.initBlueprint(fx, "o/r", opts(fx)), /^ALREADY_INITIALIZED/);
  assert.equal(fx.commits.size, before);
});

test("STALE read that never catches up is reported, not guessed", async () => {
  const fx = seed();
  await fx.snapshot("o/r", "main", 0);
  fx.commit("main", { "x.txt": "1" }, "moves on");
  fx.staleSnapshots = 99;
  assert.match(await engine.nextCell(fx, "o/r", opts(fx), "claim"), /^STALE_READ/);
  assert.equal(fx.refs.has("cell/C-000"), false); // nothing was claimed from stale data
});

const CELL = (id: string, dep = "", skeleton = false) =>
  `id: ${id}\ntitle: t\ngoal: g\n${skeleton ? "type: skeleton\n" : ""}${dep ? `inputs:\n  - from: ${dep}\n    kind: implementation\n    contract: c\n` : ""}provides:\n  - "src/${id}.py: def f()"\nallowed_paths: [src/${id}.py]\noutputs: [src/${id}.py]\nacceptance:\n  - cmd: "true"\n`;

test("publish_plan: adds validated cells to main in ONE commit; then next_cell hands one out", async () => {
  const fx = new FakeGitHub();
  await engine.initBlueprint(fx, "o/r", opts(fx));
  const before = fx.commits.size;
  const out = await engine.publishPlan(fx, "o/r", opts(fx), { cells: [{ id: "C-000", yaml: CELL("C-000", "", true) }, { id: "C-001", yaml: CELL("C-001", "C-000") }] });
  assert.match(out, /^OK published 2 cell\(s\): C-000, C-001/);
  assert.equal(fx.commits.size - before, 1);
  assert.match(await engine.nextCell(fx, "o/r", opts(fx), "claim"), /^CLAIMED C-000/);
});

test("publish_plan refuses to change an existing cell and refuses plans that would be invalid", async () => {
  const fx = seed();
  const tip = fx.refs.get("main");
  assert.match(await engine.publishPlan(fx, "o/r", opts(fx), { cells: [{ id: "C-000", yaml: "x" }] }), /^CELL_EXISTS C-000/);
  assert.match(await engine.publishPlan(fx, "o/r", opts(fx), { cells: [{ id: "C-900", yaml: CELL("C-900", "C-777") }] }), /^REJECTED \(nothing committed\)/);
  assert.match(await engine.publishPlan(fx, "o/r", opts(fx), { cells: [{ id: "bad", yaml: "" }] }), /^BAD_CELL_ID/);
  assert.equal(fx.refs.get("main"), tip);
  const empty = new FakeGitHub();
  assert.match(await engine.publishPlan(empty, "o/r", opts(empty), { cells: [{ id: "C-000", yaml: CELL("C-000") }] }), /^NOT_INITIALIZED/);
});

test("ci_result right after submit never shows a preflight or an older gate as the answer (live bug)", async () => {
  const fx = await withConftest();
  fx.addRun("cell-preflight.yml", "preflight C-000", "completed", "success", 0, "PASS C-000 (acceptance 1/1)");
  fx.tick(5000);
  await submit(fx); // PR open, the real gate has not started
  const out = await ci(fx, 0);
  assert.match(out, /^PENDING C-000: the merge gate for your PR #1 has not started yet/);
  assert.doesNotMatch(out, /preflight only/);
});

test("ci_result: a failed gate for OLDER code is not reported after a fix commit", async () => {
  const fx = await withConftest();
  await submit(fx);
  fx.tick(5000);
  fx.addRun("cell-gate.yml", "gate cell/C-000", "completed", "failure", 0, "FAIL C-000 old");
  fx.tick(60000);
  fx.commit("cell/C-000", { "tests/more.py": "x" }, "WIP: fix");
  assert.match(await ci(fx, 0), /^PENDING C-000: the merge gate/);
});

test("read_files refuses other cells' definitions but allows your own", async () => {
  const fx = seed();
  assert.match(await read(fx, { files: [{ path: "cells/C-001.yaml" }] }), /^OUT_OF_SCOPE/);
  assert.match(await read(fx, { cell_id: "C-000", files: [{ path: "cells/C-001.yaml" }] }), /^OUT_OF_SCOPE/);
  assert.match(await read(fx, { cell_id: "C-000", files: [{ path: "cells/C-000.yaml" }] }), /^--- cells\/C-000\.yaml/);
});

test("kit upgrade: refused without upgrade:true; with it only kit files change, never cells or blueprint.yaml", async () => {
  const fx = new FakeGitHub();
  await engine.initBlueprint(fx, "o/r", opts(fx));
  assert.match(await engine.initBlueprint(fx, "o/r", opts(fx)), /^ALREADY_INITIALIZED: kit [0-9a-f]{8} is current/);
  // an older install: different marker, edited workflow, customised project config and a cell
  fx.commit("main", { ".github/blueprint-kit.version": "00000000\n", ".github/workflows/cell-checks.yml": "old\n", "blueprint.yaml": "project: mine\nlease_minutes: 5\n", "cells/C-000.yaml": "keep\n" }, "old");
  assert.match(await engine.initBlueprint(fx, "o/r", opts(fx)), /^ALREADY_INITIALIZED: installed kit is 00000000.*upgrade:true/);
  assert.equal(fx.file("main", ".github/workflows/cell-checks.yml"), "old\n");
  assert.match(await engine.initBlueprint(fx, "o/r", opts(fx), { upgrade: true }), /^OK upgraded blueprint kit/);
  assert.notEqual(fx.file("main", ".github/workflows/cell-checks.yml"), "old\n");
  assert.equal(fx.file("main", "blueprint.yaml"), "project: mine\nlease_minutes: 5\n");
  assert.equal(fx.file("main", "cells/C-000.yaml"), "keep\n");
  assert.match(await engine.initBlueprint(fx, "o/r", opts(fx)), /is current/);
});

test("a misspelt cell key is rejected instead of silently ignored (kind: skeleton instead of type:)", async () => {
  const fx = new FakeGitHub();
  await engine.initBlueprint(fx, "o/r", opts(fx));
  const bad = CELL("C-000").replace("goal: g", "goal: g\nkind: skeleton");
  const out = await engine.publishPlan(fx, "o/r", opts(fx), { cells: [{ id: "C-000", yaml: bad }] });
  assert.match(out, /^REJECTED \(nothing committed\)[\s\S]*unknown key 'kind'/);
});


test("a zombie chat writing after its cell was merged is told the cell is DONE (not just 'not claimed')", async () => {
  const fx = seed();
  const base = base7(await claim(fx));
  await apply(fx, "C-000", base, [{ path: "pyproject.toml", content: "x" }]);
  await submit(fx);
  fx.mergeCell("C-000");
  const out = await apply(fx, "C-000", base, [{ path: "pyproject.toml", content: "y" }]);
  assert.match(out, /^CELL_DONE C-000: already merged \(PR #1\)/);
  assert.match(await apply(fx, "C-001", "abcdef0", [{ path: "src/app/config.py", content: "y" }]), /^NOT_CLAIMED C-001/);
});

test("admin gate: takeover/publish_plan are off without ADMIN_TOKEN and need the exact key", async () => {
  assert.match((await engine.checkAdmin(undefined, "anything"))!, /^ADMIN_NOT_CONFIGURED/);
  assert.match((await engine.checkAdmin("k1", undefined))!, /^ADMIN_ONLY: this tool needs admin_key/);
  assert.match((await engine.checkAdmin("k1", "k2"))!, /^ADMIN_ONLY: wrong admin_key/);
  assert.equal(await engine.checkAdmin("k1", "k1"), null);
});

test("ci_result: a gate that PASSED but failed to merge is re-run once (seen live under load)", async () => {
  const fx = await withConftest();
  await submit(fx);
  fx.tick(5000);
  const run = fx.addRun("cell-gate.yml", "gate cell/C-000", "completed", "failure", 0, "PASS C-000 (acceptance 1/1)\n");
  const out = await ci(fx, 0);
  assert.match(out, /^PASS C-000 \(acceptance 1\/1\)\nMERGE_RETRY/);
  assert.deepEqual(fx.reruns, [run.id]);
  fx.failNext["rerunFailed"] = new ApiError("re-run failed jobs: 403 forbidden", 403);
  assert.match(await ci(fx, 0), /MERGE_STUCK: .*403/);
});

test("CLAIMED and RESUME tell the chat which repo to pass on every call", async () => {
  const fx = seed();
  assert.match(await claim(fx), /repo=o\/r/);
});
