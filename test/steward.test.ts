// steward.test.ts: lease, claim, release, problem ordering, notes and briefing of the Steward.
import { test } from "node:test";
import assert from "node:assert/strict";

import { FakeGitHub } from "./fakegh.ts";
import { mergedOf, type EngineOptions } from "../src/common.ts";
import { BRANCH_RE, SUBJECT_RE, claimsFromBranches, loadCells, loadConfig } from "../src/plan.ts";
import { isFeedback, isRelease, parseTrailers, stewardNote, subjectOf } from "../src/trailers.ts";
import {
  STEWARD_BRANCH,
  buildBriefing,
  claimSteward,
  findProblems,
  gatherBriefing,
  noteCell,
  readTip,
  releaseSteward,
  stewardStatus,
  type ProblemInput,
} from "../src/steward.ts";

const REPO = "o/r";
const MIN = 60000;

const cellYaml = (id: string, after: string[] = []) =>
  `id: ${id}\ntitle: Cell ${id}\ngoal: do ${id}\n${after.length ? `after: [${after.join(", ")}]\n` : ""}allowed_paths:\n  - src/${id}.ts\noutputs:\n  - src/${id}.ts\nacceptance:\n  - cmd: "true"\n`;

function setup(specs: Record<string, string[]>, extra: Record<string, string> = {}): FakeGitHub {
  const gh = new FakeGitHub();
  const files: Record<string, string> = { "blueprint.yaml": "project: demo\nlease_minutes: 60\n", ...extra };
  for (const [id, after] of Object.entries(specs)) files[`cells/${id}.yaml`] = cellYaml(id, after);
  gh.commit("main", files, "plan");
  return gh;
}

function engine(gh: FakeGitHub): EngineOptions {
  let n = 0;
  return { mainBranch: "main", historyPages: 1, now: () => gh.clock, sleep: async () => {}, uuid: () => `u${++n}` };
}

async function problemsOf(gh: FakeGitHub, extra: Partial<ProblemInput> = {}) {
  const snap = await gh.snapshot(REPO, "main", 1);
  return findProblems({ cells: loadCells(snap.cellFiles).cells, cfg: loadConfig(snap.blueprint).cfg, snap, merged: mergedOf(snap), now: gh.clock, ...extra });
}

const leaseMsg = (extra = "") => `steward(lease): x\n\nsteward-who: Ann\nsteward-session: s1\nsteward-at: 2026-10-30T10:00:00.000Z${extra}`;

// ---------------------------------------------------------------- lease states
test("stewardStatus: none, active, expired, released", () => {
  const t0 = Date.parse("2026-10-30T10:00:00Z");
  assert.deepEqual(stewardStatus(null, t0), { state: "none" });
  assert.deepEqual(stewardStatus({ branches: {} }, t0), { state: "none" });
  const tip = { message: leaseMsg(), committedDate: "2026-10-30T10:00:00Z" };
  assert.deepEqual(stewardStatus(tip, t0 + 20 * MIN, 60), { state: "active", holder: "Ann", session: "s1", minutesLeft: 40 });
  assert.deepEqual(stewardStatus({ branches: { [STEWARD_BRANCH]: tip } }, t0 + 20 * MIN, 60), { state: "active", holder: "Ann", session: "s1", minutesLeft: 40 });
  assert.deepEqual(stewardStatus(tip, t0 + 120 * MIN, 60), { state: "expired", holder: "Ann", session: "s1", expiredMinutesAgo: 60 });
  const rel = { message: leaseMsg("\nrelease: handoff"), committedDate: "2026-10-30T10:00:00Z" };
  assert.deepEqual(stewardStatus(rel, t0 + 1 * MIN, 60), { state: "released", holder: "Ann", session: "s1" });
});

