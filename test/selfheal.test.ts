// selfheal.test.ts: authority, budget, problem classes, briefing size and secrets of the self-heal core.
import { test } from "node:test";
import assert from "node:assert/strict";

import { FakeGitHub } from "./fakegh.ts";
import { nextCell } from "../src/claim.ts";
import { cellSignal } from "../src/signal.ts";
import { noteCell } from "../src/steward.ts";
import { subjectOf } from "../src/trailers.ts";
import {
  BRIEFING_MAX_CHARS,
  MAX_HEALS,
  cellClear,
  cellHelp,
  cellNote,
  cellSync,
  classifyProblem,
  healsOf,
  mentionedPaths,
  ownOutsideOf,
  pathAllowed,
  type HealOptions,
} from "../src/selfheal.ts";

const REPO = "o/r";
const MIN = 60000;

interface Spec {
  after?: string[];
  goal?: string;
  allowed?: string[];
}

function cellYaml(id: string, o: Spec = {}): string {
  const after = o.after?.length ? `after: [${o.after.join(", ")}]\n` : "";
  const allowed = [`src/${id}.ts`, ...(o.allowed ?? [])].map((p) => `  - ${p}\n`).join("");
  return `id: ${id}\ntitle: Cell ${id}\ngoal: ${o.goal ?? `do ${id}`}\n${after}allowed_paths:\n${allowed}outputs:\n  - src/${id}.ts\nacceptance:\n  - cmd: "true"\n`;
}

function setup(specs: Record<string, Spec>): FakeGitHub {
  const gh = new FakeGitHub();
  const files: Record<string, string> = { "blueprint.yaml": "project: demo\nlease_minutes: 60\n" };
  for (const [id, o] of Object.entries(specs)) files[`cells/${id}.yaml`] = cellYaml(id, o);
  gh.commit("main", files, "plan");
  return gh;
}

function engine(gh: FakeGitHub, secrets?: string[]): HealOptions {
  let n = 0;
  return { mainBranch: "main", historyPages: 1, now: () => gh.clock, sleep: async () => {}, uuid: () => `u${++n}`, secrets };
}

/** Claim exactly this cell and return its base. */
async function claim(gh: FakeGitHub, id: string): Promise<string> {
  const text = await nextCell(gh, REPO, { ...engine(gh), claim: { pin: id } }, "claim");
  const m = /^CLAIMED (C-\d+) base=([0-9a-f]+)/.exec(text);
  assert.ok(m, text);
  return m[2];
}

const tipOf = (gh: FakeGitHub, id: string): string => gh.refs.get(`cell/${id}`)!;
const baseOf = (gh: FakeGitHub, id: string): string => tipOf(gh, id).slice(0, 7);
const nextBase = (text: string): string => /next base=([0-9a-f]+)/.exec(text)![1];

type Fn = (a: { cell_id: string; base: string }) => Promise<string>;
function allFns(gh: FakeGitHub, o: HealOptions): [string, Fn][] {
  return [
    ["help", (a) => cellHelp(gh, REPO, o, { ...a, problem: "x" })],
    ["note", (a) => cellNote(gh, REPO, o, { ...a, text: "n" })],
    ["sync", (a) => cellSync(gh, REPO, o, a)],
    ["clear", (a) => cellClear(gh, REPO, o, a)],
  ];
}

// ---------------------------------------------------------------- authority
test("denied: missing or wrong base, unknown cell, no branch, expired lease (nothing is written)", async () => {
  const gh = setup({ "C-001": {}, "C-002": {} });
  const o = engine(gh);
  const base = await claim(gh, "C-001");
  const before = tipOf(gh, "C-001");
  for (const [name, f] of allFns(gh, o)) {
    assert.match(await f({ cell_id: "C-001", base: "" }), /^SELFHEAL_DENIED: missing base/, name);
    const wrong = await f({ cell_id: "C-001", base: "0000000" });
    assert.match(wrong, /^SELFHEAL_DENIED: base 0000000 is not the tip/, name);
    assert.ok(!wrong.includes(base), `${name}: the answer must not reveal the real tip`);
    assert.match(await f({ cell_id: "C-999", base }), /^SELFHEAL_DENIED: unknown cell/, name);
    assert.match(await f({ cell_id: "../x", base }), /^SELFHEAL_DENIED: .* is not a cell id/, name);
    assert.match(await f({ cell_id: "C-002", base }), /^SELFHEAL_DENIED: no live lease/, name);
  }
  assert.equal(tipOf(gh, "C-001"), before);

  gh.tick(61 * MIN);
  for (const [name, f] of allFns(gh, o)) assert.match(await f({ cell_id: "C-001", base }), /^SELFHEAL_DENIED: the lease of C-001 expired/, name);
  assert.equal(tipOf(gh, "C-001"), before);
});

