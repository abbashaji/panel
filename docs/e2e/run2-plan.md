# E2E run 2 plan

Run date: 2026-11-10, test repo abbashaji/e2e. This is the plan that was run, and the result expected AFTER the fixes of C-081, C-082, C-086, C-087 and PR 78.

## Cells

- C-001: skeleton, adds hello.txt. Expected: merges first.
- C-002, C-008, C-009: parallel cells after C-001. Expected: all three run at once and merge, no false CONFLICT when Run ready starts several cells.
- C-003: replaced by C-004 (supersedes). Never run. Expected: hidden in the panel.
- C-004: replaces C-003. Expected: runs and merges.
- C-005: depends on the replaced C-003. Expected: becomes ready through the gate fix, runs and merges.
- C-006: spec gap, no contract for the line format. Expected: the chat ends with cell_signal feedback, the panel shows Needs steward, the Steward publishes a superseding cell with a stated line format, that cell merges.
- C-007: path gap, manifest.txt is outside allowed_paths. Expected: its own chat calls cell_help, then cell_fix replace (kind replace, C-081). No Steward is needed.
- C-010: integration cell, writes RESULT.txt. Expected: ready after all others, runs and merges.

## Rule for stopped cells

A stopped cell never shows Running for more than 10 minutes without the label Needs steward (C-087).

## Not in this plan

Release and cancel reservation, sync links, auto-send, Steward button states. See Run 2 results in docs/e2e-runbook.md.
