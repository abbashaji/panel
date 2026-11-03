// fakegh.ts: an in-memory GitHub implementing GitHubApi with GitHub's real atomicity rules:
//  - creating a branch that exists is refused (the claim lock),
//  - a non-force ref update must be a fast-forward (the takeover),
//  - commits/trees are content-addressed, so a losing claimer leaves only an unreferenced object.
import { createHash } from "node:crypto";
import { ApiError, type BranchInfo, type GitHubApi, type PrRef, type RunRef, type Snapshot, type TreeEntry } from "../src/api.ts";

interface Commit {
  oid: string;
  tree: string;
  parent: string | null;
  message: string;
  date: string;
}

const sha = (s: string) => createHash("sha1").update(s).digest("hex");

export class FakeGitHub implements GitHubApi {
  trees = new Map<string, Record<string, string>>();
  commits = new Map<string, Commit>();
  refs = new Map<string, string>(); // branch name -> commit oid
  clock = Date.parse("2026-10-30T10:00:00Z");
  mergedPrIds = new Set<string>(); // cells merged through mergeCell(): what the PR search would report (findPr is unchanged)
  prs: (PrRef & { branch: string; title: string; body: string })[] = [];
  runs: (RunRef & { workflow: string })[] = [];
  artifacts = new Map<number, string>(); // run id -> output.log
  jobs = new Map<number, { done: number; total: number }>();
  dispatched: { workflow: string; ref: string; inputs: Record<string, string> }[] = [];
  calls: string[] = [];
  failNext: Record<string, Error> = {};
  nextRunId = 1000;
  nextPr = 1;
  repo = "o/r";

  constructor(empty = false) {
    if (!empty) this.commit("main", { "README.md": "x\n" }, "init");
  }
  staleSnapshots = 0; // the next N snapshot() calls return the previous main (GitHub read-replica lag)
  private lastSnap: Snapshot | null = null;

  async putFile(_repo: string, path: string, content: string, message: string) {
    this.maybeFail("putFile");
    this.commit("main", { [path]: content }, message);
  }

  // ---- test helpers
  private put(files: Record<string, string>): string {
    const key = JSON.stringify(Object.entries(files).sort());
    const oid = sha("tree" + key);
    this.trees.set(oid, { ...files });
    return oid;
  }

  tick(ms: number) {
    this.clock += ms;
  }

  /** Commit directly onto a branch (creating it from main if needed). */
  commit(branch: string, files: Record<string, string | null>, message: string): string {
    const parentOid = this.refs.get(branch) ?? (branch === "main" ? null : this.refs.get("main")!);
    const base = parentOid ? { ...this.trees.get(this.commits.get(parentOid)!.tree)! } : {};
    for (const [p, c] of Object.entries(files)) {
      if (c === null) delete base[p];
      else base[p] = c;
    }
    const tree = this.put(base);
    const oid = sha(`commit${tree}${parentOid}${message}${this.clock}${this.commits.size}`);
    this.commits.set(oid, { oid, tree, parent: parentOid, message, date: new Date(this.clock).toISOString() });
    this.refs.set(branch, oid);
    return oid;
  }

  /** Squash-merge a cell branch into main the way the gate does, then delete the branch. */
  mergeCell(id: string, title = "done") {
    const b = this.refs.get(`cell/${id}`)!;
    const tree = this.trees.get(this.commits.get(b)!.tree)!;
    const mainTree = this.trees.get(this.commits.get(this.refs.get("main")!)!.tree)!;
    const files: Record<string, string | null> = {};
    for (const [p, c] of Object.entries(tree)) if (mainTree[p] !== c) files[p] = c;
    this.commit("main", files, `cell(${id}): ${title} (#${this.nextPr})`);
    this.refs.delete(`cell/${id}`);
    this.mergedPrIds.add(id);
    const pr = this.prs.find((p) => p.branch === `cell/${id}`);
    if (pr) {
      pr.state = "closed";
      pr.merged = true;
    }
  }

  /** Add n unrelated commits to main (pushes older merges out of the history window). */
  addMainCommits(n: number) {
    for (let i = 0; i < n; i++) this.commit("main", { [`docs/bulk${this.commits.size}.md`]: "x" }, `human ${i}`);
  }

  file(branch: string, path: string): string | undefined {
    const oid = this.refs.get(branch);
    return oid ? this.trees.get(this.commits.get(oid)!.tree)![path] : undefined;
  }

