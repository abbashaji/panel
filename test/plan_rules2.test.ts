// Task 02f worked examples K to O (attempts / needs_split, feedback / needs_human, supersedes).
// The same table is in blueprint-kit/tools/tests/test_resilience2.py.
import { test } from "node:test";
import assert from "node:assert/strict";

import * as plan from "../src/plan.ts";

type Spec = Record<string, { after?: string[]; supersedes?: string[] }>;

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
const pair = () => mk({ "C-001": {}, "C-002": {} });
const ids = (s: plan.State) => s.ready.map((r) => r.id);
const cfg = { ...plan.DEFAULTS, protected_paths: [...plan.DEFAULT_PROTECTED], owners: {} } as unknown as plan.Config;
const vc = (...cs: plan.Cell[]) => Object.fromEntries(cs.map((c) => [c.id, c]));
function vcell(id: string, paths: string[], extra: Record<string, unknown> = {}): plan.Cell {
  return {
    id, title: `t ${id}`, goal: "g", inputs: [], after: [], provides: [], allowed_paths: paths,
    outputs: paths.filter((p) => !p.includes("*")).length ? paths.filter((p) => !p.includes("*")) : [paths[0].replace("/**", "/x.py")],
    acceptance: [{ cmd: "true" }], ...extra,
  };
}
const st = (cells: Record<string, plan.Cell>, merged: string[], claims: Record<string, number> = {}, o: plan.StateOptions = {}) =>
  plan.computeState(cells, merged, claims, 60, {}, 45, 4, o);

test("K: needs_split", () => {
  let s = st(pair(), [], { "C-001": 70 }, { attempts: { "C-001": 3 } });
  assert.deepEqual(ids(s), ["C-002"]);
  assert.deepEqual(s.needs_split, [{ id: "C-001", attempts: 3 }]);
  assert.equal(s.status, "ready");
  assert.equal("needs_human" in s, false);
  s = st(pair(), [], { "C-001": 70 }, { attempts: { "C-001": 2 } });
  assert.deepEqual(ids(s), ["C-002", "C-001"]); // young expired cell goes last
  assert.equal(s.ready.find((r) => r.id === "C-001")!.reclaim, true);
  assert.equal("needs_split" in s, false);
  s = st(pair(), [], { "C-001": 70 }, { released: ["C-001"], attempts: { "C-001": 3 } });
  assert.ok(ids(s).includes("C-001"));
  assert.equal("needs_split" in s, false);
  s = st(pair(), [], { "C-001": 5 }, { attempts: { "C-001": 3 } });
  assert.deepEqual(s.locked, [{ id: "C-001", minutes_left: 55 }]);
  assert.deepEqual(ids(s), ["C-002"]);
  assert.equal("needs_split" in s, false);
});

test("K: a fresh cell is never split, maxAttempts is honoured", () => {
  let s = st(pair(), [], {}, { attempts: { "C-001": 9 } });
  assert.deepEqual(ids(s), ["C-001", "C-002"]);
  assert.equal("needs_split" in s, false);
  s = st(pair(), [], { "C-001": 70 }, { attempts: { "C-001": 2 }, maxAttempts: 2 });
  assert.deepEqual(s.needs_split, [{ id: "C-001", attempts: 2 }]);
});

test("L: needs_human", () => {
  const s = st(pair(), [], {}, { feedback: ["C-002"] });
  assert.deepEqual(s.needs_human, [{ id: "C-002" }]);
  assert.deepEqual(ids(s), ["C-001"]);
  assert.equal(s.status, "ready");
});

test("L: feedback wins over a lease and over the attempts limit; blockers come first", () => {
  let s = st(pair(), [], { "C-001": 5 }, { attempts: { "C-001": 3 }, feedback: ["C-001"] });
  assert.deepEqual(s.needs_human, [{ id: "C-001" }]);
  assert.equal("needs_split" in s, false);
  assert.deepEqual(s.locked, []);
  s = st(mk({ "C-001": {}, "C-002": { after: ["C-001"] } }), [], {}, { feedback: ["C-002"] });
  assert.deepEqual(s.waiting, [{ id: "C-002", blocked_by: ["C-001"] }]);
  assert.equal("needs_human" in s, false);
});

test("defaults keep old states unchanged", () => {
  const s = st(pair(), [], { "C-001": 70 });
  assert.deepEqual(Object.keys(s).sort(), ["locked", "ready", "status", "waiting"]);
});

test("O: render", () => {
  let s = st(mk({ "C-001": {} }), [], { "C-001": 70 }, { attempts: { "C-001": 3 } });
  assert.equal(s.status, "none_ready");
  assert.equal(
    plan.render(s),
    "NONE_READY: no cell can be started now.\nneeds_split: C-001(3 attempts)\nA human must resolve the cells above.",
  );
  s = st(pair(), [], { "C-001": 70 }, { attempts: { "C-001": 3 }, feedback: ["C-002"] });
  assert.equal(
    plan.render(s),
    "NONE_READY: no cell can be started now.\nneeds_split: C-001(3 attempts)\nneeds_human: C-002\nA human must resolve the cells above.",
  );
  s = st(mk({ "C-001": {}, "C-002": {}, "C-003": {} }), [], { "C-001": 70, "C-003": 5 }, { attempts: { "C-001": 3 }, feedback: ["C-002"] });
  assert.equal(
    plan.render(s),
    "NONE_READY: no cell can be started now.\nrunning: C-003(55m)\nneeds_split: C-001(3 attempts)\nneeds_human: C-002\n" +
      "Wait for the running cells to merge, then ask again.",
  );
});

