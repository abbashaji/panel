// F9: a cell merged long ago must not look unmerged once the merge is older than the commit window.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as engine from "../src/engine.ts";
import { FakeGitHub } from "./fakegh.ts";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = "o/r";
beforeEach(() => engine.clearPlanCache());
let n = 0;
const o = (fx: FakeGitHub, pages = 1) => ({ mainBranch: "main", historyPages: pages, now: () => fx.clock, sleep: async (ms: number) => fx.tick(ms), uuid: () => `h${++n}` });

function seed(): FakeGitHub {
  const fx = new FakeGitHub();
  const files: Record<string, string> = { "blueprint.yaml": readFileSync(join(here, "example/blueprint.yaml"), "utf-8") };
  for (const f of readdirSync(join(here, "example/cells"))) files[`cells/${f}`] = readFileSync(join(here, "example/cells", f), "utf-8");
  fx.commit("main", files, "plan");
  return fx;
}

async function mergedLongAgo(): Promise<FakeGitHub> {
  const fx = seed();
  assert.match(await engine.nextCell(fx, REPO, o(fx), "claim"), /^CLAIMED C-000/);
  fx.commit("cell/C-000", { "pyproject.toml": "x" }, "WIP");
  fx.mergeCell("C-000");
  fx.addMainCommits(1000);
  return fx;
}

test("fake snapshot reports merged cells as mergedIds", async () => {
  const fx = await mergedLongAgo();
  const s = await fx.snapshot(REPO, "main", 1);
  assert.deepEqual(s.mergedIds, ["C-000"]);
  assert.equal(s.historyComplete, false);
});

test("peek does not list a cell merged 1,000 commits ago as ready", async () => {
  const fx = await mergedLongAgo();
  const peek = await engine.nextCell(fx, REPO, o(fx), "peek");
  assert.doesNotMatch(peek, /C-000/);
});

test("next_cell never hands out the long-merged cell, and the call count stays bounded", async () => {
  const fx = await mergedLongAgo();
  fx.calls.length = 0;
  const out = await engine.nextCell(fx, REPO, o(fx), "claim");
  assert.doesNotMatch(out.split("\n")[0], /C-000/); // C-001 is claimed instead (it merely lists C-000 as its input)
  assert.equal(fx.refs.has("cell/C-000"), false);
  assert.ok(fx.calls.length <= 12, `too many fake API calls: ${fx.calls.length}`);
});
