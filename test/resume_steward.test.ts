// resume_steward.test.ts: a steward note is the first thing a fresh chat sees when it resumes the cell.
import { test } from "node:test";
import assert from "node:assert/strict";

import { FakeGitHub } from "./fakegh.ts";
import type { EngineOptions } from "../src/common.ts";
import { nextCell } from "../src/claim.ts";
import { takeoverCell } from "../src/takeover.ts";
import { noteCell } from "../src/steward.ts";
import { isSteward, stewardNote } from "../src/trailers.ts";

const REPO = "o/r";
const MIN = 60000;

function setup(): FakeGitHub {
  const gh = new FakeGitHub();
  gh.commit(
    "main",
    {
      "blueprint.yaml": "project: demo\nlease_minutes: 60\n",
      "cells/C-001.yaml": "id: C-001\ntitle: First\ngoal: do it\nallowed_paths:\n  - src/a.ts\noutputs:\n  - src/a.ts\nacceptance:\n  - cmd: \"true\"\n",
    },
    "plan",
  );
  return gh;
}

function engine(gh: FakeGitHub): EngineOptions {
  let n = 0;
  return { mainBranch: "main", historyPages: 1, now: () => gh.clock, sleep: async () => {}, uuid: () => `u${++n}` };
}

test("trailer helpers: isSteward and stewardNote", () => {
  assert.equal(isSteward("steward(C-001): hello"), true);
  assert.equal(isSteward("steward(lease): adopt u1"), true);
  assert.equal(isSteward("cell(C-001): hello"), false);
  assert.equal(stewardNote("steward(C-001): use postgres\n\nnext: go"), "use postgres");
  assert.equal(stewardNote("steward(lease): adopt u1"), null);
  assert.equal(stewardNote("feedback(C-001): hello"), null);
  assert.equal(stewardNote("steward(C-001):"), null);
});

test("resume text shows the steward note right under the header, before the file list", async () => {
  const gh = setup();
  gh.commit("cell/C-001", {}, "feedback(C-001): which db?\n\nnext: wait");
  await noteCell(gh, REPO, "C-001", "Use postgres, see docs/db.md");
  const text = await takeoverCell(gh, REPO, engine(gh), "C-001", false, { clear_feedback: true });
  assert.match(text.split("\n")[0], /^RESUME C-001 base=[0-9a-f]{7} repo=o\/r/);
  const at = text.indexOf("STEWARD NOTE");
  assert.ok(at > 0, text);
  assert.ok(text.includes("Use postgres, see docs/db.md"));
  assert.ok(at < text.indexOf("Files already changed"));
});

test("resume text without a note has no steward line", async () => {
  const gh = setup();
  gh.commit("cell/C-001", {}, "cell(C-001): work\n\nnext: go on");
  gh.tick(61 * MIN);
  const text = await takeoverCell(gh, REPO, engine(gh), "C-001", true);
  assert.match(text, /^RESUME C-001/);
  assert.ok(!text.includes("STEWARD NOTE"));
});

test("the newest note wins", async () => {
  const gh = setup();
  gh.commit("cell/C-001", {}, "cell(C-001): work\n\nnext: go on");
  await noteCell(gh, REPO, "C-001", "first advice");
  await noteCell(gh, REPO, "C-001", "second advice");
  gh.tick(61 * MIN);
  const text = await takeoverCell(gh, REPO, engine(gh), "C-001", true);
  assert.ok(text.includes("second advice"));
  assert.ok(!text.includes("first advice"));
});

test("a released cell claimed through next_cell still shows the note", async () => {
  const gh = setup();
  gh.commit("cell/C-001", {}, "cell(C-001): work\n\nnext: go on");
  await noteCell(gh, REPO, "C-001", "Skip the cache layer, it is out of scope.");
  const rel = await takeoverCell(gh, REPO, engine(gh), "C-001", true, { handoff: true });
  assert.match(rel, /^RELEASED C-001/);
  const text = await nextCell(gh, REPO, { ...engine(gh), claim: { pin: "C-001" } }, "claim");
  assert.match(text, /^RESUME C-001/);
  assert.ok(text.includes("Skip the cache layer"), text);
});
