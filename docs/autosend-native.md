# Built-in auto-send: design note

This is the single reference every later cell of the built-in auto-send feature reads. It is plain text on purpose: no code.

## 1. Decision and why

Decision: the launcher presses Send itself through Windows UI Automation. Nothing is installed in any browser: no extension, no userscript manager, no per-profile setup. The Tampermonkey userscript (C-065) stays only as an opt-in legacy engine (settings key autoSendEngine = userscript).

Why:

- Tampermonkey was flaky, needed setup, and teammates struggled to install it on different browsers.
- claude.ai never sends a prompt from a link (a link only pre-fills it), so something outside the page has to press Send.
- A native program can do that for any browser without touching the browser.

## 2. Flow

One cell, step by step:

1. Start window: the teammate picks a profile, ticks Auto-send and, the first time for a repo, ticks "Allow auto-send for <repo> on this PC", then clicks Open.
2. The launcher records the visible top-level browser windows, starts the browser with --new-window and the pre-filled URL, and finds the new window within 8 seconds.
3. It parks that window in a small always-on-top box in the bottom-right corner without taking focus (a minimized or fully covered window does not finish loading; a small visible one does). A small status window above it shows progress.
4. A background thread reads the page through UI Automation every 250 ms until the composer text equals this launch's prompt and Send is enabled for 800 ms in a row. Timeout: 60 seconds.
5. A 3 second countdown with a Cancel button.
6. Re-verify, press Send with UI Automation Invoke, then confirm that the pre-filled composer text is gone (up to 12 seconds).
7. Put the window back to its normal size and not-on-top, without taking focus. The status window closes after 4 seconds. Start-many runs one cell at a time.

## 3. Safety rules

1. Only a cell prompt: the page text must equal this launch's prompt and match the fixed cell template exactly (whitespace-insensitive). The Steward and admin-key prompts are never sent.
2. Only for a repo the teammate allowed on this PC (settings allowedRepos). The allowance comes from an explicit tick in the launcher window, never from a link.
3. Only in the NEW window this launch created (windows before and after, --new-window), never another window that happens to show claude.ai.
4. Visible 3 second countdown with Cancel. The page is read again right before the press, and the adapter checks the text again inside the same read as the press.
5. The only action is UI Automation Invoke on the Send button. No keystrokes, no mouse, no SendInput, no SetForegroundWindow, no clipboard.
6. Never presses twice. At most 12 sends per 10 minutes, kept in a local file. One attempt per launched cell.
7. No network. The log (autosend.log) holds time, decision, browser id, window state and timings; never prompt text, URL, repo name or page text.
8. Every failure ends as "Not sent, press Send yourself" with the prompt still pre-filled.

## 4. Measured evidence

One machine, one profile, Windows 10 build 19045, Chrome 158.0.8127.38, 2026-11-26. A read-only spike plus an opt-in send test.

- claude.ai/new?q= pre-filled the composer with the exact launcher template (165 characters).
- UI Automation saw the browser toolbar about 0.7 to 1 s after launch (the first scan after a cold browser start took about 4 s) and the web page document about 1.4 s after launch. The pre-filled text appeared 7.8 to 14.1 s after launch. Send became enabled 8.8 to 31.1 s after launch (31 s once, while the user worked in another window).
- A page that had already loaded stayed readable when covered by another window and when minimized (scans 230 to 540 ms).
- A page that was loading while the window was minimized did not finish within 40 s (the tree stayed at 64 nodes, no composer, no Send button). After the window was restored it was ready 1.4 s later.
- A small always-on-top window in the corner loaded normally (Send ready at 8.8 s).
- Pressing Send with UI Automation Invoke on the "Send message" button worked with the window in the background while the user was typing elsewhere (Invoke 49 ms) and in the foreground (34 ms). The pre-filled composer text disappeared 1.7 to 1.8 s later. No focus, mouse or keystrokes were used.
- After a window restore, Send was disabled and the tree 4 nodes smaller for one sample while the composer text still matched; cause unknown. Hence the 800 ms stability rule.
- Controls: a Document control contains an Edit named "Write your prompt to Claude" and a Button named "Send message" (English UI). The address bar is also an Edit but is outside the Document. Match the composer by its text, not its name. Keep button names in one list.
- Starting a browser with --profile-directory set to a display name instead of a folder made Chrome create a new signed-out profile. The launcher already uses folders read from Local State; keep it that way.
- UI Automation calls must run on a thread-pool (MTA) thread, never on the WinForms STA UI thread.

## 5. NOT verified

None of the following has been tested:

- [ ] Edge, Firefox, Opera, Yandex and Brave
- [ ] Windows 11
- [ ] A second virtual desktop
- [ ] claude.ai project pages
- [ ] Non-English claude.ai
- [ ] High-DPI scaling
- [ ] An elevated (administrator) browser
- [ ] Several cells started one after another
- [ ] A browser that is already running with another profile
- [ ] Chrome starting the new window maximized

## 6. Component map

- C-090: settings, allowlist, rate cap, log (launcher/Core/LauncherSettings.cs, AutoSendGuard.cs, AutoSendLog.cs).
- C-091: seam types, template match, new-window arguments (ChatPage.cs, PromptBuilder.cs, LaunchCommand.cs).
- C-092: the send engine, pure logic (AutoSendEngine.cs, AutoSendResult.cs).
- C-093: the Windows adapter: UI Automation, window finding and parking (launcher/App/Native/).
- C-094: status window and the coordinator (SendStatusForm.cs, SendCoordinator.cs).
- C-095: start windows use it.
- C-096: read-only check mode.
- C-097: panel texts.
- C-098: docs.

## 7. Settings and files

settings.json keys:

- autoSend (bool)
- autoSendEngine ("native" by default, or "userscript")
- allowedRepos (list of owner/name, at most 50)

Other files:

- autosend-sends.json: send times.
- autosend.log: diagnostics, 64 KB cap.

All of them live in %LOCALAPPDATA%\BlueprintLauncher. The panel link format blueprint:// and the Worker do not change.

## 8. Failure behaviour

Every failure ends the same way: the launcher shows "Not sent, press Send yourself" and the prompt stays pre-filled in the chat, so the teammate presses Send by hand. Nothing is retried and Send is never pressed twice. The waits that can end this way are the 8 second window search, the 60 second wait for the prompt and an enabled Send, a Cancel during the countdown, and the 12 second check that the composer text is gone.

## 9. Rollback

Set autoSendEngine to userscript in settings.json to go back to the legacy Tampermonkey engine (C-065), or untick Auto-send in the launcher window so that the chat is only pre-filled. The panel link format and the Worker are unchanged, so nothing else has to be rolled back.

---

Note for the owner: docs/decisions.md is protected and was not edited. The owner must update the decision "the launcher never clicks" by hand: the launcher now presses Send only through this feature and only after the opt-in.
