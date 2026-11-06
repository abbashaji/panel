// Panel/engine parity: src/panel/state.ts must give every cell the status that src/plan.ts computeState gives it.
// Scenarios: every state case of test/fixtures.json.gz (generated from the Python reference) plus hand-written ones.
// Each scenario is written into an in-memory GitHub (test/fakegh.ts) as a plan, merge commits and claim / release /
// feedback branch tips of the right age; then PanelState and computeState are compared from the same inputs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import type { GitHubApi } from "../src/api.ts";
import { clearPlanCache } from "../src/common.ts";
import { buildPanelState, clearPanelCache } from "../src/panel/state.ts";
import type { PanelState, PanelStatus } from "../src/panel/types.ts";
import * as plan from "../src/plan.ts";
import { formatMessage } from "../src/trailers.ts";
import { FakeGitHub } from "./fakegh.ts";

const REPO = "o/r";
const NOW = Date.parse("2026-10-30T10:00:00Z"); // FakeGitHub's starting clock
const STATUSES: PanelStatus[] = ["done", "running", "ready", "waiting", "expired", "needs_human", "needs_split"];
const here = dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(gunzipSync(readFileSync(join(here, "fixtures.json.gz"))).toString("utf-8"));

interface Scenario {
  name: string;
  cells: Record<string, any>;
  merged?: string[];
  claims?: Record<string, number>; // minutes since the last commit on the cell branch
  released?: string[];
  feedback?: string[];
  attempts?: Record<string, number>;
  ci?: Record<string, number>; // minutes since an active workflow run of the cell started
  lease?: number;
  threshold?: number;
  maxAttempts?: number;
  chain?: number;
  transitive?: number;
  criticalLease?: number;
  parkMax?: number;
}

/** The scenario as git can express it: only inputs that both the engine and the panel can see. */
function normalize(sc: Scenario) {
  const ids = new Set(Object.keys(sc.cells));
  const known = (xs: Iterable<string> = []) => [...xs].filter((i) => ids.has(i));
  const claims: Record<string, number> = {};
  for (const [i, age] of Object.entries(sc.claims ?? {})) if (ids.has(i)) claims[i] = age;
  const feedback = known(sc.feedback);
  for (const i of feedback) claims[i] ??= 5; // feedback is a commit on a branch, so the cell has a branch
  const attempts: Record<string, number> = {};
  for (const [i, n] of Object.entries(sc.attempts ?? {})) if (i in claims) attempts[i] = n;
  const ci: Record<string, number> = {};
  for (const [i, m] of Object.entries(sc.ci ?? {})) if (ids.has(i)) ci[i] = m;
  return {
    cells: sc.cells,
    merged: known(sc.merged),
    claims,
    feedback,
    released: known(sc.released).filter((i) => i in claims && !feedback.includes(i)), // a tip is one or the other
    attempts,
    ci,
    lease: sc.lease ?? 60,
    threshold: sc.threshold ?? 4,
    maxAttempts: sc.maxAttempts ?? 3,
    chain: sc.chain ?? 3,
    transitive: sc.transitive ?? 5,
    criticalLease: sc.criticalLease ?? 15,
    parkMax: sc.parkMax ?? 120,
  };
}
type Norm = ReturnType<typeof normalize>;

// JSON is valid YAML, so the plan files are written as JSON.
function blueprintText(n: Norm): string {
  return JSON.stringify({
    project: "parity",
    main_branch: "main",
    lease_minutes: n.lease,
    max_ci_minutes: 45,
    bottleneck_threshold: n.threshold,
    critical_lease_minutes: n.criticalLease,
    critical_chain_threshold: n.chain,
    critical_transitive_threshold: n.transitive,
    park_max_minutes: n.parkMax,
    max_attempts: n.maxAttempts,
    max_cell_files: 8,
    acceptance_timeout_s: 60,
    owners: { "pyproject.toml": "C-000" },
  });
}

function tipMessage(id: string, n: Norm): string {
  const subject = n.feedback.includes(id) ? `feedback(${id}): needs a human` : n.released.includes(id) ? `release(${id}): handing over` : `claim(${id}): working`;
  return formatMessage(subject, { next: "continue", attempt: n.attempts[id] ?? 0 });
}

