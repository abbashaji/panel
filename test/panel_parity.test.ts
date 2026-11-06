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
function firstDifference(n: Norm, st: plan.State, p: PanelState): string | null {
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
async function runScenario(sc: Scenario, strict: boolean): Promise<PanelState | null> {
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
  const diff = firstDifference(n, await engineState(n, gh), p);
  if (diff) assert.fail(`panel and engine differ in scenario "${sc.name}": ${diff}`);
  return p;
}
