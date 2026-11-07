// engine.ts
//
// The cell engine facade: everything the Blueprint Kit protocol needs, as functions over the GitHubApi interface.
// The bulk lives in common/claim/resume/takeover/apply; the public names are re-exported from here.
// Every function returns the short text an agent will read. Nothing here knows about MCP or Cloudflare.

import type { GitHubApi, RunRef } from "./api.ts";
import { carry } from "./trailers.ts";
import { ID_RE, RUN_TITLE_RE, loadCells, loadConfig, validate } from "./plan.ts";
import { KIT_FILES, KIT_VERSION } from "./kit.ts";
import { NOT_INIT, branchOf, cleanPath, errText, freshSnapshot, invalidText, loadPlan, oneLine, short, type EngineOptions } from "./common.ts";

// Public facade: tests and index.ts import these names from engine.ts.
export { clearPlanCache, cleanPath, loadPlan, type EngineOptions, type Loaded } from "./common.ts";
export { nextCell, reserveKey, getReservation, setReservation, clearReservation, type ClaimOptions, type ReserveKv } from "./claim.ts";
export { takeoverCell } from "./takeover.ts";
export { applyChanges, type Op } from "./apply.ts";
import { bytes } from "./apply.ts";

// ---------------------------------------------------------------- init_blueprint (zero-setup per repo)
const KIT_MARKER = ".github/blueprint-kit.version";
const NEVER_UPGRADED = new Set(["blueprint.yaml", "cells/_TEMPLATE.yaml", "docs/decisions.md"]); // belong to the project

/** Install the kit (workflows, tools, config) on main in ONE commit. Never overwrites an existing Blueprint, except
 *  with upgrade:true, which replaces only the kit's own files (workflows, tools, BLUEPRINT.md), never the project's. */
export async function initBlueprint(api: GitHubApi, repo: string, opts: EngineOptions, args: { upgrade?: boolean } = {}): Promise<string> {
  let f = await freshSnapshot(api, repo, opts, 0);
  if (typeof f === "string" && f.startsWith("EMPTY_REPO")) {
    await api.putFile(repo, "README.md", `# ${repo.split("/")[1]}\n`, "chore: initial commit");
    f = await freshSnapshot(api, repo, opts, 0);
  }
  if (typeof f === "string") return f;
  const snap = f;
  const name = repo.split("/")[1] ?? repo;
  const installed = snap.blueprint !== null;
  let entries: { path: string; content: string }[];
  if (!installed) {
    entries = Object.entries(KIT_FILES).map(([path, content]) => ({
      path,
      content: path === "blueprint.yaml" ? content.replace(/^project: .*$/m, `project: ${name}`).replace(/^main_branch: .*$/m, `main_branch: ${opts.mainBranch}`) : content,
    }));
  } else {
    const have = (await api.readFiles(repo, opts.mainBranch, [KIT_MARKER]))[KIT_MARKER]?.trim() ?? "unknown";
    if (have === KIT_VERSION) return `ALREADY_INITIALIZED: kit ${KIT_VERSION} is current; nothing changed.`;
    if (!args.upgrade) return `ALREADY_INITIALIZED: installed kit is ${have}, this connector has ${KIT_VERSION}. Call init_blueprint with upgrade:true to update workflows and tools (cells and blueprint.yaml are never touched).`;
    entries = Object.entries(KIT_FILES).filter(([p]) => !NEVER_UPGRADED.has(p)).map(([path, content]) => ({ path, content }));
  }
  entries.push({ path: KIT_MARKER, content: KIT_VERSION + "\n" });
  const oid = await api.commitFiles(repo, snap.mainOid, snap.mainTreeOid, entries, `chore: ${installed ? "upgrade" : "install"} blueprint kit ${KIT_VERSION}`);
  const r = await api.fastForward(repo, opts.mainBranch, oid);
  if (r !== "ok") return `INIT_FAILED: could not update ${opts.mainBranch} (${r}); main may have moved or be protected. Retry once.`;
  return installed
    ? `OK upgraded blueprint kit to ${KIT_VERSION} (${entries.length} files). Cells and blueprint.yaml untouched.`
    : `OK installed blueprint kit ${KIT_VERSION} (${entries.length} files) on ${opts.mainBranch}. Next: add cells with publish_plan, then call next_cell.`;
}

