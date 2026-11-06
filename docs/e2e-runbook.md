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

1. Copy `docs/e2e/E-001.yaml` to `E-005.yaml` and rename ids to the repo's scheme. Example: `E-001` to `C-001` ... `E-005` to `C-005`, in the file names, in `id:` and in every `after:` entry. If the plan uses a dedicated skeleton cell type, set `type:` of the first cell accordingly.
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
