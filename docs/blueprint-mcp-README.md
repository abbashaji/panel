# blueprint-mcp

Cloudflare Worker (MCP connector) built for **blueprint-kit**. Same stack as ondine/remote_mcp (OAuth + KV + `/mcp`), but 11 small tools (init_blueprint also upgrades with upgrade:true) instead of 70, and all cell logic server-side so a browser chat spends almost no tokens on it.

| Tool | Who | Purpose |
|---|---|---|
| `next_cell` (`wait_seconds` 0-60) | agent | claim or resume the next ready cell; long-poll, `retry_after` when idle |
| `ready_cells` | human | read-only overview |
| `read_files` | agent | capped reads from the cell branch |
| `apply_changes` | agent | one commit: `content`, `old/new`, `append`, `delete`; safe retry (`already applied`) |
| `cell_signal` | agent | `heartbeat`, `release` (hand over with `next:`), `feedback` (-> `needs_human`) |
| `submit_cell` / `preflight` / `ci_result` | agent | PR, dry-run CI, verdict |
| `init_blueprint` | agent/human | install or upgrade the kit |
| `publish_plan` | **admin_key** | add cells |
| `takeover` (`handoff`, `clear_feedback`) | **admin_key** | force a cell away from a chat |

## Deploy
1. `npm install`
2. `npx wrangler kv namespace create OAUTH_KV`, paste the id into `wrangler.toml`; set `ALLOWED_REPOS = "you/*"` there (every repo of that owner; `DEFAULT_REPO` is optional). The chat passes `repo` on its calls. Limit real reach by giving the PAT access only to the repos you want.
3. Create a **personal access token** (classic: scopes `repo` + `workflow`; or fine-grained: Contents, Pull requests, Actions, Workflows = read/write). It must be a PAT, not `GITHUB_TOKEN`, so the pushes trigger the gate workflow.
4. `npx wrangler secret put GITHUB_TOKEN`, `npx wrangler secret put MCP_AUTH_TOKEN` (any long random password: you type it on the consent page) and `npx wrangler secret put ADMIN_TOKEN` (your own key for `publish_plan` and `takeover`; keep it OUT of the password you share with teammates. Without it those two tools are off).
5. Optional, for the browser extension (usage-limit release): `npx wrangler secret put EXT_TOKEN` with a long random value (see "Extension endpoints" below). Without it every `/ext/*` is a 404.
6. `npx wrangler deploy`
7. Claude → Settings → Connectors → add custom connector: `https://blueprint-mcp.<you>.workers.dev/mcp`, enter the password when asked.
8. In the repo: copy blueprint-kit in, enable Actions, "Allow auto-merge" is NOT needed (the gate squash-merges itself).

## Extension endpoints (`/ext/*`, not MCP tools)
Used by the Chrome extension `blueprint-limit-ext`; contracts C1 to C5 are in [`../blueprint-kit/docs/contracts.md`](../blueprint-kit/docs/contracts.md) (single source of truth; not embedded in `src/kit.ts`). Off unless the secret `EXT_TOKEN` is set (then every `/ext/*` is a plain 404). Auth: `Authorization: Bearer <EXT_TOKEN>`, timing-safe compare. No CORS headers, body at most 2 KB.
- `GET /ext/ping` -> `{ok, version}`.
- `POST /ext/release` `{repo, cell_id, base, label?}` -> `{status, detail}`: writes one empty `release(C-NNN): usage limit` commit (fast-forward only) when the chat still owns the cell and no PR is open. Statuses: `released`, `already_released`, `needs_human`, `not_owner`, `unverifiable`, `no_branch`, `submitted`, `moved`, `error`; HTTP 400 `refused` (bad input or repo outside `ALLOWED_REPOS`), 401 bad token.
- `POST /ext/warn` `{repo, cell_id, resets_at?}` -> `warned`, `not_running`, `already_released`, `error`. Stores an advisory KV flag (`warn:<repo>:<cell_id>`, never a git commit); while it exists, replies of `apply_changes`, `cell_signal`, `read_files` (with `cell_id`), `submit_cell`, `ci_result` and `preflight` end with `LIMIT_WARNING`. The flag is deleted on `next_cell` CLAIMED/RESUME of that cell, on `cell_signal release` and on admin `takeover`.

