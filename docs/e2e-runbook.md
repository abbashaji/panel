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
mkdir -p out/cells
for f in E-00*.yaml; do
  n=${f#E-}
  sed 's/E-00/C-00/g' "$f" > "out/cells/C-$n"
done
```

This writes `out/cells/C-001.yaml` to `C-005.yaml` with every `E-00` replaced by `C-00`. If the test repo already uses those ids, pick another prefix and number range, and change `after:` to match. A text editor search and replace works as well.

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

## 7. Run the smoke script

The script needs Node 18, no packages. It prints no secret. Set the variables in your shell (do not put them in a file that is committed):

```bash
export WORKER_URL=https://<your-worker>.workers.dev
export PANEL_PASSWORD=...   # PANEL_TOKEN
export REPO=<you>/panel-e2e
export ADMIN_KEY=...        # ADMIN_TOKEN, optional: without it the release checks are skipped
node scripts/e2e-smoke.mjs
```

PowerShell: `$env:WORKER_URL = '...'` and so on, then `node scripts/e2e-smoke.mjs`.

Optional variables: `CELL_ID` (reserve this cell instead of the first ready one), `REPLACED_IDS` (default `C-052,C-058`, ids that must not appear in the state), `STEWARD_FIELD` (default `steward`).

The script checks: an unauthenticated state call gives 401, login and the cookie flags, the state shape and counts, replaced cells absent, the steward field, reserve then `reservedBy` visible within 3 seconds, release then no `reservedBy` and a new status within 10 seconds.

**Expected**

- [ ] A table with PASS on every row, exit code 0 (`echo $?` prints 0).
- [ ] Without `ADMIN_KEY` the two release rows say SKIP, not FAIL.
- [ ] No password or key appears in the output.
- [ ] A FAIL on the steward row means the field name differs (see section 0), not that the Worker is broken.

## 8. Start three cell chats

Start the skeleton first, then the three parallel cells together.

1. In the panel select C-001 and press Start (double click works too). Without the launcher, open a new chat and paste the prompt from `docs/panel-contracts.md` section 4.2 with `cell_id=C-001`. Press Send yourself.
2. Wait for C-001 to turn green (merged). The panel polls every 5 seconds.
3. C-002, C-003 and C-004 are now ready. Open three browsers or profiles, logged in to claude.ai. In the panel press **Run ready** and choose one profile per cell (needs the Windows launcher, section 12). Without the launcher, start three chats by hand, one per cell, each with its own `cell_id`.
4. Press Send in each chat. Each starts with its CLAIMED line.

**Expected**

- [ ] C-001 goes ready, running, done. `hello.txt` is on `main`.
- [ ] Three cells show running at the same time, each with its own lease bar.
- [ ] Each chat's first line is `CLAIMED C-00N base=... repo=...`.
- [ ] While a cell is only reserved (before Send) the card shows it as reserved and nobody else can start it.
- [ ] C-002 merges. C-003 and C-004 do not finish yet (steps 9 and 10).

## 9. Stale branch, spec gap and path gap: watch them heal

The tools `cell_help`, `cell_note`, `cell_sync`, `cell_clear` and `cell_fix` come from C-061. Read their descriptions in the chat first (section 0).

**9a. Spec gap (C-003).** The cell text refers to a contract it does not list. The chat must not guess.

- The chat reports the gap with `cell_note`.
- You answer in the cell: the line format is just the letter `b`. Add it as a contract to the cell (`cell_fix`, or edit `cells/C-003.yaml` on `main`), then clear the note (`cell_clear`) so the chat can go on.

**Expected**

- [ ] The panel shows C-003 as needing attention (the `needs_human` color and label), not silently stuck.
- [ ] After your answer the chat continues, writes `parts/b.txt` with `b`, and C-003 merges.

**9b. Path gap (C-004).** The goal needs `manifest.txt`, which is outside `allowed_paths`.

- The chat cannot write `manifest.txt` and asks for help with `cell_help`.
- You or the Steward repair the cell with `cell_fix` (add `manifest.txt` to `allowed_paths` and `outputs`).

**Expected**

- [ ] The chat does not write outside `allowed_paths`.
- [ ] After `cell_fix` the chat writes `parts/c.txt` and `manifest.txt`, and C-004 merges.

**9c. Stale branch.** While a cell is still running, push one unrelated commit to `main` (on GitHub, create a file `notes.txt` and commit it). The running cell's branch is now behind.

- The chat (or the Steward) brings the branch up to date with `cell_sync`.

**Expected**

- [ ] The chat does not run git itself; it uses `cell_sync`.
- [ ] The branch contains the new `main` commit afterwards and the cell still merges.
- [ ] When C-002, C-003 and C-004 are merged, C-005 becomes ready, runs (start it as in step 8) and merges. `result.txt` has four lines: `hello`, `a`, `b`, `c`.

## 10. Kill a chat and resume

Use a cell that is running and has made at least one commit.

1. Close the chat tab. Do not release it.
2. The lease is 60 minutes. To test the real expiry wait until the card shows lease expired (red, `expired`). Shortcut that tests Release instead: press **Release** on the card, type `ADMIN_TOKEN` when asked, and read the confirm text (it names the exact git write).
3. Press Start (or double click) on the card.

**Expected**

- [ ] The card shows **Ready to resume** (expired) or ready again after Release, and the attempts counter is unchanged or one higher.
- [ ] The new chat's first line is `RESUME C-00N base=... repo=...` and it goes on from the last commit's `next:`.
- [ ] The old chat, if you reopen it, gets `CONFLICT` and stops.

## 11. Steward: start and release

Use this on a spare cell that is stuck (for example a cell you left in step 9b without `cell_fix`).

1. Open a new chat and tell it: "You are the Steward for `<you>/panel-e2e`." Type the `ADMIN_TOKEN` when it asks for `admin_key` (never write it in the prompt that you save).
2. It starts with `steward_next` and follows its briefing.
3. Reload the panel and rerun `node scripts/e2e-smoke.mjs`.
4. When done, tell the Steward to give up the role (`steward_release`, with handoff if work is left).

**Expected**

- [ ] The panel and the state show a steward and its status while it runs.
- [ ] The Steward repairs or hands over the stuck cell and leaves a short note on it.
- [ ] After `steward_release` the steward field is empty again (`null`) and the smoke script still passes.

## 12. Windows launcher check

On a Windows PC with Chrome and Edge (at least two profiles in one of them):

1. Run `.\launcher\build-install.ps1` (see `docs/deploy.md`).
2. In the panel press Start on a ready cell.
3. Create a new browser profile, then press Start again.
4. In the panel select three ready cells and press Run ready (`startmany`).
5. Merge a cell and start another one (the panel sends `sync`).
6. Block the launcher in the firewall and press Start again.

**Expected**

- [ ] `blueprint://` is registered under `HKCU\Software\Classes\blueprint` (no admin rights asked).
- [ ] The launcher window and the picker show the app icon and the profile names only (no email addresses).
- [ ] The newly created browser profile appears in the picker without a reinstall.
- [ ] A confirm window opens before each start; the chat opens with the prompt filled in and is not sent.
- [ ] `startmany` shows one picker for the cells and opens one confirm window per chosen profile; more than 12 cells or a duplicate id is refused.
- [ ] `%LOCALAPPDATA%\BlueprintLauncher\cells.json` has a record per started cell and the record of a merged cell is removed on `sync`.
- [ ] With the launcher blocked in the firewall everything still works (it opens no network connection).

## 13. Clean up

- [ ] Close all test chats.
- [ ] Delete the GitHub test repo (Settings, Danger Zone).
- [ ] Delete the Worker: `npx wrangler delete` (or roll back, see `docs/deploy.md`). Remove the secrets you only created for this test: `npx wrangler secret delete PANEL_TOKEN` and the others.
- [ ] Revoke or rotate the `GITHUB_TOKEN` if it was made only for this test.
- [ ] Uninstall the launcher: `.\launcher\install.ps1 -Uninstall` (or remove `HKCU:\Software\Classes\blueprint`), then delete `%LOCALAPPDATA%\BlueprintLauncher`.
- [ ] Clear the `ADMIN_KEY`, `PANEL_PASSWORD` variables from your shell (`unset ADMIN_KEY PANEL_PASSWORD`).
- [ ] Delete the renamed sample files (`out/`).

## Results sheet

Copy this, fill it in, and keep it with the release notes.

| Step | Result (OK / FAIL) | Note |
| --- | --- | --- |
| 2 Test repo | | |
| 3 Deploy | | |
| 4 init_blueprint | | |
| 5 Publish plan | | |
| 6 Panel | | |
| 7 Smoke script | | |
| 8 Three chats | | |
| 9 Heal | | |
| 10 Resume | | |
| 11 Steward | | |
| 12 Launcher | | |
| 13 Clean up | | |