test("denied: a released lease", async () => {
  const gh = setup({ "C-001": {} });
  const base = await claim(gh, "C-001");
  assert.match(await cellSignal(gh, REPO, engine(gh), { cell_id: "C-001", base, kind: "release", next: "continue later" }), /^released/);
  const b2 = baseOf(gh, "C-001");
  for (const [name, f] of allFns(gh, engine(gh))) assert.match(await f({ cell_id: "C-001", base: b2 }), /^SELFHEAL_DENIED: the lease of C-001 was released/, name);
});

// ---------------------------------------------------------------- budget
test("budget: three heals, then ESCALATE everywhere; being up to date stays free", async () => {
  const gh = setup({ "C-001": {} });
  const o = engine(gh);
  let base = await claim(gh, "C-001");
  assert.equal(MAX_HEALS, 3);
  for (let i = 1; i <= MAX_HEALS; i++) {
    const r = await cellNote(gh, REPO, o, { cell_id: "C-001", base, text: `note ${i}` });
    assert.match(r, new RegExp(`^HEALED C-001: .*Heals left: ${MAX_HEALS - i} of ${MAX_HEALS}`), r);
    base = nextBase(r);
    assert.equal(base, baseOf(gh, "C-001"));
  }
  const msg = gh.commits.get(tipOf(gh, "C-001"))!.message;
  assert.equal(subjectOf(msg), "heal(C-001): note");
  assert.match(msg, /^heal: note$/m);
  assert.match(msg, /^note: note 3$/m);
  assert.equal((await healsOf(gh, REPO, "C-001")).length, MAX_HEALS);

  const before = tipOf(gh, "C-001");
  assert.match(await cellNote(gh, REPO, o, { cell_id: "C-001", base, text: "one more" }), /^ESCALATE C-001: .*cell_signal/);
  assert.match(await cellHelp(gh, REPO, o, { cell_id: "C-001", base, problem: "still stuck" }), /^ESCALATE C-001: .*cell_signal.*feedback/);
  assert.match(await cellSync(gh, REPO, o, { cell_id: "C-001", base }), /^UP_TO_DATE/);
  gh.commit("main", { "docs/x.md": "x" }, "human");
  assert.match(await cellSync(gh, REPO, o, { cell_id: "C-001", base }), /^ESCALATE/);
  assert.equal(tipOf(gh, "C-001"), before);
});

// ---------------------------------------------------------------- classification
test("classifyProblem: every class, first match wins", () => {
  const f = { behind: 0, outside: [] as string[], ownMention: false, mainRed: false, missingContract: false };
  assert.equal(classifyProblem("I need to edit package.json", { ...f, outside: ["package.json"] }), "scope_violation");
  assert.equal(classifyProblem("this is outside the allowed paths", f), "scope_violation");
  assert.equal(classifyProblem("every test fails, even untouched ones", { ...f, mainRed: true }), "broken_main");
  assert.equal(classifyProblem("the contract of the provider is unclear", f), "spec_gap");
  assert.equal(classifyProblem("what should it return?", { ...f, missingContract: true }), "spec_gap");
  assert.equal(classifyProblem("cannot find module after the merge", { ...f, behind: 2 }), "stale_branch");
  assert.equal(classifyProblem("tests fail", { ...f, behind: 1 }), "stale_branch");
  assert.equal(classifyProblem("assertion failed", { ...f, behind: 1, ownMention: true }), "own_bug");
  assert.equal(classifyProblem("TypeError in my parser", f), "own_bug");
  assert.equal(classifyProblem("hmm, not sure what to do", f), "unknown");
  assert.equal(classifyProblem("", f), "unknown");
});

test("mentionedPaths and pathAllowed", () => {
  assert.deepEqual(mentionedPaths("fails in src/a.ts:12 and ./package.json, see https://github.com/x/y/z.md and node:fs/promises and and/or"), ["src/a.ts", "package.json"]);
  assert.deepEqual(mentionedPaths("at node_modules/foo/index.js"), []);
  assert.ok(pathAllowed("src/a.ts", ["src/a.ts"]));
  assert.ok(pathAllowed("src/x/y.ts", ["src/x/"]));
  assert.ok(pathAllowed("src/x/y.ts", ["src/x"]));
  assert.ok(pathAllowed("test/a.test.ts", ["test/*.test.ts"]));
  assert.ok(!pathAllowed("test/sub/a.test.ts", ["test/*.test.ts"]));
  assert.ok(pathAllowed("test/sub/a.ts", ["test/**"]));
  assert.ok(!pathAllowed("package.json", ["src/a.ts", "src/x/"]));
});

