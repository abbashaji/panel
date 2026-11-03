import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as engine from "../src/engine.ts";
import { cellSignal } from "../src/signal.ts";
import { takeoverCell } from "../src/takeover.ts";
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
let n = 0;
const o = (fx: FakeGitHub) => ({ mainBranch: "main", historyPages: 5, now: () => fx.clock, sleep: async (ms: number) => fx.tick(ms), uuid: () => `s${++n}` });
const claim = (fx: FakeGitHub) => engine.nextCell(fx, REPO, o(fx), "claim");
const min = (fx: FakeGitHub, m: number) => fx.tick(m * 60000);
const tipOid = (fx: FakeGitHub) => fx.refs.get("cell/C-000")!;
const tipMsg = (fx: FakeGitHub) => fx.commits.get(tipOid(fx))!.message;
const sig = (fx: FakeGitHub, kind: "heartbeat" | "release" | "feedback", extra: { text?: string; next?: string; base?: string; id?: string } = {}) =>
  cellSignal(fx, REPO, o(fx), { cell_id: extra.id ?? "C-000", base: extra.base ?? tipOid(fx).slice(0, 7), kind, text: extra.text, next: extra.next });

async function started(fx: FakeGitHub) {
  assert.match(await claim(fx), /^CLAIMED C-000/);
  fx.commit("cell/C-000", { "pyproject.toml": "x" }, "WIP: first\n\nnext: step two\nattempt: 2");
}

test("heartbeat resets the lease", async () => {
  const fx = seed();
  await started(fx);
  min(fx, 10);
  const before = fx.commits.get(tipOid(fx))!.date;
  const r = await sig(fx, "heartbeat");
  assert.match(r, /^ok [0-9a-f]{7} \(next base=[0-9a-f]{7}\)$/);
  assert.notEqual(fx.commits.get(tipOid(fx))!.date, before);
  assert.match(tipMsg(fx), /^hb\(C-000\): alive/);
  min(fx, 10); // 20 min since the last file change, 10 since the heartbeat (critical lease 15m)
  assert.match(await claim(fx), /^NONE_READY/);
  min(fx, 6);
  assert.match(await claim(fx), /RESUME C-000/);
});

test("heartbeat, release and feedback carry next and attempt", async () => {
  for (const kind of ["heartbeat", "release", "feedback"] as const) {
    const fx = seed();
    await started(fx);
    const r = await sig(fx, kind, { text: "some text", next: kind === "release" ? "do step three" : undefined });
    assert.doesNotMatch(r, /^(CONFLICT|MISSING|ERROR)/);
    const t = parseTrailers(tipMsg(fx));
    assert.equal(t.attempt, 2);
    assert.equal(t.next, kind === "release" ? "do step three" : "step two");
  }
});

test("release needs next, and is worded as a lease end", async () => {
  const fx = seed();
  await started(fx);
  assert.match(await sig(fx, "release"), /^MISSING_NEXT/);
  assert.match(await sig(fx, "release", { next: "ab" }), /^MISSING_NEXT/);
  assert.equal(await sig(fx, "release", { next: "resume at step 3" }), "released C-000: the lease is over; another chat will adopt it");
  assert.match(tipMsg(fx), /^release\(C-000\): yield/);
});

test("feedback needs text, is cut to 300 and says stop", async () => {
  const fx = seed();
  await started(fx);
  assert.match(await sig(fx, "feedback"), /^MISSING_TEXT/);
  assert.match(await sig(fx, "feedback", { text: "no" }), /^MISSING_TEXT/);
  assert.equal(await sig(fx, "feedback", { text: "x".repeat(400) }), "feedback recorded for C-000: stop now; a human decides");
  assert.equal(tipMsg(fx).split("\n")[0], `feedback(C-000): ${"x".repeat(300)}`);
});

test("wrong base gives CONFLICT with tip, bad input is validated", async () => {
  const fx = seed();
  await started(fx);
  const before = tipOid(fx);
  const r = await sig(fx, "heartbeat", { base: "abcdef1" });
  assert.match(r, /^CONFLICT C-000: .*tip: WIP: first/);
  assert.equal(tipOid(fx), before);
  assert.match(await sig(fx, "heartbeat", { base: "zz" }), /^MISSING_BASE/);
  assert.equal(await sig(fx, "heartbeat", { id: "nope" }), "BAD_CELL_ID nope");
  assert.equal(await sig(fx, "heartbeat", { id: "C-077" }), "UNKNOWN_CELL C-077");
});

test("no branch -> NOT_CLAIMED; merged cell -> CELL_DONE", async () => {
  const fx = seed();
  assert.match(await sig(fx, "heartbeat", { base: "abcdef1" }), /^NOT_CLAIMED C-000/);
  await started(fx);
  fx.prs.push({ number: 7, state: "open", merged: false, branch: "cell/C-000", title: "t", body: "" } as any);
  fx.mergeCell("C-000");
  assert.match(await sig(fx, "heartbeat", { base: "abcdef1" }), /^CELL_DONE C-000/);
});

test("takeover handoff writes a release tip and leaves attempt unchanged", async () => {
  const fx = seed();
  await started(fx);
  min(fx, 20);
  const r = await takeoverCell(fx, REPO, o(fx), "C-000", true, { handoff: true });
  assert.equal(r, "RELEASED C-000: handed off. Tell a fresh chat to call next_cell.");
  assert.match(tipMsg(fx), /^release\(C-000\): handoff/);
  const t = parseTrailers(tipMsg(fx));
  assert.equal(t.attempt, 2);
  assert.equal(t.next, "step two");
});

test("takeover of a feedback tip needs clear_feedback", async () => {
  const fx = seed();
  await started(fx);
  await sig(fx, "feedback", { text: "which db do we use?" });
  const r = await takeoverCell(fx, REPO, o(fx), "C-000", true);
  assert.equal(r, "NEEDS_HUMAN C-000: which db do we use?. Resolve it, then call again with clear_feedback=true (or supersede the cell).");
  assert.match(tipMsg(fx), /^feedback\(/);
  assert.match(await takeoverCell(fx, REPO, o(fx), "C-000", true, { clear_feedback: true }), /^RESUME C-000/);
});

test("plain takeover now produces an adopt( tip", async () => {
  const fx = seed();
  await started(fx);
  assert.match(await takeoverCell(fx, REPO, o(fx), "C-000", true), /^RESUME C-000/);
  assert.match(tipMsg(fx), /^adopt\(C-000\): lock /);
});
