# Blueprint Panel: integration status

This file lists what the automated tests cover and, separately, what has **not** been verified. Nothing in the NOT VERIFIED list has been run against a real service or machine.

## Covered by automated tests

- `test/panel_integration.test.ts` (Worker, against `test/fakegh.ts`, not real GitHub): login, state, reserve, a pinned `next_cell` claims exactly the reserved cell, a plain `next_cell` skips a reserved cell, release needs the admin key.
- `web/src/integration.test.tsx` (jsdom, mock data): `App` renders every slot: graph, inspector, shell, table, launch.
- `launcher/Core.Tests`: launcher parsing, validation and local record logic.

## NOT VERIFIED

- [ ] **`/panel/*` routing next to `OAuthProvider`.** Routing in `src/index.ts` is only exercised in tests, not on a deployed Worker with the real OAuth provider in front.
- [ ] **GraphQL fields for merged PRs and the merge sha.** `sha.merged` may be `null`; the extended query in `github.ts` has not been checked against the live GitHub schema.
- [ ] **`github.ts` has never run against real GitHub.** All tests use `test/fakegh.ts`. Rate limits, pagination, permissions and response shapes are unchecked.
- [ ] **`blueprint://` permission prompt on real Windows + Chrome/Edge.** The browser's "open external app" prompt, and whether `--profile-directory=<folder>` selects the right profile, are untested on a real machine.
- [ ] **`claude.ai/new?q=` prefill on the user's account.** Whether the prompt is pre-filled for a given account, plan or browser profile is unconfirmed.
- [ ] **Long-poll limits.** `wait_seconds` behavior under real Worker time limits is untested.
- [ ] **The reservation race.** KV is eventually consistent, so two callers can both see a cell as unreserved. The git branch lock (the `claim(<id>):` commit) is the arbiter; the reservation is only a courtesy. This race has not been exercised for real.
- [ ] **Pinned call without `who`.** The launcher prompt carries no `who`, so a pinned call can claim a cell reserved for someone else (contracts, open point (a)).
