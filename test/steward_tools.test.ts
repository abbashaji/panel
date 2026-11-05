// Handler-level tests for the Steward tools (steward_next, steward_note, steward_release).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import * as engine from "../src/engine.ts";
import type { EngineOptions } from "../src/engine.ts";
import { stewardToolHandlers, toolHandlers, type Env } from "../src/tools.ts";
import { FakeGitHub } from "./fakegh.ts";

const here = dirname(fileURLToPath(import.meta.url));
const KEY = "owner-secret-4f9a1c";
const DAY = 24 * 60 * 60 * 1000;
let counter = 0;

beforeEach(() => engine.clearPlanCache());

function seed(): FakeGitHub {
  const fx = new FakeGitHub();
  const files: Record<string, string> = {
    "blueprint.yaml": readFileSync(join(here, "example/blueprint.yaml"), "utf-8"),
    "BLUEPRINT.md": `# Rules\nBe terse.\nADMIN_TOKEN=${KEY}\nthe owner key is ${KEY}\n`,
  };
  for (const f of readdirSync(join(here, "example/cells"))) files[`cells/${f}`] = readFileSync(join(here, "example/cells", f), "utf-8");
  fx.commit("main", files, "plan");
  return fx;
}

function opts(fx: FakeGitHub): EngineOptions {
  return { mainBranch: "main", historyPages: 5, now: () => fx.clock, sleep: async (ms) => fx.tick(ms), uuid: () => `u${++counter}` };
}

const envOf = (over: Partial<Env> = {}): Env => ({ GITHUB_TOKEN: "t", DEFAULT_REPO: "o/r", ...over }) as Env;
const steward = (fx: FakeGitHub, env: Env) => stewardToolHandlers(env, opts(fx), () => fx);
const sessionOf = (out: string): string => /session=(\S+)/.exec(out)![1];

const WRITE_CALLS = new Set(["commitFiles", "commitEmpty", "createBranch", "fastForward", "putFile", "createPr", "dispatch", "rerunFailed"]);
const state = (fx: FakeGitHub) => JSON.stringify({ refs: [...fx.refs].sort(), commits: fx.commits.size, prs: fx.prs.length, dispatched: fx.dispatched.length });
const writes = (fx: FakeGitHub) => fx.calls.filter((c) => WRITE_CALLS.has(c));

test("the Steward handlers are exactly three, and the cell tools stay at 11", () => {
  const fx = seed();
  assert.deepEqual(Object.keys(steward(fx, envOf())).sort(), ["steward_next", "steward_note", "steward_release"]);
  assert.equal(Object.keys(toolHandlers(envOf(), opts(fx), () => fx)).length, 11);
});

test("ADMIN_TOKEN unset: all three Steward tools are off and write nothing", async () => {
  const fx = seed();
  const h = steward(fx, envOf());
  fx.calls.length = 0;
  const before = state(fx);
  for (const key of [undefined, KEY]) {
    assert.ok((await h.steward_next({ admin_key: key })).startsWith("ADMIN_NOT_CONFIGURED"));
    assert.ok((await h.steward_note({ cell_id: "C-000", note: "hi", admin_key: key })).startsWith("ADMIN_NOT_CONFIGURED"));
    assert.ok((await h.steward_release({ session: "steward-u1", handoff: true, admin_key: key })).startsWith("ADMIN_NOT_CONFIGURED"));
  }
  assert.equal(state(fx), before);
  assert.deepEqual(writes(fx), []);
  assert.ok(!fx.refs.has("steward/lease"));
});

test("wrong or missing key: ADMIN_ONLY text, no lease, and an existing lease does not move", async () => {
  const fx = seed();
  const h = steward(fx, envOf({ ADMIN_TOKEN: KEY }));
  fx.calls.length = 0;
  const before = state(fx);
  const bad = [undefined, "", "wrong", KEY + "x"];
  for (const key of bad) {
    assert.ok((await h.steward_next({ admin_key: key })).startsWith("ADMIN_ONLY"));
    assert.ok((await h.steward_note({ cell_id: "C-000", note: "hi", admin_key: key })).startsWith("ADMIN_ONLY"));
    assert.ok((await h.steward_release({ session: "steward-u1", handoff: true, admin_key: key })).startsWith("ADMIN_ONLY"));
  }
  assert.equal(state(fx), before);
  assert.deepEqual(writes(fx), []);
  assert.ok(!fx.refs.has("steward/lease"));
  const started = await h.steward_next({ admin_key: KEY });
  const session = sessionOf(started);
  const tip = fx.refs.get("steward/lease");
  for (const key of bad) {
    assert.ok((await h.steward_next({ admin_key: key, session })).startsWith("ADMIN_ONLY"));
    assert.ok((await h.steward_release({ session, handoff: true, admin_key: key })).startsWith("ADMIN_ONLY"));
  }
  assert.equal(fx.refs.get("steward/lease"), tip);
});

test("start, refresh, release, resume", async () => {
  const fx = seed();
  const h = steward(fx, envOf({ ADMIN_TOKEN: KEY }));
  const a = await h.steward_next({ admin_key: KEY, who: "alice" });
  assert.ok(a.startsWith("STEWARD_STARTED session=steward-"), a);
  assert.ok(a.includes("repo=o/r"));
  assert.ok(a.includes("STEWARD BRIEFING for"));
  assert.ok(a.includes("WORKING RULES"));
  const session = sessionOf(a);
  assert.ok(fx.refs.has("steward/lease"));
  const tip1 = fx.refs.get("steward/lease");
  const b = await h.steward_next({ admin_key: KEY, session });
  assert.ok(b.startsWith("STEWARD_REFRESHED session=" + session), b);
  assert.ok(b.includes("STEWARD BRIEFING for"));
  assert.notEqual(fx.refs.get("steward/lease"), tip1);
  const rel = await h.steward_release({ admin_key: KEY, session, handoff: true });
  assert.ok(rel.startsWith("STEWARD_RELEASED: handed off"), rel);
  const c = await h.steward_next({ admin_key: KEY, who: "bob" });
  assert.ok(c.startsWith("STEWARD_RESUMED session="), c);
  assert.notEqual(sessionOf(c), session);
  assert.ok(c.includes("STEWARD BRIEFING for"));
});

test("a dead Steward (lease expired) is resumed by a fresh chat", async () => {
  const fx = seed();
  const h = steward(fx, envOf({ ADMIN_TOKEN: KEY }));
  const first = sessionOf(await h.steward_next({ admin_key: KEY }));
  fx.tick(DAY);
  const out = await h.steward_next({ admin_key: KEY, who: "carol" });
  assert.ok(out.startsWith("STEWARD_RESUMED session="), out);
  assert.notEqual(sessionOf(out), first);
});
