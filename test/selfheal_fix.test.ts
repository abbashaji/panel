// selfheal_fix.test.ts: cellFix (replace / blocker), limits, plan lock, engine-assigned ids.
import { test } from "node:test";
import assert from "node:assert/strict";

import { FakeGitHub } from "./fakegh.ts";
import { nextCell } from "../src/claim.ts";
import { cellFix, PLAN_LOCK_BRANCH } from "../src/selfheal_fix.ts";
import { cellNote, healsOf, parseHeal, type HealOptions } from "../src/selfheal.ts";

const REPO = "o/r";
const GOAL = "build the thing";

function cellYaml(id: string, extra = ""): string {
  return `id: ${id}\ntitle: Cell ${id}\ngoal: ${GOAL}\n${extra}allowed_paths:\n  - src/${id}.ts\noutputs:\n  - src/${id}.ts\nacceptance:\n  - cmd: "true"\n`;
}

/** cells: id -> extra yaml lines (e.g. "priority: 5\n") */
function setup(cells: Record<string, string>): FakeGitHub {
  const gh = new FakeGitHub();
  const files: Record<string, string> = { "blueprint.yaml": "project: demo\nlease_minutes: 60\n" };
  for (const [id, extra] of Object.entries(cells)) files[`cells/${id}.yaml`] = cellYaml(id, extra);
  gh.commit("main", files, "plan");
  return gh;
}

function engine(gh: FakeGitHub): HealOptions {
  let n = 0;
  return { mainBranch: "main", historyPages: 1, now: () => gh.clock, sleep: async () => {}, uuid: () => `u${++n}` };
}

async function claim(gh: FakeGitHub, id: string): Promise<string> {
  const text = await nextCell(gh, REPO, { ...engine(gh), claim: { pin: id } }, "claim");
  const m = /^CLAIMED (C-\d+) base=([0-9a-f]+)/.exec(text);
  assert.ok(m, text);
  return m[2];
}

const tipOf = (gh: FakeGitHub, id: string): string => gh.refs.get(`cell/${id}`)!;
const baseOf = (gh: FakeGitHub, id: string): string => tipOf(gh, id).slice(0, 7);
const msgOf = (gh: FakeGitHub, id: string): string => gh.commits.get(tipOf(gh, id))!.message;
const lockMsg = (gh: FakeGitHub): string => gh.commits.get(gh.refs.get(PLAN_LOCK_BRANCH)!)!.message;
const nextBase = (text: string): string => /next base=([0-9a-f]+)/.exec(text)![1];
const mainFile = (gh: FakeGitHub, id: string): string | undefined => gh.file("main", `cells/${id}.yaml`);

const blocker = (paths: string[], extra: Record<string, unknown> = {}) => ({
  title: "Fix main",
  goal: "make main green again",
  allowed_paths: paths,
  outputs: paths,
  acceptance: [{ cmd: "true" }],
  notes: "main is red: src/shared.ts is missing",
  ...extra,
});
const replacement = (extra: Record<string, unknown> = {}) => ({
  title: "Cell C-001 v2",
  allowed_paths: ["src/C-001.ts", "src/C-001b.ts"],
  outputs: ["src/C-001.ts", "src/C-001b.ts"],
  acceptance: [{ cmd: "true" }],
  notes: "the first contract was wrong",
  ...extra,
});

test("replace: publishes a cell that supersedes the caller's cell, keeps its goal, writes the heal trailer, releases the lock", async () => {
  const gh = setup({ "C-001": "", "C-002": "" });
  const base = await claim(gh, "C-001");
  const r = await cellFix(gh, REPO, engine(gh), { cell_id: "C-001", base, kind: "replace", cells: [replacement()] });
  assert.match(r, /^FIXED C-001: replace published C-003 /, r);
  assert.match(r, /release it with a handoff note/i);
  assert.match(r, /Heals left: 2 of 3/);
  const y = mainFile(gh, "C-003")!;
  assert.match(y, /^supersedes: \["C-001"\]$/m);
  assert.match(y, /^goal: "build the thing"$/m);
  assert.deepEqual(parseHeal(msgOf(gh, "C-001"), "C-001")?.kind, "replace");
  assert.match(msgOf(gh, "C-001"), /^heal: replace$/m);
  assert.equal((await healsOf(gh, REPO, "C-001")).length, 1);
  assert.equal(nextBase(r), baseOf(gh, "C-001"));
  assert.match(lockMsg(gh), /^release: done$/m);
});