test("claim: create, busy, heartbeat, adopt after expiry, release, adopt after release", async () => {
  const gh = setup({ "C-001": [] });
  const o = engine(gh);
  const a = await claimSteward(gh, REPO, "Ann", undefined, o);
  assert.equal(a.status, "CREATED");
  assert.match(a.session, /^steward-/);
  assert.ok(gh.refs.has(STEWARD_BRANCH));

  const busy = await claimSteward(gh, REPO, "Bob", undefined, o);
  assert.equal(busy.status, "STEWARD_BUSY");
  assert.match(busy.text, /Ann/);
  assert.equal(await claimSteward(gh, REPO, "Bob", "not-the-session", o).then((r) => r.status), "STEWARD_BUSY");

  gh.tick(30 * MIN);
  const before = gh.refs.get(STEWARD_BRANCH);
  const hb = await claimSteward(gh, REPO, "Ann", a.session, o);
  assert.equal(hb.status, "REFRESHED");
  assert.equal(hb.session, a.session);
  assert.notEqual(gh.refs.get(STEWARD_BRANCH), before);
  let st = stewardStatus(await readTip(gh, REPO, STEWARD_BRANCH), gh.clock, 60);
  assert.equal(st.state === "active" && st.minutesLeft, 60);

  gh.tick(61 * MIN);
  st = stewardStatus(await readTip(gh, REPO, STEWARD_BRANCH), gh.clock, 60);
  assert.equal(st.state, "expired");
  const b = await claimSteward(gh, REPO, "Bob", undefined, o);
  assert.equal(b.status, "ADOPTED");
  assert.notEqual(b.session, a.session);

  assert.equal((await releaseSteward(gh, REPO, a.session, true, o)).ok, false); // not the holder any more
  const rel = await releaseSteward(gh, REPO, b.session, true, o);
  assert.equal(rel.ok, true);
  assert.equal(stewardStatus(await readTip(gh, REPO, STEWARD_BRANCH), gh.clock, 60).state, "released");
  const c = await claimSteward(gh, REPO, "Cy", undefined, o);
  assert.equal(c.status, "ADOPTED");
  assert.equal(stewardStatus(await readTip(gh, REPO, STEWARD_BRANCH), gh.clock, 60).state, "active");
});

test("claim is race safe: two chats at once, exactly one wins", async () => {
  const gh = setup({ "C-001": [] });
  const o = engine(gh);
  const [x, y] = await Promise.all([claimSteward(gh, REPO, "X", undefined, o), claimSteward(gh, REPO, "Y", undefined, o)]);
  assert.deepEqual([x.status, y.status].sort(), ["CREATED", "STEWARD_BUSY"]);
  gh.tick(90 * MIN);
  const [p, q] = await Promise.all([claimSteward(gh, REPO, "P", undefined, o), claimSteward(gh, REPO, "Q", undefined, o)]);
  assert.deepEqual([p.status, q.status].sort(), ["ADOPTED", "STEWARD_BUSY"]);
});

test("lease length comes from lease_minutes of blueprint.yaml", async () => {
  const gh = setup({ "C-001": [] }, { "blueprint.yaml": "project: demo\nlease_minutes: 10\n" });
  const o = engine(gh);
  const a = await claimSteward(gh, REPO, "Ann", undefined, o);
  assert.match(a.text, /lease 10 min/);
  gh.tick(11 * MIN);
  assert.equal((await claimSteward(gh, REPO, "Bob", undefined, o)).status, "ADOPTED");
});

test("cell/ regexes and the cell engine ignore steward/lease", async () => {
  assert.equal(BRANCH_RE.test(STEWARD_BRANCH), false);
  assert.equal(SUBJECT_RE.test("steward(C-001): a note"), false);
  assert.deepEqual(claimsFromBranches({ [STEWARD_BRANCH]: { committedDate: new Date().toISOString() } }, Date.now()), {});
  assert.equal(isRelease(leaseMsg("\nrelease: handoff")), false);
  assert.equal(isFeedback(leaseMsg()), false);
  const gh = setup({ "C-001": [] });
  await claimSteward(gh, REPO, "Ann", undefined, engine(gh));
  const snap = await gh.snapshot(REPO, "main", 1);
  assert.deepEqual(Object.keys(snap.branches), []);
  assert.deepEqual(await problemsOf(gh), []);
});

// ---------------------------------------------------------------- problems
test("problems are ordered by transitive dependents, then age", async () => {
  const gh = setup({ "C-001": [], "C-002": [], "C-003": ["C-002"], "C-004": ["C-002"], "C-005": ["C-003"] });
  gh.commit("cell/C-001", {}, "feedback(C-001): which db?\n\nnext: wait");
  gh.tick(5 * MIN);
  gh.commit("cell/C-002", {}, "feedback(C-002): which queue?\n\nnext: wait");
  const p = await problemsOf(gh);
  assert.deepEqual(p.map((x) => x.id), ["C-002", "C-001"]);
  assert.equal(p[0].dependents, 3);
  assert.equal(p[0].kind, "needs_human");
  assert.match(p[0].why, /which queue/);
  assert.ok(p[0].actions.length > 0);
  assert.match(p[0].lastCommit, /^feedback\(C-002\)/);
});

