# End to end runbook

How to test the whole Blueprint system on a fresh GitHub test repo. Work top to bottom. Every step ends with an **Expected** checklist; do not go on until all boxes are true.

Sample cells live in `docs/e2e/E-001.yaml` to `E-005.yaml` (ids `E-...` so they are never part of `cells/`):

| Sample | Purpose |
| --- | --- |
| E-001 | skeleton: adds `hello.txt` |
| E-002, E-003 | two parallel cells after E-001 |
| E-004 | deliberate spec gap (no contract for the greeting format), exercises `cell_note` |
| E-005 | integration after all others; needs `hello.txt`, which is outside its `allowed_paths`, exercises `cell_help` then `cell_fix` |

You need: a GitHub account that can create repos, a Cloudflare account with `wrangler` logged in, a claude.ai account with the Blueprint connector, Node 18+, and for step 12 a Windows PC with Chrome or Edge.

## 0. Values to keep at hand

Write these down (never commit them): the Worker URL, `PANEL_TOKEN` (panel password), `ADMIN_TOKEN` (admin key), `GITHUB_TOKEN`, `MCP_AUTH_TOKEN`, the test repo `owner/name`.

## 1. Create the test repo

1. On GitHub create an empty private repo, for example `yourname/blueprint-e2e`, with a README so `main` exists.
2. Make sure `GITHUB_TOKEN` can read and write that repo (contents, pull requests, actions).

**Expected**
- [ ] The repo exists and has a `main` branch.
- [ ] The token can push to it.

## 2. Deploy the Worker pointing at the test repo

1. In the panel repo: `npx wrangler login`, then set the four secrets listed in `docs/deploy.md` with `npx wrangler secret put <NAME>`.
2. If your Worker has a default repository setting, set it to the test repo; otherwise every call passes the repo explicitly.
3. Run `bash scripts/release.sh` (Windows: `.\scripts\release.ps1`).

**Expected**
- [ ] Every release step passes (`npm ci`, tests, web build, secret check, deploy).
- [ ] The script prints `<worker-url>/panel/`.
- [ ] Opening that URL shows the panel login page.

## 3. init_blueprint from a chat

1. Open a new claude.ai chat with the Blueprint connector enabled.
2. Ask it to run `init_blueprint` on the test repo (the owner key is required).

**Expected**
- [ ] The reply confirms Blueprint files were installed (BLUEPRINT.md, workflows, tools).
- [ ] The repo on GitHub shows the new commit on `main`.

## 4. Publish the sample plan

1. Copy the five files `docs/e2e/E-001.yaml` to `docs/e2e/E-005.yaml` and rename the ids to the repo's scheme. Example: `E-001` to `C-001` ... `E-005` to `C-005`, in the file names, in `id:` and in every `after:` entry. If the plan uses a dedicated skeleton cell type, set `type:` of the first cell accordingly.
2. In an owner chat call `publish_plan` with the five renamed cells and the admin key.

**Expected**
- [ ] `publish_plan` reports 5 new cells and no errors.
- [ ] The five files appear under `cells/` on `main`.
- [ ] `ready_cells` lists only the skeleton cell as ready; the other four are waiting.

## 5. Open the panel

1. Open `<worker-url>/panel/`, log in with `PANEL_TOKEN`, choose the test repo.

**Expected**
- [ ] The graph shows 5 cards left to right: skeleton, then three parallel cells, then the integration cell.
- [ ] The skeleton card is yellow (ready) with a START badge; the others are grey (waiting).
- [ ] A wrong password is refused.
- [ ] The state refreshes by itself about every 5 seconds.

## 6. Run the smoke script

```bash
WORKER_URL=https://<worker-url> PANEL_PASSWORD=<PANEL_TOKEN> REPO=owner/name ADMIN_KEY=<ADMIN_TOKEN> node scripts/e2e-smoke.mjs
```

`ADMIN_KEY` is optional; without it the release check is skipped. The script never prints the password, the key or the cookie. Run it while the skeleton is still ready, so the reserve check has a cell to use.

**Expected**
- [ ] The final line reads `... 0 FAIL ...` and the exit code is 0.
- [ ] Login, cookie flags, state shape, counts, reserve and (with a key) release all show PASS.
- [ ] `steward status field` is PASS or SKIP; a SKIP means the field name is not yet in the contracts doc.
- [ ] After the script, the skeleton cell has no `reservedBy` in the panel (or it vanishes within 10 minutes).

## 7. Start 3 cell chats

First finish the skeleton: click START on it, send the prefilled prompt, and wait until it merges (card turns green; E-002, E-003, E-004 become ready).

Then start the three parallel cells in either way:

- Manually: START on each card, one chat each.
- With **Run ready**: select the 3 ready cards and use Run ready with 3 browsers or profiles (Windows launcher, step 12).

**Expected**
- [ ] Each chat begins its first message with its own `CLAIMED C-00n ...` line.
- [ ] The three cards turn blue (running) with a lease timer.
- [ ] Two of them, the plain parallel cells, reach CI and merge; their cards turn green.
- [ ] The spec gap cell does not finish by itself; see step 8.
- [ ] No two chats hold the same cell.

## 8. Heal a stale branch, a spec gap and a path gap

### 8a. Stale branch (`cell_sync`)

