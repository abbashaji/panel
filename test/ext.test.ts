// Tests for /ext/* (contracts C3, C5): auth, limitRelease statuses, commit shape, paging, the value test, the usage warning.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as engine from "../src/engine.ts";
import { extFetch, limitRelease, warnFlag, warnKey, warnTtl, LIMIT_WARNING_TEXT, WORKER_VERSION, RELEASE_NEXT_FALLBACK } from "../src/ext.ts";
import { toolHandlers, type Env } from "../src/tools.ts";
import { carry, isRelease, parseTrailers, subjectOf } from "../src/trailers.ts";
import { FakeGitHub } from "./fakegh.ts";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = "o/r";
const TOKEN = "ext-secret-token";
beforeEach(() => engine.clearPlanCache());

function seed(): FakeGitHub {
  const fx = new FakeGitHub();
  const files: Record<string, string> = { "blueprint.yaml": readFileSync(join(here, "example/blueprint.yaml"), "utf-8") };
  for (const f of readdirSync(join(here, "example/cells"))) files[`cells/${f}`] = readFileSync(join(here, "example/cells", f), "utf-8");
  fx.commit("main", files, "plan");
  return fx;
}
const CELL = (id: string, after: string[] = []) =>
  `id: ${id}\ntitle: t\ngoal: g\n${after.length ? `after: [${after.join(", ")}]\n` : ""}provides:\n  - "src/${id}.py: def f()"\nallowed_paths: [src/${id}.py]\noutputs: [src/${id}.py]\nacceptance:\n  - cmd: "true"\n`;
/** C-000 plus 4 direct dependents: C-000 is critical (bottleneck_threshold 4). */
function seedCritical(): FakeGitHub {
  const fx = new FakeGitHub();
  const files: Record<string, string> = { "blueprint.yaml": "project: p\nmain_branch: main\nlease_minutes: 60\nmax_ci_minutes: 45\nbottleneck_threshold: 4\nmax_cell_files: 8\nacceptance_timeout_s: 600\nprotected_paths: []\nowners: {}\n", "cells/C-000.yaml": CELL("C-000") };
  for (const i of [1, 2, 3, 4]) files[`cells/C-00${i}.yaml`] = CELL(`C-00${i}`, ["C-000"]);
  fx.commit("main", files, "plan");
  return fx;
}
let n = 0;
const opts = (fx: FakeGitHub) => ({ mainBranch: "main", historyPages: 5, now: () => fx.clock, sleep: async (ms: number) => fx.tick(ms), uuid: () => `x${++n}` });
const claim = (fx: FakeGitHub) => engine.nextCell(fx, REPO, opts(fx), "claim");
const base7 = (t: string) => /base=([0-9a-f]{7})/.exec(t)![1];
const min = (fx: FakeGitHub, m: number) => fx.tick(m * 60000);
const tip = (fx: FakeGitHub, id = "C-000") => fx.commits.get(fx.refs.get(`cell/${id}`)!)!;
const WRITE_CALLS = new Set(["commitFiles", "commitEmpty", "createBranch", "fastForward", "putFile", "createPr", "dispatch", "rerunFailed"]);
const writes = (fx: FakeGitHub) => fx.calls.filter((c) => WRITE_CALLS.has(c));
const rel = (fx: FakeGitHub, base: string, extra: { label?: string } = {}) => limitRelease(fx, REPO, { cell_id: "C-000", base, ...extra });

class FakeKv {
  map = new Map<string, string>();
  puts: { key: string; value: string; opts?: { expirationTtl?: number } }[] = [];
  async get(k: string) {
    return this.map.get(k) ?? null;
  }
  async put(key: string, value: string, o?: { expirationTtl?: number }) {
    this.puts.push({ key, value, opts: o });
    this.map.set(key, value);
  }
  async delete(k: string) {
    this.map.delete(k);
  }
}
const envOf = (over: Partial<Env> = {}): Env => ({ GITHUB_TOKEN: "gh-token-xyz", ALLOWED_REPOS: "o/r", EXT_TOKEN: TOKEN, ...over }) as Env;
const req = (path: string, o: { method?: string; token?: string | null; body?: unknown; raw?: string } = {}) =>
  new Request(`https://w.example${path}`, {
    method: o.method ?? (path === "/ext/ping" ? "GET" : "POST"),
    headers: { ...(o.token === null ? {} : { Authorization: `Bearer ${o.token ?? TOKEN}` }), "Content-Type": "application/json" },
    body: (o.method ?? (path === "/ext/ping" ? "GET" : "POST")) === "GET" ? undefined : (o.raw ?? JSON.stringify(o.body ?? {})),
  });
