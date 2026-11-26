# Auto-send (built in, opt-in)

By default the launcher only pre-fills the prompt in a new claude.ai chat and you press Send yourself. Auto-send is a feature of the launcher that presses Send for you after a short countdown. It is off until you turn it on. Nothing is installed in your browser: no extension, no userscript manager.

Design and measurements: `docs/autosend-native.md`.

## What it does

After you click Open in the start window or the start-many window, the launcher:

1. Starts the browser in a new window with the prompt pre-filled.
2. Keeps that window in a small always-on-top box in the bottom-right corner, without taking focus, and shows a small status window.
3. Waits until the prompt is in the chat and Send is ready (up to 60 seconds).
4. Counts down 3 seconds. You can press Cancel.
5. Presses Send, then checks that the pre-filled text left the chat box (up to 12 seconds).
6. Puts the window back to its normal size, still without taking focus.

Start-many runs one cell at a time. It only sends a cell prompt, only in the window it opened itself, and never presses Send twice. The Steward prompt is never sent. At most 12 sends per 10 minutes.

## Turn it on

1. Tick **Auto-send** in the launcher window. The choice is saved at once.
2. The first time for a repo, tick **Allow auto-send for <repo> on this PC**. Only this tick in the launcher window gives the permission; a link can never give it.
3. Click Open.

## Countdown and Cancel

The status window shows a 3 second countdown with a **Cancel** button. If you press Cancel, nothing is sent and the prompt stays in the chat.

## When it does not send

Every failure ends the same way: the launcher shows **Not sent, press Send yourself** and the prompt stays pre-filled, so you press Send by hand. Nothing is retried. This happens when the new window is not found within 8 seconds, the prompt or Send is not ready within 60 seconds, you press Cancel, the prompt text no longer matches the cell prompt (for example you edited it), or the text is still in the chat box 12 seconds after the press.

## Check a browser

`blueprint-launcher.exe --check-autosend [browser] [profile-folder]` prints a read-only report to a message box and to `autosend.log`. It sends nothing.

## Files

All in `%LOCALAPPDATA%\BlueprintLauncher`:

- `settings.json`: `autoSend` (true or false), `autoSendEngine` (`native` by default, or `userscript`) and `allowedRepos` (the repos you allowed on this PC).
- `autosend-sends.json`: the times of recent sends, for the rate cap.
- `autosend.log`: diagnostics, 64 KB cap. It holds time, decision, browser id, window state and timings, never prompt text, URL, repo name or page text.

## Connector tool approvals

claude.ai may still ask you to approve the Blueprint connector tools (for example `next_cell`) the first time they are used in a chat. Auto-send only presses Send on the prompt; it does not approve tools. To avoid a pause in every chat, set the Blueprint tools to "always allow" in your claude.ai connector settings.

## Turning it off

- Untick **Auto-send** in the launcher window. The next chat is only pre-filled.
- Or set `autoSend` to `false` in `settings.json`.
- To take back the permission for one repo, remove it from `allowedRepos` in `settings.json`.
- Deleting `settings.json` returns the launcher to the default (off).

## Legacy browser helper (userscript)

The older engine is a userscript in your browser. Set `autoSendEngine` to `userscript` in `settings.json` to use it. It needs a userscript manager (for example Tampermonkey or Violentmonkey) and the Blueprint auto-send helper userscript in the profile you start cells in. The launcher then marks the cell URL with `&autosend=1` and the userscript presses Send after a 3 second cancel banner. If it cannot, it shows that the prompt was not sent and you press Send yourself. Set `autoSendEngine` back to `native` to return to the built-in auto-send.
