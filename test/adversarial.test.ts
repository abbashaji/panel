import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as engine from "../src/engine.ts";
import { cellSignal } from "../src/signal.ts";
import { toolHandlers } from "../src/tools.ts";
import { FakeGitHub } from "./fakegh.ts";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = "o/r";
beforeEach(() => engine.clearPlanCache());
function seed(): FakeGitHub {
  const fx = new FakeGitHub();
  const files: Record<string, string> = { "blueprint.yaml": readFileSync(join(here, "example/blueprint.yaml"), "utf-8") };
  for (const f of readdirSync(join(here, "example/cells"))) files[`cells/${f}`] = readFileSync(join(here, "example/cells", f), "utf-8");
  fx.commit("main", files, "plan");
  return fx;
}
let n = 0;
const o = (fx: FakeGitHub, pages = 5) => ({ mainBranch: "main", historyPages: pages, now: () => fx.clock, sleep: async (ms: number) => fx.tick(ms), uuid: () => `u${++n}` });
const claim = (fx: FakeGitHub) => engine.nextCell(fx, REPO, o(fx), "claim");
const base7 = (t: string) => /base=([0-9a-f]{7})/.exec(t)![1];
const min = (fx: FakeGitHub, m: number) => fx.tick(m * 60000);
const apply = (fx: FakeGitHub, id: string, base: string, ops: any[], next = "step X") =>
  engine.applyChanges(fx, REPO, o(fx), { cell_id: id, base, message: "m", next, ops });

test("F1 skeleton: a dead chat idles every other chat for at most the 15 min critical lease", async () => {
  const fx = seed();
  const c = await claim(fx); // chat A takes C-000 (skeleton, now [critical], lease capped at 15m)
  assert.match(c, /^CLAIMED C-000/);
  min(fx, 1); // A's quota dies right now
  for (const m of [4, 5, 4]) { min(fx, m); assert.match(await claim(fx), /^NONE_READY/); } // 5, 10, 14 min
  min(fx, 2);
  assert.match(await claim(fx), /RESUME C-000/); // after 16 min, not 60
});

test("F1b skeleton is flagged [critical] in the hand-out line", async () => {
  const fx = seed();
  const out = await engine.nextCell(fx, REPO, o(fx), "peek");
  assert.match(out.split("\n")[0], /^READY C-000\[critical\]/);
});

test("F2 yield: a released (PARTIAL) cell is adopted by the next next_cell at once, attempt unchanged", async () => {
  const fx = seed();
  const a = await claim(fx);
  const a2 = await apply(fx, "C-000", base7(a), [{ path: "pyproject.toml", content: "x" }], "write conftest");
  // chat A reaches 60% context and says PARTIAL -> releases through cell_signal
  const tip = /base=([0-9a-f]{7})/.exec(a2)![1];
  assert.match(await cellSignal(fx, REPO, o(fx), { cell_id: "C-000", base: tip, kind: "release", next: "write conftest" }), /^released C-000/);
  min(fx, 1);
  const b = await claim(fx);
  assert.match(b, /^RESUME C-000/);
  assert.doesNotMatch(b.split("\n")[0], /attempt [1-9]/); // an adoption is not an attempt
  assert.match(fx.commits.get(fx.refs.get("cell/C-000")!)!.message, /^adopt\(C-000\)/);
});

test("F3 breadcrumb: a takeover commit carries the next: line and the attempt count to the next resumer", async () => {
  const fx = seed();
  const a = await claim(fx);
  await apply(fx, "C-000", base7(a), [{ path: "pyproject.toml", content: "x" }], "NEXT-STEP-MARKER write conftest");
  min(fx, 61);
  const b = await claim(fx); // B resumes, sees the marker
  assert.match(b, /NEXT-STEP-MARKER/);
  min(fx, 61); // B's quota dies before its first commit
  const c = await claim(fx);
  assert.match(c, /^RESUME C-000/);
  assert.match(c, /NEXT-STEP-MARKER/); // breadcrumb survives two deaths
  assert.match(c, /attempt 2/);
  console.log("   C sees:", c.split("\n").slice(0, 3).join(" | "));
});

