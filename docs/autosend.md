# Auto-send (opt-in helper)

By default the launcher only pre-fills the prompt in a new claude.ai chat and you press Send yourself. Auto-send is an optional helper that presses Send for you. It is off unless you turn it on.

## Why it is opt-in

Sending a message is an action in your account. The default stays the safe one: you read the prompt and you press Send. Auto-send exists for people who start many cells and accept that trade. It is never switched on for you, and it never applies to the Steward.

## How it works

1. The launcher stays offline. It never clicks anything and opens no network connection.
2. In the start window and the start-many window there is a checkbox, **Auto-send in the browser**. It is off by default. The choice is saved in `%LOCALAPPDATA%\BlueprintLauncher\settings.json` (one value, `autoSend`).
3. When the checkbox is on, the launcher adds `&autosend=1` to the chat URL, and only to a cell URL. `PromptBuilder.WithAutoSend` refuses anything else: a Steward URL, another host, a URL with extra parameters, or a prompt that is not exactly the launcher's cell template for a valid repo and cell. The admin-key prompt can never be marked.
4. A userscript in your browser does the click. It acts only on a chat that carries the marker, only when the prompt is exactly the launcher's template, and only for an allowed repo. Before it sends, it shows a banner with a 3 second countdown. You can cancel during that time and nothing is sent.

## Setup (once per browser profile)

1. Install a userscript manager (for example Tampermonkey or Violentmonkey) in the browser profile you start cells in.
2. Install the Blueprint auto-send helper userscript in that profile and check its allowed repo setting in the CONFIG block.
3. Open the launcher's start window and tick **Auto-send in the browser**.

A profile without the helper still works: the chat opens with the prompt pre-filled and you press Send. The footer in the launcher window says which mode is active.

## Connector tool approvals

claude.ai may still ask you to approve the Blueprint connector tools (for example `next_cell`) the first time they are used in a chat. Auto-send only presses Send on the prompt; it does not approve tools. To avoid a pause in every chat, set the Blueprint tools to "always allow" in your claude.ai connector settings.

## When claude.ai changes

The helper finds the prompt box and the Send button with selectors listed in the CONFIG block of the userscript. If claude.ai changes its page, a selector may stop matching. The helper then shows a banner saying the prompt was **not sent**, and you press Send yourself. Fix it by updating the selectors in the CONFIG block.

## Turning it off

- Untick **Auto-send in the browser** in the launcher window. The setting is saved at once and the next chat is pre-filled only.
- Or disable or remove the userscript in the browser profile.
- Deleting `settings.json` also returns the launcher to the default (off).
