import { test } from "node:test";
import assert from "node:assert/strict";
import { superseders, unmergedBlockers } from "../src/plan.ts";

const cells = (m: Record<string, string[]>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { supersedes: v }])) as any;

test("a dependency replaced by a replaced cell waits for the last replacement", () => {
  // A is replaced by B, B is replaced by C (B never merged)
  const sup = superseders(cells({ A: [], B: ["A"], C: ["B"] }));
  assert.deepEqual(unmergedBlockers("A", sup, new Set()), ["C"]);
  assert.deepEqual(unmergedBlockers("A", sup, new Set(["C"])), []);
});

test("a merged middle replacement satisfies the dependency", () => {
  const sup = superseders(cells({ A: [], B: ["A"], C: ["B"] }));
  assert.deepEqual(unmergedBlockers("A", sup, new Set(["B"])), []);
});

test("plain and merged dependencies behave as before", () => {
  const sup = superseders(cells({ A: [], D: [] }));
  assert.deepEqual(unmergedBlockers("D", sup, new Set()), ["D"]);
  assert.deepEqual(unmergedBlockers("D", sup, new Set(["D"])), []);
});

test("one replacement of several: all unmerged superseders count", () => {
  const sup = superseders(cells({ A: [], B: ["A"], C: ["A"] }));
  assert.deepEqual(unmergedBlockers("A", sup, new Set(["B"])), ["C"]);
});

test("a cycle does not loop", () => {
  const sup = superseders(cells({ A: ["B"], B: ["A"] }));
  assert.ok(Array.isArray(unmergedBlockers("A", sup, new Set())));
});
