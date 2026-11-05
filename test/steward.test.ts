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
