# Blueprint Panel contracts

The confirmed contracts for the Blueprint Panel. Every later cell codes against this file; it is self-contained. If a contract looks wrong, report it with `cell_signal feedback` instead of working around it.

## 1. What we are building

A web panel plus a small Windows launcher, replacing `blueprint-limit-ext`.

- **Panel** (web, served by the existing Worker): shows every cell as a left-to-right dependency graph, color-coded by status; finds the bottleneck; lets a teammate start a cell; lets the owner Release / Hand over a stuck cell.
- **Launcher** (Windows, local, offline): opens the chosen browser profile on `claude.ai/new?q=<prompt>`; the teammate presses Send.
- **No extension.** Lost on purpose: automatic release at the usage limit (use Release in the panel) and automatic chat-link capture (optional paste box).

### 1.1 Decisions already made (do not reopen)

1. Web panel on the Worker, same origin (the Worker sends no CORS headers on purpose).
2. Local-first launcher on Windows only; no Worker fallback for launching.
3. Browser data never reaches a web page or service. The profile picker lives in the launcher's own window.
4. The panel sends only `repo + cell id` (plus the display name `who`) to the launcher. The launcher builds the prompt itself from a fixed template.
5. The prompt is pre-filled, never auto-sent. The launcher always shows a confirm window.
6. A teammate can only reopen their own cells. Others' cells show a name, no link.
7. Local records are deleted when the cell is merged (green), or after 14 days.
8. Stack: React 18 + TypeScript + Vite, Tailwind, Radix UI, `@xyflow/react` + dagre (rankdir LR), TanStack Query, Vitest. Launcher: C# .NET 8 WinForms, self-contained single exe.

### 1.2 Architecture

```
Browser (panel SPA)  --same origin-->  Worker (blueprint-mcp)  -->  GitHub
        | blueprint://start?repo=&cell=&who=
        v
Windows launcher (offline)  -->  chrome.exe --profile-directory=... https://claude.ai/new?q=...
```

