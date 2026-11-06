# End to end runbook

Test the whole Blueprint system (Worker, panel, cell chats, Steward, Windows launcher) on a fresh GitHub test repo. Do this on a throwaway repo, never on a real project.

Each step ends with an **Expected** checklist. Tick every box before going on. If one fails, stop and note the step number.

## 0. What this runbook could not verify

This runbook was written by a cell chat that has no real GitHub, no real browsers and no Windows machine. These parts are written from `docs/panel-contracts.md` and `docs/deploy.md` and are **unverified**:

- The exact names and arguments of `cell_help`, `cell_note`, `cell_sync`, `cell_clear` and `cell_fix` (they exist since C-061). Read each tool's description in the chat before using it; where this runbook says what to pass, treat it as a hint.
- How the Worker learns which repo to use. `docs/deploy.md` does not say. Every call passes `owner/name`, and `GITHUB_TOKEN` must be able to reach the test repo; if your Worker has a default repository setting, point it at the test repo.
- The name of the steward field in `GET /panel/api/state`. The contract file does not list it. The smoke script reads `state.steward` (override with `STEWARD_FIELD`).
- What Release does to a reservation. The smoke script expects that after Release the cell has no `reservedBy`.
- Everything on Windows: the launcher, icons, browser profiles, `startmany`.
- The sample plan has five cells, not six: the spec gap sits in E-003 (a parallel cell) and the path gap in E-004 (also parallel), so E-005 is the integration cell.

## 1. Prerequisites

- Node 18 or newer, `npm`, `git`, and a Cloudflare account (`npx wrangler login` done).
- A GitHub account that can create a repo, and a `GITHUB_TOKEN` with access to the test repo.
- Claude chats you can open (claude.ai) with the Blueprint connector (the `kit` tools) enabled. For step 8 you need three browsers or browser profiles.
- Windows 10 or 11 for step 12 only.
- These secrets, kept in a password manager and never pasted into a chat: `GITHUB_TOKEN`, `ADMIN_TOKEN`, `MCP_AUTH_TOKEN`, `PANEL_TOKEN` (see `docs/deploy.md`).

## 2. Create the test repo

1. On GitHub create an empty repo, for example `<you>/panel-e2e`. Private is fine. Tick "Add a README" so `main` exists.
2. Make sure `GITHUB_TOKEN` can read and write this repo (contents and pull requests).

**Expected**

- [ ] The repo exists and `main` has one commit.
- [ ] `GITHUB_TOKEN` can write to it.

## 3. Deploy the Worker

1. In a clone of this repo (the Worker source) log in: `npx wrangler login`.
2. Set the four secrets once: `npx wrangler secret put GITHUB_TOKEN`, then `ADMIN_TOKEN`, `MCP_AUTH_TOKEN`, `PANEL_TOKEN`.
3. Point the Worker at the test repo (see section 0, the repo setting is unverified).
4. Deploy with `bash scripts/release.sh` (or `.\scripts\release.ps1` on Windows PowerShell). See `docs/deploy.md`.
5. Note the printed panel path `<worker-url>/panel/`.

**Expected**

- [ ] The script ran `npm ci`, `npm test`, the web build, the secret check and `wrangler deploy` without a FAIL.
- [ ] It printed `<worker-url>/panel/`.
- [ ] Opening that URL shows the panel login page.

## 4. init_blueprint from a chat

1. Open a new chat with the Blueprint connector.
2. Ask it to call `init_blueprint` for `<you>/panel-e2e` (it installs Blueprint into a repo that has none).
3. Give it nothing else to do.

**Expected**

- [ ] The chat reports success.
- [ ] On GitHub `main` now has `BLUEPRINT.md` and the Blueprint workflows.
- [ ] No cell exists yet.

## 5. Publish the sample plan

The five sample cells are in `docs/e2e/`. Their ids `E-001` to `E-005` are placeholders. Rename them to the id scheme of the test repo (for example `C-001` to `C-005`) **in the file name, in `id:`, and in every `after:` list**:

| Sample | Example |
| --- | --- |
| E-001 skeleton, adds hello.txt | C-001 |
| E-002 parallel A | C-002 |
| E-003 parallel B, missing contract | C-003 |
| E-004 parallel C, needs a file outside allowed_paths | C-004 |
| E-005 integration, after all | C-005 |

Bash example (run in a copy of `docs/e2e/`):

```bash
for n in 1 2 3 4 5; do
  sed -i "s/E-00$n/C-00$n/g" E-00$n.yaml
done
sed -i 's/E-00\([1-5]\)/C-00\1/g' C-00*.yaml 2>/dev/null || true
for n in 1 2 3 4 5; do mv E-00$n.yaml cells/C-00$n.yaml 2>/dev/null || true; done
```

Simpler: rename by hand with a text editor search and replace of `E-00` with `C-00`, then save the files as `cells/C-001.yaml` and so on.

Then, in a chat, ask it to call `publish_plan` with the five cells (it needs the `ADMIN_TOKEN` as `admin_key`; type it yourself when asked, never put it in a prompt you save).

**Expected**

- [ ] `publish_plan` says the cells were added.
- [ ] `cells/C-001.yaml` to `cells/C-005.yaml` exist on `main`.
- [ ] The sample plan has no cycle: C-001 first, C-002 to C-004 after it, C-005 last.

## 6. Open the panel

1. Open `<worker-url>/panel/`, log in with `PANEL_TOKEN`, choose the test repo.

**Expected**

- [ ] The graph shows five cards left to right: C-001, then C-002 to C-004, then C-005.
- [ ] C-001 is ready (yellow). The other four are waiting (grey).
- [ ] The bottleneck banner is not shown, or points at C-001 (it blocks four cells).
- [ ] The counts in the sidebar are ready 1, waiting 4.
- [ ] Every status has an icon and a text label, not only a color.
