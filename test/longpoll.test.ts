import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as engine from "../src/engine.ts";
import { nextCell } from "../src/claim.ts";
import { MAX_POLLS, MAX_WAIT_SECONDS, nextCellWait } from "../src/longpoll.ts";
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
function o(fx: FakeGitHub, sleeps: number[] = []) {
  return { mainBranch: "main", historyPages: 5, now: () => fx.clock, sleep: async (ms: number) => { sleeps.push(ms); fx.tick(ms); }, uuid: () => `lp${++n}` };
}
const min = (fx: FakeGitHub, m: number) => fx.tick(m * 60000);
function counting(fx: FakeGitHub) {
  const c = { snapshots: 0 };
  const api = new Proxy(fx, {
    get(t, p, r) {
      const v = Reflect.get(t, p, r);
      if (p === "snapshot") return (...a: any[]) => { c.snapshots++; return (v as any).apply(t, a); };
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  return { api, c };
}

test("wait 0 (and negative) equals plain nextCell, no sleep", async () => {
  const fx = seed();
  await nextCell(fx, REPO, o(fx), "claim"); // C-000 claimed, others blocked
  const sleeps: number[] = [];
  const plain = await nextCell(fx, REPO, o(fx), "claim");
  assert.match(plain, /^NONE_READY/);
  assert.equal(await nextCellWait(fx, REPO, o(fx, sleeps), 0), plain);
  assert.equal(await nextCellWait(fx, REPO, o(fx, sleeps), -5), plain);
  assert.deepEqual(sleeps, []);
});

test("CLAIMED returns at once without sleeping", async () => {
  const fx = seed();
  const sleeps: number[] = [];
  const out = await nextCellWait(fx, REPO, o(fx, sleeps), 60);
  assert.match(out, /^CLAIMED C-000/);
  assert.deepEqual(sleeps, []);
});

test("ALL_DONE returns at once without sleeping", async () => {
  const fx = new FakeGitHub();
  const files: Record<string, string> = { "blueprint.yaml": readFileSync(join(here, "example/blueprint.yaml"), "utf-8") };
  for (const f of readdirSync(join(here, "example/cells"))) files[`cells/${f}`] = readFileSync(join(here, "example/cells", f), "utf-8");
  fx.commit("main", files, "plan");
  for (let i = 0; i < 6; i++) fx.commit("main", { [`done${i}.txt`]: "x" }, `cell(C-00${i}): done`);
  const sleeps: number[] = [];
  const out = await nextCellWait(fx, REPO, o(fx, sleeps), 60);
  assert.match(out, /^ALL_DONE/);
  assert.deepEqual(sleeps, []);
});

test("a lease that expires 30 s into the wait yields RESUME", async () => {
  const fx = seed();
  await nextCell(fx, REPO, o(fx), "claim"); // C-000, critical, 15 min lease
  fx.tick(15 * 60000 - 30000); // 30 s before expiry
  const sleeps: number[] = [];
  const out = await nextCellWait(fx, REPO, o(fx, sleeps), 60);
  assert.match(out, /^RESUME C-000/);
  assert.ok(sleeps.length >= 1 && sleeps.length <= 4, `sleeps ${sleeps}`);
  assert.doesNotMatch(out, /retry_after/);
});

test("nothing frees: ends with retry_after=45 and at most MAX_POLLS snapshots", async () => {
  const fx = seed();
  await nextCell(fx, REPO, o(fx), "claim");
  min(fx, 3);
  const { api, c } = counting(fx);
  const sleeps: number[] = [];
  const out = await nextCellWait(api, REPO, o(fx, sleeps), 60);
  assert.match(out, /^NONE_READY/);
  // 15 min lease - 3 min idle - 50 s waited = 11.2 min, rounded by render()
  assert.match(out.split("\n").at(-1)!, /^retry_after=45 \(next lease expiry in ~11 min\)$/);
  assert.ok(c.snapshots >= 1 && c.snapshots <= MAX_POLLS, `snapshots ${c.snapshots}`);
  assert.ok(sleeps.every((s) => s <= 10_000));
});

test("wait 500 is clamped to 60 s", async () => {
  const fx = seed();
  await nextCell(fx, REPO, o(fx), "claim");
  const start = fx.clock;
  const sleeps: number[] = [];
  const out = await nextCellWait(fx, REPO, o(fx, sleeps), 500);
  assert.match(out, /retry_after=45/);
  assert.ok(fx.clock - start <= MAX_WAIT_SECONDS * 1000, `waited ${fx.clock - start} ms`);
  assert.equal(sleeps.length, MAX_POLLS - 1);
});

test("a short wait sleeps only the remaining time", async () => {
  const fx = seed();
  await nextCell(fx, REPO, o(fx), "claim");
  const sleeps: number[] = [];
  await nextCellWait(fx, REPO, o(fx, sleeps), 15);
  assert.deepEqual(sleeps.slice(0, 2), [10_000, 5_000]);
});

test("lease-expiry hint only appears when running cells with a lease exist", async () => {
  const fx = seed();
  await nextCell(fx, REPO, o(fx), "claim");
  min(fx, 16); // lease expired, but an active CI run keeps C-000 locked: running: C-000(CI<=..m)
  fx.addRun("cell-gate.yml", "gate cell/C-000", "in_progress", null, 5);
  const ci = await nextCellWait(fx, REPO, o(fx), 20);
  assert.match(ci, /running: C-000\(CI<=\d+m\)/);
  assert.match(ci, /\nretry_after=45$/);
  assert.doesNotMatch(ci, /next lease expiry/);

  const fx2 = seed();
  await nextCell(fx2, REPO, o(fx2), "claim");
  const lease = await nextCellWait(fx2, REPO, o(fx2), 20);
  assert.match(lease, /\nretry_after=45 \(next lease expiry in ~\d+ min\)$/);
});