// ---------------------------------------------------------------- read_files
export interface ReadSpec {
  path: string;
  start?: number;
  end?: number;
}

export async function readFiles(
  api: GitHubApi,
  repo: string,
  opts: EngineOptions,
  args: { cell_id?: string; files: ReadSpec[]; max_lines?: number },
): Promise<string> {
  if (args.cell_id !== undefined && !ID_RE.test(args.cell_id)) return `BAD_CELL_ID ${args.cell_id}`;
  if (!args.files?.length) return "NOTHING_TO_READ";
  for (const f of args.files) {
    const m = /^\/?cells\/(C-\d+)\.yaml$/.exec(f.path);
    if (m && m[1] !== args.cell_id) return `OUT_OF_SCOPE ${f.path}: you only need your own cell (it was in your CLAIMED reply). Other cells are not your concern; use ready_cells to see status.`;
  }
  if (args.files.length > 12) return "TOO_MANY_FILES: at most 12 per call";
  const budget = Math.min(Math.max(args.max_lines ?? 300, 1), 600);
  const branch = args.cell_id ? branchOf(args.cell_id) : opts.mainBranch;

  const dirs: string[] = [];
  const specs: ReadSpec[] = [];
  const bad: string[] = [];
  for (const f of args.files) {
    const isDir = f.path.trim().endsWith("/") || f.path.trim() === "";
    const clean = isDir ? (f.path.trim() === "" ? "" : cleanPath(f.path.trim().replace(/\/+$/, ""))) : cleanPath(f.path);
    if (clean === null) bad.push(f.path);
    else if (isDir) dirs.push(clean);
    else specs.push({ ...f, path: clean });
  }

  const content: Record<string, string | null> = {};
  if (specs.length) {
    const paths = [...new Set(specs.map((s) => s.path))];
    Object.assign(content, await api.readFiles(repo, branch, paths));
    const missing = paths.filter((p) => content[p] === null);
    if (missing.length && branch !== opts.mainBranch) Object.assign(content, await api.readFiles(repo, opts.mainBranch, missing));
  }

  const out: string[] = [];
  for (const p of bad) out.push(`REJECTED path: ${p}`);
  for (const d of dirs) {
    let names = await api.listDir(repo, branch, d);
    if (names === null && branch !== opts.mainBranch) names = await api.listDir(repo, opts.mainBranch, d);
    out.push(names === null ? `NOT_FOUND dir ${d || "/"}` : `--- ${d || "/"} (${names.length} entries)\n${names.slice(0, 100).join("\n")}${names.length > 100 ? "\n..." : ""}`);
  }
  let left = budget;
  for (const s of specs) {
    const text = content[s.path];
    if (text === null || text === undefined) {
      out.push(`NOT_FOUND ${s.path}`);
      continue;
    }
    const lines = text.split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    const total = lines.length;
    const start = Math.max(1, s.start ?? 1);
    const end = Math.min(total, s.end ?? total);
    if (start > total) {
      out.push(`--- ${s.path} (${total} lines)\n(start is beyond the end of the file)`);
      continue;
    }
    const take = Math.max(0, Math.min(end - start + 1, left));
    const slice = lines.slice(start - 1, start - 1 + take);
    left -= take;
    const range = start === 1 && take === total ? "" : `, lines ${start}-${start + take - 1}`;
    let block = `--- ${s.path} (${total} lines${range})\n${slice.join("\n")}`;
    if (take < end - start + 1) block += `\n[TRUNCATED at line ${start + take - 1} of ${total}; ask again with start/end or a larger max_lines]`;
    out.push(block);
  }
  return out.join("\n");
}