const call = async (fx: FakeGitHub, env: Env, path: string, o: Parameters<typeof req>[1] = {}) => {
  const res = await extFetch(req(path, o), env, () => fx);
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { res, json, text };
};
const noCors = (res: Response) => assert.deepEqual([...res.headers.keys()].filter((k) => k.startsWith("access-control")), []);

// ---------------------------------------------------------------- auth
test("auth: EXT_TOKEN unset -> 404 for every /ext path", async () => {
  const fx = seed();
  for (const p of ["/ext/ping", "/ext/release", "/ext/warn", "/ext/other"]) {
    const r = await call(fx, envOf({ EXT_TOKEN: undefined }), p, { token: TOKEN });
    assert.equal(r.res.status, 404, p);
    noCors(r.res);
  }
});

test("auth: wrong or missing token -> 401, no CORS header anywhere, no OPTIONS handling", async () => {
  const fx = seed();
  for (const token of ["wrong", "", ext_prefix(), null]) {
    for (const p of ["/ext/ping", "/ext/release", "/ext/warn"]) {
      const r = await call(fx, envOf(), p, { token });
      assert.equal(r.res.status, 401, `${p} ${token}`);
      noCors(r.res);
    }
  }
  const pre = await extFetch(new Request("https://w.example/ext/release", { method: "OPTIONS", headers: { Origin: "https://claude.ai", "Access-Control-Request-Method": "POST" } }), envOf(), () => fx);
  assert.equal(pre.status, 401);
  noCors(pre);
  const ok = await call(fx, envOf(), "/ext/ping");
  noCors(ok.res);
  assert.equal(writes(fx).length, 0);
});
function ext_prefix() {
  return TOKEN.slice(0, -1);
}

test("routing: ping -> {ok, version}; unknown path 404; wrong method 405 (after auth)", async () => {
  const fx = seed();
  const p = await call(fx, envOf(), "/ext/ping");
  assert.equal(p.res.status, 200);
  assert.deepEqual(p.json, { ok: true, version: WORKER_VERSION });
  assert.equal((await call(fx, envOf(), "/ext/nope")).res.status, 404);
  assert.equal((await call(fx, envOf(), "/ext/ping", { method: "POST", body: {} })).res.status, 405);
  assert.equal((await call(fx, envOf(), "/ext/release", { method: "GET" })).res.status, 405);
  assert.equal((await call(fx, envOf(), "/ext/warn", { method: "PUT", body: {} })).res.status, 405);
  assert.equal((await call(fx, envOf(), "/ext/nope", { token: "bad" })).res.status, 401); // auth before routing
});

test("input: body over 2 KB -> 400 refused; not JSON -> 400; foreign or missing repo -> 400", async () => {
  const fx = seed();
  const big = await call(fx, envOf(), "/ext/release", { body: { repo: REPO, cell_id: "C-000", base: "abcdef0", label: "x".repeat(3000) } });
  assert.equal(big.res.status, 400);
  assert.equal(big.json.status, "refused");
  assert.equal((await call(fx, envOf(), "/ext/release", { raw: "{nope" })).res.status, 400);
  assert.equal((await call(fx, envOf(), "/ext/release", { raw: "[1]" })).res.status, 400);
  const foreign = await call(fx, envOf(), "/ext/release", { body: { repo: "evil/x", cell_id: "C-000", base: "abcdef0" } });
  assert.equal(foreign.res.status, 400);
  assert.equal(foreign.json.status, "refused");
  assert.equal((await call(fx, envOf({ DEFAULT_REPO: REPO }), "/ext/release", { body: { cell_id: "C-000", base: "abcdef0" } })).res.status, 400); // the repo must be explicit
  assert.equal((await call(fx, envOf(), "/ext/release", { body: { repo: REPO, cell_id: "nope", base: "abcdef0" } })).res.status, 400);
  assert.equal((await call(fx, envOf(), "/ext/release", { body: { repo: REPO, cell_id: "C-000", base: "zz" } })).res.status, 400);
  assert.deepEqual(writes(fx), []);
});