  addRun(workflow: string, title: string, status: string, conclusion: string | null = null, ageMin = 0, log?: string): RunRef {
    const run = {
      id: this.nextRunId++,
      status,
      conclusion,
      displayTitle: title,
      headBranch: "main",
      createdAt: new Date(this.clock - ageMin * 60000).toISOString(),
      url: `https://github.com/${this.repo}/actions/runs/${this.nextRunId - 1}`,
      workflow,
    };
    this.runs.push(run);
    if (log !== undefined) this.artifacts.set(run.id, log);
    return run;
  }

  private maybeFail(name: string) {
    this.calls.push(name);
    const e = this.failNext[name];
    if (e) {
      delete this.failNext[name];
      throw e;
    }
  }

  // ---- GitHubApi
  async snapshot(repo: string, mainBranch: string, historyPages: number): Promise<Snapshot> {
    if (this.staleSnapshots > 0 && this.lastSnap) {
      this.staleSnapshots--;
      this.calls.push("snapshot");
      return this.lastSnap;
    }
    const s = await this.snapshotNow(repo, mainBranch, historyPages);
    this.lastSnap = s;
    return s;
  }

  private async snapshotNow(_repo: string, mainBranch: string, historyPages: number): Promise<Snapshot> {
    this.maybeFail("snapshot");
    if (!this.refs.has(mainBranch)) throw new ApiError(`branch ${mainBranch} not found in o/r`);
    const mainOid = this.refs.get(mainBranch)!;
    const mc = this.commits.get(mainOid)!;
    const tree = this.trees.get(mc.tree)!;
    const cellFiles: Record<string, string> = {};
    for (const [p, c] of Object.entries(tree)) if (p.startsWith("cells/") && !p.slice(6).includes("/")) cellFiles[p.slice(6)] = c;
    const branches: Record<string, BranchInfo> = {};
    for (const [name, oid] of this.refs) {
      if (name.startsWith("cell/")) {
        const c = this.commits.get(oid)!;
        branches[name] = { oid, treeOid: c.tree, committedDate: c.date, message: c.message };
      }
    }
    const subjects: string[] = [];
    let historyComplete = true;
    if (historyPages > 0) {
      let cur: string | null = mainOid;
      const cap = historyPages * 100;
      while (cur) {
        if (subjects.length >= cap) {
          historyComplete = false;
          break;
        }
        const c: Commit = this.commits.get(cur)!;
        subjects.push(c.message.split("\n")[0]);
        cur = c.parent;
      }
    }
    const mergedIds = [...new Set([...this.mergedPrIds, ...this.prs.filter((p) => p.merged).map((p) => /^cell\/(C-\d{3,})$/.exec(p.branch)?.[1]).filter((x): x is string => !!x)])];
    return { mainOid, mainTreeOid: mc.tree, cellFiles, blueprint: tree["blueprint.yaml"] ?? null, branches, subjects, historyComplete, mergedIds };
  }

  async readFiles(_repo: string, ref: string, paths: string[]) {
    this.maybeFail("readFiles");
    const oid = this.refs.get(ref);
    const out: Record<string, string | null> = {};
    for (const p of paths) out[p] = oid ? (this.trees.get(this.commits.get(oid)!.tree)![p] ?? null) : null;
    return out;
  }

  async listDir(_repo: string, ref: string, path: string) {
    this.maybeFail("listDir");
    const oid = this.refs.get(ref);
    if (!oid) return null;
    const tree = this.trees.get(this.commits.get(oid)!.tree)!;
    const prefix = path ? path.replace(/\/+$/, "") + "/" : "";
    const names = new Set<string>();
    for (const p of Object.keys(tree)) {
      if (p.startsWith(prefix)) {
        const rest = p.slice(prefix.length);
        names.add(rest.includes("/") ? rest.split("/")[0] + "/" : rest);
      }
    }
    return names.size ? [...names].sort() : null;
  }

  async commitFiles(_repo: string, parentOid: string, baseTreeOid: string, entries: TreeEntry[], message: string) {
    this.maybeFail("commitFiles");
    const base = { ...this.trees.get(baseTreeOid)! };
    for (const e of entries) {
      if (e.content === null) delete base[e.path];
      else base[e.path] = e.content;
    }
    const tree = this.put(base);
    const oid = sha(`commit${tree}${parentOid}${message}${this.commits.size}`);
    this.commits.set(oid, { oid, tree, parent: parentOid, message, date: new Date(this.clock).toISOString() });
    return oid;
  }