// ---------------------------------------------------------------- automatic main sync (submit_cell, preflight)
/** When cell/<id> is behind main, merge main into it (never touches main, costs no heal). stop = the CONFLICT text to return; line = the SYNCED note to add to the answer (empty when nothing was merged). */
async function syncMain(api: GitHubApi, repo: string, opts: EngineOptions, id: string): Promise<{ stop: string | null; line: string }> {
  const cmp = await api.compare(repo, opts.mainBranch, branchOf(id)).catch(() => null);
  if (!cmp || cmp.behind === 0) return { stop: null, line: "" };
  const snap = await api.snapshot(repo, opts.mainBranch, 0);
  const prev = snap.branches[branchOf(id)]?.message ?? "";
  const res = await api.mergeBranch(repo, branchOf(id), opts.mainBranch, carry(prev, `sync(${id}): merge ${opts.mainBranch}`));
  if (res.status === "conflict") {
    const files = (res.files ?? []).slice(0, 12).join(", ");
    return { line: "", stop: `CONFLICT ${id} (sync): ${opts.mainBranch} and your branch changed the same file(s)${files ? `: ${files}` : ""}. This is NOT a takeover: the cell is still yours and nothing was changed. Resolve those files inside allowed_paths with apply_changes, then call again; or call cell_help.` };
  }
  const tip = res.oid ?? (await api.branchTip(repo, branchOf(id)))?.oid;
  const line = res.status === "merged" && tip ? `SYNCED ${opts.mainBranch} into your branch (no takeover). New base=${short(tip)}. Continue with this base.` : "";
  return { stop: null, line };
}

// ---------------------------------------------------------------- submit_cell
export async function submitCell(
  api: GitHubApi,
  repo: string,
  opts: EngineOptions,
  args: { cell_id: string; summary: string },
): Promise<string> {
  const id = args.cell_id;
  if (!ID_RE.test(id)) return `BAD_CELL_ID ${id}`;
  const snap = await api.snapshot(repo, opts.mainBranch, 0);
  const plan = loadPlan(repo, snap, opts);
  if (plan.errors.length) return invalidText(plan);
  const cell = plan.cells[id];
  if (!cell) return `UNKNOWN_CELL ${id}`;
  if (!snap.branches[branchOf(id)]) return `NOT_CLAIMED ${id}: there is no branch ${branchOf(id)}. Call next_cell first.`;

  const existing = await api.findPr(repo, branchOf(id));
  if (existing?.state === "open") return `PR #${existing.number} already open; call ci_result`;
  const files = await api.changedFiles(repo, opts.mainBranch, branchOf(id));
  if (files.length === 0) return `NOTHING_TO_SUBMIT ${id}: the branch has no changes compared with ${opts.mainBranch}`;

  const sync = await syncMain(api, repo, opts, id);
  if (sync.stop) return sync.stop;
  const note = sync.line ? `\n${sync.line}` : "";

  const title = `cell(${id}): ${oneLine(String(cell.title ?? id), 120)}`;
  const body = String(args.summary ?? "").slice(0, 2000);
  try {
    const pr = await api.createPr(repo, { title, head: branchOf(id), base: opts.mainBranch, body });
    return `PR #${pr.number} opened (${files.length} files); call ci_result${note}`;
  } catch (e) {
    const again = await api.findPr(repo, branchOf(id));
    if (again?.state === "open") return `PR #${again.number} already open; call ci_result${note}`;
    return `ERROR: could not open the pull request: ${errText(e)}${note}`;
  }
}

// ---------------------------------------------------------------- preflight
export async function preflight(api: GitHubApi, repo: string, opts: EngineOptions, id: string): Promise<string> {
  if (!ID_RE.test(id)) return `BAD_CELL_ID ${id}`;
  const tip = await api.branchTip(repo, branchOf(id));
  if (!tip) return `NOT_CLAIMED ${id}: there is no branch ${branchOf(id)}. Call next_cell first.`;
  const sync = await syncMain(api, repo, opts, id);
  if (sync.stop) return sync.stop;
  const note = sync.line ? `\n${sync.line}` : "";
  try {
    await api.dispatch(repo, "cell-preflight.yml", opts.mainBranch, { cell_id: id });
  } catch (e) {
    return `ERROR: could not start the preflight: ${errText(e)}${note}`;
  }
  return `started preflight ${id}; keep working, then call ci_result once${note}`;
}

// ---------------------------------------------------------------- ci_result
function runCell(title: string): string | null {
  const m = RUN_TITLE_RE.exec(title || "");
  return m ? m[1] : null;
}

