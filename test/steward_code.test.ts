// steward_code.test.ts: one-time Steward codes (mint, consume once, expiry, repo, hash only) and authorizeSteward.
import { test } from "node:test";
import assert from "node:assert/strict";

import { FakeGitHub } from "./fakegh.ts";
import type { EngineOptions } from "../src/common.ts";
import { claimSteward, releaseSteward } from "../src/steward.ts";
import { STEWARD_CODE_TTL, authorizeSteward, consumeStewardCode, mintStewardCode } from "../src/steward_code.ts";

const REPO = "o/r";
const MIN = 60000;
const KEY = "owner-secret-4f9a1c";

function fakeKv(now: () => number) {
  const store = new Map<string, { v: string; exp: number }>();
  return {
    store,
    get: async (k: string) => {
      const e = store.get(k);
      if (!e) return null;
      if (e.exp <= now()) {
        store.delete(k);
        return null;
      }
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

function setup(): FakeGitHub {
  const gh = new FakeGitHub();
  gh.commit("main", { "blueprint.yaml": "project: demo\nlease_minutes: 60\n", "cells/C-001.yaml": "id: C-001\ntitle: t\ngoal: g\nallowed_paths:\n  - src/a.ts\noutputs:\n  - src/a.ts\nacceptance:\n  - cmd: \"true\"\n" }, "plan");
  return gh;
}

function engine(gh: FakeGitHub): EngineOptions {
  let n = 0;
  return { mainBranch: "main", historyPages: 1, now: () => gh.clock, sleep: async () => {}, uuid: () => `u${++n}` };
}

const env = { ADMIN_TOKEN: KEY };
const opt = (gh: FakeGitHub) => ({ mainBranch: "main", now: () => gh.clock });

// ---------------------------------------------------------------- codes
test("mint: 32 base64url characters, random, only the SHA-256 is stored, with a 600 s TTL", async () => {
  const gh = setup();
  const kv = fakeKv(() => gh.clock);
  const a = await mintStewardCode(kv, REPO);
  const b = await mintStewardCode(kv, REPO);
  assert.match(a, /^[A-Za-z0-9_-]{32}$/);
  assert.match(b, /^[A-Za-z0-9_-]{32}$/);
  assert.notEqual(a, b);
  assert.equal(kv.store.size, 2);
  for (const [k, e] of kv.store) {
    assert.match(k, /^stewardcode:o\/r:[0-9a-f]{64}$/);
    assert.ok(!k.includes(a) && !k.includes(b));
    assert.ok(!e.v.includes(a) && !e.v.includes(b));
    assert.equal(e.exp - gh.clock, STEWARD_CODE_TTL * 1000);
  }
  assert.equal(STEWARD_CODE_TTL, 600);
});

test("consume: true exactly once, false for used, unknown and malformed codes", async () => {
  const gh = setup();
  const kv = fakeKv(() => gh.clock);
  const code = await mintStewardCode(kv, REPO);
  assert.equal(await consumeStewardCode(kv, REPO, code), true);
  assert.equal(kv.store.size, 0);
  assert.equal(await consumeStewardCode(kv, REPO, code), false);
  const other = await mintStewardCode(kv, REPO);
  assert.equal(await consumeStewardCode(kv, REPO, "A".repeat(32)), false);
  assert.equal(await consumeStewardCode(kv, REPO, "short"), false);
  assert.equal(await consumeStewardCode(kv, REPO, ""), false);
  assert.equal(await consumeStewardCode(kv, REPO, undefined), false);
  assert.equal(await consumeStewardCode(kv, REPO, other + "x"), false);
  assert.equal(await consumeStewardCode(kv, REPO, other), true); // the failed tries did not burn it
});

test("consume: an expired code is refused", async () => {
  const gh = setup();
  const kv = fakeKv(() => gh.clock);
  const late = await mintStewardCode(kv, REPO);
  const early = await mintStewardCode(kv, REPO);
  gh.tick(599 * 1000);
  assert.equal(await consumeStewardCode(kv, REPO, early), true);
  gh.tick(2 * 1000);
  assert.equal(await consumeStewardCode(kv, REPO, late), false);
});

test("consume: a code of another repo does not work, and stays valid for its own repo", async () => {
  const gh = setup();
  const kv = fakeKv(() => gh.clock);
  const code = await mintStewardCode(kv, REPO);
  assert.equal(await consumeStewardCode(kv, "o/other", code), false);
  assert.equal(await consumeStewardCode(kv, REPO, code), true);
});

test("consume: a KV failure is a refusal, never a pass", async () => {
  const kv = {
    get: async () => {
      throw new Error("kv down");
    },
    put: async () => {},
    delete: async () => {},
  };
  assert.equal(await consumeStewardCode(kv, REPO, "A".repeat(32)), false);
});

// ---------------------------------------------------------------- authorizeSteward
test("authorize: by the admin key", async () => {
  const gh = setup();
  assert.equal(await authorizeSteward(env, gh, REPO, { admin_key: KEY }, opt(gh)), null);
  assert.match((await authorizeSteward(env, gh, REPO, { admin_key: "wrong" }, opt(gh)))!, /^ADMIN_ONLY: wrong admin_key/);
  assert.match((await authorizeSteward(env, gh, REPO, {}, opt(gh)))!, /^ADMIN_ONLY/);
  assert.match((await authorizeSteward({}, gh, REPO, { admin_key: KEY }, opt(gh)))!, /^ADMIN_NOT_CONFIGURED/);
  assert.match((await authorizeSteward({}, gh, REPO, {}, opt(gh)))!, /^ADMIN_NOT_CONFIGURED/);
});

test("authorize: by the session of the live lease, with or without an admin token", async () => {
  const gh = setup();
  const c = await claimSteward(gh, REPO, "Ann", undefined, engine(gh));
  assert.equal(await authorizeSteward(env, gh, REPO, { steward_session: c.session }, opt(gh)), null);
  assert.equal(await authorizeSteward({}, gh, REPO, { steward_session: c.session }, opt(gh)), null);
  assert.equal(await authorizeSteward(env, gh, REPO, { admin_key: "wrong", steward_session: c.session }, opt(gh)), null);
  gh.tick(59 * MIN);
  assert.equal(await authorizeSteward(env, gh, REPO, { steward_session: c.session }, opt(gh)), null);
});

test("authorize: a wrong, empty or foreign session is refused", async () => {
  const gh = setup();
  const c = await claimSteward(gh, REPO, "Ann", undefined, engine(gh));
  for (const s of ["steward-other", c.session + "x", "", "   ", undefined, 42]) {
    const out = await authorizeSteward(env, gh, REPO, { steward_session: s }, opt(gh));
    assert.ok(out !== null && /^(NOT_STEWARD|ADMIN_ONLY)/.test(out), String(out));
  }
  assert.match((await authorizeSteward(env, gh, REPO, { steward_session: "steward-other" }, opt(gh)))!, /^NOT_STEWARD/);
  assert.ok(!(await authorizeSteward(env, gh, REPO, { steward_session: "steward-other" }, opt(gh)))!.includes("steward-other"));
});

test("authorize: an expired session is refused", async () => {
  const gh = setup();
  const c = await claimSteward(gh, REPO, "Ann", undefined, engine(gh));
  gh.tick(61 * MIN);
  assert.match((await authorizeSteward(env, gh, REPO, { steward_session: c.session }, opt(gh)))!, /^NOT_STEWARD/);
});

test("authorize: a released session is refused, and so is a session when nobody holds the lease", async () => {
  const gh = setup();
  assert.match((await authorizeSteward(env, gh, REPO, { steward_session: "steward-u1" }, opt(gh)))!, /^NOT_STEWARD/);
  const o = engine(gh);
  const c = await claimSteward(gh, REPO, "Ann", undefined, o);
  assert.equal(await authorizeSteward(env, gh, REPO, { steward_session: c.session }, opt(gh)), null);
  assert.equal((await releaseSteward(gh, REPO, c.session, false, o)).ok, true);
  assert.match((await authorizeSteward(env, gh, REPO, { steward_session: c.session }, opt(gh)))!, /^NOT_STEWARD/);
});

test("authorize: a session is valid only for the repo of its lease", async () => {
  const gh = setup();
  const c = await claimSteward(gh, REPO, "Ann", undefined, engine(gh));
  const elsewhere = setup(); // another repo: no lease there
  assert.match((await authorizeSteward(env, elsewhere, "o/other", { steward_session: c.session }, opt(elsewhere)))!, /^NOT_STEWARD/);
  const second = setup();
  const d = await claimSteward(second, "o/other", "Bob", undefined, engine(second));
  assert.match((await authorizeSteward(env, second, "o/other", { steward_session: c.session }, opt(second)))!, /^NOT_STEWARD/);
  assert.equal(await authorizeSteward(env, second, "o/other", { steward_session: d.session }, opt(second)), null);
});

test("authorize: a failing GitHub read fails closed", async () => {
  const gh = setup();
  const c = await claimSteward(gh, REPO, "Ann", undefined, engine(gh));
  const broken = new Proxy(gh, {
    get(t, p, r) {
      if (p === "branchCommits" || p === "branchTip") return async () => {
        throw new Error("github down");
      };
      return Reflect.get(t, p, r);
    },
  });
  assert.match((await authorizeSteward(env, broken as any, REPO, { steward_session: c.session }, opt(gh)))!, /^NOT_STEWARD/);
});
