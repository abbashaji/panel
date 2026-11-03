# Changelog

## Unreleased
- Usage-limit release (contracts in `blueprint-kit/docs/contracts.md`): new endpoints `GET /ext/ping`, `POST /ext/release` and `POST /ext/warn` in `src/ext.ts`, served only when the secret `EXT_TOKEN` is set (otherwise 404). Deploy step: `npx wrangler secret put EXT_TOKEN` (long random value), then `npx wrangler deploy`. Rotate by running the same `secret put` again. The paid Workers plan is recommended.
- `/ext/release` commits `release(C-NNN): usage limit` (empty commit, fast-forward only, no reset time in git), refuses when the chat no longer owns the lock commit, when a PR is open (`submitted`) or when the cell is already released. `GitHubApi.branchCommits` was added for the lock search (never run against real GitHub).
- `/ext/warn` (C5) sets an advisory KV flag, never a commit; while flagged, write-tool replies end with `LIMIT_WARNING`. New agent rules (`RULES`, `BLUEPRINT.md`): echo the bind line after `next_cell` (C1) and obey `LIMIT_WARNING`. `BLUEPRINT.md` changed, so run `init_blueprint` with `upgrade: true` on every repo.
- New test `test/contracts.test.ts`: the C1 regex and the C2 subject agree across extension, Worker and `contracts.md` (skipped when the sibling folders are absent).
- Order: a released cell is served BEFORE fresh cells (class 0 with expired critical cells). New order: expired critical or released first, then fresh, then expired non-critical (promoted to the fresh class after `park_max_minutes`). Released cells are otherwise unchanged (expired at once, override CI, never `needs_split`). Python reference, `plan.ts` and the fixtures changed together; `tools/blueprintlib.py` changed, so run `init_blueprint` with `upgrade: true` on every repo.
- RESUME body: `Last commit:` shows only the subject of the tip plus a `next:` line; the `attempt:` and `req:` trailers are never printed (the header `attempt n/max` is the single source).
- Fix: the CLAIMED header shows the capped lease (critical_lease_minutes) for critical cells.
- Fix: the RESUME body no longer echoes the previous tip's `attempt:` trailer.

## Failures F1-F9 (found in the adversarial tests), old -> new
- **F1 skeleton idles 60 min.** Old: a skeleton cell was never critical and waited out a full 60-minute lease. New: skeletons count as critical-path cells; the lease is capped at `critical_lease_minutes` (15).
- **F2 PARTIAL keeps the lease.** Old: a chat that replied PARTIAL left the cell locked until the lease ran out. New: `cell_signal release` with `next:` makes the cell adoptable at once.
- **F3 breadcrumb erased by takeover.** Old: the takeover commit did not carry the `next:` line and attempt count to the next resumer. New: lock commits (`claim(`, `takeover(`, `adopt(`) carry `next:`, `attempt:` and `req:` trailers forward.
- **F4 no heartbeat.** Old: only commits renewed a lease, so a long generation looked dead. New: `cell_signal heartbeat`.
- **F5 false death on a slow chat.** Old: a chat in one long generation on a 15-minute critical lease was fenced out (CONFLICT) mid-generation. New: `cell_signal heartbeat` before generations over ~5 minutes, and commits after every finished file group.
- **F6 admin gate tests.** Old: no role separation was tested: takeover / force on a live cell was open to any caller. New: `takeover` and `publish_plan` need `admin_key` (`ADMIN_TOKEN`); agents never get it.
- **F7 human takeover not adoptable.** Old: a cell taken over by the owner could not be picked up by the next chat. New: `takeover` with `handoff` makes it adoptable; `clear_feedback` clears `needs_human`.
- **F8 no attempt counter.** Old: a cell that kills every chat was retried forever. New: `attempt:` counts `takeover(` only; above `max_attempts` (3) the cell is `needs_split`.
- **F9 old merged cells shown ready.** Old: merged state came only from the recent `main` log. New: merged pull requests are read too.

## Docs
- New agent rules (`RULES`, `BLUEPRINT.md`): heartbeat, release at ~60% context, `append` for files over ~150 lines, `cell_signal feedback`, `retry_after` loop (max 8), one `apply_changes` after a gate failure, `already applied`.
- Not verified live yet: see README.