test("equal dependents: the older problem comes first", async () => {
  const gh = setup({ "C-001": [], "C-002": [] });
  gh.commit("cell/C-002", {}, "feedback(C-002): old question");
  gh.tick(30 * MIN);
  gh.commit("cell/C-001", {}, "feedback(C-001): new question");
  assert.deepEqual((await problemsOf(gh)).map((x) => x.id), ["C-002", "C-001"]);
});

test("problem kinds: needs_split, expired with 2 attempts, CI failed, stuck ready", async () => {
  // needs_split: 3 dead attempts and an expired lease
  let gh = setup({ "C-001": [] });
  gh.commit("cell/C-001", {}, "takeover(C-001): lock a\n\nnext: go\nattempt: 3");
  gh.tick(61 * MIN);
  let p = await problemsOf(gh);
  assert.equal(p.length, 1);
  assert.equal(p[0].kind, "needs_split");
  assert.equal(p[0].attempts, 3);

  // expired with 2 attempts counts; with 1 attempt it does not
  gh = setup({ "C-001": [], "C-002": [] });
  gh.commit("cell/C-001", {}, "takeover(C-001): lock a\n\nnext: go\nattempt: 2");
  gh.commit("cell/C-002", {}, "takeover(C-002): lock b\n\nnext: go\nattempt: 1");
  gh.tick(61 * MIN);
  p = await problemsOf(gh);
  assert.deepEqual(p.map((x) => [x.id, x.kind]), [["C-001", "expired"]]);

  // CI failed: only when the chat has been idle for a while
  gh = setup({ "C-001": [] });
  gh.commit("cell/C-001", {}, "cell(C-001): work\n\nnext: fix ci");
  gh.tick(5 * MIN);
  assert.deepEqual(await problemsOf(gh, { failedCi: ["C-001"] }), []);
  gh.tick(20 * MIN);
  p = await problemsOf(gh, { failedCi: ["C-001"] });
  assert.deepEqual(p.map((x) => x.kind), ["ci_failed"]);

  // stuck ready: nobody takes a ready cell for over 60 minutes
  gh = setup({ "C-001": [] });
  assert.deepEqual(await problemsOf(gh, { mainAgeMinutes: 30 }), []);
  p = await problemsOf(gh, { mainAgeMinutes: 90 });
  assert.deepEqual(p.map((x) => [x.id, x.kind]), [["C-001", "stuck_ready"]]);
  assert.match(p[0].lastCommit, /no branch/);
});

// ---------------------------------------------------------------- notes
test("noteCell: bounded, control characters stripped, trailers and feedback state kept", async () => {
  const gh = setup({ "C-001": [] });
  gh.commit("cell/C-001", {}, "feedback(C-001): which db?\n\nnext: ask\nattempt: 1");
  const res = await noteCell(gh, REPO, "C-001", "line1\nline2\u0007\u001b[31m" + "x".repeat(5000));
  assert.match(res, /^NOTED C-001/);
  const tip = (await readTip(gh, REPO, "cell/C-001"))!;
  const subject = subjectOf(tip.message);
  assert.match(subject, /^steward\(C-001\): line1 line2 /);
  assert.ok(!/[\u0000-\u001f\u007f]/.test(subject));
  assert.equal(stewardNote(tip.message)!.length, 2000);
  assert.equal(parseTrailers(tip.message).next, "ask");
  assert.equal(parseTrailers(tip.message).attempt, 1);
  assert.equal(isFeedback(tip.message), true); // the note does not hide the open feedback
  assert.equal((await problemsOf(gh))[0].kind, "needs_human");

  assert.match(await noteCell(gh, REPO, "C-009", "x"), /^NOT_RUNNING/);
  assert.match(await noteCell(gh, REPO, "nope", "x"), /^UNKNOWN_CELL/);
  assert.match(await noteCell(gh, REPO, "C-001", " \n\t "), /^EMPTY_NOTE/);
});

test("noteCell is race safe: a stale tip is refused by the fast-forward", async () => {
  const gh = setup({ "C-001": [] });
  gh.commit("cell/C-001", {}, "cell(C-001): work\n\nnext: a");
  gh.failNext.fastForward = new Error("boom");
  assert.match(await noteCell(gh, REPO, "C-001", "hello"), /^NOTE_FAILED/);
  assert.match(await noteCell(gh, REPO, "C-001", "hello"), /^NOTED/);
});

// ---------------------------------------------------------------- briefing
function briefingInput(gh: FakeGitHub, snap: Awaited<ReturnType<FakeGitHub["snapshot"]>>, docs: { path: string; text: string }[], secrets: string[] = []) {
  return { cells: loadCells(snap.cellFiles).cells, cfg: loadConfig(snap.blueprint).cfg, snap, merged: mergedOf(snap), now: gh.clock, repo: REPO, docs, secrets };
}