test("missing GITHUB_TOKEN -> 200 NOT_CONFIGURED; an exception -> 200 error with a secret-free cut message", async () => {
  const fx = seed();
  const nc = await call(fx, envOf({ GITHUB_TOKEN: "" }), "/ext/release", { body: { repo: REPO, cell_id: "C-000", base: "abcdef0" } });
  assert.equal(nc.res.status, 200);
  assert.deepEqual(nc.json, { status: "error", detail: "NOT_CONFIGURED" });
  const t = base7(await claim(fx));
  fx.failNext.branchCommits = new Error(`boom gh-token-xyz ghp_${"a".repeat(36)} ${"z".repeat(400)}`);
  const r = await call(fx, envOf(), "/ext/release", { body: { repo: REPO, cell_id: "C-000", base: t } });
  assert.equal(r.res.status, 200);
  assert.equal(r.json.status, "error");
  assert.ok(r.json.detail.length <= 200);
  assert.doesNotMatch(r.text, /gh-token-xyz|ghp_|zzzzzzzz/);
});

// ---------------------------------------------------------------- C3 statuses
test("released: via HTTP, commit shape (subject, label, parent = old tip, same tree, isRelease)", async () => {
  const fx = seed();
  const base = base7(await claim(fx));
  fx.commit("cell/C-000", { "pyproject.toml": "x" }, "WIP: step\n\nnext: do step two\nattempt: 2\nreq: abc123");
  const before = tip(fx);
  const r = await call(fx, envOf(), "/ext/release", { body: { repo: REPO, cell_id: "C-000", base, label: "Work_PC!" } });
  assert.equal(r.res.status, 200);
  assert.equal(r.json.status, "released");
  const t = tip(fx);
  assert.equal(t.parent, before.oid);
  assert.equal(t.tree, before.tree);
  assert.ok(isRelease(t.message));
  assert.equal(subjectOf(t.message), "release(C-000): usage limit [workpc]");
  assert.deepEqual(parseTrailers(t.message), { attempt: 2, next: "do step two" });
  assert.doesNotMatch(t.message, /req:/);
});

test("commit shape: no label -> plain subject; next: carried, fallback only when the tip has none; attempt unchanged", async () => {
  const fx = seed();
  const base = base7(await claim(fx));
  assert.equal((await rel(fx, base, { label: "!!!" })).status, "released");
  assert.equal(subjectOf(tip(fx).message), "release(C-000): usage limit");
  assert.deepEqual(parseTrailers(tip(fx).message), { attempt: 0, next: RELEASE_NEXT_FALLBACK }); // fresh claim has no next:
  // a tip with next: keeps it; label longer than 20 chars is cut
  const fx2 = seed();
  const b2 = base7(await claim(fx2));
  fx2.commit("cell/C-000", {}, "WIP\n\nnext: KEEP ME");
  await rel(fx2, b2, { label: "a".repeat(30) });
  assert.equal(subjectOf(tip(fx2).message), `release(C-000): usage limit [${"a".repeat(20)}]`);
  assert.equal(parseTrailers(tip(fx2).message).next, "KEEP ME");
  assert.ok(tip(fx2).message.length < 200);
});

test("already_released, needs_human, no_branch, unverifiable, not_owner write nothing", async () => {
  const fx = seed();
  assert.equal((await rel(fx, "abcdef0")).status, "no_branch");
  const base = base7(await claim(fx));
  assert.equal((await rel(fx, base)).status, "released");
  fx.calls.length = 0;
  assert.equal((await rel(fx, base)).status, "already_released");
  assert.deepEqual(writes(fx), []);

  const f2 = seed();
  const b2 = base7(await claim(f2));
  await engine.nextCell(f2, REPO, opts(f2), "peek");
  const { cellSignal } = await import("../src/signal.ts");
  assert.match(await cellSignal(f2, REPO, opts(f2), { cell_id: "C-000", base: tip(f2).oid.slice(0, 7), kind: "feedback", text: "need a decision" }), /^feedback recorded/);
  f2.calls.length = 0;
  assert.equal((await rel(f2, b2)).status, "needs_human");
  assert.deepEqual(writes(f2), []);

  // not_owner: another chat adopted after the lock the extension knows
  const f3 = seed();
  const old = base7(await claim(f3));
  min(f3, 20);
  assert.match(await claim(f3), /^RESUME C-000/);
  const tipBefore = f3.refs.get("cell/C-000");
  f3.calls.length = 0;
  assert.equal((await rel(f3, old)).status, "not_owner");
  assert.equal(f3.refs.get("cell/C-000"), tipBefore);
  assert.deepEqual(writes(f3), []);

  // unverifiable: no lock commit at all
  const f4 = seed();
  f4.commit("cell/C-000", { a: "1" }, "WIP only");
  assert.equal((await rel(f4, "abcdef0")).status, "unverifiable");
});