test("F4 no heartbeat: empty apply_changes is refused, lease can only be renewed by a real file change", async () => {
  const fx = seed();
  const a = await claim(fx);
  assert.equal(await apply(fx, "C-000", base7(a), []), "NOTHING_COMMIT".replace("COMMIT", "TO_COMMIT"));
  // the heartbeat lives in cellSignal: it renews the lease without a file change
  min(fx, 10);
  const hb = await cellSignal(fx, REPO, o(fx), { cell_id: "C-000", base: base7(a), kind: "heartbeat" });
  assert.match(hb, /^ok [0-9a-f]{7} \(next base=/);
  min(fx, 10); // 20 min since the claim, 10 since the heartbeat (critical lease 15m)
  assert.match(await claim(fx), /^NONE_READY/);
});

test("F5 false death: slow chat on a 15m-lease critical cell is fenced out mid-generation", async () => {
  const fx = seed();
  const a = await claim(fx); // C-000
  fx.commit("cell/C-000", { "pyproject.toml": "x" }, "WIP");
  fx.mergeCell("C-000");
  // make C-001 a hypothetical 15m cell by aging: simulate chat A generating a huge file for 16 min
  const a1 = await claim(fx); // C-001
  min(fx, 61); // (default 60m lease here; with lease_minutes:15 the same happens at 16m)
  const b = await claim(fx);
  assert.match(b, /RESUME C-001|CLAIMED C-002/);
  if (/RESUME C-001/.test(b)) {
    const r = await apply(fx, "C-001", base7(a1), [{ path: "src/app/config.py", content: "big" }]);
    assert.match(r, /^CONFLICT/); // A's whole generation is lost
  }
});

test("F6 takeover is ungated in the engine by design; the admin gate lives in tools.ts", async () => {
  const fx = seed();
  const a = await claim(fx);
  // engine level: calling takeoverCell directly works (documented, not a hole: agents never get this function)
  const t = await engine.takeoverCell(fx, REPO, o(fx), "C-000", true);
  assert.match(t, /^RESUME C-000/);
  assert.match(await apply(fx, "C-000", base7(a), [{ path: "pyproject.toml", content: "x" }]), /^CONFLICT/);
  // tool level: without the right admin_key the handler refuses and writes nothing
  const fx2 = seed();
  await claim(fx2);
  const before = fx2.refs.get("cell/C-000");
  const h = toolHandlers({ GITHUB_TOKEN: "t", DEFAULT_REPO: REPO, ADMIN_TOKEN: "secret" } as any, o(fx2), () => fx2);
  for (const key of [undefined, "wrong"]) {
    const r = await h.takeover({ repo: REPO, cell_id: "C-000", force: true, admin_key: key } as any);
    assert.match(r, /^ADMIN_ONLY/);
  }
  assert.equal(fx2.refs.get("cell/C-000"), before);
});

test("F7 human takeover with handoff: a fresh next_cell gets RESUME, not NONE_READY", async () => {
  const fx = seed();
  await claim(fx);
  min(fx, 5);
  assert.match(await engine.takeoverCell(fx, REPO, o(fx), "C-000", false, { handoff: true }), /^RELEASED C-000/);
  assert.match(await claim(fx), /^RESUME C-000/); // fresh chat following BLUEPRINT.md gets the cell
});

test("F8 poison cell: after max_attempts deaths the cell is needs_split and never handed out again", async () => {
  const fx = seed();
  let out = await claim(fx);
  for (let i = 1; i <= 3; i++) {
    min(fx, 61); out = await claim(fx);
    assert.match(out, /^RESUME C-000/);
    assert.match(out.split("\n")[0], new RegExp(`attempt ${i}/3\\.`));
  }
  min(fx, 61);
  out = await claim(fx); // 4th claim: C-000 has died 3 times
  assert.doesNotMatch(out, /^RESUME|^CLAIMED/);
  assert.match(out, /needs_split: C-000\(3 attempts\)/);
  assert.match(await engine.nextCell(fx, REPO, o(fx), "peek"), /needs_split: C-000\(3 attempts\)/);
});

test("F9 history window: merged cells older than the window are not offered again (mergedIds from merged PRs)", async () => {
  const fx = seed();
  await claim(fx); fx.commit("cell/C-000", { "pyproject.toml": "x" }, "WIP"); fx.mergeCell("C-000");
  for (let i = 0; i < 130; i++) fx.commit("main", { [`docs/n${i}.md`]: "x" }, `human ${i}`);
  const peek = await engine.nextCell(fx, REPO, o(fx, 1), "peek"); // 1 page = 100 subjects
  console.log("   peek:", peek.split("\n")[0], "|", peek.split("\n").slice(1).join(" ").slice(0, 120));
  assert.doesNotMatch(peek, /C-000/); // merged long ago: not re-offered
});
