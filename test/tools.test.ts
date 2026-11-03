// Handler-level tests for the MCP tool wiring (tools.ts): admin gate, repo policy, tool list.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import * as engine from "../src/engine.ts";
import type { EngineOptions } from "../src/engine.ts";
import { toolHandlers, type Env } from "../src/tools.ts";
import { FakeGitHub } from "./fakegh.ts";

const here = dirname(fileURLToPath(import.meta.url));
const KEY = "owner-secret";

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
  return { mainBranch: "main", historyPages: 5, now: () => fx.clock, sleep: async (ms) => fx.tick(ms), uuid: () => `u${++n}` };
}

const envOf = (over: Partial<Env> = {}): Env => ({ GITHUB_TOKEN: "t", DEFAULT_REPO: "o/r", ...over }) as Env;
const handlers = (fx: FakeGitHub, env: Env) => toolHandlers(env, opts(fx), () => fx);

const CELL = (id: string) =>
  `id: ${id}\ntitle: t\ngoal: g\nprovides:\n  - "src/${id}.py: def f()"\nallowed_paths: [src/${id}.py]\noutputs: [src/${id}.py]\nacceptance:\n  - cmd: "true"\n`;

/** Everything a write could change: branch tips, object counts, and write-type calls. */
const WRITE_CALLS = new Set(["commitFiles", "commitEmpty", "createBranch", "fastForward", "putFile", "createPr", "dispatch", "rerunFailed"]);
const state = (fx: FakeGitHub) => JSON.stringify({ refs: [...fx.refs].sort(), commits: fx.commits.size, prs: fx.prs.length, dispatched: fx.dispatched.length });
const writes = (fx: FakeGitHub) => fx.calls.filter((c) => WRITE_CALLS.has(c));

test("toolHandlers has exactly the 11 tools", () => {
  const keys = Object.keys(handlers(seed(), envOf())).sort();
  assert.deepEqual(keys, ["apply_changes", "cell_signal", "ci_result", "init_blueprint", "next_cell", "preflight", "publish_plan", "read_files", "ready_cells", "submit_cell", "takeover"]);
});

test("ADMIN_TOKEN unset: takeover and publish_plan are off and write nothing", async () => {
  const fx = seed();
  await engine.nextCell(fx, "o/r", opts(fx), "claim"); // C-000 running
  const h = handlers(fx, envOf());
  fx.calls.length = 0;
  const before = state(fx);
  for (const key of [undefined, KEY]) {
    assert.match(await h.takeover({ cell_id: "C-000", admin_key: key }), /^ADMIN_NOT_CONFIGURED/);
    assert.match(await h.publish_plan({ cells: [{ id: "C-900", yaml: CELL("C-900") }], admin_key: key }), /^ADMIN_NOT_CONFIGURED/);
  }
  assert.equal(state(fx), before);
  assert.deepEqual(writes(fx), []);
});

test("ADMIN_TOKEN set: no key or wrong key -> ADMIN_ONLY and no write", async () => {
  const fx = seed();
  await engine.nextCell(fx, "o/r", opts(fx), "claim");
  const h = handlers(fx, envOf({ ADMIN_TOKEN: KEY }));
  fx.calls.length = 0;
  const before = state(fx);
  for (const key of [undefined, "", "wrong", KEY + "x"]) {
    assert.match(await h.takeover({ cell_id: "C-000", admin_key: key }), /^ADMIN_ONLY/);
    assert.match(await h.publish_plan({ cells: [{ id: "C-900", yaml: CELL("C-900") }], admin_key: key }), /^ADMIN_ONLY/);
  }
  assert.equal(state(fx), before);
  assert.deepEqual(writes(fx), []);
});

test("ADMIN_TOKEN set: the correct key lets takeover through", async () => {
  const fx = seed();
  await engine.nextCell(fx, "o/r", opts(fx), "claim");
  const out = await handlers(fx, envOf({ ADMIN_TOKEN: KEY })).takeover({ cell_id: "C-000", admin_key: KEY });
  assert.match(out, /^RESUME C-000 base=/);
});