// ---------------------------------------------------------------- the briefing
async function help(gh: FakeGitHub, id: string, problem: string, base = baseOf(gh, id)): Promise<string> {
  return cellHelp(gh, REPO, engine(gh), { cell_id: id, base, problem });
}

test("help: stale_branch (behind main) offers the exact sync call", async () => {
  const gh = setup({ "C-001": {} });
  const base = await claim(gh, "C-001");
  gh.commit("main", { "docs/y.md": "y" }, "human 1");
  const r = await help(gh, "C-001", "cannot find module './x', my branch is stale");
  assert.match(r, /^SELF-HEAL BRIEFING C-001 "Cell C-001"/);
  assert.match(r, /CLASS: stale_branch/);
  assert.match(r, /behind main by 1 commit/);
  assert.ok(r.includes(`cell_sync(repo="o/r", cell_id="C-001", base="${base}")`), r);
  assert.match(r, /BUDGET: 3 of 3 heals left/);
  assert.match(r, /ALLOWED_PATHS: src\/C-001\.ts/);
  assert.match(r, /ACCEPTANCE: true/);
  assert.equal(tipOf(gh, "C-001").slice(0, 7), base, "help is read-only");
});

test("help: scope_violation, spec_gap, own_bug and unknown", async () => {
  const gh = setup({ "C-001": {} });
  await claim(gh, "C-001");
  const scope = await help(gh, "C-001", "I need to change package.json to add a dependency");
  assert.match(scope, /CLASS: scope_violation/);
  assert.match(scope, /outside allowed_paths: package\.json/);
  assert.match(scope, /cell_signal\(.*kind="feedback"/);
  const spec = await help(gh, "C-001", "the goal is ambiguous about the return shape");
  assert.match(spec, /CLASS: spec_gap/);
  assert.match(spec, /cell_note\(repo="o\/r", cell_id="C-001"/);
  const own = await help(gh, "C-001", "assertion failed in src/C-001.ts line 12");
  assert.match(own, /CLASS: own_bug/);
  assert.match(own, /preflight\(repo="o\/r", cell_id="C-001"\)/);
  const unknown = await help(gh, "C-001", "hmm, not sure what to do");
  assert.match(unknown, /CLASS: unknown/);
  assert.match(unknown, /nothing found beyond what you reported/);
});

test("help: broken_main when the newest main run is red", async () => {
  const gh = setup({ "C-001": {} });
  await claim(gh, "C-001");
  gh.addRun("cell-gate.yml", "gate main", "completed", "failure");
  const r = await help(gh, "C-001", "all tests fail even the ones I did not touch");
  assert.match(r, /CLASS: broken_main/);
  assert.match(r, /main CI is red/);
  assert.match(r, /the Steward takes it/);
});

test("help: dependents and unmerged dependencies by id and title only", async () => {
  const gh = setup({ "C-001": {}, "C-002": { after: ["C-001"], goal: "TOPSECRETGOAL of the second cell" }, "C-003": { after: ["C-001"] } });
  await claim(gh, "C-001");
  const r = await help(gh, "C-001", "hmm");
  assert.match(r, /DEPENDENTS \(cells waiting for this one\): C-002 "Cell C-002", C-003 "Cell C-003"/);
  assert.ok(!r.includes("TOPSECRETGOAL"), "no other cell's content");

  gh.commit("cell/C-002", {}, "claim(C-002): lock t"); // a branch whose dependency C-001 is not merged
  const d = await help(gh, "C-002", "hmm");
  assert.match(d, /a dependency is not merged: C-001 "Cell C-001"/);
});

test("help: the briefing stays within its size bound whatever the cell and the problem hold", async () => {
  const many = Array.from({ length: 40 }, (_, i) => `src/area${i}/module_with_a_long_name_${i}.ts`);
  const gh = setup({ "C-001": { goal: "word ".repeat(1000).trim(), allowed: many } });
  await claim(gh, "C-001");
  for (let i = 0; i < 6; i++) await noteCell(gh, REPO, "C-001", `steward note ${i} ${"x".repeat(2100)}`);
  const problem = Array.from({ length: 30 }, (_, i) => `package${i}.json`).join(" ") + " cannot build " + "y ".repeat(1500);
  const r = await help(gh, "C-001", problem);
  assert.match(r, /^SELF-HEAL BRIEFING C-001/);
  assert.ok(r.length <= BRIEFING_MAX_CHARS, `briefing is ${r.length} chars`);
  assert.match(r, /\(steward\) steward note 5/);
});

// ---------------------------------------------------------------- secrets
test("no secret appears in any answer or in a note commit", async () => {
  const secret = "hunter2-secret";
  const token = `ghp_${"a1B2c3D4".repeat(4)}`;
  const gh = setup({ "C-001": {} });
  const o = engine(gh, [secret]);
  let base = await claim(gh, "C-001");
  const problem = `fails with ${secret} and ${token}`;
  const answers: string[] = [await cellHelp(gh, REPO, o, { cell_id: "C-001", base, problem })];
  const r = await cellNote(gh, REPO, o, { cell_id: "C-001", base, text: `use ${secret} and ${token} and GITHUB_TOKEN=abc12345` });
  answers.push(r);
  base = nextBase(r);
  answers.push(await cellSync(gh, REPO, o, { cell_id: "C-001", base }));
  answers.push(await cellClear(gh, REPO, o, { cell_id: "C-001", base }));
  answers.push(await cellHelp(gh, REPO, o, { cell_id: "C-001", base, problem }));
  answers.push(await cellNote(gh, REPO, o, { cell_id: "C-001", base: "0000000", text: secret }));
  const msg = gh.commits.get(tipOf(gh, "C-001"))!.message;
  for (const a of [...answers, msg]) {
    assert.ok(!a.includes(secret), a);
    assert.ok(!a.includes(token), a);
    assert.ok(!/GITHUB_TOKEN\s*=\s*abc12345/.test(a), a);
  }
  assert.match(msg, /\[redacted\]/);
});

// ---------------------------------------------------------------- own deliverables outside allowed_paths, spec_gap and the note reminder (C-081)
test("ownOutsideOf: only paths named in the goal or an acceptance command are own", () => {
  assert.deepEqual(ownOutsideOf(["package.json", "src/x.ts"], "add a script to package.json", ["npm test"]), ["package.json"]);
  assert.deepEqual(ownOutsideOf(["package.json"], "do it", ["node scripts/check.mjs package.json"]), ["package.json"]);
  assert.deepEqual(ownOutsideOf(["package.json"], "edit ./package.json.", []), ["package.json"]);
  assert.deepEqual(ownOutsideOf(["x.json"], "edit src/x.json", []), []);
  assert.deepEqual(ownOutsideOf(["package.json"], "do it", ["npm test"]), []);
});

test("help: scope_violation with an own deliverable starts with cell_fix replace, widened by that path only", async () => {
  const gh = setup({ "C-001": { goal: "add the dependency to package.json" } });
  await claim(gh, "C-001");
  const base = baseOf(gh, "C-001");
  const r = await help(gh, "C-001", "I need to change package.json and tsconfig.json");
  assert.match(r, /CLASS: scope_violation/);
  const lines = r.split("\n");
  const first = lines.find((l) => l.startsWith("1. "))!;
  assert.ok(first.startsWith(`1. cell_fix(repo="o/r", cell_id="C-001", base="${base}", kind="replace"`), first);
  assert.ok(first.includes('"allowed_paths": ["src/C-001.ts","package.json"]'), first);
  assert.ok(first.includes('"outputs": ["src/C-001.ts","package.json"]'), first);
  assert.ok(!first.includes("tsconfig.json"), "a path that only the problem names is not own");
  const second = lines.find((l) => l.startsWith("2. "))!;
  assert.ok(second.includes(`cell_signal(repo="o/r", cell_id="C-001", base="${base}", kind="release"`), second);
  assert.match(second, /do not continue this cell/i);
  assert.match(second, /fresh chat/);
  assert.match(r, /cell_fix\(.*kind="blocker"/);
  assert.match(r, /kind="feedback"/);
  assert.equal(tipOf(gh, "C-001").slice(0, 7), base, "help is read-only");
});

test("help: a path that is not named in the goal or acceptance does not get replace first", async () => {
  const gh = setup({ "C-001": {} });
  await claim(gh, "C-001");
  const r = await help(gh, "C-001", "I need to change package.json to add a dependency");
  const first = r.split("\n").find((l) => l.startsWith("1. "))!;
  assert.match(first, /^1\. never write outside allowed_paths/);
  assert.ok(!r.includes('kind="replace"'), "no replace for a path that is not own");
});

test("help: spec_gap says never stop after only a note; the cell_note answer carries the reminder", async () => {
  const gh = setup({ "C-001": {} });
  const base = await claim(gh, "C-001");
  const spec = await help(gh, "C-001", "the goal is ambiguous about the return shape");
  assert.match(spec, /CLASS: spec_gap/);
  assert.match(spec, /never stop after only a note/);
  assert.match(spec, /A note alone leaves the cell running and nobody sees it/);
  const r = await cellNote(gh, REPO, engine(gh), { cell_id: "C-001", base, text: "assume X" });
  assert.match(r, /^HEALED C-001: /);
  assert.ok(r.endsWith("A note does not hand the cell on: continue the cell, or file cell_signal feedback if you cannot."), r);
});
