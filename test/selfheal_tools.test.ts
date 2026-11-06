// selfheal_tools.test.ts: the self-heal tools (cell_help, cell_note, cell_sync, cell_clear, cell_fix) and the automatic main sync before submit and preflight.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import * as engine from "../src/engine.ts";
import type { EngineOptions } from "../src/engine.ts";
import { RULES, SERVER_INSTRUCTIONS } from "../src/protocol.ts";
import { buildServer, selfhealToolHandlers, toolHandlers, type Env } from "../src/tools.ts";
import { FakeGitHub } from "./fakegh.ts";

const REPO = "o/r";
const ID = "C-001";
const TOOLS = ["cell_clear", "cell_fix", "cell_help", "cell_note", "cell_sync"];

beforeEach(() => engine.clearPlanCache());

const envOf = (): Env => ({ GITHUB_TOKEN: "t", DEFAULT_REPO: REPO }) as Env;
function opts(gh: FakeGitHub): EngineOptions {
  let n = 0;
  return { mainBranch: "main", historyPages: 1, now: () => gh.clock, sleep: async () => {}, uuid: () => `u${++n}` };
}
const cellYaml = `id: ${ID}\ntitle: Cell ${ID}\ngoal: do it\nallowed_paths:\n  - src/${ID}.ts\noutputs:\n  - src/${ID}.ts\nacceptance:\n  - cmd: "true"\n`;

/** A claimed cell C-001 with one commit of work on its branch; returns the handlers and the base. */
async function setup(): Promise<{ gh: FakeGitHub; h: Record<string, (a: any) => Promise<string>>; base: string }> {
  const gh = new FakeGitHub();
  gh.commit("main", { "blueprint.yaml": "project: demo\nlease_minutes: 60\n", [`cells/${ID}.yaml`]: cellYaml }, "plan");
  const text = await engine.nextCell(gh, REPO, { ...opts(gh), claim: { pin: ID } }, "claim");
  const m = /^CLAIMED C-001 base=([0-9a-f]+)/.exec(text);
  assert.ok(m, text);
  const h = { ...toolHandlers(envOf(), opts(gh), () => gh), ...selfhealToolHandlers(envOf(), opts(gh), () => gh) };
  return { gh, h, base: m[1] };
}
const tipOf = (gh: FakeGitHub): string => gh.refs.get(`cell/${ID}`)!;
const behind = async (gh: FakeGitHub): Promise<number> => (await gh.compare(REPO, "main", `cell/${ID}`)).behind;

test("the self-heal handlers are exactly five, the cell tools stay at 11, and buildServer registers them", () => {
  const gh = new FakeGitHub();
  assert.deepEqual(Object.keys(selfhealToolHandlers(envOf(), opts(gh), () => gh)).sort(), TOOLS);
  assert.equal(Object.keys(toolHandlers(envOf(), opts(gh), () => gh)).length, 11);
  const registered = (buildServer(envOf(), () => gh) as any)._registeredTools;
  if (registered) for (const t of TOOLS) assert.ok(t in registered, `${t} is registered`);
});

test("denied without base: every tool, nothing written", async () => {
  const { gh, h } = await setup();
  const before = tipOf(gh);
  const calls: Record<string, any> = { cell_help: { problem: "x" }, cell_note: { note: "n" }, cell_sync: {}, cell_clear: {}, cell_fix: { kind: "replace", cells: [] } };
  for (const t of TOOLS) assert.match(await h[t]({ repo: REPO, cell_id: ID, ...calls[t] }), /^SELFHEAL_DENIED: missing base/, t);
  assert.equal(tipOf(gh), before);
});

test("every tool answers with a base (no admin key anywhere)", async () => {
  const { gh, h, base } = await setup();
  const a = { repo: REPO, cell_id: ID, base };
  assert.match(await h.cell_help({ ...a, problem: "hmm" }), /^SELF-HEAL BRIEFING C-001/);
  assert.match(await h.cell_sync(a), /^UP_TO_DATE/);
  assert.match(await h.cell_clear(a), /^NO_FEEDBACK/);
  const fix = await h.cell_fix({ ...a, kind: "replace", cells: [] });
  assert.ok(fix.length > 0 && !fix.startsWith("SELFHEAL_DENIED") && !fix.startsWith("ERROR"), fix);
  const noted = await h.cell_note({ ...a, note: "assume x" });
  assert.match(noted, /^HEALED C-001: /);
  assert.match(gh.commits.get(tipOf(gh))!.message, /^note: assume x$/m);
});

test("submit on a behind branch merges main first", async () => {
  const { gh, h } = await setup();
  gh.commit(`cell/${ID}`, { [`src/${ID}.ts`]: "work" }, "work");
  gh.commit("main", { "docs/y.md": "y" }, "human");
  assert.equal(await behind(gh), 1);
  const out = await h.submit_cell({ repo: REPO, cell_id: ID, summary: "s" });
  assert.match(out, /^synced main into cell\/C-001.*PR #\d+ opened/, out);
  assert.equal(await behind(gh), 0);
  assert.equal(gh.prs.length, 1);
});

test("preflight on a behind branch merges main first", async () => {
  const { gh, h } = await setup();
  gh.commit("main", { "docs/y.md": "y" }, "human");
  const out = await h.preflight({ repo: REPO, cell_id: ID });
  assert.match(out, /^synced main into cell\/C-001.*started preflight C-001/, out);
  assert.equal(await behind(gh), 0);
});

test("submit on a conflicting branch stops with CONFLICT and changes nothing", async () => {
  const { gh, h } = await setup();
  gh.commit("main", { [`src/${ID}.ts`]: "from main" }, "human");
  gh.commit(`cell/${ID}`, { [`src/${ID}.ts`]: "from branch" }, "work");
  const before = tipOf(gh);
  const out = await h.submit_cell({ repo: REPO, cell_id: ID, summary: "s" });
  assert.match(out, /^CONFLICT C-001/, out);
  assert.equal(tipOf(gh), before);
  assert.equal(gh.prs.length, 0);
});

test("submit on an up-to-date branch changes nothing but the PR", async () => {
  const { gh, h } = await setup();
  gh.commit(`cell/${ID}`, { [`src/${ID}.ts`]: "work" }, "work");
  const before = gh.commits.size;
  const out = await h.submit_cell({ repo: REPO, cell_id: ID, summary: "s" });
  assert.match(out, /^PR #\d+ opened/, out);
  assert.equal(gh.commits.size, before);
});

test("the rules and the server instructions send a blocked chat to cell_help first", () => {
  for (const t of [RULES, SERVER_INSTRUCTIONS]) {
    assert.match(t, /cell_help/);
    assert.match(t, /ESCALATE/);
  }
  assert.match(RULES, /BEFORE cell_signal feedback/);
  assert.match(RULES, /Wrong or impossible contract: no workaround/);
});