  async commitEmpty(_repo: string, parentOid: string, treeOid: string, message: string) {
    this.maybeFail("commitEmpty");
    const oid = sha(`commit${treeOid}${parentOid}${message}${this.commits.size}`);
    this.commits.set(oid, { oid, tree: treeOid, parent: parentOid, message, date: new Date(this.clock).toISOString() });
    return oid;
  }

  async createBranch(_repo: string, branch: string, oid: string) {
    this.maybeFail("createBranch");
    if (this.refs.has(branch)) return "exists" as const;
    this.refs.set(branch, oid);
    return "created" as const;
  }

  private isAncestor(anc: string, desc: string): boolean {
    for (let cur: string | null = desc; cur; cur = this.commits.get(cur)!.parent) if (cur === anc) return true;
    return false;
  }

  async fastForward(_repo: string, branch: string, oid: string) {
    this.maybeFail("fastForward");
    const cur = this.refs.get(branch);
    if (!cur) return "missing" as const;
    if (!this.isAncestor(cur, oid)) return "not_ff" as const;
    this.refs.set(branch, oid);
    return "ok" as const;
  }

  async branchTip(_repo: string, branch: string) {
    this.maybeFail("branchTip");
    const oid = this.refs.get(branch);
    if (!oid) return null;
    const c = this.commits.get(oid)!;
    return { oid, treeOid: c.tree, committedDate: c.date };
  }

  async branchCommits(_repo: string, branch: string, page: number, perPage: number) {
    this.maybeFail("branchCommits");
    let oid = this.refs.get(branch) ?? null;
    if (!oid) return null;
    const n = Math.min(100, Math.max(1, Math.trunc(perPage) || 1));
    const p = Math.max(1, Math.trunc(page) || 1);
    const all: { oid: string; treeOid: string; message: string }[] = [];
    while (oid) {
      const c: Commit = this.commits.get(oid)!;
      all.push({ oid, treeOid: c.tree, message: c.message });
      oid = c.parent;
    }
    return all.slice((p - 1) * n, p * n);
  }

  async changedFiles(_repo: string, base: string, head: string) {
    this.maybeFail("changedFiles");
    const a = this.trees.get(this.commits.get(this.refs.get(base)!)!.tree)!;
    const hOid = this.refs.get(head);
    if (!hOid) return [];
    const b = this.trees.get(this.commits.get(hOid)!.tree)!;
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((p) => a[p] !== b[p]).sort();
  }

  async activeRuns() {
    this.maybeFail("activeRuns");
    return this.runs.filter((r) => r.status === "queued" || r.status === "in_progress");
  }

  async workflowRuns(_repo: string, workflowFile: string, perPage: number) {
    this.maybeFail("workflowRuns");
    return this.runs.filter((r) => r.workflow === workflowFile).slice(-perPage);
  }

  async getRun(_repo: string, runId: number) {
    this.maybeFail("getRun");
    return this.runs.find((r) => r.id === runId) ?? null;
  }

  reruns: number[] = [];
  async rerunFailed(_repo: string, runId: number) {
    this.maybeFail("rerunFailed");
    this.reruns.push(runId);
  }

  async jobsProgress(_repo: string, runId: number) {
    return this.jobs.get(runId) ?? { done: 0, total: 0 };
  }

  async artifactText(_repo: string, runId: number) {
    this.maybeFail("artifactText");
    return this.artifacts.get(runId) ?? null;
  }

  async findPr(_repo: string, branch: string) {
    this.maybeFail("findPr");
    const list = this.prs.filter((p) => p.branch === branch);
    return list.length ? list[list.length - 1] : null;
  }

  async createPr(_repo: string, args: { title: string; head: string; base: string; body: string }) {
    this.maybeFail("createPr");
    if (this.prs.some((p) => p.branch === args.head && p.state === "open")) throw new ApiError("create pull request: 422 A pull request already exists", 422);
    const pr = { number: this.nextPr++, state: "open", merged: false, url: "u", branch: args.head, title: args.title, body: args.body };
    this.prs.push(pr);
    return pr;
  }

  async dispatch(_repo: string, workflow: string, ref: string, inputs: Record<string, string>) {
    this.maybeFail("dispatch");
    this.dispatched.push({ workflow, ref, inputs });
  }
}