export async function ciResult(
  api: GitHubApi,
  repo: string,
  opts: EngineOptions,
  args: { cell_id: string; wait_seconds?: number },
): Promise<string> {
  const id = args.cell_id;
  if (!ID_RE.test(id)) return `BAD_CELL_ID ${id}`;
  const waitMs = Math.min(Math.max(args.wait_seconds ?? 45, 0), 90) * 1000;
  const deadline = opts.now() + waitMs;
  const POLL_MS = 5000;

  const newest = async () => {
    const [g, p] = await Promise.all([api.workflowRuns(repo, "cell-gate.yml", 30), api.workflowRuns(repo, "cell-preflight.yml", 30)]);
    const mine = [...g.map((r) => ({ r, kind: "gate" })), ...p.map((r) => ({ r, kind: "preflight" }))].filter((x) => runCell(x.r.displayTitle) === id);
    mine.sort((a, b) => Date.parse(b.r.createdAt) - Date.parse(a.r.createdAt));
    return mine[0] ?? null;
  };

  // After submit_cell the REAL gate is what matters. A preflight (or a gate for older code) must never be shown
  // as the answer: live test: ci_result showed "PASS ... preflight only" right after submit, before the gate started.
  const pr0 = await api.findPr(repo, branchOf(id));
  if (pr0?.merged) return `MERGED #${pr0.number}: ${id} is done.`;
  const gateWanted = pr0?.state === "open";
  const tip = await api.branchTip(repo, branchOf(id));
  const usable = (x: { r: RunRef; kind: string } | null) =>
    !!x && !(gateWanted && (x.kind !== "gate" || (tip && Date.parse(tip.committedDate) > Date.parse(x.r.createdAt) + 1000)));

  let found = await newest();
  // A run starts a few seconds after a PR or a dispatch: give it a moment to appear.
  while (!usable(found) && opts.now() < deadline) {
    await opts.sleep(POLL_MS);
    found = await newest();
  }
  if (gateWanted && !usable(found)) return `PENDING ${id}: the merge gate for your PR #${pr0!.number} has not started yet. Do other work or end your turn; call ci_result once later.`;
  if (!found) return `NO_RUN ${id}: nothing started. Call submit_cell (real gate) or preflight.`;

  let run = found.r;
  while (run.status !== "completed" && opts.now() < deadline) {
    await opts.sleep(POLL_MS);
    run = (await api.getRun(repo, run.id)) ?? run;
  }
  if (run.status !== "completed") {
    const pr = await api.jobsProgress(repo, run.id);
    const progress = pr.total ? `, ${pr.done}/${pr.total} jobs done` : "";
    return `PENDING ${id} run ${run.id} (${found.kind}${progress}). Do not poll in a loop: do other work or end your turn.`;
  }

  const text = await api.artifactText(repo, run.id, "test-results", "output.log");
  if (text === null) {
    return `FAIL ${id}: run ${run.id} ${run.conclusion ?? "ended"} without a result (pipeline error). See ${run.url}`;
  }
  const verdict = text.trim();
  if (found.kind === "preflight") {
    const tip = await api.branchTip(repo, branchOf(id));
    const stale = tip && Date.parse(tip.committedDate) > Date.parse(run.createdAt)
      ? "STALE: you committed after this preflight started; the result below is for older code. Run preflight again.\n"
      : "";
    return `${stale}${verdict}\n(preflight only: nothing is merged)`;
  }
  if (/^PASS\b/.test(verdict)) {
    const pr = await api.findPr(repo, branchOf(id));
    if (pr?.merged) return `${verdict}\nMERGED #${pr.number}`;
    // Checks passed but the merge step itself failed (seen live under load): re-run only the failed jobs once.
    if (pr?.state === "open" && run.conclusion === "failure") {
      try {
        await api.rerunFailed(repo, run.id);
        return `${verdict}\nMERGE_RETRY: the merge step failed; it was re-run. Call ci_result once more in a minute.`;
      } catch (e) {
        return `${verdict}\nMERGE_STUCK: checks passed but the PR is not merged and the re-run was refused (${errText(e)}). Ask the owner.`;
      }
    }
    if (pr?.state === "closed") return `${verdict}\nPR #${pr.number} is closed without merge; submit again if needed`;
    return `${verdict}\nMERGE_PENDING: checks passed, GitHub merges within seconds. Call ci_result once more.`;
  }
  return verdict;
}

// ---------------------------------------------------------------- admin gate (takeover, publish_plan)
/** Constant-time check of the admin key. Fails closed: with no ADMIN_TOKEN configured the admin tools are off. */
export async function checkAdmin(expected: string | undefined, given: string | undefined): Promise<string | null> {
  if (!expected) return "ADMIN_NOT_CONFIGURED: this tool is off until the owner sets the ADMIN_TOKEN secret.";
  if (!given) return "ADMIN_ONLY: this tool needs admin_key (the owner's key). Agents never use it; ask the owner.";
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(expected)), crypto.subtle.digest("SHA-256", enc.encode(given))]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0 ? null : "ADMIN_ONLY: wrong admin_key.";
}

