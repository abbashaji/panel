// selfheal_tools.test.ts: the self-heal MCP tools, and the automatic main sync before submit_cell and preflight.
import { test } from "node:test";
import assert from "node:assert/strict";

import { FakeGitHub } from "./fakegh.ts";
import { nextCell } from "../src/claim.ts";
import { RULES, SERVER_INSTRUCTIONS } from "../src/protocol.ts";
import { buildServer, healToolHandlers, toolHandlers, type Env } from "../src/tools.ts";
import type { EngineOptions } from "../src/engine.ts";

const REPO = "o/r";
const env = { GITHUB_TOKEN: "t", MCP_AUTH_TOKEN: "m", DEFAULT_REPO: REPO } as unknown as Env;

function setup(): FakeGitHub {
  const gh = new FakeGitHub();
  const y = "title: Cell\ngoal: build it\nallowed_paths:\n  - src/C-001.ts\noutputs:\n  - src/C-001.ts\nacceptance:\n  - cmd: \"true\"\n";
  gh.commit("main", { "blueprint.yaml": "project: demo\nlease_minutes: 60\n", "cells/C-001.yaml": `id: C-001\n${y}` }, "plan");
  return gh;
}

function opts(gh: FakeGitHub): EngineOptions {
  let n = 0;
  return { mainBranch: "main", historyPages: 1, now: () => gh.clock, sleep: async () => {}, uuid: () => `u${++n}` };
}

async function claim(gh: FakeGitHub): Promise<string> {
  const text = await nextCell(gh, REPO, { ...opts(gh), claim: { pin: "C-001" } }, "claim");
  const m = /^CLAIMED C-001 base=([0-9a-f]+)/.exec(text);
  assert.ok(m, text);
  return m[1];
}

const handlers = (gh: FakeGitHub) => ({ ...toolHandlers(env, opts(gh), () => gh), ...healToolHandlers(env, opts(gh), () => gh) });
const tip = (gh: FakeGitHub): string => gh.refs.get("cell/C-001")!.slice(0, 7);

test("buildServer registers the five heal tools without error", () => {
  assert.ok(buildServer(env, () => setup()));
});

test("every heal tool answers and is denied without base", async () => {
  const gh = setup();
  const base = await claim(gh);
  const h = handlers(gh);
  for (const name of ["cell_help", "cell_note", "cell_sync", "cell_clear", "cell_fix"]) {
    assert.match(await h[name]({ repo: REPO, cell_id: "C-001" }), /^SELFHEAL_DENIED/, name);
  }
  assert.match(await h.cell_help({ repo: REPO, cell_id: "C-001", base, problem: "tests fail" }), /^SELF-HEAL BRIEFING C-001/);
  const note = await h.cell_note({ repo: REPO, cell_id: "C-001", base, note: "assume utf-8" });
  assert.match(note, /^HEALED C-001/, note);
  assert.match(await h.cell_sync({ repo: REPO, cell_id: "C-001", base: tip(gh) }), /^UP_TO_DATE C-001/);
  assert.match(await h.cell_clear({ repo: REPO, cell_id: "C-001", base: tip(gh) }), /^NO_FEEDBACK C-001/);
  const fix = await h.cell_fix({
    repo: REPO, cell_id: "C-001", base: tip(gh), kind: "replace",
    cells: [{ title: "Cell v2", allowed_paths: ["src/C-001.ts"], outputs: ["src/C-001.ts"], acceptance: [{ cmd: "true" }], notes: "first contract was wrong" }],
  });
  assert.match(fix, /^FIXED C-001: replace published C-002 /, fix);
});

test("cell_sync merges a behind branch", async () => {
  const gh = setup();
  const base = await claim(gh);
  gh.commit("main", { "docs/a.md": "a\n" }, "main moves");
  assert.match(await handlers(gh).cell_sync({ repo: REPO, cell_id: "C-001", base }), /^HEALED C-001/);
  assert.equal(gh.file("cell/C-001", "docs/a.md"), "a\n");
});

test("submit_cell on a behind branch merges main first", async () => {
  const gh = setup();
  await claim(gh);
  gh.commit("cell/C-001", { "src/C-001.ts": "x\n" }, "work");
  gh.commit("main", { "docs/a.md": "a\n" }, "main moves");
  const r = await handlers(gh).submit_cell({ repo: REPO, cell_id: "C-001", summary: "done" });
  assert.match(r, /^PR #\d+ opened/, r);
  assert.equal(gh.file("cell/C-001", "docs/a.md"), "a\n");
});

test("submit_cell and preflight on a conflicting branch stop with CONFLICT", async () => {
  const gh = setup();
  await claim(gh);
  gh.commit("cell/C-001", { "src/C-001.ts": "mine\n" }, "work");
  gh.commit("main", { "src/C-001.ts": "theirs\n" }, "main moves");
  const h = handlers(gh);
  const s = await h.submit_cell({ repo: REPO, cell_id: "C-001", summary: "done" });
  assert.match(s, /^CONFLICT C-001 \(sync\)/, s);
  assert.equal(gh.prs.length, 0);
  assert.match(await h.preflight({ repo: REPO, cell_id: "C-001" }), /^CONFLICT C-001 \(sync\)/);
  assert.equal(gh.dispatched.length, 0);
});

test("submit_cell on an up-to-date branch changes nothing", async () => {
  const gh = setup();
  await claim(gh);
  gh.commit("cell/C-001", { "src/C-001.ts": "x\n" }, "work");
  const before = gh.refs.get("cell/C-001");
  assert.match(await handlers(gh).submit_cell({ repo: REPO, cell_id: "C-001", summary: "done" }), /^PR #\d+ opened/);
  assert.equal(gh.refs.get("cell/C-001"), before);
});

test("the rules and instructions point a blocked chat to cell_help and keep the old sentences", () => {
  assert.match(RULES, /call cell_help\(repo, cell_id, base, problem\) BEFORE cell_signal feedback/);
  assert.match(RULES, /cell_signal feedback is only for ESCALATE answers/);
  assert.match(RULES, /Wrong or impossible contract: no workaround; cell_signal feedback/);
  assert.match(SERVER_INSTRUCTIONS, /Start every chat with next_cell/);
  assert.match(SERVER_INSTRUCTIONS, /call cell_help first/);
});
