// Handler-level tests for the Steward tools (steward_next, steward_note, steward_release).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import * as engine from "../src/engine.ts";
import type { EngineOptions } from "../src/engine.ts";
import { stewardToolHandlers, toolHandlers, type Env } from "../src/tools.ts";
import { mintStewardCode } from "../src/steward_code.ts";
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

test("another live Steward: STEWARD_BUSY, and the lease does not move", async () => {
  const fx = seed();
  const h = steward(fx, envOf({ ADMIN_TOKEN: KEY }));
  await h.steward_next({ admin_key: KEY, who: "alice" });
  const tip = fx.refs.get("steward/lease");
  for (const session of [undefined, "steward-other"]) {
    const out = await h.steward_next({ admin_key: KEY, session, who: "mallory" });
    assert.ok(out.startsWith("STEWARD_BUSY"), out);
    assert.ok(!out.includes("STEWARD BRIEFING"));
  }
  assert.equal(fx.refs.get("steward/lease"), tip);
  const rel = await h.steward_release({ admin_key: KEY, session: "steward-other", handoff: true });
  assert.ok(rel.startsWith("NOT_STEWARD"), rel);
  assert.ok((await h.steward_release({ admin_key: KEY, handoff: true })).startsWith("NOT_STEWARD"));
  assert.equal(fx.refs.get("steward/lease"), tip);
});

test("steward_note writes on a cell with a branch and refuses the rest", async () => {
  const fx = seed();
  await engine.nextCell(fx, "o/r", opts(fx), "claim"); // C-000 has a branch
  const h = steward(fx, envOf({ ADMIN_TOKEN: KEY }));
  const tip = fx.refs.get("cell/C-000");
  const out = await h.steward_note({ admin_key: KEY, cell_id: "C-000", note: "the last chat got stuck on the import; start with the types" });
  assert.ok(out.startsWith("NOTED C-000"), out);
  assert.notEqual(fx.refs.get("cell/C-000"), tip);
  const tip2 = fx.refs.get("cell/C-000");
  assert.ok((await h.steward_note({ admin_key: KEY, cell_id: "C-900", note: "x" })).startsWith("NOT_RUNNING C-900"));
  assert.ok((await h.steward_note({ admin_key: KEY, cell_id: "not-a-cell", note: "x" })).startsWith("UNKNOWN_CELL"));
  assert.ok((await h.steward_note({ admin_key: KEY, cell_id: "C-000", note: "   " })).startsWith("EMPTY_NOTE C-000"));
  assert.ok((await h.steward_note({ admin_key: KEY, cell_id: "C-000" })).startsWith("BAD_ARGS"));
  assert.equal(fx.refs.get("cell/C-000"), tip2);
});

test("the admin key never appears in any answer", async () => {
  const fx = seed();
  await engine.nextCell(fx, "o/r", opts(fx), "claim");
  const h = steward(fx, envOf({ ADMIN_TOKEN: KEY }));
  const outs: string[] = [];
  const first = await h.steward_next({ admin_key: KEY });
  outs.push(first);
  const session = sessionOf(first);
  outs.push(await h.steward_next({ admin_key: KEY, session }));
  outs.push(await h.steward_next({ admin_key: "guess-" + KEY }));
  outs.push(await h.steward_next({ admin_key: KEY, session: "steward-other" }));
  outs.push(await h.steward_note({ admin_key: KEY, cell_id: "C-000", note: "the key is " + KEY }));
  outs.push(await h.steward_note({ admin_key: KEY, cell_id: "C-900", note: "x" }));
  outs.push(await h.steward_note({ admin_key: "nope-" + KEY, cell_id: "C-000", note: "x" }));
  outs.push(await h.steward_release({ admin_key: KEY, session: "steward-other" }));
  outs.push(await h.steward_release({ admin_key: KEY, session, handoff: true }));
  outs.push(await steward(fx, envOf()).steward_next({ admin_key: KEY }));
  // the project's own BLUEPRINT.md contains the key: the briefing must hide it
  assert.ok(first.includes("[redacted]"));
  // an error that carries the key is redacted too
  const boom = stewardToolHandlers(envOf({ ADMIN_TOKEN: KEY }), opts(fx), () => {
    throw new Error("boom " + KEY);
  });
  const err = await boom.steward_next({ admin_key: KEY });
  assert.ok(err.startsWith("ERROR:") && err.includes("[redacted]"), err);
  outs.push(err);
  for (const o of outs) assert.ok(!o.includes(KEY), o);
});