test("a lock commit of ANOTHER cell id is ignored", async () => {
  const f1 = seed();
  f1.commit("cell/C-000", {}, "claim(C-001): lock zz"); // wrong id only
  const base = f1.refs.get("cell/C-000")!.slice(0, 7);
  assert.equal((await rel(f1, base)).status, "unverifiable");
  // a newer foreign lock on top of the real one does not hide the real lock
  const f2 = seed();
  const b2 = base7(await claim(f2));
  f2.commit("cell/C-000", {}, "adopt(C-001): lock yy");
  assert.equal((await rel(f2, b2)).status, "released");
  // and a foreign lock whose sha matches base is never accepted
  const f3 = seed();
  const real = base7(await claim(f3));
  f3.commit("cell/C-000", {}, "takeover(C-002): lock q");
  const foreign = f3.refs.get("cell/C-000")!.slice(0, 7);
  assert.equal((await rel(f3, foreign)).status, "not_owner");
  assert.notEqual(real, foreign);
});

test("submitted: an open PR means nothing is written; a closed or merged PR does not block", async () => {
  const fx = seed();
  const base = base7(await claim(fx));
  await fx.createPr(REPO, { title: "cell(C-000): t", head: "cell/C-000", base: "main", body: "b" });
  const before = fx.refs.get("cell/C-000");
  fx.calls.length = 0;
  const r = await rel(fx, base);
  assert.equal(r.status, "submitted");
  assert.equal(fx.refs.get("cell/C-000"), before);
  assert.deepEqual(writes(fx), []);
  fx.prs[0].state = "closed";
  assert.equal((await rel(fx, base)).status, "released");
});