test("ADMIN_TOKEN set: the correct key lets publish_plan through (one new cell yaml)", async () => {
  const fx = seed();
  const before = fx.commits.size;
  const out = await handlers(fx, envOf({ ADMIN_TOKEN: KEY })).publish_plan({ cells: [{ id: "C-900", yaml: CELL("C-900") }], admin_key: KEY });
  assert.match(out, /^OK published 1 cell\(s\): C-900/);
  assert.equal(fx.commits.size - before, 1);
  assert.ok(Object.keys(fx.trees.get(fx.commits.get(fx.refs.get("main")!)!.tree)!).includes("cells/C-900.yaml"));
});

test("a non-admin tool (ready_cells) works with no key, even with ADMIN_TOKEN unset", async () => {
  const fx = seed();
  for (const env of [envOf(), envOf({ ADMIN_TOKEN: KEY })]) {
    const out = await handlers(fx, env).ready_cells({});
    assert.match(out, /C-000/);
    assert.doesNotMatch(out, /^ADMIN_/);
  }
  assert.deepEqual(writes(fx), []);
});

test("a repo outside ALLOWED_REPOS is refused with the existing text and touches nothing", async () => {
  const fx = seed();
  const env = envOf({ DEFAULT_REPO: undefined, ALLOWED_REPOS: "o/r", ADMIN_TOKEN: KEY });
  const expected = engine.resolveRepo(env, "evil/x");
  assert.ok("error" in expected);
  const h = handlers(fx, env);
  fx.calls.length = 0;
  assert.equal(await h.ready_cells({ repo: "evil/x" }), (expected as { error: string }).error);
  assert.equal(await h.takeover({ repo: "evil/x", cell_id: "C-000", admin_key: KEY }), (expected as { error: string }).error);
  assert.deepEqual(fx.calls, []);
});

test("cell_signal heartbeat reaches the engine, needs no admin key, and is repo-checked", async () => {
  const fx = seed();
  const claimed = await engine.nextCell(fx, "o/r", opts(fx), "claim");
  const base = /base=([0-9a-f]{7})/.exec(claimed)![1];
  const h = handlers(fx, envOf({ ADMIN_TOKEN: KEY })); // admin configured, no key passed: must still work
  fx.calls.length = 0;
  const out = await h.cell_signal({ cell_id: "C-000", base, kind: "heartbeat" });
  assert.match(out, /^ok [0-9a-f]{7} \(next base=/);
  assert.ok(writes(fx).includes("commitEmpty"));
  assert.match(await h.cell_signal({ cell_id: "C-000", base, kind: "heartbeat" }), /^CONFLICT/); // stale base is fenced
  const env = envOf({ DEFAULT_REPO: undefined, ALLOWED_REPOS: "o/r" });
  const expected = engine.resolveRepo(env, "evil/x") as { error: string };
  fx.calls.length = 0;
  assert.equal(await handlers(fx, env).cell_signal({ repo: "evil/x", cell_id: "C-000", base, kind: "heartbeat" }), expected.error);
  assert.deepEqual(fx.calls, []);
});

test("takeover with handoff keeps the admin gate: no key, no write; right key releases", async () => {
  const fx = seed();
  await engine.nextCell(fx, "o/r", opts(fx), "claim");
  const h = handlers(fx, envOf({ ADMIN_TOKEN: KEY }));
  fx.calls.length = 0;
  const before = state(fx);
  for (const key of [undefined, "wrong"]) {
    assert.match(await h.takeover({ cell_id: "C-000", handoff: true, clear_feedback: true, admin_key: key }), /^ADMIN_ONLY/);
  }
  assert.equal(state(fx), before);
  assert.deepEqual(writes(fx), []);
  const tipBefore = fx.refs.get("cell/C-000");
  const out = await h.takeover({ cell_id: "C-000", handoff: true, admin_key: KEY });
  assert.doesNotMatch(out, /^ADMIN_|^ERROR/);
  assert.notEqual(fx.refs.get("cell/C-000"), tipBefore); // handoff wrote a release commit
});

test("next_cell with wait_seconds 0 (or absent) behaves like the plain claim", async () => {
  const plain = await engine.nextCell(seed(), "o/r", opts(seed()), "claim");
  for (const args of [{}, { wait_seconds: 0 }]) {
    const fx = seed();
    const out = await handlers(fx, envOf()).next_cell(args);
    assert.match(out, /^CLAIMED C-000 /);
    assert.equal(out.split("\n")[0].replace(/base=\w+/, ""), plain.split("\n")[0].replace(/base=\w+/, ""));
  }
});
