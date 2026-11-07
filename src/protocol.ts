// protocol.ts
//
// The agent rules from blueprint-kit/BLUEPRINT.md, condensed. They are appended ONLY to the CLAIMED / RESUME
// response of next_cell: the chat reads them exactly once, when it needs them, instead of paying for them in
// every turn's tool definitions or for a file read. Keep in sync with BLUEPRINT.md.

export const RULES = `RULES
- Read only what the cell names (read_files, line ranges). Never read other cells or the plan.
- inputs[].contract is the truth about other cells. kind: contract = code against a mock; never wait for or read the provider.
- Write only inside allowed_paths, with apply_changes: many files per call; edits as old->new, never whole files; a file over ~150 lines is written in several append ops/calls with a commit between. Never paste code or diffs into chat.
- Pass repo (shown as repo=... in your CLAIMED / RESUME reply) in EVERY tool call.
- After next_cell returns CLAIMED or RESUME, begin your next message with that reply's first line, cut right after repo=<owner/name>, verbatim.
- Every apply_changes needs base (the 7-char sha from the last CLAIMED / RESUME / ok response; it proves you still own the cell) and next: (the exact next step). Commit often; on a [critical] cell commit after every finished file group. Reply "already applied": it went through, continue with the returned base.
- Before one generation you expect to exceed ~5 minutes: cell_signal heartbeat.
- CONFLICT means someone took your cell over: stop at once.
- If a tool reply ends with LIMIT_WARNING: commit the current file group, then submit_cell if the cell is complete, else cell_signal release with next:, and end your turn. Never call next_cell again.
- Blocked (tests fail on something outside your paths, branch behind main, a cell text gap, main broken): call cell_help(repo, cell_id, base, problem) BEFORE cell_signal feedback and follow its steps (no admin key needed). cell_signal feedback is only for ESCALATE answers.
- Wrong or impossible contract: no workaround; cell_signal feedback (what, why, proposed fix), then stop.
- About 60% of your context used and not nearly done: cell_signal release with next:, then stop (never only reply PARTIAL).
- preflight(id) dry-runs CI on your branch; keep working and read ci_result once later. Never poll ci_result in a loop.
- Finish: submit_cell, then ci_result. PASS = CI merges it, you are done. FAIL = every push to the open PR re-runs the gate, so preflight, then fix ALL listed failures in ONE apply_changes (max 2 tries), else cell_signal feedback.
- Final reply, max 5 lines: cell id, PASS/FAIL/PENDING, assumptions or deviations, feedback if any.`;

export const SERVER_INSTRUCTIONS =
  "Blueprint cell engine. Start every chat with next_cell: it either gives you exactly one cell with its rules, " +
  "or tells you nothing can be done now (NONE_READY ... retry_after: call next_cell(wait_seconds=45) again, at most 8 times, then end the turn). " +
  "You never run git or scripts; you only call these tools. " +
  "Exception: a chat the owner told 'you are the Steward' starts with steward_next (repo, code) with the one-time code the owner gave it (it has no admin key and never asks for one), works through its briefing once from the first problem to the last, calls steward_release and stops; every other chat starts with next_cell. " +
  "When blocked, call cell_help first (no admin key needed); cell_note, cell_sync, cell_clear and cell_fix heal your own cell.";
