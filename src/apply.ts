// apply.ts
//
// apply_changes: validated, fenced commits onto a cell branch.

import type { GitHubApi, TreeEntry } from "./api.ts";
import { ID_RE, matches, slist } from "./plan.ts";
import { carry, parseTrailers, subjectOf } from "./trailers.ts";
import { branchOf, cleanPath, errText, invalidText, loadPlan, notClaimed, oneLine, short, type EngineOptions } from "./common.ts";

// ---------------------------------------------------------------- apply_changes
export interface Op {
  path: string;
  content?: string;
  old?: string;
  new?: string;
  delete?: boolean;
  append?: string;
}

export const MAX_OPS = 30;
export const MAX_FILE_BYTES = 200_000;
export const MAX_TOTAL_BYTES = 400_000;

export function bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** First 12 hex chars of SHA-256 over [cell_id, message, ops with sorted keys]. */
async function reqHash(cellId: string, message: string, ops: Op[]): Promise<string> {
  const canon = ops.map((o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
  const data = new TextEncoder().encode(JSON.stringify([cellId, message, canon]));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
}

export async function applyChanges(
  api: GitHubApi,
  repo: string,
  opts: EngineOptions,
  args: { cell_id: string; base: string; message: string; next: string; ops: Op[] },
): Promise<string> {
  const id = args.cell_id;
  if (!ID_RE.test(id)) return `BAD_CELL_ID ${id}`;
  if (!args.ops?.length) return "NOTHING_TO_COMMIT";
  if (args.ops.length > MAX_OPS) return `TOO_MANY_OPS: at most ${MAX_OPS} per call`;
  const next = oneLine(args.next ?? "", 300);
  if (next.length < 3) return "MISSING_NEXT: say what the next step is (next:), it is how a fresh chat resumes";
  let message = oneLine(args.message ?? "", 200);
  if (!message) return "MISSING_MESSAGE";
  if (!/^WIP:/i.test(message)) message = `WIP: ${message}`;

  const snap = await api.snapshot(repo, opts.mainBranch, 0);
  const plan = loadPlan(repo, snap, opts);
  if (plan.errors.length) return invalidText(plan);
  const cell = plan.cells[id];
  if (!cell) return `UNKNOWN_CELL ${id}`;
  const branch = snap.branches[branchOf(id)];
  if (!branch) return notClaimed(api, repo, id);
  const base = String(args.base ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(base)) return "MISSING_BASE: pass base = the 7-character sha from the last CLAIMED / RESUME / ok response";
  const baseOk = branch.oid.startsWith(base);
  const conflictText = `CONFLICT ${id}: ${branchOf(id)} is at ${short(branch.oid)}, not ${base.slice(0, 7)}: the cell was taken over or another chat is writing. Nothing was written. Stop and call next_cell.`;

  const allowed = slist(cell, "allowed_paths");
  const problems: string[] = [];
  const clean: Op[] = [];
  for (const op of args.ops) {
    const p = typeof op.path === "string" ? cleanPath(op.path) : null;
    if (p === null) {
      problems.push(`bad path: ${String(op.path)}`);
      continue;
    }
    if (matches(p, plan.cfg.protected_paths)) problems.push(`protected: ${p}`);
    else if (!matches(p, allowed)) problems.push(`outside allowed_paths: ${p}`);
    const kinds = [op.delete === true, typeof op.content === "string", typeof op.old === "string" || typeof op.new === "string", typeof op.append === "string"];
    if (kinds.filter(Boolean).length !== 1) problems.push(`${p}: give exactly one of content | old+new | delete | append`);
    else if (kinds[2] && !(typeof op.old === "string" && typeof op.new === "string" && op.old.length > 0)) problems.push(`${p}: an edit needs non-empty old and new`);
    clean.push({ ...op, path: p });
  }
  if (problems.length && !baseOk) return `${conflictText} tip: ${subjectOf(branch.message ?? "")}`;
  if (problems.length) {
    return `REJECTED (nothing committed)\n${problems.slice(0, 10).map((x) => `- ${x}`).join("\n")}\nallowed_paths: ${allowed.join(", ")}`;
  }

  const req = await reqHash(id, message, clean);
  if (!baseOk) {
    const tip = branch.message ?? "";
    if (parseTrailers(tip).req === req) return `ok ${short(branch.oid)} (already applied) (next base=${short(branch.oid)})`;
    return `${conflictText} tip: ${subjectOf(tip)}`;
  }

  // Working copies: edits see the result of earlier ops in the same call.
  const work = new Map<string, string | null>();
  const editPaths = [...new Set(clean.filter((o) => typeof o.old === "string" || typeof o.append === "string").map((o) => o.path))];
  if (editPaths.length) {
    const current = await api.readFiles(repo, branchOf(id), editPaths);
    for (const p of editPaths) work.set(p, current[p]);
  }
  for (const op of clean) {
    if (op.delete === true) work.set(op.path, null);
    else if (typeof op.content === "string") work.set(op.path, op.content);
    else if (typeof op.append === "string") work.set(op.path, (work.get(op.path) ?? "") + op.append);
    else {
      const cur = work.get(op.path);
      if (cur === null || cur === undefined) return `EDIT_FAILED ${op.path}: file does not exist on ${branchOf(id)} (nothing committed)`;
      const n = cur.split(op.old as string).length - 1;
      if (n === 0) return `EDIT_FAILED ${op.path}: old text not found (nothing committed)`;
      if (n > 1) return `EDIT_FAILED ${op.path}: old text occurs ${n} times, make it unique (nothing committed)`;
      work.set(op.path, cur.replace(op.old as string, () => op.new as string));
    }
  }

  const entries: TreeEntry[] = [...work.entries()].map(([path, content]) => ({ path, content }));
  let total = 0;
  for (const e of entries) {
    const size = e.content === null ? 0 : bytes(e.content);
    if (size > MAX_FILE_BYTES) return `TOO_LARGE ${e.path}: ${size} bytes (limit ${MAX_FILE_BYTES}); split the file`;
    total += size;
  }
  if (total > MAX_TOTAL_BYTES) return `TOO_LARGE: ${total} bytes in one call (limit ${MAX_TOTAL_BYTES}); send fewer files per call`;

  let oid: string;
  try {
    oid = await api.commitFiles(repo, branch.oid, branch.treeOid, entries, carry(branch.message ?? "", message, { next, req }));
  } catch (e) {
    return `ERROR: could not create the commit: ${errText(e)}`;
  }
  const moved = await api.fastForward(repo, branchOf(id), oid);
  if (moved === "ok") return `ok ${short(oid)} ${entries.length} file${entries.length === 1 ? "" : "s"} (next base=${short(oid)})`;
  if (moved === "missing") return notClaimed(api, repo, id);
  return `CONFLICT ${id}: ${branchOf(id)} moved while you were writing (taken over, or another chat is writing). Nothing was written. Stop and call next_cell.`;
}