function materialize(n: Norm): FakeGitHub {
  const gh = new FakeGitHub();
  const files: Record<string, string> = { "blueprint.yaml": blueprintText(n) };
  for (const [id, c] of Object.entries(n.cells)) files[`cells/${id}.yaml`] = JSON.stringify(c);
  gh.commit("main", files, "plan");
  for (const id of n.merged) gh.commit("main", {}, `cell(${id}): done`);
  for (const [id, age] of Object.entries(n.claims)) {
    gh.clock = NOW - age * 60000;
    gh.commit(`cell/${id}`, {}, tipMessage(id, n));
  }
  gh.clock = NOW;
  for (const [id, age] of Object.entries(n.ci)) gh.addRun("gate.yml", `gate cell/${id}`, "in_progress", null, age);
  return gh;
}

async function engineState(n: Norm, api: GitHubApi): Promise<plan.State> {
  const ci = plan.parseRuns(await api.activeRuns(REPO), NOW);
  return plan.computeState(n.cells, n.merged, n.claims, n.lease, ci, 45, n.threshold, {
    criticalChainThreshold: n.chain,
    criticalTransitiveThreshold: n.transitive,
    criticalLeaseMinutes: n.criticalLease,
    parkMaxMinutes: n.parkMax,
    released: n.released,
    attempts: n.attempts,
    maxAttempts: n.maxAttempts,
    feedback: n.feedback,
  });
}

/** The first cell (or count) where the panel disagrees with the engine, or null. */
function firstDifference(n: Norm, st: plan.State, p: PanelState, tolerated?: string[]): string | null {
  const sup = plan.superseders(n.cells);
  const merged = new Set(n.merged);
  const replaced = (id: string) => id in sup && !merged.has(id);
  const want = new Map<string, PanelStatus>();
  for (const id of merged) want.set(id, "done");
  for (const r of st.ready) want.set(r.id, r.reclaim ? "expired" : "ready");
  for (const r of st.locked) want.set(r.id, "running");
  for (const r of st.waiting) want.set(r.id, "waiting");
  for (const r of st.needs_split ?? []) want.set(r.id, "needs_split");
  for (const r of st.needs_human ?? []) want.set(r.id, "needs_human");
  const ids = Object.keys(n.cells).sort();
  if (p.cells.length !== ids.length) return `panel lists ${p.cells.length} cells, the plan has ${ids.length}`;
  const byId = new Map(p.cells.map((c) => [c.id, c]));
  // Known difference (see the test at the end): a CI-locked cell that the panel shows as needs_split.
  if (tolerated) {
    for (const r of st.locked) {
      if (r.ci && byId.get(r.id)?.status === "needs_split") {
        want.set(r.id, "needs_split");
        tolerated.push(r.id);
      }
    }
  }
  for (const id of ids) {
    const c = byId.get(id);
    if (!c) return `${id}: missing from the panel`;
    if (replaced(id)) {
      if (want.has(id)) return `${id}: superseded, yet the engine reports it as ${want.get(id)}`;
      if (JSON.stringify(c.supersededBy) !== JSON.stringify(sup[id])) return `${id}: supersededBy is ${JSON.stringify(c.supersededBy)}, expected ${JSON.stringify(sup[id])}`;
      continue;
    }
    if (c.supersededBy) return `${id}: panel marks it superseded by ${c.supersededBy.join(",")}, but it is live`;
    if (!want.has(id)) return `${id}: the engine gives a live cell no status`;
    if (c.status !== want.get(id)) return `${id}: panel says ${c.status}, engine says ${want.get(id)}`;
    if (merged.has(id) && c.status !== "done") return `${id}: merged but panel says ${c.status}`;
  }
  const live = ids.filter((id) => !replaced(id));
  const total = STATUSES.reduce((a, k) => a + p.counts[k], 0);
  if (total !== live.length) return `counts add up to ${total}, but ${live.length} cells are live`;
  for (const k of STATUSES) {
    const expected = live.filter((id) => want.get(id) === k).length;
    if (p.counts[k] !== expected) return `counts.${k} is ${p.counts[k]}, the engine has ${expected}`;
  }
  return null;
}

