// github.ts
//
// GitHubApi (api.ts) against GitHub. Reads go through ONE GraphQL query wherever possible (the whole project
// state is a single subrequest, which matters on Workers' per-request subrequest limit and on latency);
// writes use the Git Data REST API so a whole batch of file changes becomes a single commit.

import {
  ApiError,
  type BranchInfo,
  type GitHubApi,
  type PrRef,
  type RunRef,
  type Snapshot,
  type TreeEntry,
} from "./api.ts";
import { BRANCH_RE, SUBJECT_RE } from "./plan.ts";
import { extractFileFromZip } from "./zip.ts";

const API = "https://api.github.com";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function split(repo: string): [string, string] {
  const [owner, name] = repo.split("/");
  return [owner, name];
}

function mapRun(r: any): RunRef {
  return {
    id: r.id,
    status: r.status ?? "",
    conclusion: r.conclusion ?? null,
    displayTitle: r.display_title ?? r.name ?? "",
    headBranch: r.head_branch ?? "",
    createdAt: r.run_started_at ?? r.created_at ?? "",
    url: r.html_url ?? "",
  };
}

function mapPr(p: any): PrRef {
  return { number: p.number, state: p.state, merged: !!p.merged_at, url: p.html_url ?? "" };
}

const SNAPSHOT_QUERY = `
query($owner:String!,$name:String!,$ref:String!,$cells:String!,$cfg:String!,$withHist:Boolean!){
  repository(owner:$owner,name:$name){
    ref(qualifiedName:$ref){
      target{ ... on Commit{
        oid
        tree{ oid }
        history(first:100) @include(if:$withHist){ pageInfo{ hasNextPage endCursor } nodes{ messageHeadline } }
      } }
    }
    pullRequests(states: MERGED, first: 100, orderBy: {field: UPDATED_AT, direction: DESC}){ nodes{ title headRefName } pageInfo{ hasNextPage endCursor } }
    cells: object(expression:$cells){ ... on Tree{ entries{ name object{ ... on Blob{ text isTruncated } } } } }
    cfg: object(expression:$cfg){ ... on Blob{ text } }
    branches: refs(refPrefix:"refs/heads/cell/", first:100){
      pageInfo{ hasNextPage endCursor }
      nodes{ name target{ ... on Commit{ oid message committedDate tree{ oid } } } }
    }
  }
}`;

const HISTORY_PAGE_QUERY = `
query($owner:String!,$name:String!,$ref:String!,$after:String!){
  repository(owner:$owner,name:$name){
    ref(qualifiedName:$ref){ target{ ... on Commit{
      history(first:100, after:$after){ pageInfo{ hasNextPage endCursor } nodes{ messageHeadline } }
    } } }
  }
}`;

const PR_PAGE_QUERY = `
query($owner:String!,$name:String!,$after:String!){
  repository(owner:$owner,name:$name){
    pullRequests(states: MERGED, first: 100, after:$after, orderBy: {field: UPDATED_AT, direction: DESC}){
      nodes{ title headRefName } pageInfo{ hasNextPage endCursor }
    }
  }
}`;

/** Cell ids of merged pull requests: the head branch is cell/C-NNN or the title starts with cell(C-NNN). */
function addMergedIds(nodes: any[], into: Set<string>) {
  for (const n of nodes || []) {
    const m = BRANCH_RE.exec(n?.headRefName ?? "") || SUBJECT_RE.exec(n?.title ?? "");
    if (m) into.add(m[1]);
  }
}

const BRANCH_PAGE_QUERY = `
query($owner:String!,$name:String!,$after:String!){
  repository(owner:$owner,name:$name){
    branches: refs(refPrefix:"refs/heads/cell/", first:100, after:$after){
      pageInfo{ hasNextPage endCursor }
      nodes{ name target{ ... on Commit{ oid message committedDate tree{ oid } } } }
    }
  }
}`;

