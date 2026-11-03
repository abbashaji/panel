import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as engine from "../src/engine.ts";
import { RULES } from "../src/protocol.ts";
import { FakeGitHub } from "./fakegh.ts";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = "o/r";
// C1 literal, copied from blueprint-kit/docs/contracts.md (identical text).
const C1 = /\b(CLAIMED|RESUME)\s+(C-\d+)\s+base=([0-9a-f]{7,40})\s+repo=([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/g;

beforeEach(() => engine.clearPlanCache());
function seed(): FakeGitHub {
  const fx = new FakeGitHub();
  const files: Record<string, string> = { "blueprint.yaml": readFileSync(join(here, "example/blueprint.yaml"), "utf-8") };
  for (const f of readdirSync(join(here, "example/cells"))) files[`cells/${f}`] = readFileSync(join(here, "example/cells", f), "utf-8");
  fx.commit("main", files, "plan");
  return fx;
}
let n = 0;
const o = (fx: FakeGitHub) => ({ mainBranch: "main", historyPages: 5, now: () => fx.clock, sleep: async (ms: number) => fx.tick(ms), uuid: () => `t${++n}` });
const claim = (fx: FakeGitHub) => engine.nextCell(fx, REPO, o(fx), "claim");
const min = (fx: FakeGitHub, m: number) => fx.tick(m * 60000);
const tipOid = (fx: FakeGitHub, id: string) => fx.refs.get(`cell/${id}`)!;

function check(text: string, id: string, kind: RegExp, lockOid: string) {
  const first = text.split("\n")[0];
  const m = [...first.matchAll(C1)];
  assert.equal(m.length, 1, first);
  assert.equal(m[0][1] === "CLAIMED" ? "CLAIMED" : "RESUME", m[0][1]);
  assert.match(m[0][1], kind);
  assert.equal(m[0][2], id);
  assert.equal(m[0][3], lockOid.slice(0, 7));
  assert.equal(m[0][4], REPO);
}

test("RULES contains the echo rule, one line of at most 40 words", () => {
  const line = RULES.split("\n").find((l) => l.includes("cut right after"));
  assert.ok(line, "echo rule missing");
  assert.match(line!, /CLAIMED or RESUME/);
  assert.match(line!, /repo=<owner\/name>/);
  assert.ok(line!.replace(/^- /, "").split(/\s+/).length <= 40);
});

test("critical cell, no attempt: first line matches C1, base = LOCK sha7 (not a later WIP commit)", async () => {
  const fx = seed();
  const out = await claim(fx);
  const lock = tipOid(fx, "C-000");
  assert.match(fx.commits.get(lock)!.message, /^claim\(C-000\)/);
  fx.commit("cell/C-000", { "pyproject.toml": "x" }, "WIP: later");
  check(out, "C-000", /^CLAIMED$/, lock);
  assert.notEqual(tipOid(fx, "C-000").slice(0, 7), lock.slice(0, 7));
});

test("critical cell, with attempt: RESUME after one takeover, base = takeover commit sha7", async () => {
  const fx = seed();
  await claim(fx);
  fx.commit("cell/C-000", { "pyproject.toml": "x" }, "WIP: one\n\nnext: NEXT-A");
  min(fx, 61);
  const out = await claim(fx);
  const lock = tipOid(fx, "C-000");
  assert.match(fx.commits.get(lock)!.message, /^takeover\(C-000\)/);
  assert.match(out, /attempt 1\/3/);
  fx.commit("cell/C-000", { "pyproject.toml": "y" }, "WIP: later\n\nnext: NEXT-B");
  check(out, "C-000", /^RESUME$/, lock);
});


test("non-critical cell, no attempt: CLAIMED line matches C1 with the LOCK sha7", async () => {
  const fx = seed();
  await claim(fx);
  fx.mergeCell("C-000");
  const peek = await engine.nextCell(fx, REPO, o(fx), "peek");
  assert.doesNotMatch(peek.split("\n")[0], /\[critical\]/, peek);
  const out = await claim(fx);
  const id = /^CLAIMED (C-\d+)/.exec(out)![1];
  const lock = tipOid(fx, id);
  assert.match(fx.commits.get(lock)!.message, new RegExp(`^claim\\(${id}\\)`));
  fx.commit(`cell/${id}`, {}, "WIP: later\n\nnext: X");
  check(out, id, /^CLAIMED$/, lock);
});

test("non-critical cell, with attempt: RESUME line matches C1 with the takeover sha7", async () => {
  const fx = seed();
  await claim(fx);
  fx.mergeCell("C-000");
  const first = await claim(fx);
  assert.match(first, /^CLAIMED C-\d+/);
  fx.commit(`cell/${/^CLAIMED (C-\d+)/.exec(first)![1]}`, {}, "WIP: one\n\nnext: NEXT-A");
  min(fx, 61);
  let out = "";
  for (let i = 0; i < 10 && !out.startsWith("RESUME"); i++) out = await claim(fx); // fresh cells are handed out before expired ones
  assert.match(out, /^RESUME C-\d+ .*attempt 1\/3/);
  const id = /^RESUME (C-\d+)/.exec(out)![1];
  const lock = tipOid(fx, id);
  assert.match(fx.commits.get(lock)!.message, new RegExp(`^takeover\\(${id}\\)`));
  fx.commit(`cell/${id}`, {}, "WIP: later\n\nnext: NEXT-B");
  check(out, id, /^RESUME$/, lock);
});
