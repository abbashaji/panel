// Task 01c worked examples A to J. The same table is in blueprint-kit/tools/tests/test_resilience.py.
import { test } from "node:test";
import assert from "node:assert/strict";

import * as plan from "../src/plan.ts";

type Spec = Record<string, { after?: string[]; type?: string; lease_minutes?: number }>;

function mk(spec: Spec): Record<string, plan.Cell> {
  const out: Record<string, plan.Cell> = {};
  for (const [id, kw] of Object.entries(spec)) {
    const { after = [], ...rest } = kw;
    out[id] = {
      id, title: `t ${id}`, goal: "g", inputs: [], after, provides: [], allowed_paths: [`src/${id.toLowerCase()}/**`],
      outputs: [`src/${id.toLowerCase()}/x.py`], acceptance: [{ cmd: "true" }], ...rest,
    };
  }
  return out;
}
function fan(skeleton = false) {
  const d: Spec = { "C-000": skeleton ? { type: "skeleton" } : {} };
  for (let i = 1; i <= 4; i++) d[`C-00${i}`] = { after: ["C-000"] };
  d["C-010"] = {};
  return mk(d);
}
const pair = () => mk({ "C-010": {}, "C-011": {} });
const ids = (s: plan.State) => s.ready.map((r) => r.id);
const entry = (s: plan.State, id: string) => s.ready.find((r) => r.id === id)!;
const state = (cells: Record<string, plan.Cell>, merged: string[], claims: Record<string, number> = {}, ci: Record<string, number> = {}, released: string[] = [], lease = 60) =>
  plan.computeState(cells, merged, claims, lease, ci, 45, 4, { released });

/** critical flag of EVERY cell (merge all its ancestors so that it is ready). */
function criticalAll(cells: Record<string, plan.Cell>): string[] {
  const g = plan.hardGraph(cells);
  const out: string[] = [];
  for (const id of Object.keys(cells)) {
    const anc = new Set<string>();
    const stack = [...g[id]];
    while (stack.length) {
      const n = stack.pop()!;
      if (!anc.has(n)) { anc.add(n); stack.push(...g[n]); }
    }
    if (entry(state(cells, [...anc]), id).critical) out.push(id);
  }
  return out.sort();
}

test("A: a critical cell expires after 15 minutes and is handed out first", () => {
  const s = state(fan(), [], { "C-000": 16 });
  assert.deepEqual(ids(s), ["C-000", "C-010"]);
  assert.deepEqual(entry(s, "C-000"), { id: "C-000", reclaim: true, critical: true, released: false });
  assert.equal(entry(s, "C-010").reclaim, false);
  assert.equal(entry(s, "C-010").critical, false);
  assert.deepEqual(s.locked, []);
});

test("B: a young expired non-critical cell goes last", () => {
  assert.deepEqual(ids(state(pair(), [], { "C-010": 70 })), ["C-011", "C-010"]);
});

test("C: an old expired non-critical cell is ordered like an unclaimed one (by id)", () => {
  assert.deepEqual(ids(state(pair(), [], { "C-010": 130 })), ["C-010", "C-011"]);
});

test("D: a released cell is expired at once", () => {
  const s = state(pair(), [], { "C-010": 5 }, {}, ["C-010"]);
  assert.deepEqual(ids(s), ["C-010", "C-011"]); // released is served before fresh (class 0)
  const e = entry(s, "C-010");
  assert.equal(e.reclaim, true);
  assert.equal(e.critical, false);
  assert.equal(e.released, true);
});

test("a released cell is served before a fresh one even with a later id", () => {
  const s = state(pair(), [], { "C-011": 5 }, {}, ["C-011"]);
  assert.deepEqual(ids(s), ["C-011", "C-010"]);
  assert.deepEqual(s.locked, []);
});

test("a released critical cell is still class 0", () => {
  let s = state(fan(), [], { "C-000": 5 }, {}, ["C-000"]);
  assert.deepEqual(ids(s), ["C-000", "C-010"]);
  assert.deepEqual(entry(s, "C-000"), { id: "C-000", reclaim: true, critical: true, released: true });
  s = state(fan(), [], { "C-000": 16, "C-010": 5 }, {}, ["C-010"]);
  assert.deepEqual(ids(s), ["C-000", "C-010"]); // both class 0: deeper cell first
});

