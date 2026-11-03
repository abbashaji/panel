// Integration tests for task 03a: nextCell feeds released / attempts / feedback and the config thresholds into computeState.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as engine from "../src/engine.ts";
import { cellSignal } from "../src/signal.ts";
import { FakeGitHub } from "./fakegh.ts";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = "o/r";
beforeEach(() => engine.clearPlanCache());

function exampleFiles(): Record<string, string> {
  const files: Record<string, string> = { "blueprint.yaml": readFileSync(join(here, "example/blueprint.yaml"), "utf-8") };
  for (const f of readdirSync(join(here, "example/cells"))) files[`cells/${f}`] = readFileSync(join(here, "example/cells", f), "utf-8");
  return files;
}
function seed(extra: Record<string, string> = {}): FakeGitHub {
  const fx = new FakeGitHub();
  fx.commit("main", { ...exampleFiles(), ...extra }, "plan");
  return fx;
}
const CELL = (id: string) =>
  `id: ${id}\ntitle: t\ngoal: g\nprovides:\n  - "src/${id}.py: def f()"\nallowed_paths: [src/${id}.py]\noutputs: [src/${id}.py]\nacceptance:\n  - cmd: "true"\n`;
/** Two independent cells and nothing else: C-000 is the poison one, C-001 is healthy. */
function seedIndependent(): FakeGitHub {
  const fx = new FakeGitHub();
  fx.commit("main", { "blueprint.yaml": readFileSync(join(here, "example/blueprint.yaml"), "utf-8").replace(/owners:[\s\S]*$/, "owners: {}\n"), "cells/C-000.yaml": CELL("C-000"), "cells/C-001.yaml": CELL("C-001") }, "plan");
  return fx;
}

let n = 0;
const o = (fx: FakeGitHub) => ({ mainBranch: "main", historyPages: 5, now: () => fx.clock, sleep: async (ms: number) => fx.tick(ms), uuid: () => `i${++n}` });
const claim = (fx: FakeGitHub) => engine.nextCell(fx, REPO, o(fx), "claim");
const peek = (fx: FakeGitHub) => engine.nextCell(fx, REPO, o(fx), "peek");
const base7 = (t: string) => /base=([0-9a-f]{7})/.exec(t)![1];
const min = (fx: FakeGitHub, m: number) => fx.tick(m * 60000);
const tipMsg = (fx: FakeGitHub, id: string) => fx.commits.get(fx.refs.get(`cell/${id}`)!)!.message;
const apply = (fx: FakeGitHub, id: string, base: string, ops: any[], next = "step X") =>
  engine.applyChanges(fx, REPO, o(fx), { cell_id: id, base, message: "m", next, ops });

test("dead critical skeleton: RESUME after 15 min (not 60), with the next: breadcrumb and attempt 1", async () => {
  const fx = seed();
  const a = await claim(fx);
  assert.match(a, /^CLAIMED C-000/);
  const w = await apply(fx, "C-000", base7(a), [{ path: "pyproject.toml", content: "x" }], "BREADCRUMB-STEP write conftest");
  assert.match(w, /^ok /);
  min(fx, 14); // A died right after its write
  assert.match(await claim(fx), /^NONE_READY/);
  min(fx, 2); // 16 min since the last commit
  const b = await claim(fx);
  assert.match(b, /^RESUME C-000/);
  assert.match(b, /BREADCRUMB-STEP write conftest/);
  assert.match(b.split("\n")[0], /attempt 1\/3/);
});

test("poison cell: three deaths -> ready_cells shows needs_split and next_cell never serves it", async () => {
  const fx = seed();
  await claim(fx);
  for (let i = 1; i <= 3; i++) {
    min(fx, 16);
    const r = await claim(fx);
    assert.match(r, /^RESUME C-000/);
    assert.match(r.split("\n")[0], new RegExp(`attempt ${i}/3`));
  }
  min(fx, 16);
  assert.match(await peek(fx), /needs_split: C-000\(3 attempts\)/);
  const out = await claim(fx);
  assert.match(out, /^NONE_READY/);
  assert.match(out, /needs_split: C-000\(3 attempts\)/);
  assert.doesNotMatch(out, /^RESUME|^CLAIMED/);
});

