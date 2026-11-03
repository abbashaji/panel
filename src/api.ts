// api.ts
//
// The narrow, high-level GitHub surface the cell engine needs. engine.ts only talks to this interface:
// github.ts implements it against GitHub (one GraphQL query for the whole project state, REST for writes),
// test/fakegh.ts implements it in memory with the same atomicity rules, so the engine's races are testable.

export interface BranchInfo {
  oid: string;
  treeOid: string;
  committedDate: string; // ISO time of the last commit: the lease heartbeat
  message: string; // full message of the last commit (ends with "next: ...")
}

export interface Snapshot {
  mainOid: string;
  mainTreeOid: string;
  cellFiles: Record<string, string>; // file name inside cells/ -> text
  blueprint: string | null; // text of blueprint.yaml
  branches: Record<string, BranchInfo>; // key "cell/C-007"
  subjects: string[]; // commit headlines of the main branch, newest first
  historyComplete: boolean; // false when more history exists than was read
  mergedIds?: string[]; // cells known merged from a source other than the commit subjects (github.ts fills it in)
}

export interface RunRef {
  id: number;
  status: string; // queued | in_progress | completed | ...
  conclusion: string | null;
  displayTitle: string; // "gate cell/C-007" / "preflight C-007" (run-name in the workflows)
  headBranch: string;
  createdAt: string;
  url: string;
}

export interface PrRef {
  number: number;
  state: string; // open | closed
  merged: boolean;
  url: string;
}

export interface TreeEntry {
  path: string;
  content: string | null; // null = delete the file
}

export interface GitHubApi {
  /** One round trip: main commit/tree, cells/*.yaml, blueprint.yaml, cell/* branches, merge history. */
  snapshot(repo: string, mainBranch: string, historyPages: number): Promise<Snapshot>;
  /** Text of files at a ref (branch name); null where a file does not exist or is not text. */
  readFiles(repo: string, ref: string, paths: string[]): Promise<Record<string, string | null>>;
  /** Names in a directory (suffix "/" for sub-directories); null if the path is not a directory. */
  listDir(repo: string, ref: string, path: string): Promise<string[] | null>;
  /** New commit with the given file changes on top of parent. Does not move any branch. */
  commitFiles(repo: string, parentOid: string, baseTreeOid: string, entries: TreeEntry[], message: string): Promise<string>;
  /** New commit that reuses an existing tree (a lock / heartbeat commit). Does not move any branch. */
  commitEmpty(repo: string, parentOid: string, treeOid: string, message: string): Promise<string>;
  /** Create branch; "exists" if it already does (the atomic lock). */
  createBranch(repo: string, branch: string, oid: string): Promise<"created" | "exists">;
  /** Move a branch forward without force: "not_ff" if oid is not a descendant of the current tip. */
  fastForward(repo: string, branch: string, oid: string): Promise<"ok" | "not_ff" | "missing">;
  /** Create the very first commit of an EMPTY repository (Contents API; the Git Data API cannot do this). */
  putFile(repo: string, path: string, content: string, message: string): Promise<void>;
  branchTip(repo: string, branch: string): Promise<{ oid: string; treeOid: string; committedDate: string } | null>;
  /** Commits of a branch, newest first (first-parent order). page starts at 1; perPage is clamped to 1..100; null when the branch does not exist; [] past the end. */
  branchCommits(repo: string, branch: string, page: number, perPage: number): Promise<{ oid: string; treeOid: string; message: string }[] | null>;
  changedFiles(repo: string, base: string, head: string): Promise<string[]>;
  activeRuns(repo: string): Promise<RunRef[]>;
  workflowRuns(repo: string, workflowFile: string, perPage: number): Promise<RunRef[]>;
  getRun(repo: string, runId: number): Promise<RunRef | null>;
  /** Re-run only the failed jobs of a workflow run (the merge step of a gate whose checks passed). */
  rerunFailed(repo: string, runId: number): Promise<void>;
  jobsProgress(repo: string, runId: number): Promise<{ done: number; total: number }>;
  artifactText(repo: string, runId: number, artifact: string, file: string): Promise<string | null>;
  findPr(repo: string, branch: string): Promise<PrRef | null>; // newest PR from this branch, any state
  createPr(repo: string, args: { title: string; head: string; base: string; body: string }): Promise<PrRef>;
  dispatch(repo: string, workflowFile: string, ref: string, inputs: Record<string, string>): Promise<void>;
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.status = status;
  }
}
