// The automatic main sync is not a takeover: apply_changes and cell_signal go on after a sync(<id>): or heal(<id>): commit
// (same lock, written by the Worker), and still answer CONFLICT when any other commit sits between base and the tip.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import * as engine from "../src/engine.ts";
import type { EngineOptions } from "../src/engine.ts";
import { cellSignal } from "../src/signal.ts";
import { FakeGitHub } from "./fakegh.ts";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = "o/r";
const HINT = "If your last preflight or submit reported SYNCED, use the new base it gave; otherwise the cell was taken over.";

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
const tip = (fx: FakeGitHub) => fx.refs.get("cell/C-000")!;
const msg = (fx: FakeGitHub) => fx.commits.get(tip(fx))!.message;
const apply = (fx: FakeGitHub, base: string, append: string) =>
  engine.applyChanges(fx, REPO, opts(fx), { cell_id: "C-000", base, message: "more", next: "go on", ops: [{ path: "pyproject.toml", append }] });
const preflight = (fx: FakeGitHub) => engine.preflight(fx, REPO, opts(fx), "C-000");
const mainMoves = (fx: FakeGitHub) => fx.commit("main", { "docs/other.md": `m${fx.commits.size}\n` }, "human: docs");
const adopt = (fx: FakeGitHub) => fx.commit("cell/C-000", {}, "adopt(C-000): resumed by another chat\n\nnext: go on");
const heal = (fx: FakeGitHub) => fx.commit("cell/C-000", {}, "heal(C-000): merge main\n\nnext: go on");

/** The chat claims C-000 and commits one file; returns the base it got from that commit. */
async function started(fx: FakeGitHub): Promise<string> {
  const c = await engine.nextCell(fx, REPO, opts(fx), "claim");
  assert.match(c, /^CLAIMED C-000/);
  const out = await apply(fx, base7(c), "one\n");
  assert.match(out, /^ok /);
  return base7(out);
}

test("preflight on a behind branch merges main and reports SYNCED with the new base", async () => {
  const fx = seed();
  await started(fx);
  mainMoves(fx);
  const out = await preflight(fx);
  assert.match(msg(fx), /^sync\(C-000\): merge main/);
  const nb = tip(fx).slice(0, 7);
  assert.equal(out, `started preflight C-000; keep working, then call ci_result once\nSYNCED main into your branch (no takeover). New base=${nb}. Continue with this base.`);
});

test("apply_changes with the old base after a sync commit succeeds and reports the new base", async () => {
  const fx = seed();
  const b1 = await started(fx);
  mainMoves(fx);
  await preflight(fx);
  const synced = tip(fx);
  assert.notEqual(synced.slice(0, 7), b1);
  const out = await apply(fx, b1, "two\n");
  assert.match(out, /^ok [0-9a-f]{7} 1 file \(next base=([0-9a-f]{7})\)\nbase moved by an automatic sync; new base=\1$/);
  assert.equal(base7(out), tip(fx).slice(0, 7));
  assert.equal(fx.commits.get(tip(fx))!.parent, synced);
  assert.equal(fx.file("cell/C-000", "pyproject.toml"), "one\ntwo\n");
  assert.equal(fx.file("cell/C-000", "docs/other.md")?.startsWith("m"), true);
});

test("apply_changes with the old base after a heal commit succeeds", async () => {
  const fx = seed();
  const b1 = await started(fx);
  heal(fx);
  const out = await apply(fx, b1, "two\n");
  assert.match(out, /^ok [0-9a-f]{7} 1 file \(next base=([0-9a-f]{7})\)\nbase moved by an automatic sync; new base=\1$/);
  assert.equal(fx.file("cell/C-000", "pyproject.toml"), "one\ntwo\n");
});

test("apply_changes after a sync then a heal commit succeeds", async () => {
  const fx = seed();
  const b1 = await started(fx);
  mainMoves(fx);
  await preflight(fx);
  heal(fx);
  assert.match(await apply(fx, b1, "two\n"), /^ok [0-9a-f]{7} 1 file .*\nbase moved by an automatic sync; new base=[0-9a-f]{7}$/);
});

test("apply_changes after an adopt commit still answers CONFLICT and writes nothing", async () => {
  const fx = seed();
  const b1 = await started(fx);
  adopt(fx);
  const before = tip(fx);
  const out = await apply(fx, b1, "two\n");
  assert.match(out, /^CONFLICT C-000: cell\/C-000 is at [0-9a-f]{7}, not [0-9a-f]{7}\./);
  assert.ok(out.includes(HINT));
  assert.ok(out.includes("adopt(C-000)"));
  assert.equal(tip(fx), before);
});

test("apply_changes after a sync then an adopt (or an adopt then a sync) still answers CONFLICT", async () => {
  const fx = seed();
  const b1 = await started(fx);
  mainMoves(fx);
  await preflight(fx);
  const synced = base7(msg(fx).length ? `base=${tip(fx).slice(0, 7)}` : "");
  adopt(fx);
  assert.match(await apply(fx, b1, "two\n"), /^CONFLICT C-000/);
  assert.match(await apply(fx, synced, "two\n"), /^CONFLICT C-000/);

  const fy = seed();
  const c1 = await started(fy);
  adopt(fy);
  mainMoves(fy);
  await preflight(fy);
  assert.match(msg(fy), /^sync\(C-000\)/);
  assert.match(await apply(fy, c1, "two\n"), /^CONFLICT C-000/);
});

test("a base that is not on the branch at all still answers CONFLICT", async () => {
  const fx = seed();
  await started(fx);
  heal(fx);
  assert.match(await apply(fx, "abcdef0", "two\n"), /^CONFLICT C-000/);
});
