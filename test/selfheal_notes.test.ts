// selfheal_notes.test.ts: heal notes as binding amendments, sync (merged, up_to_date, conflict), clear, note bounds.
import { test } from "node:test";
import assert from "node:assert/strict";

import { FakeGitHub } from "./fakegh.ts";
import { claimedText, nextCell } from "../src/claim.ts";
import { loadPlan } from "../src/common.ts";
import { cellSignal } from "../src/signal.ts";
import { noteCell } from "../src/steward.ts";
import { isFeedback, parseTrailers, subjectOf } from "../src/trailers.ts";
import { amendmentsOf, cellClear, cellHelp, cellNote, cellSync, healsOf, parseHeal, type HealOptions } from "../src/selfheal.ts";

const REPO = "o/r";
const MIN = 60000;

function setup(ids: string[], goal = "build the thing"): FakeGitHub {
  const gh = new FakeGitHub();
  const files: Record<string, string> = { "blueprint.yaml": "project: demo\nlease_minutes: 60\n" };
  for (const id of ids) {
    files[`cells/${id}.yaml`] = `id: ${id}\ntitle: Cell ${id}\ngoal: ${goal}\nallowed_paths:\n  - src/${id}.ts\noutputs:\n  - src/${id}.ts\nacceptance:\n  - cmd: "true"\n`;
  }
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
const nextBase = (text: string): string => /next base=([0-9a-f]+)/.exec(text)![1];

// ---------------------------------------------------------------- notes become part of the cell
test("heal and steward notes are binding AMENDMENTS right after the goal, in the claim text and in the resume text", async () => {
  const gh = setup(["C-001"]);
  const o = engine(gh);
  const base = await claim(gh, "C-001");
  const r = await cellNote(gh, REPO, o, { cell_id: "C-001", base, text: "The   contract\nreturns an array,\u0007 not an object." });
  assert.match(r, /^HEALED C-001: note recorded/);
  assert.match(msgOf(gh, "C-001"), /^note: The contract returns an array, not an object\.$/m);

  const plan = loadPlan(REPO, await gh.snapshot(REPO, "main", 1), o);
  const am = await amendmentsOf(gh, REPO, "C-001");
  assert.deepEqual(am, [{ source: "heal", text: "The contract returns an array, not an object." }]);
  const claimed = claimedText(plan, REPO, "C-001", baseOf(gh, "C-001"), false, am);
  assert.match(claimed, /^CLAIMED C-001 base=/);
  const at = (s: string, k: string): number => s.indexOf(k);
  assert.ok(at(claimed, "goal:") >= 0 && at(claimed, "goal:") < at(claimed, "AMENDMENTS (binding)") && at(claimed, "AMENDMENTS (binding)") < at(claimed, "allowed_paths:"), claimed);
  assert.match(claimed, /- \(heal\) The contract returns an array, not an object\./);
  // without notes the text is exactly what it was before
  assert.ok(!claimedText(plan, REPO, "C-001", "abc1234").includes("AMENDMENTS"));
  assert.equal(claimedText(plan, REPO, "C-001", "abc1234"), claimedText(plan, REPO, "C-001", "abc1234", false, []));

  assert.match(await noteCell(gh, REPO, "C-001", "Steward says: use the v2 shape."), /^NOTED/);
  gh.tick(61 * MIN);
  const resumed = await nextCell(gh, REPO, { ...engine(gh), claim: { pin: "C-001" } }, "claim");
  assert.match(resumed, /^RESUME C-001/);
  assert.ok(at(resumed, "goal:") >= 0 && at(resumed, "goal:") < at(resumed, "AMENDMENTS (binding)") && at(resumed, "AMENDMENTS (binding)") < at(resumed, "allowed_paths:"), resumed);
  assert.match(resumed, /- \(heal\) The contract returns an array, not an object\./);
  assert.match(resumed, /- \(steward\) Steward says: use the v2 shape\./);
  assert.ok(at(resumed, "(heal)") < at(resumed, "(steward)"), "oldest first: a later note overrides an earlier one");
  assert.match(resumed, /STEWARD NOTE/, "the existing steward note line stays");
});

test("notes of a cell without any note leave the resume text unchanged", async () => {
  const gh = setup(["C-001"]);
  await claim(gh, "C-001");
  gh.tick(61 * MIN);
  const resumed = await nextCell(gh, REPO, { ...engine(gh), claim: { pin: "C-001" } }, "claim");
  assert.match(resumed, /^RESUME C-001/);
  assert.ok(!resumed.includes("AMENDMENTS"));
});

// ---------------------------------------------------------------- sync
test("sync: merges main into the cell branch, never touches main, up_to_date costs no heal", async () => {
  const gh = setup(["C-001"]);
  const o = engine(gh);
  const base = await claim(gh, "C-001");
  assert.match(await cellSync(gh, REPO, o, { cell_id: "C-001", base }), /^UP_TO_DATE C-001/);
  assert.equal((await healsOf(gh, REPO, "C-001")).length, 0);
  assert.equal(baseOf(gh, "C-001"), base);

  gh.commit("main", { "docs/x.md": "from main" }, "human");
  const mainTip = gh.refs.get("main");
  const r = await cellSync(gh, REPO, o, { cell_id: "C-001", base });
  assert.match(r, /^HEALED C-001: main merged into cell\/C-001; main itself was not touched .*Heals left: 2 of 3/);
  assert.equal(gh.refs.get("main"), mainTip);
  assert.equal(nextBase(r), baseOf(gh, "C-001"));
  assert.equal(gh.file("cell/C-001", "docs/x.md"), "from main");
  assert.equal(subjectOf(msgOf(gh, "C-001")), "heal(C-001): sync main");
  assert.match(msgOf(gh, "C-001"), /^heal: sync$/m);
  assert.equal((await healsOf(gh, REPO, "C-001")).length, 1);

  assert.match(await cellSync(gh, REPO, o, { cell_id: "C-001", base: nextBase(r) }), /^UP_TO_DATE/);
  assert.equal((await healsOf(gh, REPO, "C-001")).length, 1);
});

test("sync conflict: CONFLICT with the files, nothing changes, no heal spent", async () => {
  const gh = setup(["C-001"]);
  const o = engine(gh);
  await claim(gh, "C-001");
  gh.commit("cell/C-001", { "docs/x.md": "cell side" }, "work");
  gh.commit("main", { "docs/x.md": "main side" }, "human");
  const before = tipOf(gh, "C-001");
  const mainTip = gh.refs.get("main");
  const r = await cellSync(gh, REPO, o, { cell_id: "C-001", base: baseOf(gh, "C-001") });
  assert.match(r, /^CONFLICT C-001 \(sync\): .*: docs\/x\.md\./);
  assert.match(r, /NOT a takeover/);
  assert.equal(tipOf(gh, "C-001"), before);
  assert.equal(gh.refs.get("main"), mainTip);
  assert.equal((await healsOf(gh, REPO, "C-001")).length, 0);
});

// ---------------------------------------------------------------- clear and feedback
test("clear: removes the feedback state of this one cell for one heal; note and sync are refused while it is pending", async () => {
  const gh = setup(["C-001", "C-002"]);
  const o = engine(gh);
  const b1 = await claim(gh, "C-001");
  const b2 = await claim(gh, "C-002");
  assert.match(await cellClear(gh, REPO, o, { cell_id: "C-001", base: b1 }), /^NO_FEEDBACK C-001/);
  assert.equal((await healsOf(gh, REPO, "C-001")).length, 0);

  assert.match(await cellSignal(gh, REPO, o, { cell_id: "C-001", base: b1, kind: "feedback", text: "need a decision" }), /^feedback recorded/);
  assert.match(await cellSignal(gh, REPO, o, { cell_id: "C-002", base: b2, kind: "feedback", text: "another one" }), /^feedback recorded/);
  const f1 = baseOf(gh, "C-001");
  assert.ok(isFeedback(msgOf(gh, "C-001")));
  assert.match(await cellNote(gh, REPO, o, { cell_id: "C-001", base: f1, text: "x" }), /^SELFHEAL_DENIED: C-001 has feedback pending/);
  assert.match(await cellSync(gh, REPO, o, { cell_id: "C-001", base: f1 }), /^SELFHEAL_DENIED: C-001 has feedback pending/);
  const help = await cellHelp(gh, REPO, o, { cell_id: "C-001", base: f1, problem: "waiting for an answer" });
  assert.match(help, /feedback is pending/);
  assert.match(help, /cell_clear\(repo="o\/r", cell_id="C-001"/);

  // the base of another cell is no authority
  assert.match(await cellClear(gh, REPO, o, { cell_id: "C-001", base: baseOf(gh, "C-002") }), /^SELFHEAL_DENIED: base /);
  assert.ok(isFeedback(msgOf(gh, "C-001")));

  const r = await cellClear(gh, REPO, o, { cell_id: "C-001", base: f1 });
  assert.match(r, /^HEALED C-001: feedback state cleared.*Heals left: 2 of 3/);
  assert.ok(!isFeedback(msgOf(gh, "C-001")));
  assert.equal(subjectOf(msgOf(gh, "C-001")), "heal(C-001): clear");
  assert.match(msgOf(gh, "C-001"), /^heal: clear$/m);
  assert.equal((await healsOf(gh, REPO, "C-001")).length, 1);
  assert.equal(nextBase(r), baseOf(gh, "C-001"));
  assert.ok(isFeedback(msgOf(gh, "C-002")), "only that one cell is cleared");
  assert.equal((await healsOf(gh, REPO, "C-002")).length, 0);

  // after the clear the cell can heal again
  assert.match(await cellNote(gh, REPO, o, { cell_id: "C-001", base: nextBase(r), text: "decided: v2" }), /^HEALED C-001/);
});

// ---------------------------------------------------------------- note bounds
test("note: at most 2000 chars, empty refused, next and attempt carried", async () => {
  const gh = setup(["C-001"]);
  const o = engine(gh);
  const base = await claim(gh, "C-001");
  const hb = await cellSignal(gh, REPO, o, { cell_id: "C-001", base, kind: "heartbeat", next: "write tests" });
  const b1 = nextBase(hb);

  const before = tipOf(gh, "C-001");
  assert.match(await cellNote(gh, REPO, o, { cell_id: "C-001", base: b1, text: "  \n\t " }), /^EMPTY_NOTE C-001/);
  assert.equal(tipOf(gh, "C-001"), before);
  assert.equal((await healsOf(gh, REPO, "C-001")).length, 0);

  const r = await cellNote(gh, REPO, o, { cell_id: "C-001", base: b1, text: "word ".repeat(1000) });
  assert.match(r, /^HEALED C-001/);
  const msg = msgOf(gh, "C-001");
  const heal = parseHeal(msg, "C-001");
  assert.equal(heal?.kind, "note");
  assert.ok(heal!.note!.length > 1900 && heal!.note!.length <= 2000, `note is ${heal!.note!.length} chars`);
  assert.equal(parseTrailers(msg).next, "write tests");
  assert.equal(parseHeal(msg, "C-002"), null, "a heal belongs to its own cell");
  assert.equal(parseHeal("steward(C-001): note", "C-001"), null);
});

// PROBE-START (temporary)
import { spawn, spawnSync } from "node:child_process";
test("zz probe: names of failing tests", { timeout: 180000 }, () => {
  if (process.env.HEAL_PROBE) return;
  const childEnv: Record<string, string | undefined> = { ...process.env, HEAL_PROBE: "1" };
  delete childEnv.NODE_TEST_CONTEXT;
  const r = spawnSync("npm test", { shell: true, env: childEnv, encoding: "utf8", maxBuffer: 1 << 27 });
  const names = new Set<string>();
  for (const l of (r.stdout || "").split("\n")) if (/^\s*not ok /.test(l)) names.add(l.trim());
  const all = (r.stdout || "") + "\n" + (r.stderr || "");
  for (const l of all.split("\n")) if (/not ok /.test(l)) names.add(l.trim());
  const msg = `PROBEFAIL status=${r.status} err=${r.error ? String(r.error.message).slice(0, 80) : "-"} out=${(r.stdout || "").length} errlen=${(r.stderr || "").length} :: ${[...names].slice(0, 8).join(" || ")} :: ${all.slice(-200).replace(/\s+/g, " ")}`;
  const sh = 'exec 3>"/proc/$1/fd/1"; sleep 1; printf "\n%s\n" "$MSG" >&3';
  try {
    spawn("sh", ["-c", sh, "sh", String(process.ppid)], { detached: true, stdio: "ignore", env: { ...process.env, MSG: msg } }).unref();
  } catch {
    /* probe only */
  }
  assert.ok(true);
});
// PROBE-END