Security: `EXT_TOKEN` is a narrow token. It can only release cells or set warning flags in `ALLOWED_REPOS`; it cannot read files, claim cells or write anything else. Keep it separate from `MCP_AUTH_TOKEN` and `ADMIN_TOKEN`.
Rotation: run `npx wrangler secret put EXT_TOKEN` again with a new value (the old one stops working at once), then paste the new token into the extension popup and press Test connection. Also rotate the old `ADMIN_TOKEN` and `MCP_AUTH_TOKEN` if you have not yet.
Plan: the paid Workers plan is recommended (long-poll in `next_cell`, and `/ext/release` may page through up to 1000 commits).
NOT verified live: `/ext/*` has never run against real GitHub, `branchCommits` in `github.ts` was only tested with scripted fetch, and whether `OAuthProvider` hands `/ext/*` to the default handler is untested outside the unit tests (check with `npx wrangler dev`).

## Verify
`npm test` (219 tests at version 3: Python↔TS parity of the plan engine, the whole protocol against an in-memory GitHub with real atomicity rules, request shapes of the GitHub client) and `npx tsc --noEmit`.

## Not verified (needs your first real run)
- `src/github.ts` has never talked to real GitHub (only scripted fetch). First run: call `ready_cells` in a chat, then claim a trivial cell.
- Worker free plan allows ~10 ms CPU per request; plan parsing is cached per main commit, but if you see error 1102, use the paid Workers plan ($5).
- If your MCP client times out before `ci_result` returns, pass a smaller `wait_seconds`.
- NOT verified live yet: the merged-PR GraphQL query (field names, order); the 60 s `next_cell` wait against the real MCP client timeout (`MAX_POLLS` is the knob); release/adopt, attempt counting and `needs_split` with real chats; `append` and safe retry against real GitHub.
- Long-poll holds a Worker request open for up to a minute: the paid Workers plan is recommended (the free plan allows ~50 subrequests per call, so polling is capped).
- Rewritten files are committed as mode 100644 (executable bit is lost).

## One-time setup, then zero per repo
Deploy once with a **classic PAT (scopes `repo` + `workflow`)** or a fine-grained PAT on *All repositories* (Contents, Pull requests, Actions, Workflows: read/write). `ALLOWED_REPOS = "abbashaji/*"` covers every current and future repo of that owner.

For a new repo nothing is configured anywhere: tell the chat the repo name; `next_cell` answers `NOT_INITIALIZED`, the chat calls `init_blueprint` (one commit to main installing workflows, tools, `blueprint.yaml` with the project name taken from the repo, `cells/_TEMPLATE.yaml`), then someone adds cells. It never overwrites an existing Blueprint.

Needs to be true in a repo (GitHub defaults, nothing to change unless you changed them): Actions enabled, squash-merge allowed, no branch protection that blocks the PAT from pushing to main for the install commit.
Regenerate the embedded kit after changing blueprint-kit: `python3 scripts/embed_kit.py ../blueprint-kit` (a test fails if they differ).

## Owner-only tools
`publish_plan` (add cells) and `takeover` (force a cell away from a running chat) need `admin_key` = your `ADMIN_TOKEN`. Agents never get it. Expired cells return to the pool by themselves through `next_cell`.

**Admin key:** type `admin_key` only in a separate owner chat, never in an agent chat: it lands in that transcript.

## What happens when a chat dies
Every commit holds a `next:` line, so no work is lost. The lease runs out (15 min for critical cells, 60 min otherwise; a running CI workflow keeps it alive) and the next `next_cell` takes the cell over (`takeover(`, attempt + 1) and answers `RESUME` with the branch state and attempt number. A chat that releases (`cell_signal release`) is adopted at once, without counting an attempt; `next_cell` serves released and expired critical cells first, then fresh cells, then expired non-critical cells (promoted after `park_max_minutes`). After 3 takeovers the cell is `needs_split`; after `cell_signal feedback` it is `needs_human` until the owner uses `takeover` with `clear_feedback`. The old chat's next write gets `CONFLICT` (fencing by `base`).

## What the Game Day (8 chats, real GitHub) proved
Race for cells, FAIL then one-shot fix, contract + integration cells, dead / PARTIAL chats resumed from their last commit, fencing (a stale writer gets CONFLICT), repo bootstrap, 30 parallel cells. Fixed because of it: merge retry in the gate, repo echo in CLAIMED, CELL_DONE, owner-only tools, unknown-key validation, stale-read detection.