test("a refresh tells what changed since the last call (advisory KV)", async () => {
  const fx = seed();
  const claimed = await engine.nextCell(fx, "o/r", opts(fx), "claim");
  const base = /base=([0-9a-f]{7})/.exec(claimed)![1];
  const store = new Map<string, string>();
  const kv = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => {
      store.set(k, v);
    },
    delete: async (k: string) => {
      store.delete(k);
    },
  };
  const env = envOf({ ADMIN_TOKEN: KEY, OAUTH_KV: kv as any });
  const h = steward(fx, env);
  const first = await h.steward_next({ admin_key: KEY });
  assert.ok(!first.includes("CHANGES since"));
  const session = sessionOf(first);
  await toolHandlers(env, opts(fx), () => fx).cell_signal({ cell_id: "C-000", base, kind: "feedback", text: "I need a decision on the schema" });
  const second = await h.steward_next({ admin_key: KEY, session });
  assert.ok(second.startsWith("STEWARD_REFRESHED"), second);
  assert.ok(second.includes("CHANGES since your last steward_next: new problems: C-000"), second);
});

// ---------------------------------------------------------------- one-time code start, session auth, one shot
function fakeKv(now: () => number) {
  const store = new Map<string, { v: string; exp: number }>();
  return {
    store,
    get: async (k: string) => {
      const e = store.get(k);
      if (!e || e.exp <= now()) return null;
      return e.v;
    },
    put: async (k: string, v: string, o?: { expirationTtl?: number }) => {
      store.set(k, { v, exp: now() + (o?.expirationTtl ?? 1e9) * 1000 });
    },
    delete: async (k: string) => {
      store.delete(k);
    },
  };
}

test("steward_next starts with a one-time code, without any admin key, and the code works once", async () => {
  const fx = seed();
  const kv = fakeKv(() => fx.clock);
  const h = steward(fx, envOf({ ADMIN_TOKEN: KEY, OAUTH_KV: kv as any }));
  const code = await mintStewardCode(kv, "o/r");
  const started = await h.steward_next({ code, who: "alice" });
  assert.ok(started.startsWith("STEWARD_STARTED session=steward-"), started);
  assert.ok(started.includes("repo=o/r"));
  assert.ok(started.includes("STEWARD BRIEFING for"));
  assert.ok(started.includes("ONE SHOT"));
  assert.ok(started.includes("steward_session=" + sessionOf(started)));
  assert.ok(!/45 seconds|at most 8 times/.test(started));
  assert.ok(!started.includes(code));
  assert.ok(fx.refs.has("steward/lease"));
  const tip = fx.refs.get("steward/lease");
  const again = await h.steward_next({ code });
  assert.ok(again.startsWith("STEWARD_CODE_INVALID"), again);
  assert.ok(!again.includes(code));
  assert.equal(fx.refs.get("steward/lease"), tip);
});

test("a code works without ADMIN_TOKEN; bad, foreign and missing-store codes are refused and write nothing", async () => {
  const fx = seed();
  const kv = fakeKv(() => fx.clock);
  const h = steward(fx, envOf({ OAUTH_KV: kv as any }));
  fx.calls.length = 0;
  for (const bad of ["A".repeat(32), "nope", await mintStewardCode(kv, "o/other")]) {
    assert.ok((await h.steward_next({ code: bad })).startsWith("STEWARD_CODE_INVALID"));
  }
  assert.deepEqual(writes(fx), []);
  assert.ok(!fx.refs.has("steward/lease"));
  assert.ok((await steward(fx, envOf()).steward_next({ code: "A".repeat(32) })).startsWith("STEWARD_CODE_UNAVAILABLE"));
  const started = await h.steward_next({ code: await mintStewardCode(kv, "o/r") });
  assert.ok(started.startsWith("STEWARD_STARTED"), started);
  // an expired code is refused
  const old = await mintStewardCode(kv, "o/r");
  fx.tick(601 * 1000);
  assert.ok((await h.steward_next({ code: old })).startsWith("STEWARD_CODE_INVALID"));
});

test("a live Steward holds the lease: a second valid code gets STEWARD_BUSY", async () => {
  const fx = seed();
  const kv = fakeKv(() => fx.clock);
  const h = steward(fx, envOf({ OAUTH_KV: kv as any }));
  await h.steward_next({ code: await mintStewardCode(kv, "o/r"), who: "alice" });
  const tip = fx.refs.get("steward/lease");
  const out = await h.steward_next({ code: await mintStewardCode(kv, "o/r"), who: "mallory" });
  assert.ok(out.startsWith("STEWARD_BUSY"), out);
  assert.equal(fx.refs.get("steward/lease"), tip);
});