// ---------------------------------------------------------------- repo policy
export function resolveRepo(
  env: { DEFAULT_REPO?: string; ALLOWED_REPOS?: string },
  requested?: string,
): { repo: string } | { error: string } {
  const allowed = new Set<string>();
  if (env.DEFAULT_REPO) allowed.add(env.DEFAULT_REPO.trim());
  for (const r of (env.ALLOWED_REPOS ?? "").split(",")) if (r.trim()) allowed.add(r.trim());
  const concrete = [...allowed].filter((a) => !a.endsWith("/*"));
  const only = concrete.length === 1 && concrete.length === allowed.size ? concrete[0] : "";
  const repo = (requested ?? env.DEFAULT_REPO ?? only).trim();
  if (!repo) return { error: "NO_REPO: pass repo as owner/name on EVERY call, exactly as shown in your CLAIMED / RESUME reply (repo=...)" };
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { error: `BAD_REPO ${repo}: expected owner/name` };
  if (allowed.size === 0) return { error: "NOT_CONFIGURED: set DEFAULT_REPO or ALLOWED_REPOS on the connector" };
  const lc = repo.toLowerCase();
  const ok = [...allowed].some((a) => {
    const al = a.toLowerCase();
    return al === lc || (al.endsWith("/*") && lc.startsWith(al.slice(0, -1))); // "owner/*" allows every repo of that owner
  });
  if (!ok) return { error: `REPO_NOT_ALLOWED ${repo}` };
  return { repo };
}



// ---------------------------------------------------------------- publish_plan (planner only)
const MAX_PLAN_CELLS = 40;

/** Add NEW cells to main. Cells are immutable: an existing id is refused. The whole resulting plan must validate. */
export async function publishPlan(
  api: GitHubApi,
  repo: string,
  opts: EngineOptions,
  args: { cells: { id: string; yaml: string }[]; message?: string },
): Promise<string> {
  if (!args.cells?.length) return "NOTHING_TO_PUBLISH";
  if (args.cells.length > MAX_PLAN_CELLS) return `TOO_MANY_CELLS: at most ${MAX_PLAN_CELLS} per call`;
  const f = await freshSnapshot(api, repo, opts, 0);
  if (typeof f === "string") return f;
  if (f.blueprint === null) return NOT_INIT;
  const files: Record<string, string> = { ...f.cellFiles };
  const entries: { path: string; content: string }[] = [];
  for (const c of args.cells) {
    if (!ID_RE.test(c.id)) return `BAD_CELL_ID ${c.id}`;
    const name = `${c.id}.yaml`;
    if (f.cellFiles[name] !== undefined) return `CELL_EXISTS ${c.id}: cells are immutable once on main; add a new cell instead`;
    if (entries.some((e) => e.path === `cells/${name}`)) return `DUPLICATE_ID ${c.id} in this call`;
    if (bytes(c.yaml) > 20_000) return `TOO_LARGE ${c.id}`;
    files[name] = c.yaml;
    entries.push({ path: `cells/${name}`, content: c.yaml.endsWith("\n") ? c.yaml : c.yaml + "\n" });
  }
  const { cfg, errors: ce } = loadConfig(f.blueprint);
  const { cells, errors: le } = loadCells(files);
  const v = validate(cells, cfg);
  const errors = [...ce, ...le, ...v.errors];
  if (errors.length) return ["REJECTED (nothing committed): the plan would be invalid", ...errors.slice(0, 8).map((e) => ` - ${e}`)].join("\n");
  const msg = oneLine(args.message ?? "", 120) || `add ${entries.length} cell(s)`;
  const oid = await api.commitFiles(repo, f.mainOid, f.mainTreeOid, entries, `plan: ${msg}`);
  const r = await api.fastForward(repo, opts.mainBranch, oid);
  if (r !== "ok") return `PUBLISH_FAILED: ${opts.mainBranch} moved or is protected (${r}). Retry once.`;
  return `OK published ${entries.length} cell(s): ${entries.map((e) => e.path.slice(6, -5)).join(", ")}. ${v.warnings.length ? "WARN: " + v.warnings.slice(0, 3).join("; ") + ". " : ""}Call next_cell.`;
}