Repo layout: `src/panel/*` (Worker routes), `web/*` (SPA, built to `web/dist`, served with Workers Static Assets), `launcher/*` (C# solution), `docs/panel-contracts.md` (this file).

## 2. Facts about the existing engine

- Status is computed from git, not stored: `done` = commit `cell(C-NNN): ...` on main; `running` = branch `cell/C-NNN` with a live lease.
- `computeState()` in `src/plan.ts` returns `{status, ready[], locked[], waiting[], needs_split?, needs_human?}`. `ready` entries have `{id, reclaim, critical, released}`; `locked` has `{id, minutes_left, ci?}`; `waiting` has `{id, blocked_by[]}`.
- Panel status mapping: done, running (locked), ready (not reclaim), expired lease (ready with `reclaim=true`), waiting, needs_human, needs_split.
- Critical = direct dependents >= `bottleneck_threshold` (4), or chain >= 3, or transitive >= 5. Bottleneck rank for the UI = number of transitive dependents of a not-done cell.
- `next_cell` today takes only `{repo, wait_seconds}` and hands out the first ready cell. It cannot claim a chosen cell (C-001 changes that).
- `takeover` (admin_key) supports `handoff: true` and `clear_feedback`. `cell_signal` has heartbeat / release / feedback. The `/ext/*` endpoints and the extension are not used.
- `Snapshot` has `cellFiles`, `branches{oid, committedDate, message}`, `subjects`, `mergedIds`. It has no sha for main commits.
- Lock sha = newest commit with subject `claim(<id>):`, `takeover(<id>):` or `adopt(<id>):` (see `branchCommits`).

## 3. Worker contracts

All types are in `src/panel/types.ts` and must match the JSON below exactly.

### 3.1 Auth

- `POST /panel/api/login` `{password}` compares timing-safe to secret `PANEL_TOKEN`; sets cookie `bp_panel` (HttpOnly, Secure, SameSite=Strict, 12 h). Rate-limit failures.
- All `/panel/api/*` need the cookie, else `401`. No CORS headers. Body <= 4 KB.
- Admin actions (release, hand over, clear feedback) additionally need `admin_key` in the request body, typed by the user per action, compared to `ADMIN_TOKEN`; never stored in the page or cookie. Wrong or missing key: `403`.

### 3.2 `GET /panel/api/state?repo=owner/name`

```json
{ "repo":"o/r","project":"name","mainSha":"abc1234","generatedAt":"ISO",
  "counts":{"done":4,"running":1,"ready":1,"waiting":7,"expired":1,"needs_human":1,"needs_split":0},
  "cells":[{"id":"C-004","title":"API core","type":"normal","priority":0,
    "status":"expired|done|running|ready|waiting|needs_human|needs_split",
    "critical":true,"wave":1,"depends":[{"id":"C-000","kind":"implementation"}],
    "blockedBy":["C-000"],"directDependents":5,"transitiveDependents":8,
    "sha":{"lock":"7d3e1b0","tip":"9b20c4e","merged":null},
    "lease":{"minutesLeft":0,"expiredMinutesAgo":22,"ci":false},
    "attempts":2,"maxAttempts":3,"lastCommit":{"subject":"...","next":"...","at":"ISO"},
    "reservedBy":null,"pr":{"number":12,"state":"open"},
    "allowedPaths":[],"provides":[],"inputs":[]}],
  "bottleneck":{"id":"C-004","blocks":8} }
```

- Reuse `computeState` and the snapshot; do not duplicate cell logic. Cache by `mainSha` plus branch tips (60 s).
- `sha.merged` may be null: the snapshot has no main commit shas, so either extend the GraphQL query in `github.ts` (VERIFY live) or show "merged" without a sha.
- `lease`, `lastCommit` and `pr` are `null` when the cell has no branch / commit / PR. `bottleneck` is `null` when nothing is blocked.

### 3.3 Pinned claim and reservation

- `next_cell` gains optional `cell_id` (and optional `who`, see Open points). Behavior: if that cell is ready (or reclaimable) and not reserved for someone else, claim/resume exactly it (same `CLAIMED`/`RESUME` reply format, so the C1 echo line still works). Otherwise reply `NOT_READY <id> <reason>` or `RESERVED <id> by <name>`. Never fall back to another cell.
- Reservation: KV key `reserve:<repo>:<cell>` = `{who, at}`, TTL 600 s. `next_cell` without `cell_id` skips reserved cells (except for `who`'s own pinned call). The key is deleted on CLAIMED/RESUME of that cell.
- `POST /panel/api/reserve` `{repo, cell_id, who}` -> `{status: "reserved"|"not_ready"|"taken", detail}`.

### 3.4 Actions

- `POST /panel/api/release` `{repo, cell_id, admin_key}` -> `takeover(... handoff:true)`. Result text passed through (<= 200 chars).
- `POST /panel/api/clear-feedback` `{repo, cell_id, admin_key}` -> takeover with `clear_feedback`.
- The confirm step in the UI states exactly the git write (one empty commit, or branch state change) before sending.

## 4. Launcher protocol

The only input is a URL; treat it as hostile.

- `blueprint://start?repo=<owner/name>&cell=<C-NNN>&who=<name>`: confirm window, then launch.
- `blueprint://open?repo=&cell=`: "my cell" window (open claude.ai in the saved profile; optional chat link box).
- `blueprint://sync?repo=<owner/name>&merged=C-001,C-002`: silent; deletes local records of merged cells.

### 4.1 Validation (reject otherwise)

| Field | Rule |
|---|---|
| URL length | max 400 |
| repo | `^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$` |
| cell | `^C-\d{3,5}$` |
| who | `^[\w .-]{1,40}$` |
| merged | comma list of valid cells |

Also reject: unknown command, duplicate or extra keys, control characters.

### 4.2 Prompt template (built in the launcher, never taken from the URL)

```
Repo: {repo}
Follow BLUEPRINT.md.
Call next_cell with repo and cell_id={cell} (reserved for me).
Do only that cell. Begin your next message with the CLAIMED line.
```

Strip `<` and `>`; URL-encode; final URL `https://claude.ai/new?q=<encoded>`; the host is fixed, never from input.

### 4.3 Browsers and profiles

- Chrome and Edge. Profiles from `%LOCALAPPDATA%\Google\Chrome\User Data\Local State` and `...\Microsoft\Edge\User Data\Local State`, key `profile.info_cache` -> `{folder: {name}}`. Read only folder and name (never email, cookies, history).
- Launch: `chrome.exe --profile-directory="<folder>" "<url>"` as an argument list (never a shell string); exe path from the registry App Paths or standard install dirs.

### 4.4 Local record file

`%LOCALAPPDATA%\BlueprintLauncher\cells.json`:

```json
{ "<repo> <cell>": { "browser": "chrome", "profileFolder": "Profile 1", "profileName": "Work", "startedAt": "ISO", "chatUrl": "optional" } }
```

Chat link accepted only if it matches `^https://claude\.ai/chat/[0-9a-f-]{36}$`. Deleted on sync (merged) and after 14 days.

### 4.5 Registration and network

`HKCU\Software\Classes\blueprint` (no admin rights). The installer script is readable text. The launcher opens **no network connection** (test: no `System.Net` usage; firewall-block test).

## 5. UI spec

- Layout 1440 wide: header 56, sidebar 196, graph area, inspector 320, activity strip at bottom. Dark and light themes via CSS variables.
- Status colors: done `#3DD6A3`, running `#5B9DFF`, ready `#FFC857`, waiting `#9AA3B8`, expired `#FF6B5E`, needs_human `#C792FF`, needs_split `#FF8FB1`. Every status also has an icon and a text label (never color alone). Text contrast >= 4.5:1.
- Card 152x72: id (mono), status chip, title, sha7, one meta line (lease left, blocked by, merged ago). Badges (START, owner, BLOCKS n) sit fully **outside** the card, above it, covering nothing.
- Edges: solid = implementation, dashed = contract; edges from the bottleneck are red. Wave labels on top. Pan, zoom, minimap.
- Bottleneck: ring on the card, "BLOCKS n" tag, top banner with one-click Release, red downstream edges.
- Interaction: click = select, double-click = primary action (Start if ready, Open chat if mine and running, else details), shift-click = multi-select, Esc clears, Ctrl+K search, arrow keys move selection, right-click menu.
- Inspector: lease bar, attempts, branch, lock/tip sha, last commit, next step, holder, files; buttons Continue in my chat / Release / Open branch on GitHub.
- Merged cells: no Open chat badge; the panel asks the launcher to `sync` merged ids on every Start/Open.
- Views: Graph (first), Table, Timeline. Live updates by polling every 5 s (SSE later). Respect reduced motion.

## 6. Secrets

`PANEL_TOKEN` (new), `ADMIN_TOKEN` (existing), `GITHUB_TOKEN`, `MCP_AUTH_TOKEN` stay separate. `[assets]` for `web/dist` is added to `wrangler.toml` by C-002.

## 7. Open points

Gaps found in the plan while writing these contracts (to be confirmed by the owner):

- (a) A pinned `next_cell` call carries no caller identity, so the reservation cannot say whose call it is. Contract here: `next_cell` gets an optional `who`; `RESERVED <id> by <name>` is returned only when both `reservation.who` and the call's `who` are present and differ. The launcher prompt template has no `who`, so in practice a pinned call without `who` claims a reserved cell; the git branch lock remains the real arbiter.
- (b) `sha.merged` is `null`: the snapshot has no main commit sha. Either extend the GraphQL query in `github.ts` (verify live) or show "merged" without a sha.
- (c) `wrangler.toml` `[assets]` (directory `./web/dist`, binding `ASSETS`, `run_worker_first = true`) is added by C-002, which also owns `src/index.ts`. `/panel/*` routing next to `OAuthProvider` is not verified live.
- (d) The Worker `Env` interface lives in `src/tools.ts`; `PanelEnv` in `src/panel/types.ts` extends it, so new secrets need no change to `tools.ts`.
- (e) `src/panel/actions.ts` is a stub created here so that `src/panel/router.ts` (C-002) can import it before C-003 exists.