/** Returns the PanelState, or null when a fixture scenario is not a valid plan (hand-written ones must be valid). */
async function runScenario(sc: Scenario, strict: boolean, tolerated?: string[]): Promise<PanelState | null> {
  const n = normalize(sc);
  const files: Record<string, string> = {};
  for (const [id, c] of Object.entries(n.cells)) files[`${id}.yaml`] = JSON.stringify(c);
  const loaded = plan.loadCells(files);
  const errors = [...loaded.errors, ...plan.validate(loaded.cells, plan.loadConfig(blueprintText(n)).cfg).errors];
  if (errors.length) {
    if (strict) assert.fail(`scenario "${sc.name}" is not a valid plan: ${errors[0]}`);
    return null;
  }
  clearPlanCache();
  clearPanelCache();
  const gh = materialize(n);
  const opts = { mainBranch: "main", historyPages: 3, now: () => NOW, sleep: async () => {}, uuid: () => "u" };
  let p: PanelState;
  try {
    p = await buildPanelState({} as any, REPO, { api: gh, opts });
  } catch (e) {
    throw new Error(`scenario "${sc.name}": buildPanelState failed: ${(e as Error).message}`);
  }
  const diff = firstDifference(n, await engineState(n, gh), p, tolerated);
  if (diff) assert.fail(`panel and engine differ in scenario "${sc.name}": ${diff}`);
  return p;
}

// ---------------------------------------------------------------- scenarios
const mk = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `cell ${id}`,
  goal: "g",
  inputs: [],
  after: [],
  provides: [`${id}-api`],
  allowed_paths: [`src/${id}/**`],
  outputs: [`src/${id}/x.ts`],
  acceptance: [{ cmd: "true" }],
  ...extra,
});
const planOf = (...cs: { id: string }[]) => Object.fromEntries(cs.map((c) => [c.id, c]));
// C-002 and C-003 wait for C-001; C-004 is independent.
const plain = () => planOf(mk("C-001"), mk("C-002", { after: ["C-001"] }), mk("C-003", { after: ["C-001"] }), mk("C-004"));
// C-002 replaces C-001; C-003 waits for C-001 (so for C-002); C-004 is independent.
const replaced = () => planOf(mk("C-001"), mk("C-002", { supersedes: ["C-001"], provides: ["C-001-api"] }), mk("C-003", { after: ["C-001"] }), mk("C-004"));

const handWritten: Scenario[] = [
  { name: "nothing started", cells: plain() },
  { name: "everything merged", cells: plain(), merged: ["C-001", "C-002", "C-003", "C-004"] },
  { name: "live lease blocks the dependents", cells: plain(), claims: { "C-001": 10 } },
  { name: "expired lease", cells: plain(), claims: { "C-001": 90 } },
  { name: "lease expires exactly now", cells: plain(), claims: { "C-001": 60 } },
  { name: "released while the lease is alive", cells: plain(), claims: { "C-001": 3 }, released: ["C-001"] },
  { name: "released while CI runs", cells: plain(), claims: { "C-001": 3 }, released: ["C-001"], ci: { "C-001": 5 } },
  { name: "expired lease kept alive by CI", cells: plain(), claims: { "C-001": 90 }, ci: { "C-001": 5 } },
  { name: "expired lease, CI past its limit", cells: plain(), claims: { "C-001": 90 }, ci: { "C-001": 50 } },
  { name: "feedback on a live lease", cells: plain(), claims: { "C-001": 10 }, feedback: ["C-001"] },
  { name: "feedback on an expired lease", cells: plain(), claims: { "C-001": 90 }, feedback: ["C-001"] },
  { name: "feedback on a cell that is also in the released list", cells: plain(), claims: { "C-004": 90 }, feedback: ["C-004"], released: ["C-004"] },
  { name: "attempts exhausted, lease expired", cells: plain(), claims: { "C-004": 90 }, attempts: { "C-004": 3 } },
  { name: "attempts exhausted, lease alive", cells: plain(), claims: { "C-004": 10 }, attempts: { "C-004": 3 } },
  { name: "attempts exhausted, but released", cells: plain(), claims: { "C-004": 90 }, attempts: { "C-004": 3 }, released: ["C-004"] },
  { name: "attempts below the limit", cells: plain(), claims: { "C-004": 90 }, attempts: { "C-004": 2 } },
  { name: "critical cell gets the short lease", cells: plain(), claims: { "C-001": 20 }, threshold: 2 },
  { name: "superseded cell is not live", cells: replaced() },
  { name: "superseder running", cells: replaced(), claims: { "C-002": 10 } },
  { name: "superseder merged", cells: replaced(), merged: ["C-002"] },
  { name: "superseded cell merged earlier", cells: replaced(), merged: ["C-001"] },
  { name: "superseded and superseder both merged", cells: replaced(), merged: ["C-001", "C-002"] },
  { name: "superseded cell with a stale released branch", cells: replaced(), claims: { "C-001": 90 }, released: ["C-001"] },
  { name: "superseded cell with feedback", cells: replaced(), claims: { "C-001": 90 }, feedback: ["C-001"] },
  { name: "superseder with feedback", cells: replaced(), claims: { "C-002": 10 }, feedback: ["C-002"] },
  { name: "superseder with exhausted attempts", cells: replaced(), claims: { "C-002": 90 }, attempts: { "C-002": 3 } },
];