test("a released cell with attempts >= max_attempts is served, not split", () => {
  const s = plan.computeState(pair(), [], { "C-011": 5 }, 60, {}, 45, 4, { released: ["C-011"], attempts: { "C-011": 3 } });
  assert.deepEqual(ids(s), ["C-011", "C-010"]);
  assert.equal("needs_split" in s, false);
});

test("E: a release overrides the CI lease", () => {
  let s = state(pair(), [], { "C-010": 70 }, { "C-010": 5 });
  assert.deepEqual(s.locked, [{ id: "C-010", minutes_left: 40, ci: true }]);
  assert.deepEqual(ids(s), ["C-011"]);
  s = state(pair(), [], { "C-010": 70 }, { "C-010": 5 }, ["C-010"]);
  assert.ok(ids(s).includes("C-010"));
  assert.deepEqual(s.locked, []);
});

test("F: a skeleton is critical like any cell", () => {
  const s = state(fan(true), [], {});
  assert.deepEqual(ids(s), ["C-000", "C-010"]);
  assert.equal(entry(s, "C-000").critical, true);
  const d: Spec = { "C-000": { type: "skeleton" } };
  for (let i = 1; i <= 4; i++) d[`C-00${i}`] = { after: ["C-000"] };
  const only = state(mk(d), [], {});
  assert.deepEqual(ids(only), ["C-000"]);
  assert.equal(only.ready[0].critical, true);
});

test("G: critical by chain length", () => {
  const cells = mk({
    "C-000": {}, "C-001": { after: ["C-000"] }, "C-002": { after: ["C-000"] },
    "C-003": { after: ["C-001"] }, "C-004": { after: ["C-003"] }, "C-005": { after: ["C-004"] },
  });
  assert.deepEqual(criticalAll(cells), ["C-000", "C-001"]);
  const s = state(cells, ["C-000"]);
  assert.deepEqual(ids(s), ["C-001", "C-002"]);
  assert.equal(entry(s, "C-001").critical, true);
  assert.equal(entry(s, "C-002").critical, false);
});

test("H: critical by transitive dependents only", () => {
  const cells = mk({
    "C-000": {}, "C-001": { after: ["C-000"] }, "C-002": { after: ["C-000"] },
    "C-003": { after: ["C-001"] }, "C-004": { after: ["C-001"] }, "C-005": { after: ["C-002"] },
  });
  assert.equal(plan.transitiveDependents(cells)["C-000"], 5);
  assert.deepEqual(criticalAll(cells), ["C-000"]);
});

test("I: the critical lease caps the effective lease", () => {
  const cells = fan(true);
  let s = state(cells, [], { "C-000": 10 });
  assert.deepEqual(s.locked, [{ id: "C-000", minutes_left: 5 }]);
  cells["C-000"].lease_minutes = 10;
  s = state(cells, [], { "C-000": 12 });
  assert.equal(entry(s, "C-000").reclaim, true);
  assert.deepEqual(s.locked, []);
});

test("J: render shows (expired-lease) and (released)", () => {
  assert.equal(plan.render(state(fan(), [], { "C-000": 16 })), "READY C-000[critical](expired-lease) C-010\n(take the first)");
  const text = plan.render(state(pair(), [], { "C-010": 5 }, {}, ["C-010"]));
  assert.match(text, /C-010\(released\)/);
  assert.doesNotMatch(text, /expired-lease/);
});

test("a released id without a claim is ignored; config defaults exist", () => {
  const e = entry(state(pair(), [], {}, {}, ["C-010"]), "C-010");
  assert.equal(e.reclaim, false);
  assert.equal(e.released, false);
  assert.deepEqual(
    [plan.DEFAULTS.critical_lease_minutes, plan.DEFAULTS.critical_chain_threshold, plan.DEFAULTS.critical_transitive_threshold, plan.DEFAULTS.park_max_minutes, plan.DEFAULTS.max_attempts],
    [15, 3, 5, 120, 3],
  );
  assert.equal(plan.loadConfig("critical_lease_minutes: 7\n").cfg.critical_lease_minutes, 7);
});
