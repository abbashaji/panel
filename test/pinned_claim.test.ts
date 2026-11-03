// Pinned claim and reservation (docs/panel-contracts.md, 'pinned claim and reservation').
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import * as engine from "../src/engine.ts";
import { getReservation, reserveKey, setReservation, type ClaimContext, type ClaimOptions, type ReserveKv } from "../src/claim.ts";
import { toolHandlers, type Env } from "../src/tools.ts";
import { FakeGitHub } from "./fakegh.ts";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = "o/r";

beforeEach(() => engine.clearPlanCache());

/** In-memory KV with TTL on the fake GitHub clock. No parameter properties: Node only strips types. */
class FakeKv implements ReserveKv {
  store = new Map<string, { v: string; exp: number | null }>();
  ttl: Record<string, number | undefined> = {};
  now: () => number;
  constructor(now: () => number) {
    this.now = now;
  }
  async get(key: string) {
    const e = this.store.get(key);
    if (!e) return null;
    if (e.exp !== null && this.now() >= e.exp) {
      this.store.delete(key);
      return null;
    }
    return e.v;
  }
  async put(key: string, value: string, o?: { expirationTtl?: number }) {
    this.ttl[key] = o?.expirationTtl;
    this.store.set(key, { v: value, exp: o?.expirationTtl ? this.now() + o.expirationTtl * 1000 : null });
  }
  async delete(key: string) {
    this.store.delete(key);
  }
}

function seed(): FakeGitHub {
  const fx = new FakeGitHub();
  const files: Record<string, string> = { "blueprint.yaml": readFileSync(join(here, "example/blueprint.yaml"), "utf-8") };
  for (const f of readdirSync(join(here, "example/cells"))) files[`cells/${f}`] = readFileSync(join(here, "example/cells", f), "utf-8");
  fx.commit("main", files, "plan");
  return fx;
}

function opts(fx: FakeGitHub, claim?: ClaimContext): ClaimOptions {
  let n = 0;
  return {
    mainBranch: "main",
    historyPages: 5,
    now: () => fx.clock,
    sleep: async (ms) => {
      fx.tick(ms);
    },
    uuid: () => `u${++n}`,
    claim,
  };
}

const base7 = (text: string) => /base=([0-9a-f]{7})/.exec(text)![1];
const branches = (fx: FakeGitHub) => [...fx.refs.keys()].filter((k) => k.startsWith("cell/")).sort();
const pinned = (fx: FakeGitHub, kv: ReserveKv, cell: string, who?: string) => engine.nextCell(fx, REPO, opts(fx, { kv, who, pin: cell }), "claim");
const plain = (fx: FakeGitHub, kv: ReserveKv, who?: string) => engine.nextCell(fx, REPO, opts(fx, { kv, who }), "claim");

/** The skeleton C-000 is merged: C-001 and C-002 are ready, the rest waits. */
async function afterSkeleton(): Promise<FakeGitHub> {
  const fx = seed();
  assert.match(await engine.nextCell(fx, REPO, opts(fx), "claim"), /^CLAIMED C-000/);
  fx.commit("cell/C-000", { "pyproject.toml": "x" }, "WIP");
  fx.mergeCell("C-000");
  return fx;
}

test("a pinned call claims exactly the chosen ready cell, with the usual CLAIMED line", async () => {
  const fx = await afterSkeleton();
  const kv = new FakeKv(() => fx.clock);
  const out = await pinned(fx, kv, "C-002");
  assert.match(out, /^CLAIMED C-002 base=[0-9a-f]{7} repo=o\/r \(lease /);
  assert.match(out, /id: C-002/);
  assert.match(out, /\nRULES\n/);
  assert.deepEqual(branches(fx), ["cell/C-002"]); // C-001 was ready first, but was not asked for
  assert.equal(base7(out), fx.refs.get("cell/C-002")!.slice(0, 7));
});

test("a pinned call for a cell that is not ready answers NOT_READY and never falls back", async () => {
  const fx = seed(); // only C-000 is ready
  const kv = new FakeKv(() => fx.clock);
  assert.match(await pinned(fx, kv, "C-001"), /^NOT_READY C-001 waiting for C-000/);
  assert.match(await pinned(fx, kv, "C-999"), /^NOT_READY C-999 unknown cell/);
  assert.match(await pinned(fx, kv, "nope"), /^NOT_READY \? invalid cell id/);
  assert.deepEqual(branches(fx), []); // C-000 was ready, yet nothing was claimed

  assert.match(await pinned(fx, kv, "C-000"), /^CLAIMED C-000/);
  assert.match(await pinned(fx, kv, "C-000"), /^NOT_READY C-000 running/);
  fx.commit("cell/C-000", { "pyproject.toml": "x" }, "WIP");
  fx.mergeCell("C-000");
  assert.match(await pinned(fx, kv, "C-000"), /^NOT_READY C-000 done/);
  assert.deepEqual(branches(fx), []);
});

test("a cell reserved for someone else answers RESERVED; the reserver and a call without who may claim it", async () => {
  const fx = await afterSkeleton();
  const kv = new FakeKv(() => fx.clock);
  await setReservation(kv, REPO, "C-002", "Ann");
  assert.equal(kv.ttl[reserveKey(REPO, "C-002")], 600);
  assert.equal(reserveKey(REPO, "C-002"), "reserve:o/r:C-002");
  const stored = await getReservation(kv, REPO, "C-002");
  assert.equal(stored!.who, "Ann");
  assert.ok(!Number.isNaN(Date.parse(stored!.at)));

  assert.equal(await pinned(fx, kv, "C-002", "Bob"), "RESERVED C-002 by Ann");
  assert.deepEqual(branches(fx), []);
  assert.match(await pinned(fx, kv, "C-002", "Ann"), /^CLAIMED C-002 /);
  assert.equal(await getReservation(kv, REPO, "C-002"), null); // deleted on CLAIMED

  await setReservation(kv, REPO, "C-001", "Ann"); // contract 7(a): no who on the call = no conflict, the git lock arbitrates
  assert.match(await pinned(fx, kv, "C-001"), /^CLAIMED C-001 /);
  assert.equal(await getReservation(kv, REPO, "C-001"), null);
});