test("poison cell does not block independent cells: they are still served, the poison cell never", async () => {
  const fx = seedIndependent();
  // C-000 has already died three times (attempt trailer 3) and its lease is long over
  fx.commit("cell/C-000", {}, "takeover(C-000): lock x\n\nattempt: 3\nnext: split me");
  min(fx, 200);
  const p = await peek(fx);
  assert.match(p, /^READY C-001/);
  assert.match(p, /needs_split: C-000\(3 attempts\)/);
  const first = await claim(fx);
  assert.match(first, /^CLAIMED C-001/);
  const second = await claim(fx); // C-001 is now locked, C-000 is parked: nothing else to hand out
  assert.doesNotMatch(second, /C-000.*(CLAIMED|RESUME)|^RESUME C-000|^CLAIMED C-000/);
  assert.match(second, /^NONE_READY/);
  assert.match(second, /needs_split: C-000\(3 attempts\)/);
});

test("release: the next next_cell adopts at once, attempt unchanged, even while CI looks active", async () => {
  const fx = seed();
  const a = await claim(fx);
  min(fx, 20);
  fx.addRun("gate", "gate cell/C-000", "in_progress", null, 1); // CI looks active for this cell
  assert.match(await claim(fx), /^NONE_READY/); // without a release the active CI keeps it locked
  assert.match(await cellSignal(fx, REPO, o(fx), { cell_id: "C-000", base: base7(a), kind: "release", next: "continue with conftest" }), /^released C-000/);
  const b = await claim(fx);
  assert.match(b, /^RESUME C-000/);
  assert.doesNotMatch(b.split("\n")[0], /attempt [1-9]/);
  assert.match(tipMsg(fx, "C-000"), /^adopt\(C-000\)/);
  assert.doesNotMatch(tipMsg(fx, "C-000"), /attempt:/);
});

test("feedback: needs_human, admin takeover needs clear_feedback, then handoff serves the cell again", async () => {
  const fx = seed();
  const a = await claim(fx);
  assert.match(await cellSignal(fx, REPO, o(fx), { cell_id: "C-000", base: base7(a), kind: "feedback", text: "which database?" }), /^feedback recorded/);
  assert.match(await peek(fx), /needs_human: C-000/);
  min(fx, 200); // age does not matter
  const out = await claim(fx);
  assert.match(out, /^NONE_READY/);
  assert.match(out, /needs_human: C-000/);
  assert.match(await engine.takeoverCell(fx, REPO, o(fx), "C-000", true, { handoff: true }), /^NEEDS_HUMAN C-000: which database\?/);
  assert.match(await engine.takeoverCell(fx, REPO, o(fx), "C-000", true, { handoff: true, clear_feedback: true }), /^RELEASED C-000/);
  assert.match(await claim(fx), /^RESUME C-000/);
});

test("safe retry: applyChanges with a lost response is answered 'already applied', nothing is written twice", async () => {
  const fx = seed();
  const a = await claim(fx);
  const ops = [{ path: "pyproject.toml", content: "x" }];
  const first = await apply(fx, "C-000", base7(a), ops, "step 2");
  assert.match(first, /^ok /);
  const tip = fx.refs.get("cell/C-000");
  const retry = await apply(fx, "C-000", base7(a), ops, "step 2"); // chat never saw `first`, retries with the old base
  assert.match(retry, /^ok .*already applied/);
  assert.equal(base7(retry), base7(first));
  assert.equal(fx.refs.get("cell/C-000"), tip);
});

test("heartbeat keeps a critical cell locked past 15 min; without it the cell is resumed", async () => {
  const fx = seed();
  const a = await claim(fx);
  let base = base7(a);
  for (let i = 0; i < 4; i++) {
    min(fx, 10);
    const hb = await cellSignal(fx, REPO, o(fx), { cell_id: "C-000", base, kind: "heartbeat" });
    assert.match(hb, /^ok /);
    base = base7(hb);
    assert.match(await claim(fx), /^NONE_READY/); // 10, 20, 30, 40 min after the claim
  }
  min(fx, 16); // the chat stops heartbeating
  assert.match(await claim(fx), /^RESUME C-000/);
});

test("a blueprint.yaml override critical_lease_minutes: 30 is honoured by nextCell", async () => {
  const files = exampleFiles();
  const fx = seed({ "blueprint.yaml": files["blueprint.yaml"].replace(/\s*$/, "\n") + "critical_lease_minutes: 30\n" });
  await claim(fx);
  min(fx, 20); // would be expired under the default 15
  assert.match(await claim(fx), /^NONE_READY/);
  min(fx, 11); // 31 min
  assert.match(await claim(fx), /^RESUME C-000/);
});
