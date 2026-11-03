// resume.ts
//
// The RESUME text handed to a chat that continues a cell already on a branch.

import type { GitHubApi, Snapshot } from "./api.ts";
import { RULES } from "./protocol.ts";
import { RUN_TITLE_RE } from "./plan.ts";
import { parseTrailers, subjectOf } from "./trailers.ts";
import { branchOf, cellYaml, short, type Loaded } from "./common.ts";

export async function resumeText(api: GitHubApi, repo: string, snap: Snapshot, plan: Loaded, id: string, tip: string, attempt?: number): Promise<string> {
  const b = snap.branches[branchOf(id)];
  // The new lock commit is not in the snapshot: the caller passes its attempt; without it, show the old tip's attempt.
  const n = attempt ?? (b ? parseTrailers(b.message).attempt : 0);
  let files: string[] = [];
  try {
    files = await api.changedFiles(repo, plan.cfg.main_branch, branchOf(id));
  } catch {
    /* the list is a convenience */
  }
  let prLine = "";
  try {
    const pr = await api.findPr(repo, branchOf(id));
    if (pr && pr.state === "open" && !pr.merged) {
      const runs = (await api.workflowRuns(repo, "cell-gate.yml", 30)).filter((r) => RUN_TITLE_RE.exec(r.displayTitle || "")?.[1] === id);
      runs.sort((x, y) => Date.parse(y.createdAt) - Date.parse(x.createdAt));
      const r = runs[0];
      prLine = `\nPR #${pr.number} open; newest gate run: ${r ? `${r.status}/${r.conclusion ?? "running"}` : "none yet"} (call ci_result)`;
    }
  } catch {
    /* the line is a convenience */
  }
  // Last commit: its subject and next: trailer only. The attempt: and req: trailers are never printed (the header is the single source).
  const trl = parseTrailers(b?.message ?? "");
  const last = `Last commit: ${subjectOf(b?.message ?? "")}${trl.next ? `\nnext: ${trl.next}` : ""}`;
  const shown = files.slice(0, 30).join(", ") + (files.length > 30 ? ", ..." : "");
  return (
    `RESUME ${id} base=${short(tip)} repo=${repo} on ${branchOf(id)}${n > 0 ? ` attempt ${n}/${plan.cfg.max_attempts ?? 3}` : ""}. ${last}\n` +
    `Files already changed (${files.length}): ${shown || "none"}${prLine}\n\n${cellYaml(plan.cells[id])}\n\n${RULES}`
  );
}