test("steward_session replaces the admin key for next, note, release, takeover and publish_plan", async () => {
  const fx = seed();
  await engine.nextCell(fx, "o/r", opts(fx), "claim"); // C-000 has a branch
  const kv = fakeKv(() => fx.clock);
  const env = envOf({ OAUTH_KV: kv as any }); // no ADMIN_TOKEN at all
  const h = steward(fx, env);
  const cells = toolHandlers(env, opts(fx), () => fx);
  const session = sessionOf(await h.steward_next({ code: await mintStewardCode(kv, "o/r") }));

  assert.ok((await h.steward_next({ steward_session: session })).startsWith("STEWARD_REFRESHED session=" + session));
  const noted = await h.steward_note({ steward_session: session, cell_id: "C-000", note: "start with the types" });
  assert.ok(noted.startsWith("NOTED C-000"), noted);
  assert.ok((await cells.publish_plan({ steward_session: session, cells: [] })).startsWith("NOTHING_TO_PUBLISH"));
  const tk = await cells.takeover({ steward_session: session, cell_id: "C-000" });
  assert.ok(!/^(ADMIN_|NOT_STEWARD)/.test(tk), tk);

  // a wrong session or no credentials: refused, nothing written
  fx.calls.length = 0;
  const before = state(fx);
  assert.ok((await h.steward_next({ steward_session: "steward-other" })).startsWith("NOT_STEWARD"));
  assert.ok((await h.steward_note({ steward_session: "steward-other", cell_id: "C-000", note: "x" })).startsWith("NOT_STEWARD"));
  assert.ok((await h.steward_release({ steward_session: "steward-other" })).startsWith("NOT_STEWARD"));
  assert.ok((await cells.publish_plan({ steward_session: "steward-other", cells: [] })).startsWith("NOT_STEWARD"));
  assert.ok((await cells.takeover({ steward_session: "steward-other", cell_id: "C-000", force: true })).startsWith("NOT_STEWARD"));
  assert.ok((await h.steward_note({ cell_id: "C-000", note: "x" })).startsWith("ADMIN_NOT_CONFIGURED"));
  assert.equal(state(fx), before);
  assert.deepEqual(writes(fx), []);

  // the session ends with the release: it opens nothing any more
  const rel = await h.steward_release({ steward_session: session });
  assert.ok(rel.startsWith("STEWARD_RELEASED"), rel);
  assert.ok((await h.steward_note({ steward_session: session, cell_id: "C-000", note: "x" })).startsWith("NOT_STEWARD"));
  assert.ok((await cells.publish_plan({ steward_session: session, cells: [] })).startsWith("NOT_STEWARD"));
  assert.ok((await cells.takeover({ steward_session: session, cell_id: "C-000" })).startsWith("NOT_STEWARD"));
});

test("an expired steward_session opens nothing; the admin key still works as before", async () => {
  const fx = seed();
  const kv = fakeKv(() => fx.clock);
  const env = envOf({ ADMIN_TOKEN: KEY, OAUTH_KV: kv as any });
  const h = steward(fx, env);
  const cells = toolHandlers(env, opts(fx), () => fx);
  const session = sessionOf(await h.steward_next({ code: await mintStewardCode(kv, "o/r") }));
  fx.tick(DAY);
  assert.ok((await h.steward_note({ steward_session: session, cell_id: "C-000", note: "x" })).startsWith("NOT_STEWARD"));
  assert.ok((await cells.publish_plan({ steward_session: session, cells: [] })).startsWith("NOT_STEWARD"));
  assert.ok((await cells.publish_plan({ admin_key: KEY, cells: [] })).startsWith("NOTHING_TO_PUBLISH"));
  assert.ok((await cells.publish_plan({ cells: [] })).startsWith("ADMIN_ONLY"));
});

test("neither the code nor the admin key appears in any answer of the code flow", async () => {
  const fx = seed();
  const kv = fakeKv(() => fx.clock);
  const h = steward(fx, envOf({ ADMIN_TOKEN: KEY, OAUTH_KV: kv as any }));
  const code = await mintStewardCode(kv, "o/r");
  const outs: string[] = [];
  const first = await h.steward_next({ code });
  outs.push(first, await h.steward_next({ code }), await h.steward_next({ code: "bad-" + code }));
  const session = sessionOf(first);
  outs.push(await h.steward_next({ steward_session: session, code: "x" + code }));
  outs.push(await h.steward_note({ steward_session: session, cell_id: "C-900", note: "the code is " + code + " and the key " + KEY }));
  outs.push(await h.steward_release({ steward_session: session }));
  for (const o of outs) assert.ok(!o.includes(code) && !o.includes(KEY), o);
});