test("briefing: project, rules, counts, ordered problems, actions, working rules last", async () => {
  const gh = setup({ "C-001": [], "C-002": [], "C-003": ["C-002"] });
  gh.commit("cell/C-001", {}, "feedback(C-001): which db?");
  gh.commit("cell/C-002", {}, "takeover(C-002): lock\n\nnext: go\nattempt: 3");
  gh.tick(61 * MIN);
  const snap = await gh.snapshot(REPO, "main", 1);
  const text = buildBriefing(briefingInput(gh, snap, [{ path: "BLUEPRINT.md", text: "# Rules\nOne cell at a time." }, { path: "docs/style.md", text: "Use tabs." }]));
  assert.match(text, /STEWARD BRIEFING for demo/);
  assert.match(text, /One cell at a time\./);
  assert.match(text, /Use tabs\./);
  assert.match(text, /COUNTS: 3 cells, 0 merged/);
  assert.ok(text.indexOf("1. C-002") > 0 && text.indexOf("1. C-002") < text.indexOf("2. C-001"));
  assert.match(text, /why: .*which db/);
  assert.match(text, /attempts: 3; last commit: takeover\(C-002\)/);
  assert.match(text, /dependents: 1/);
  assert.match(text, /allowed: .*clear_feedback/);
  assert.match(text, /allowed: .*publish_plan/);
  assert.match(text, /45 seconds/);
  assert.ok(text.trimEnd().endsWith("then stop."));
  assert.ok(text.lastIndexOf("WORKING RULES") > text.indexOf("PROBLEM LIST"));
});

test("briefing: empty list says so; docs are bounded", async () => {
  const gh = setup({ "C-001": [] });
  const snap = await gh.snapshot(REPO, "main", 1);
  const big = Array.from({ length: 4000 }, (_, i) => `line ${i}`).join("\n");
  const text = buildBriefing(briefingInput(gh, snap, [{ path: "BLUEPRINT.md", text: big }, ...Array.from({ length: 10 }, (_, i) => ({ path: `docs/d${i}.md`, text: big }))]));
  assert.match(text, /EMPTY: no open problems/);
  assert.match(text, /45 seconds/);
  assert.ok(text.length < 12000, `briefing too long: ${text.length}`);
});

test("briefing never contains secrets", async () => {
  const token = "ghp_abcdefghijklmnop1234567890";
  const secret = "supersecretvalue99";
  const gh = setup(
    { "C-001": [] },
    {
      "BLUEPRINT.md": `# Rules\nGITHUB_TOKEN=${token}\nuse ${secret} for nothing\n`,
      "docs/rules.md": `ADMIN_TOKEN: ${secret}\nkeep it short\n`,
    },
  );
  gh.commit("cell/C-001", {}, `feedback(C-001): the key is ${secret} and ${token}`);
  const text = await gatherBriefing(gh, REPO, engine(gh), { secrets: [secret, token] });
  assert.match(text, /STEWARD BRIEFING for demo/);
  assert.match(text, /keep it short/);
  assert.ok(!text.includes(secret), "secret value leaked");
  assert.ok(!text.includes(token), "token leaked");
  assert.ok(!/ghp_/.test(text));
  // even without being told the values, token shapes and token assignments are removed
  const text2 = await gatherBriefing(gh, REPO, engine(gh));
  assert.ok(!text2.includes(token));
  assert.ok(!/ADMIN_TOKEN:\s*supersecret/.test(text2));
});

test("gatherBriefing reads docs and finds a failed CI gate", async () => {
  const gh = setup({ "C-001": [] }, { "BLUEPRINT.md": "# Blueprint\nWork in cells.\n", "docs/arch.md": "Architecture notes.\n" });
  gh.commit("cell/C-001", {}, "cell(C-001): work\n\nnext: fix ci");
  gh.addRun("cell-gate.yml", "gate cell/C-001", "completed", "failure", 30);
  gh.tick(20 * MIN);
  const text = await gatherBriefing(gh, REPO, engine(gh));
  assert.match(text, /--- BLUEPRINT\.md/);
  assert.match(text, /--- docs\/arch\.md/);
  assert.match(text, /1\. C-001 .*\(ci_failed\)/);
  const none = await gatherBriefing(new FakeGitHub(true), REPO, engine(new FakeGitHub(true)));
  assert.match(none, /EMPTY_REPO|NOT_INIT/);
});