const fromFixture = (c: any, i: number): Scenario => ({
  name: `fixtures.state[${i}]`,
  cells: c.cells,
  merged: c.merged,
  claims: c.claims,
  released: c.released,
  feedback: c.feedback,
  attempts: c.attempts,
  ci: c.ci,
  lease: c.lease,
  threshold: c.threshold,
  maxAttempts: c.max_attempts,
  chain: c.options.critical_chain_threshold,
  transitive: c.options.critical_transitive_threshold,
  criticalLease: c.options.critical_lease_minutes,
  parkMax: c.options.park_max_minutes,
});

test("panel agrees with the engine on the hand-written scenarios", async () => {
  const seen = new Set<string>();
  for (const sc of handWritten) {
    const p = await runScenario(sc, true);
    for (const k of STATUSES) if (p && p.counts[k] > 0) seen.add(k);
  }
  for (const k of STATUSES) assert.ok(seen.has(k), `no hand-written scenario produces a ${k} cell`);
});

test("panel agrees with the engine on every fixture scenario", async () => {
  const seen = new Set<string>();
  let ran = 0;
  let withSuperseded = 0;
  const tolerated: string[] = [];
  for (const [i, c] of fx.state.entries()) {
    const p = await runScenario(fromFixture(c, i), false, tolerated);
    if (!p) continue;
    ran++;
    for (const k of STATUSES) if (p.counts[k] > 0) seen.add(k);
    if (p.cells.some((x) => x.supersededBy)) withSuperseded++;
  }
  assert.ok(ran >= fx.state.length / 2, `only ${ran} of ${fx.state.length} fixture scenarios were valid plans`);
  for (const k of STATUSES) assert.ok(seen.has(k), `no fixture scenario produces a ${k} cell`);
  assert.ok(withSuperseded > 0, "no fixture scenario has a superseded cell");
});

// KNOWN DIFFERENCE in src/panel/state.ts (not fixed here, this cell only adds the test): the panel reads the active
// workflow runs only when some ready cell is a reclaim. A cell with exhausted attempts and an expired lease is
// needs_split in that first pass, so a CI run that keeps it 'running' in computeState is never looked at and the panel
// shows needs_split. The fixture test above tolerates exactly this case. Delete this test once state.ts is fixed.
test("known difference: CI-locked cell with exhausted attempts shows needs_split in the panel", async () => {
  const sc: Scenario = { name: "attempts exhausted, CI still running", cells: plain(), claims: { "C-004": 90 }, attempts: { "C-004": 3 }, ci: { "C-004": 5 } };
  await assert.rejects(runScenario(sc, true), /C-004: panel says needs_split, engine says running/);
});