1. While a parallel cell is running, merge another cell (or push a commit) to `main` so its branch falls behind.
2. In the running chat, or after resuming it, the worker calls `cell_sync`.

**Expected**
- [ ] The chat reports the branch was synced with `main` (or that it was already current).
- [ ] No manual git work was needed; CI still passes afterwards.

### 8b. Spec gap (`cell_note`, sample E-004)

1. Let the chat for the spec gap cell run.

**Expected**
- [ ] The chat does not invent a greeting format; it records the missing contract with `cell_note`.
- [ ] The panel shows the cell as needing attention (needs_human or a note on the card).
- [ ] After you add the exact line (for example `gamma from E-004`) to the cell goal on `main`, a new chat can finish it and it merges.

### 8c. Path gap (`cell_help` then `cell_fix`, sample E-005)

1. Start the integration cell once E-002, E-003 and E-004 are merged.

**Expected**
- [ ] The chat asks for help with `cell_help` because `hello.txt` is outside `allowed_paths`; it does not write there.
- [ ] You run `cell_fix` with the admin key, adding `hello.txt` to `allowed_paths` and `outputs`.
- [ ] The chat continues, CI passes and the integration cell merges; all five cards are green.

## 9. Kill a chat and resume

1. Start any ready cell, let it make one commit, then close the claude.ai tab without finishing.
2. Wait for the lease to run out (60 minutes), or ask the owner to release it from the panel (step 11) to save time.
3. Reload the panel.

**Expected**
- [ ] The card turns red (lease expired) or shows **Ready to resume**.
- [ ] START opens a new chat whose first line is `RESUME C-00n ...` with the previous commit shown.
- [ ] The work continues from the old branch; nothing is repeated or lost.

## 10. Start a Steward

1. Open a new chat and tell it: you are the Steward, giving the repo and the admin key; it starts with `steward_next`.
2. Reload the panel.

**Expected**
- [ ] The chat follows its briefing and reports what it checks.
- [ ] The panel (and `steward status field` in the smoke script, once the field exists) shows an active Steward.
- [ ] No cell chat is disturbed.

## 11. Release the Steward

1. In the Steward chat ask it to give up the role, or run `steward_release` (admin key).
2. Optionally also use Release on a stuck cell from the panel; the confirm step names the exact git write.
3. Run the smoke script again.

**Expected**
- [ ] The panel shows no active Steward.
- [ ] A released cell goes back to ready (or resumable) and no longer shows a holder.
- [ ] The smoke script reports 0 FAIL.

## 12. Windows launcher

On a Windows PC with Chrome or Edge:

1. Run `.\launcher\build-install.ps1` (see `docs/deploy.md`).
2. In the panel click START on a ready cell.
3. Try Run ready with 3 browsers: select three ready cells and use `startmany`.
4. Merge a cell and click START or Open again.

**Expected**
- [ ] The `blueprint://` protocol is registered for the current user (no admin prompt).
- [ ] Windows asks to open the launcher; a confirm window shows the repo and cell.
- [ ] The profile picker lists your Chrome and Edge profiles with their names and icons, and nothing else.
- [ ] Confirming opens a new browser window in the chosen profile on `claude.ai/new` with the prompt filled in and **not sent**.
- [ ] `startmany` shows one profile picker for 3 cells and opens 3 separate windows, each with its own confirm window.
- [ ] A malformed link (for example a wrong cell id) is rejected with no window.
- [ ] After a cell merges, its local record is gone and the panel no longer offers Open chat for it.
- [ ] With the firewall blocking `blueprint-launcher.exe`, everything above still works.

## 13. Clean up

1. Remove the launcher: `.\launcher\install.ps1 -Uninstall`, and delete `%LOCALAPPDATA%\BlueprintLauncher` if you want to drop local records.
2. Delete the Worker, or roll it back (`npx wrangler delete`, or `npx wrangler rollback`).
3. Remove the secrets you created for the test: `npx wrangler secret delete <NAME>`.
4. Revoke or rotate the test `GITHUB_TOKEN`.
5. Delete the GitHub test repo.
6. Close any claude.ai chats left over from the test.

**Expected**
- [ ] `reg query HKCU\Software\Classes\blueprint` finds nothing.
- [ ] The Worker URL no longer serves the panel (or is rolled back).
- [ ] The test repo and tokens are gone.

## What this runbook could not verify when written

The cell that produced this file ran without GitHub, a Worker, a browser or Windows, so the following are untested and may need small corrections:

- The real GitHub flow: `init_blueprint`, `publish_plan`, CI and automatic merge on the test repo.
- The exact wording of tool replies (`cell_sync`, `cell_note`, `cell_help`, `cell_fix`, `steward_*`) and what the panel shows for a noted cell.
- Whether `/panel/api/state` has a `steward` field and what it is called; the smoke script skips that check if it is absent.
- What `/panel/api/release` does on a cell that is only reserved; the smoke script expects HTTP 200 and then no `reservedBy`.
- Real browsers: panel rendering, polling, Run ready with 3 browsers.
- The Windows launcher: protocol registration, profile picker, icons, new browser windows, `startmany`.
- The sample cells were written in the normal cell format from the task description; the plan's own `type` values and rules for `after:` were not checked.