export function createGitHubApi(token: string, fetchImpl: FetchLike = fetch as FetchLike): GitHubApi {
  const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "blueprint-mcp (Cloudflare Worker)",
    ...extra,
  });

  async function rest(method: string, path: string, body?: unknown): Promise<{ status: number; json: any; text: string }> {
    const resp = await fetchImpl(`${API}${path}`, {
      method,
      headers: headers(body === undefined ? {} : { "Content-Type": "application/json" }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await resp.text();
    if ((resp.status === 403 || resp.status === 429) && resp.headers.get("x-ratelimit-remaining") === "0") {
      const reset = resp.headers.get("x-ratelimit-reset");
      throw new ApiError(`GitHub rate limit reached${reset ? ` (resets at ${new Date(Number(reset) * 1000).toISOString()})` : ""}`, resp.status);
    }
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    return { status: resp.status, json, text };
  }

  function fail(what: string, r: { status: number; json: any; text: string }): never {
    const msg = r.json?.message ?? r.text.slice(0, 200);
    throw new ApiError(`${what}: ${r.status} ${msg}`, r.status);
  }

  async function gql(query: string, variables: Record<string, unknown>): Promise<any> {
    const resp = await fetchImpl(`${API}/graphql`, {
      method: "POST",
      headers: headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ query, variables }),
    });
    const text = await resp.text();
    if (!resp.ok) throw new ApiError(`GitHub GraphQL: ${resp.status} ${text.slice(0, 200)}`, resp.status);
    const data = JSON.parse(text);
    if (data.errors?.length) throw new ApiError(`GitHub GraphQL: ${data.errors[0].message}`, 200);
    return data.data;
  }

  const branchMap = (nodes: any[], into: Record<string, BranchInfo>) => {
    for (const n of nodes || []) {
      const t = n.target;
      if (t?.oid) {
        into[`cell/${n.name}`] = { oid: t.oid, treeOid: t.tree.oid, committedDate: t.committedDate, message: t.message ?? "" };
      }
    }
  };

  return {
    async snapshot(repo, mainBranch, historyPages) {
      const [owner, name] = split(repo);
      const ref = `refs/heads/${mainBranch}`;
      const d = await gql(SNAPSHOT_QUERY, {
        owner,
        name,
        ref,
        cells: `${mainBranch}:cells`,
        cfg: `${mainBranch}:blueprint.yaml`,
        withHist: historyPages > 0,
      });
      const r = d.repository;
      if (!r) throw new ApiError(`repository ${repo} not found or the token cannot see it`);
      const target = r.ref?.target;
      if (!target?.oid) throw new ApiError(`branch ${mainBranch} not found in ${repo}`);

      const cellFiles: Record<string, string> = {};
      for (const e of r.cells?.entries ?? []) {
        const o = e.object;
        if (!o || typeof o.text !== "string") continue;
        if (o.isTruncated) throw new ApiError(`cells/${e.name} is too large to read`);
        cellFiles[e.name] = o.text;
      }

      const branches: Record<string, BranchInfo> = {};
      branchMap(r.branches?.nodes, branches);
      let bp = r.branches?.pageInfo;
      for (let page = 0; bp?.hasNextPage && page < 5; page++) {
        const more = await gql(BRANCH_PAGE_QUERY, { owner, name, after: bp.endCursor });
        branchMap(more.repository.branches.nodes, branches);
        bp = more.repository.branches.pageInfo;
      }

      const subjects: string[] = [];
      let historyComplete = true;
      if (historyPages > 0) {
        let h = target.history;
        for (const n of h?.nodes ?? []) subjects.push(n.messageHeadline);
        for (let page = 1; h?.pageInfo?.hasNextPage && page < historyPages; page++) {
          const more = await gql(HISTORY_PAGE_QUERY, { owner, name, ref, after: h.pageInfo.endCursor });
          h = more.repository.ref.target.history;
          for (const n of h?.nodes ?? []) subjects.push(n.messageHeadline);
        }
        historyComplete = !h?.pageInfo?.hasNextPage;
      }

      let mergedIds: string[] | undefined;
      if (r.pullRequests && Array.isArray(r.pullRequests.nodes)) {
        const ids = new Set<string>();
        addMergedIds(r.pullRequests.nodes, ids);
        let pp = r.pullRequests.pageInfo;
        for (let page = 0; pp?.hasNextPage && page < historyPages; page++) {
          const more = await gql(PR_PAGE_QUERY, { owner, name, after: pp.endCursor });
          const prs = more.repository?.pullRequests;
          if (!prs) break;
          addMergedIds(prs.nodes, ids);
          pp = prs.pageInfo;
        }
        mergedIds = [...ids];
      }

      return {
        mainOid: target.oid,
        mainTreeOid: target.tree.oid,
        cellFiles,
        blueprint: typeof r.cfg?.text === "string" ? r.cfg.text : null,
        branches,
        subjects,
        historyComplete,
        mergedIds,
      } satisfies Snapshot;
    },

    async readFiles(repo, ref, paths) {
      const [owner, name] = split(repo);
      const vars: Record<string, string> = { owner, name };
      const defs = ["$owner:String!", "$name:String!"];
      const fields: string[] = [];
      paths.forEach((p, i) => {
        vars[`e${i}`] = `${ref}:${p}`;
        defs.push(`$e${i}:String!`);
        fields.push(`f${i}: object(expression:$e${i}){ ... on Blob{ text isBinary isTruncated } }`);
      });
      if (!paths.length) return {};
      const d = await gql(`query(${defs.join(",")}){ repository(owner:$owner,name:$name){ ${fields.join("\n")} } }`, vars);
      const out: Record<string, string | null> = {};
      paths.forEach((p, i) => {
        const o = d.repository?.[`f${i}`];
        if (o?.isTruncated) throw new ApiError(`${p} is too large to read through the API`);
        out[p] = o && !o.isBinary && typeof o.text === "string" ? o.text : null;
      });
      return out;
    },

    async listDir(repo, ref, path) {
      const [owner, name] = split(repo);
      const d = await gql(
        `query($owner:String!,$name:String!,$e:String!){ repository(owner:$owner,name:$name){ o: object(expression:$e){ ... on Tree{ entries{ name type } } } } }`,
        { owner, name, e: `${ref}:${path.replace(/\/+$/, "")}` },
      );
      const entries = d.repository?.o?.entries;
      if (!Array.isArray(entries)) return null;
      return entries.map((e: any) => (e.type === "tree" ? `${e.name}/` : e.name));
    },

    async commitFiles(repo, parentOid, baseTreeOid, entries: TreeEntry[], message) {
      const tree = entries.map((e) =>
        e.content === null
          ? { path: e.path, mode: "100644", type: "blob", sha: null }
          : { path: e.path, mode: "100644", type: "blob", content: e.content },
      );
      const t = await rest("POST", `/repos/${repo}/git/trees`, { base_tree: baseTreeOid, tree });
      if (t.status !== 201) fail("create tree", t);
      const c = await rest("POST", `/repos/${repo}/git/commits`, { message, tree: t.json.sha, parents: [parentOid] });
      if (c.status !== 201) fail("create commit", c);
      return c.json.sha as string;
    },

    async commitEmpty(repo, parentOid, treeOid, message) {
      const c = await rest("POST", `/repos/${repo}/git/commits`, { message, tree: treeOid, parents: [parentOid] });
      if (c.status !== 201) fail("create commit", c);
      return c.json.sha as string;
    },

    async createBranch(repo, branch, oid) {
      const r = await rest("POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: oid });
      if (r.status === 201) return "created";
      if (r.status === 422 && /already exists/i.test(r.json?.message ?? r.text)) return "exists";
      return fail("create branch", r);
    },

    async fastForward(repo, branch, oid) {
      const r = await rest("PATCH", `/repos/${repo}/git/refs/heads/${branch}`, { sha: oid, force: false });
      if (r.status === 200) return "ok";
      if (r.status === 404) return "missing";
      if (r.status === 422 && /fast.?forward/i.test(r.json?.message ?? r.text)) return "not_ff";
      return fail("update branch", r);
    },

    async putFile(repo, path, content, message) {
      const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(content)));
      const r = await rest("PUT", `/repos/${repo}/contents/${path}`, { message, content: b64 });
      if (r.status !== 201 && r.status !== 200) fail("create first commit", r);
    },

    async branchTip(repo, branch) {
      const r = await rest("GET", `/repos/${repo}/branches/${branch}`);
      if (r.status === 404) return null;
      if (r.status !== 200) fail("read branch", r);
      const c = r.json.commit;
      return { oid: c.sha, treeOid: c.commit.tree.sha, committedDate: c.commit.committer.date };
    },

    async branchCommits(repo, branch, page, perPage) {
      const n = Math.min(100, Math.max(1, Math.trunc(perPage) || 1));
      const p = Math.max(1, Math.trunc(page) || 1);
      const r = await rest("GET", `/repos/${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=${n}&page=${p}`);
      if (r.status === 404 || r.status === 422) return null;
      if (r.status !== 200) fail("list commits", r);
      return (r.json ?? []).map((c: any) => ({ oid: c.sha as string, treeOid: c.commit.tree.sha as string, message: c.commit.message as string }));
    },

    async changedFiles(repo, base, head) {
      const r = await rest("GET", `/repos/${repo}/compare/${base}...${head}?per_page=100`);
      if (r.status !== 200) fail("compare", r);
      return (r.json.files ?? []).map((f: any) => f.filename as string);
    },

    async activeRuns(repo) {
      const [a, b] = await Promise.all([
        rest("GET", `/repos/${repo}/actions/runs?status=in_progress&per_page=100`),
        rest("GET", `/repos/${repo}/actions/runs?status=queued&per_page=100`),
      ]);
      if (a.status !== 200) fail("list runs", a);
      if (b.status !== 200) fail("list runs", b);
      const seen = new Set<number>();
      const out: RunRef[] = [];
      for (const r of [...(a.json.workflow_runs ?? []), ...(b.json.workflow_runs ?? [])]) {
        if (!seen.has(r.id)) {
          seen.add(r.id);
          out.push(mapRun(r));
        }
      }
      return out;
    },

    async workflowRuns(repo, workflowFile, perPage) {
      const r = await rest("GET", `/repos/${repo}/actions/workflows/${workflowFile}/runs?per_page=${perPage}`);
      if (r.status === 404) return [];
      if (r.status !== 200) fail("list workflow runs", r);
      return (r.json.workflow_runs ?? []).map(mapRun);
    },

    async getRun(repo, runId) {
      const r = await rest("GET", `/repos/${repo}/actions/runs/${runId}`);
      if (r.status === 404) return null;
      if (r.status !== 200) fail("get run", r);
      return mapRun(r.json);
    },

    async rerunFailed(repo, runId) {
      const r = await rest("POST", `/repos/${repo}/actions/runs/${runId}/rerun-failed-jobs`);
      if (r.status !== 201 && r.status !== 200) fail("re-run failed jobs", r);
    },

    async jobsProgress(repo, runId) {
      const r = await rest("GET", `/repos/${repo}/actions/runs/${runId}/jobs?per_page=100&filter=latest`);
      if (r.status !== 200) return { done: 0, total: 0 };
      const jobs: any[] = r.json.jobs ?? [];
      return { done: jobs.filter((j) => j.status === "completed").length, total: jobs.length };
    },

    async artifactText(repo, runId, artifact, file) {
      const list = await rest("GET", `/repos/${repo}/actions/runs/${runId}/artifacts?per_page=100`);
      if (list.status !== 200) fail("list artifacts", list);
      const match = (list.json.artifacts ?? []).find((a: any) => a.name === artifact && !a.expired);
      if (!match) return null;
      const dl = await fetchImpl(match.archive_download_url, { headers: headers() });
      if (!dl.ok) throw new ApiError(`download artifact: ${dl.status}`, dl.status);
      return extractFileFromZip(new Uint8Array(await dl.arrayBuffer()), file);
    },

    async findPr(repo, branch) {
      const [owner] = split(repo);
      const r = await rest(
        "GET",
        `/repos/${repo}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=all&sort=created&direction=desc&per_page=1`,
      );
      if (r.status !== 200) fail("find pull request", r);
      return Array.isArray(r.json) && r.json.length ? mapPr(r.json[0]) : null;
    },

    async createPr(repo, args) {
      const r = await rest("POST", `/repos/${repo}/pulls`, args);
      if (r.status !== 201) fail("create pull request", r);
      return mapPr(r.json);
    },

    async dispatch(repo, workflowFile, ref, inputs) {
      const r = await rest("POST", `/repos/${repo}/actions/workflows/${workflowFile}/dispatches`, { ref, inputs });
      if (r.status !== 204) fail("dispatch workflow", r);
    },
  };
}
