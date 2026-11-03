import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as engine from "../src/engine.ts";
import { tryTakeover } from "../src/claim.ts";
import { parseTrailers, subjectOf } from "../src/trailers.ts";
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
let n = 0;
const o = (fx: FakeGitHub) => ({ mainBranch: "main", historyPages: 5, now: () => fx.clock, sleep: async (ms: number) => fx.tick(ms), uuid: () => `t${++n}` });
const claim = (fx: FakeGitHub) => engine.nextCell(fx, REPO, o(fx), "claim");
const base7 = (t: string) => /base=([0-9a-f]{7})/.exec(t)![1];
const min = (fx: FakeGitHub, m: number) => fx.tick(m * 60000);
const apply = (fx: FakeGitHub, base: string, next: string) =>
  engine.applyChanges(fx, REPO, o(fx), { cell_id: "C-000", base, message: "m", next, ops: [{ path: "pyproject.toml", content: "x" }] });
const tipMsg = (fx: FakeGitHub) => fx.commits.get(fx.refs.get("cell/C-000")!)!.message;

test("fresh claim has no trailers; expired takeovers count attempts 1, 2 and keep next:", async () => {
  const fx = seed();
  const a = await claim(fx);
  assert.match(subjectOf(tipMsg(fx)), /^claim\(C-000\): lock /);
  assert.equal(tipMsg(fx).includes("\n"), false);
  assert.doesNotMatch(a, /attempt \d/);
  await apply(fx, base7(a), "NEXT-X");
  min(fx, 61);
  const b = await claim(fx);
  assert.match(subjectOf(tipMsg(fx)), /^takeover\(C-000\): lock /);
  assert.deepEqual(parseTrailers(tipMsg(fx)), { attempt: 1, next: "NEXT-X" });
  assert.match(b, /^RESUME C-000 base=[0-9a-f]{7} repo=o\/r on cell\/C-000 attempt 1\/3\./);
  assert.match(b, /NEXT-X/);
  min(fx, 61);
  const c = await claim(fx);
  assert.equal(parseTrailers(tipMsg(fx)).attempt, 2);
  assert.equal(parseTrailers(tipMsg(fx)).next, "NEXT-X");
  assert.match(c, /attempt 2\/3/);
  assert.doesNotMatch(c, /^attempt:/m); // the old tip's attempt trailer is not echoed under the header
  assert.match(c, /^next: /m);
  assert.match(c, /NEXT-X/);
});

test("RESUME body: subject and next: only, never attempt: or req: lines", async () => {
  const fx = seed();
  await claim(fx);
  fx.commit("cell/C-000", { "pyproject.toml": "x" }, "WIP: step one\n\nnext: NEXT-Z\nattempt: 1\nreq: abc123");
  min(fx, 61);
  const r = await claim(fx);
  assert.match(r, /attempt 2\/3\. Last commit: WIP: step one\nnext: NEXT-Z\n/);
  assert.doesNotMatch(r, /^attempt:/m);
  assert.doesNotMatch(r, /^req:/m);
  assert.doesNotMatch(r, /abc123/);
});

test("a released tip is adopted: subject adopt(, attempt unchanged, next: kept (nextCell does not pick adopt yet: plan.ts released wiring is a later task)", async () => {
  const fx = seed();
  const a = await claim(fx);
  await apply(fx, base7(a), "NEXT-Y");
  min(fx, 61);
  await claim(fx); // takeover -> attempt 1
  fx.commit("cell/C-000", {}, `release(C-000): done for now\n\nnext: NEXT-Y\nattempt: 1`);
  const snap = await fx.snapshot(REPO, "main", 5);
  const oid = await tryTakeover(fx, REPO, snap, "C-000", o(fx), "adopt");
  assert.ok(oid);
  assert.match(subjectOf(tipMsg(fx)), /^adopt\(C-000\): lock /);
  assert.deepEqual(parseTrailers(tipMsg(fx)), { attempt: 1, next: "NEXT-Y" });
});

test("an old branch (lock commit without trailers, next: only in a WIP commit) still resumes", async () => {
  const fx = seed();
  await claim(fx);
  fx.commit("cell/C-000", { "pyproject.toml": "x" }, "WIP\n\nnext: OLD-STYLE");
  min(fx, 61);
  const r = await claim(fx);
  assert.match(r, /^RESUME C-000/);
  assert.match(r, /OLD-STYLE/);
  assert.equal(parseTrailers(tipMsg(fx)).attempt, 1);
});

test("PR/CI line only with an open PR; failing workflowRuns does not break RESUME", async () => {
  const fx = seed();
  await claim(fx);
  min(fx, 61);
  assert.doesNotMatch(await claim(fx), /PR #/);

  fx.createPr(REPO, { title: "t", head: "cell/C-000", base: "main", body: "" });
  fx.addRun("cell-gate.yml", "gate cell/C-000", "completed", "failure", 5);
  fx.addRun("cell-gate.yml", "gate cell/C-000", "in_progress", null, 1);
  fx.addRun("cell-gate.yml", "gate cell/C-001", "completed", "success", 0);
  min(fx, 61);
  const r = await claim(fx);
  assert.match(r, /\nPR #1 open; newest gate run: in_progress\/running \(call ci_result\)\n/);
  assert.ok(r.indexOf("Files already changed") < r.indexOf("PR #1"));

  min(fx, 61);
  fx.failNext["workflowRuns"] = new Error("boom");
  const r2 = await claim(fx);
  assert.match(r2, /^RESUME C-000/);
  assert.doesNotMatch(r2, /PR #/);
  // a 4th death would now make C-000 needs_split (max_attempts 3), so the findPr failure is checked on a fresh cell
  const fx2 = seed();
  await claim(fx2);
  min(fx2, 61);
  fx2.failNext["findPr"] = new Error("boom");
  assert.match(await claim(fx2), /^RESUME C-000/);
});

test("without a PR, a takeover adds at most the one findPr call and no workflowRuns", async () => {
  const fx = seed();
  await claim(fx);
  min(fx, 61);
  fx.calls.length = 0;
  await claim(fx);
  const count = (name: string) => fx.calls.filter((c) => c === name).length;
  assert.equal(count("workflowRuns"), 0);
  assert.equal(count("findPr"), 1);
  assert.equal(count("commitEmpty"), 1);
  assert.equal(count("fastForward"), 1);
});