test("O: needs_* lines also follow a READY render", () => {
  const s = st(pair(), [], { "C-001": 70 }, { attempts: { "C-001": 3 } });
  assert.equal(plan.render(s), "READY C-002\n(take the first)\nneeds_split: C-001(3 attempts)");
});

const sgraph = () =>
  mk({ "C-001": {}, "C-002": { after: ["C-001"] }, "C-005": { supersedes: ["C-001"] }, "C-006": { supersedes: ["C-001"] } });

test("M: a superseded cell is replaced by its superseders", () => {
  let s = st(sgraph(), [], {});
  assert.deepEqual(ids(s), ["C-005", "C-006"]);
  assert.deepEqual(s.waiting, [{ id: "C-002", blocked_by: ["C-005", "C-006"] }]);
  assert.ok(!JSON.stringify(s).includes("C-001"));
  s = st(sgraph(), ["C-005"], {});
  assert.deepEqual(ids(s), ["C-006"]);
  assert.deepEqual(s.waiting, [{ id: "C-002", blocked_by: ["C-006"] }]);
  s = st(sgraph(), ["C-005", "C-006"], {});
  assert.deepEqual(ids(s), ["C-002"]);
  assert.deepEqual(s.waiting, []);
  s = st(sgraph(), ["C-002", "C-005", "C-006"], {});
  assert.equal(s.status, "all_done");
});

test("M: a merged superseded cell counts as merged; blocked_by is de-duplicated", () => {
  assert.deepEqual(ids(st(sgraph(), ["C-001"], {})), ["C-002", "C-005", "C-006"]);
  const cells = mk({
    "C-001": {}, "C-002": { after: ["C-001"] }, "C-003": { after: ["C-001"] }, "C-005": { supersedes: ["C-001"] },
    "C-006": { supersedes: ["C-001"] }, "C-007": { after: ["C-001", "C-005"] },
  });
  const s = st(cells, [], {});
  assert.deepEqual(s.waiting.find((w) => w.id === "C-007")!.blocked_by, ["C-005", "C-006"]);
});

test("N: validator errors", () => {
  const a = vcell("C-001", ["src/a/**"], { provides: ["cfg"] });
  const b = vcell("C-002", ["src/b/**"]);
  const c3 = vcell("C-003", ["src/c/**"]);
  assert.deepEqual(plan.validate(vc(a, b, c3), cfg), { errors: [], warnings: [] });
  assert.deepEqual(plan.validate(vc({ ...a, supersedes: ["C-001"] }, b), cfg).errors, ["C-001: supersedes: a cell cannot supersede itself"]);
  assert.deepEqual(plan.validate(vc({ ...a, supersedes: ["C-099"] }, b), cfg).errors, ["C-001: supersedes: unknown cell 'C-099'"]);
  assert.deepEqual(
    plan.validate(vc({ ...a, supersedes: ["C-002"] }, { ...b, supersedes: ["C-001"] }), cfg).errors,
    ["supersedes cycle: C-001 -> C-002 -> C-001"],
  );
  assert.deepEqual(plan.validate(vc(a, { ...b, supersedes: "C-001" }), cfg).errors, ["C-002: 'supersedes' must be a list of strings"]);
});

test("N: path overlap is allowed only for the superseded pair", () => {
  const a = vcell("C-001", ["src/a/**"], { provides: ["cfg"] });
  const c3 = vcell("C-003", ["src/c/**"]);
  const s5 = vcell("C-005", ["src/a/**"], { provides: ["cfg"], supersedes: ["C-001"] });
  assert.deepEqual(plan.validate(vc(a, c3, s5), cfg), { errors: [], warnings: [] });
  const s5b = vcell("C-005", ["src/a/**", "src/c/**"], { provides: ["cfg"], supersedes: ["C-001"] });
  const e = plan.validate(vc(a, c3, s5b), cfg).errors;
  assert.equal(e.length, 1);
  assert.ok(e[0].startsWith("C-003 and C-005 can run in parallel but their paths overlap"), e[0]);
});

test("N: a provides line that no superseder provides is a warning", () => {
  const a = vcell("C-001", ["src/a/**"], { provides: ["cfg", "extra"] });
  const s5 = vcell("C-005", ["src/e/**"], { provides: ["cfg"], supersedes: ["C-001"] });
  const r = plan.validate(vc(a, s5), cfg);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, ["C-001: superseded, but no superseder provides 'extra' (dependents may be left with a dangling contract)"]);
  const s6 = vcell("C-006", ["src/f/**"], { provides: ["extra"], supersedes: ["C-001"] });
  assert.deepEqual(plan.validate(vc(a, s5, s6), cfg), { errors: [], warnings: [] }); // the union of the superseders counts
});

test("supersedes is a known key", () => {
  assert.ok(plan.CELL_KEYS.includes("supersedes"));
});