test("blocker: new cell with top priority and a 15 minute lease; the caller's cell gets no edit", async () => {
  const gh = setup({ "C-001": "", "C-002": "priority: 5\n" });
  const base = await claim(gh, "C-001");
  const treeBefore = gh.commits.get(tipOf(gh, "C-001"))!.tree;
  const r = await cellFix(gh, REPO, engine(gh), { cell_id: "C-001", base, kind: "blocker", cells: [blocker(["src/shared.ts"])] });
  assert.match(r, /^FIXED C-001: blocker published C-003 /, r);
  assert.match(r, /only after C-003 has merged/);
  const y = mainFile(gh, "C-003")!;
  assert.match(y, /^priority: 6$/m);
  assert.match(y, /^lease_minutes: 15$/m);
  assert.match(y, /^notes: "main is red/m);
  assert.ok(!/supersedes/.test(y));
  assert.equal(gh.commits.get(tipOf(gh, "C-001"))!.tree, treeBefore, "no file of the caller's branch changed");
  assert.match(msgOf(gh, "C-001"), /^heal: blocker$/m);
  assert.match(lockMsg(gh), /^release: done$/m);
});

test("rejected when the heal budget is used up", async () => {
  const gh = setup({ "C-001": "" });
  const o = engine(gh);
  let base = await claim(gh, "C-001");
  for (let i = 0; i < 3; i++) base = nextBase(await cellNote(gh, REPO, o, { cell_id: "C-001", base, text: `note ${i}` }));
  const r = await cellFix(gh, REPO, o, { cell_id: "C-001", base, kind: "blocker", cells: [blocker(["src/shared.ts"])] });
  assert.match(r, /^ESCALATE C-001/, r);
  assert.equal(mainFile(gh, "C-003"), undefined);
  assert.equal(gh.refs.has(PLAN_LOCK_BRANCH), false, "no lock was taken");
});

test("authority: a wrong base is denied and touches nothing", async () => {
  const gh = setup({ "C-001": "" });
  await claim(gh, "C-001");
  const r = await cellFix(gh, REPO, engine(gh), { cell_id: "C-001", base: "abcdef0", kind: "blocker", cells: [blocker(["src/shared.ts"])] });
  assert.match(r, /^SELFHEAL_DENIED: base abcdef0 is not the tip/, r);
  assert.equal(gh.refs.has(PLAN_LOCK_BRANCH), false);
  assert.equal((await healsOf(gh, REPO, "C-001")).length, 0);
});

test("protected path is rejected by the plan validation, nothing written, no heal, lock released", async () => {
  const gh = setup({ "C-001": "" });
  const base = await claim(gh, "C-001");
  const r = await cellFix(gh, REPO, engine(gh), { cell_id: "C-001", base, kind: "blocker", cells: [blocker(["blueprint.yaml"])] });
  assert.match(r, /^FIX_REJECTED C-001/, r);
  assert.match(r, /protected/);
  assert.equal(mainFile(gh, "C-002"), undefined);
  assert.equal((await healsOf(gh, REPO, "C-001")).length, 0);
  assert.match(lockMsg(gh), /^release: done$/m);
});

test("superseding a foreign cell, a changed goal and a superseding blocker are rejected before any write", async () => {
  const gh = setup({ "C-001": "", "C-002": "" });
  const base = await claim(gh, "C-001");
  const o = engine(gh);
  const foreign = await cellFix(gh, REPO, o, { cell_id: "C-001", base, kind: "replace", cells: [replacement({ supersedes: ["C-002"] })] });
  assert.match(foreign, /^FIX_REJECTED C-001: cells\[0\] may supersede only your own cell C-001, not C-002/, foreign);
  const both = await cellFix(gh, REPO, o, { cell_id: "C-001", base, kind: "replace", cells: [replacement({ supersedes: ["C-001", "C-002"] })] });
  assert.match(both, /not C-002/);
  const goal = await cellFix(gh, REPO, o, { cell_id: "C-001", base, kind: "replace", cells: [replacement({ goal: "do something else" })] });
  assert.match(goal, /must keep the goal of C-001/);
  const sup = await cellFix(gh, REPO, o, { cell_id: "C-001", base, kind: "blocker", cells: [blocker(["src/shared.ts"], { supersedes: ["C-001"] })] });
  assert.match(sup, /must not supersede anything/);
  assert.equal(mainFile(gh, "C-003"), undefined);
  assert.equal((await healsOf(gh, REPO, "C-001")).length, 0);
  assert.equal(gh.refs.has(PLAN_LOCK_BRANCH), false, "rejected on input: no lock needed");
});

test("3 cells are refused; a blocker needs notes and at most 3 outputs", async () => {
  const gh = setup({ "C-001": "" });
  const base = await claim(gh, "C-001");
  const o = engine(gh);
  const three = await cellFix(gh, REPO, o, { cell_id: "C-001", base, kind: "blocker", cells: [blocker(["src/a.ts"]), blocker(["src/b.ts"]), blocker(["src/c.ts"])] });
  assert.match(three, /^TOO_MANY_CELLS C-001: at most 2 cells per call/, three);
  const noNotes = await cellFix(gh, REPO, o, { cell_id: "C-001", base, kind: "blocker", cells: [blocker(["src/a.ts"], { notes: "  " })] });
  assert.match(noNotes, /must name why in its notes/);
  const four = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"];
  const many = await cellFix(gh, REPO, o, { cell_id: "C-001", base, kind: "blocker", cells: [blocker(four)] });
  assert.match(many, /at most 3/);
  assert.equal(mainFile(gh, "C-002"), undefined);
});

test("bad overlap with a parallel cell is rejected by the plan validation", async () => {
  const gh = setup({ "C-001": "", "C-002": "" });
  const base = await claim(gh, "C-001");
  const r = await cellFix(gh, REPO, engine(gh), { cell_id: "C-001", base, kind: "blocker", cells: [blocker(["src/C-002.ts"])] });
  assert.match(r, /^FIX_REJECTED C-001/, r);
  assert.match(r, /paths overlap/);
  assert.equal(mainFile(gh, "C-003"), undefined);
  assert.equal((await healsOf(gh, REPO, "C-001")).length, 0);
  assert.match(lockMsg(gh), /^release: done$/m);
});

test("lock busy: PLAN_LOCKED with retry_after, nothing written; a stale lock is taken over", async () => {
  const gh = setup({ "C-001": "" });
  const base = await claim(gh, "C-001");
  const o = engine(gh);
  gh.commit(PLAN_LOCK_BRANCH, {}, `steward(plan-lock): acquire t\n\nwho: C-009\nat: ${new Date(gh.clock).toISOString()}`);
  const held = gh.refs.get(PLAN_LOCK_BRANCH);
  const args = { cell_id: "C-001", base, kind: "blocker", cells: [blocker(["src/shared.ts"])] };
  const r1 = await cellFix(gh, REPO, o, args);
  assert.match(r1, /^PLAN_LOCKED retry_after=90/, r1);
  gh.tick(30_000);
  assert.match(await cellFix(gh, REPO, o, args), /^PLAN_LOCKED retry_after=60/);
  assert.equal(gh.refs.get(PLAN_LOCK_BRANCH), held, "somebody else's lock is never released by a refused call");
  assert.equal(mainFile(gh, "C-002"), undefined);
  assert.equal((await healsOf(gh, REPO, "C-001")).length, 0);
  gh.tick(61_000); // 91 s: the lease of the other chat ran out
  assert.match(await cellFix(gh, REPO, o, args), /^FIXED C-001: blocker published C-002 /);
});

test("lock is released after a failure, so the next call goes through at once", async () => {
  const gh = setup({ "C-001": "" });
  const base = await claim(gh, "C-001");
  const o = engine(gh);
  const args = { cell_id: "C-001", base, kind: "blocker", cells: [blocker(["src/shared.ts"])] };
  gh.failNext["commitFiles"] = new Error("boom");
  const r = await cellFix(gh, REPO, o, args);
  assert.match(r, /^SELFHEAL_FAILED C-001: .*boom/, r);
  assert.match(lockMsg(gh), /^release: done$/m);
  assert.equal(mainFile(gh, "C-002"), undefined);
  assert.match(await cellFix(gh, REPO, o, args), /^FIXED C-001: blocker published C-002 /);
});

test("ids are assigned by the engine (next free, in order); a chosen id is refused", async () => {
  const gh = setup({ "C-001": "", "C-002": "", "C-007": "" });
  const base = await claim(gh, "C-001");
  const o = engine(gh);
  const chosen = await cellFix(gh, REPO, o, { cell_id: "C-001", base, kind: "blocker", cells: [blocker(["src/a.ts"], { id: "C-003" })] });
  assert.match(chosen, /ids are assigned by the engine/, chosen);
  const r = await cellFix(gh, REPO, o, { cell_id: "C-001", base, kind: "blocker", cells: [blocker(["src/a.ts"]), blocker(["src/b.ts"])] });
  assert.match(r, /^FIXED C-001: blocker published C-008, C-009 /, r);
  assert.match(mainFile(gh, "C-008")!, /^id: "C-008"$/m);
  assert.match(mainFile(gh, "C-009")!, /^id: "C-009"$/m);
  assert.equal(mainFile(gh, "C-003"), undefined);
});