test("moved: a racing write between the read and the fast-forward; error: an API failure", async () => {
  const fx = seed();
  const base = base7(await claim(fx));
  const orig = fx.findPr.bind(fx);
  fx.findPr = async (r: string, b: string) => {
    fx.commit(b, { race: "1" }, "WIP race");
    return orig(r, b);
  };
  const raced = fx.refs.get("cell/C-000");
  const r = await rel(fx, base);
  assert.equal(r.status, "moved");
  assert.notEqual(fx.refs.get("cell/C-000"), raced);
  assert.doesNotMatch(subjectOf(tip(fx).message), /^release\(/);

  const f2 = seed();
  const b2 = base7(await claim(f2));
  f2.failNext.commitEmpty = new Error("GitHub 500");
  const e = await rel(f2, b2);
  assert.equal(e.status, "error");
  assert.match(e.detail, /GitHub 500/);
});

test("paging: lock on page 2 of 120 commits is found; lock + 30 WIP stops after page 1", async () => {
  const fx = seed();
  const base = base7(await claim(fx));
  for (let i = 0; i < 119; i++) fx.commit("cell/C-000", { [`f${i}`]: "1" }, `WIP ${i}`);
  fx.calls.length = 0;
  assert.equal((await rel(fx, base)).status, "released");
  assert.equal(fx.calls.filter((c) => c === "branchCommits").length, 2);

  const f2 = seed();
  const b2 = base7(await claim(f2));
  for (let i = 0; i < 30; i++) f2.commit("cell/C-000", { [`f${i}`]: "1" }, `WIP ${i}`);
  f2.calls.length = 0;
  assert.equal((await rel(f2, b2)).status, "released");
  assert.equal(f2.calls.filter((c) => c === "branchCommits").length, 1);

  // no lock within 10 pages: unverifiable (at most 10 calls)
  const f3 = seed();
  await claim(f3);
  for (let i = 0; i < 1100; i++) f3.commit("cell/C-000", { f: String(i) }, `WIP ${i}`);
  f3.calls.length = 0;
  assert.equal((await rel(f3, "abcdef0")).status, "unverifiable");
  assert.equal(f3.calls.filter((c) => c === "branchCommits").length, 10);
});

// ---------------------------------------------------------------- the value test
test("VALUE: a released critical cell is resumed first and never counts an attempt; plain expiries do", async () => {
  const fx = seedCritical();
  let r = await claim(fx);
  assert.match(r, /^CLAIMED C-000/);
  for (let i = 0; i < 4; i++) {
    const base = base7(r);
    fx.commit("cell/C-000", { [`w${i}.txt`]: "x" }, `WIP ${i}\n\nnext: step ${i}`);
    assert.equal((await rel(fx, base)).status, "released", `cycle ${i}`);
    r = await claim(fx); // chat B
    assert.match(r, /^RESUME C-000 /, `cycle ${i}`); // before any fresh cell
    assert.doesNotMatch(r, /attempt \d/);
    assert.doesNotMatch(r, /needs_split/);
    assert.equal(parseTrailers(tip(fx).message).attempt, 0);
    assert.match(subjectOf(tip(fx).message), /^adopt\(C-000\)/);
  }
  assert.doesNotMatch(await engine.nextCell(fx, REPO, opts(fx), "peek"), /needs_split/);

  // contrast: plain lease expiries
  const f2 = seedCritical();
  await claim(f2);
  const seen: string[] = [];
  for (let i = 1; i <= 3; i++) {
    min(f2, 20); // critical lease 15 min
    const t = await claim(f2);
    seen.push(t);
    assert.match(t, new RegExp(`^RESUME C-000 .*attempt ${i}/3`));
  }
  min(f2, 20);
  const last = await claim(f2);
  assert.match(last, /needs_split: C-000\(3 attempts\)/);
  assert.doesNotMatch(last, /^RESUME/);
});

// ---------------------------------------------------------------- C5 warning
test("warnTtl: 40 min -> 2700, 10 s -> 1800, 20 h -> 21600, none -> 10800", () => {
  const now = Date.parse("2026-11-01T10:00:00Z");
  assert.equal(warnTtl(new Date(now + 40 * 60000).toISOString(), now), 2700);
  assert.equal(warnTtl(new Date(now + 10000).toISOString(), now), 1800);
  assert.equal(warnTtl(new Date(now + 20 * 3600000).toISOString(), now), 21600);
  assert.equal(warnTtl(undefined, now), 10800);
  assert.equal(warnTtl("garbage", now), 10800);
});

test("/ext/warn: warned (flag in KV with ttl, no git write), not_running, already_released", async () => {
  const fx = seed();
  const kv = new FakeKv();
  const env = envOf({ OAUTH_KV: kv as any });
  const nr = await call(fx, env, "/ext/warn", { body: { repo: REPO, cell_id: "C-000" } });
  assert.deepEqual(nr.json.status, "not_running");
  assert.equal(kv.puts.length, 0);

  const base = base7(await claim(fx));
  fx.calls.length = 0;
  const reset = new Date(Date.now() + 40 * 60000).toISOString();
  const w = await call(fx, env, "/ext/warn", { body: { repo: REPO, cell_id: "C-000", resets_at: reset } });
  assert.equal(w.res.status, 200);
  assert.equal(w.json.status, "warned");
  assert.deepEqual(writes(fx), []);
  assert.equal(kv.puts.length, 1);
  assert.equal(kv.puts[0].key, "warn:o/r:C-000");
  assert.ok(Math.abs(kv.puts[0].opts!.expirationTtl! - 2700) <= 2);
  assert.equal(JSON.parse(kv.puts[0].value).resets_at, reset);
  assert.ok(JSON.parse(kv.puts[0].value).at);
  const tipBefore = fx.refs.get("cell/C-000");
  assert.equal(fx.refs.get("cell/C-000"), tipBefore);

  const w2 = await call(fx, env, "/ext/warn", { body: { repo: REPO, cell_id: "C-000" } });
  assert.equal(w2.json.status, "warned");
  assert.equal(kv.puts[1].opts!.expirationTtl, 10800);

  await rel(fx, base);
  kv.puts.length = 0;
  kv.map.clear();
  const ar = await call(fx, env, "/ext/warn", { body: { repo: REPO, cell_id: "C-000" } });
  assert.equal(ar.json.status, "already_released");
  assert.equal(kv.puts.length, 0);
});

test("/ext/warn: warnFlag exact TTL with a fixed clock; 404 / 401 / 400 as for release", async () => {
  const fx = seed();
  await claim(fx);
  const kv = new FakeKv();
  const now = Date.parse("2026-11-01T10:00:00Z");
  for (const [off, want] of [[40 * 60000, 2700], [10000, 1800], [20 * 3600000, 21600]] as const) {
    const r = await warnFlag(fx, kv, REPO, { cell_id: "C-000", resets_at: new Date(now + off).toISOString() }, () => now);
    assert.equal(r.status, "warned");
    assert.equal(kv.puts.at(-1)!.opts!.expirationTtl, want);
  }
  const env = envOf({ OAUTH_KV: kv as any });
  assert.equal((await call(fx, envOf({ EXT_TOKEN: undefined, OAUTH_KV: kv as any }), "/ext/warn", { body: { repo: REPO, cell_id: "C-000" } })).res.status, 404);
  assert.equal((await call(fx, env, "/ext/warn", { token: "bad", body: { repo: REPO, cell_id: "C-000" } })).res.status, 401);
  assert.equal((await call(fx, env, "/ext/warn", { body: { repo: "evil/x", cell_id: "C-000" } })).res.status, 400);
  assert.equal((await call(fx, env, "/ext/warn", { body: { repo: REPO, cell_id: "C-000", resets_at: "nope" } })).res.status, 400);
  assert.equal((await call(fx, env, "/ext/warn", { body: { repo: REPO, cell_id: "x".repeat(3000) } })).res.status, 400);
  assert.equal((await call(fx, envOf({ OAUTH_KV: undefined }), "/ext/warn", { body: { repo: REPO, cell_id: "C-000" } })).json.detail, "NOT_CONFIGURED");
});

function warnedEnv(kv: FakeKv | undefined, over: Partial<Env> = {}) {
  return envOf({ DEFAULT_REPO: REPO, OAUTH_KV: kv as any, ...over });
}
const flag = (kv: FakeKv, id = "C-000") => kv.map.set(warnKey(REPO, id), JSON.stringify({ at: "x", resets_at: null }));

test("tool replies get LIMIT_WARNING_TEXT while the flag exists (not for CONFLICT / NOT_CLAIMED / CELL_DONE, not for another cell)", async () => {
  const fx = seed();
  const kv = new FakeKv();
  const h = toolHandlers(warnedEnv(kv), opts(fx), () => fx);
  const cl = await h.next_cell({});
  assert.match(cl, /^CLAIMED C-000/);
  flag(kv);
  const cur = () => fx.refs.get("cell/C-000")!.slice(0, 7);
  const ends = (s: string) => assert.ok(s.endsWith(`\n${LIMIT_WARNING_TEXT}`), s);

  ends(await h.apply_changes({ cell_id: "C-000", base: base7(cl), message: "m", next: "n2", ops: [{ path: "pyproject.toml", content: "x" }] }));
  ends(await h.cell_signal({ cell_id: "C-000", base: cur(), kind: "heartbeat" }));
  ends(await h.read_files({ cell_id: "C-000", files: [{ path: "pyproject.toml" }] }));
  ends(await h.preflight({ cell_id: "C-000" }));
  ends(await h.ci_result({ cell_id: "C-000" }));
  ends(await h.submit_cell({ cell_id: "C-000", summary: "s" }));

  // read_files without cell_id: no kv read, no suffix
  assert.doesNotMatch(await h.read_files({ files: [{ path: "README.md" }] }), /LIMIT_WARNING/);
  // CONFLICT: stale base
  const c = await h.apply_changes({ cell_id: "C-000", base: "0000000", message: "m", next: "next step", ops: [{ path: "pyproject.toml", content: "y" }] });
  assert.match(c, /^CONFLICT/);
  assert.doesNotMatch(c, /LIMIT_WARNING/);
  // NOT_CLAIMED, even with a flag for that cell
  flag(kv, "C-001");
  const nc = await h.apply_changes({ cell_id: "C-001", base: "abcdef0", message: "m", next: "next step", ops: [{ path: "src/x.py", content: "y" }] });
  assert.match(nc, /^NOT_CLAIMED/);
  assert.doesNotMatch(nc, /LIMIT_WARNING/);
  // another cell without flag
  const f2 = seed();
  const h2 = toolHandlers(warnedEnv(kv), opts(f2), () => f2);
  const r2 = await h2.next_cell({});
  flag(kv, "C-009");
  assert.doesNotMatch(await h2.cell_signal({ cell_id: "C-000", base: base7(r2), kind: "heartbeat" }), /LIMIT_WARNING/);
  // CELL_DONE
  const f3 = seed();
  const kv3 = new FakeKv();
  const h3 = toolHandlers(warnedEnv(kv3), opts(f3), () => f3);
  await h3.next_cell({});
  f3.mergeCell("C-000");
  flag(kv3);
  const done = await h3.apply_changes({ cell_id: "C-000", base: "abcdef0", message: "m", next: "next step", ops: [{ path: "pyproject.toml", content: "y" }] });
  assert.doesNotMatch(done, /LIMIT_WARNING/);
  assert.match(done, /^(CELL_DONE|NOT_CLAIMED|ALREADY)/);
});

test("the flag is deleted by next_cell RESUME / CLAIMED, by cell_signal release and by takeover; a heartbeat keeps it", async () => {
  const fx = seed();
  const kv = new FakeKv();
  const env = warnedEnv(kv, { ADMIN_TOKEN: "adm" });
  const h = toolHandlers(env, opts(fx), () => fx);
  const cl = await h.next_cell({});
  flag(kv);
  await h.cell_signal({ cell_id: "C-000", base: fx.refs.get("cell/C-000")!.slice(0, 7), kind: "heartbeat" });
  assert.equal(kv.map.size, 1);
  min(fx, 20);
  assert.match(await h.next_cell({}), /^RESUME C-000/);
  assert.equal(kv.map.size, 0);
  assert.ok(cl);

  flag(kv);
  const rr = await h.cell_signal({ cell_id: "C-000", base: fx.refs.get("cell/C-000")!.slice(0, 7), kind: "release", next: "continue here" });
  assert.match(rr, /^released C-000/);
  assert.doesNotMatch(rr, /LIMIT_WARNING/);
  assert.equal(kv.map.size, 0);

  // the next claim of a fresh cell deletes that cell's flag (CLAIMED)
  const f2 = seed();
  const kv2 = new FakeKv();
  const h2 = toolHandlers(warnedEnv(kv2), opts(f2), () => f2);
  flag(kv2, "C-000");
  assert.match(await h2.next_cell({}), /^CLAIMED C-000/);
  assert.equal(kv2.map.size, 0);

  // admin takeover (adopt) deletes it
  const f3 = seed();
  const kv3 = new FakeKv();
  const h3 = toolHandlers(warnedEnv(kv3, { ADMIN_TOKEN: "adm" }), opts(f3), () => f3);
  await h3.next_cell({});
  flag(kv3);
  min(f3, 20);
  assert.match(await h3.takeover({ cell_id: "C-000", admin_key: "adm" }), /^RESUME C-000/);
  assert.equal(kv3.map.size, 0);
});

test("a missing OAUTH_KV changes nothing; a failing KV never breaks a reply", async () => {
  const fx = seed();
  const h = toolHandlers(warnedEnv(undefined), opts(fx), () => fx);
  const cl = await h.next_cell({});
  assert.match(cl, /^CLAIMED C-000/);
  const r = await h.cell_signal({ cell_id: "C-000", base: base7(cl), kind: "heartbeat" });
  assert.match(r, /^ok [0-9a-f]{7}/);
  assert.doesNotMatch(r, /LIMIT_WARNING/);
  const bad = { get: async () => { throw new Error("kv down"); }, put: async () => {}, delete: async () => { throw new Error("kv down"); } };
  const h2 = toolHandlers(warnedEnv(bad as any), opts(fx), () => fx);
  const r2 = await h2.cell_signal({ cell_id: "C-000", base: fx.refs.get("cell/C-000")!.slice(0, 7), kind: "heartbeat" });
  assert.match(r2, /^ok [0-9a-f]{7}/);
});

test("carry() is the only trailer logic: release message equals carry(tip, subject, fallback)", () => {
  const msg = "WIP\n\nnext: a\nattempt: 1\nreq: z";
  assert.equal(carry(msg, "release(C-000): usage limit"), "release(C-000): usage limit\n\nnext: a\nattempt: 1");
});
