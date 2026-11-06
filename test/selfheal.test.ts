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
