# Blueprint Panel: visual design reference

Extracted from the approved mockup (`docs/design/*.png`, 4 artboards, sample data). **The mockup wins over earlier prose in `docs/panel-contracts.md` section 5 whenever they differ.** The panel is dark only by default. Fonts: **Inter** (400/500/600/700) and **JetBrains Mono** (500/600), loaded from Google Fonts in `web/index.html`, with `system-ui` / `ui-monospace` fallbacks.

## 1. Tokens

| Token | Value | Use |
|---|---|---|
| bg | `#0C101C` | page / graph canvas |
| panel | `#0F1424` | header, sidebar, inspector, activity panel |
| line | `#1E2740` | all 1px borders, dividers, bar tracks |
| raised | `#18213A` | chips, inputs, secondary buttons (border `#2A3553`) |
| card | `#131A2A` | cell card base (plus status tint, see 3) |
| selected nav | `#1B2745` | active sidebar item |
| text | `#E8ECF5` | primary |
| text-2 | `#C6CDDD` / `#D5DBE8` | rows, chips |
| muted | `#A9B2C6` | secondary |
| muted-2 | `#9AA3B8` | labels |
| muted-3 | `#8A93A8` | section captions, key hints |
| accent | `#5B9DFF` | primary button, running, logo |
| edge | `#3A4560` | normal edge |

Status colors (unchanged): merged/done `#3DD6A3`, running `#5B9DFF`, ready `#FFC857`, waiting `#9AA3B8`, lease expired `#FF6B5E`, needs human `#C792FF`, needs split `#FF8FB1`.
Danger surfaces: banner / chip bg `#2B1512`, border `#7A2E27`, text `#FFD3CD`, sub text `#FFB4AB`. Warning chip: bg `#2A2312`, border `#6B5620`, text `#FFD98A`.

**Labels change:** `done` shows **Merged**, `expired` shows **Lease expired**. Other labels as before (Running, Ready, Waiting, Needs human, Needs split).

**Icons** are 14x14 viewBox strokes (`stroke-width 1.6`, round caps/joins, `fill none`), drawn at 12px in the status color:
- merged: `M3 7.5l3 3 5-6`
- lease expired (warning triangle): `M7 2.5l5 9H2z` + `M7 6v2.5M7 10v.1`
- running (clock): `circle cx7 cy7 r4.5` + `M7 4v3l2 1.5`
- waiting (clock): `circle cx7 cy7 r5` + `M7 4.5V7h2.5`
- needs human (circled !): `circle cx7 cy7 r5` + `M7 4.5v3M7 9.5v.1`
- ready: filled triangle `M3 1.5l9 5.5-9 5.5z`
- needs split: pick a simple split glyph in the same style (not in the mockup)

## 2. Frame (1440 x 860 reference)

- **Header** 56px, bg panel, bottom border line, padding 0 20, gap 16: logo (3 rounded squares icon, stroke accent, 22px) + "Blueprint" 700 15px; repo chip `owner/name · main` (mono 500 12px, bg raised, border `#2A3553`, radius 8, padding 6 10, color `#C6CDDD`); progress bar 180x8 radius 99 on line track with segments merged (green), running (blue), expired (red) as % of all cells, then "4 / 15 merged" 600 12.5px; right side: usage-limit chip (see note), search box 200x36 (bg raised, border, radius 8, text "Search cells" 500 12.5 muted-2, right "Ctrl K" mono 11), "Live · 3s" (green 8px dot with `pulse` animation 2s, text 500 12 `#A9B2C6`; seconds since last successful poll), user chip (pill, border `#2A3553`, 26px avatar circle accent bg `#06142B` initials 700 11, name 600 12).
- **Sidebar** 196px, bg panel, right border, padding 16 12. Nav buttons (Graph, Table, Timeline, Settings): height 40, radius 8, padding 0 12, 13px; active = bg `#1B2745` white 600; inactive transparent `#A9B2C6` 500. Then caption "STATUS" (600 11px, letter-spacing .08em, muted-3), rows: 10x10 radius-3 color square + label 500 12.5 `#D5DBE8` + count right (mono, `#A9B2C6`), padding 7 8, radius 8; clicking a row toggles the status filter. Order: Merged, Running, Ready, Waiting, Lease expired, Needs human, Needs split (hide a status with count 0 only if it is not filtered). Caption "FILTERS" then checkboxes "Critical path only", "Hide merged" (500 12.5, padding 8).
- **Right inspector** 320px, bg panel, left border line, padding 20 (see 5).
- **Graph pane** between sidebar and inspector, bg bg. Reference geometry: pane starts x 196; content margin 16.
- **Activity panel** inside the graph pane at the bottom: height 172, margin 0 16 16 16, padding 12 16, border line, radius 12, bg panel; caption "LIVE ACTIVITY" (use "LIVE ACTIVITY · SAMPLE DATA" only in mock mode); rows: padding 6 0, top border line, 500 12px `#C6CDDD`, columns time (mono, muted-3, 44px, HH:MM local), icon 14px, text. Icons: heartbeat/running clock blue, warnings red triangle, merged green check. Rows are derived from `state.cells[].lastCommit` and statuses, newest first; scrolls inside the panel.

## 3. Graph view

- **Scale is 1:1.** Cards are 152 x 72 and the graph opens at zoom 1 (no fit-to-view shrink): column pitch 186 (152 card + 34 gap), row pitch 96 (72 + 24). Wave columns left to right; vertical centering of each column around its parent cells. Pan and zoom remain; add a minimap and zoom controls only if they do not overlap the activity panel (bottom-left controls, minimap bottom-right above the panel).
- **Wave labels** above the columns at the top of the pane: "WAVE 1" 600 11px letter-spacing .08em `#9AA3B8` + " · 3 cells" 500 `#6F7890`.
- **Card** (button): 152x72, padding 8 11, radius 12, bg card, border `1px solid <status color>88`, an inner overlay of the status color at opacity .1 (inset 0, radius 11), flex column space-between. Row 1: id (mono 600 11, status color) left; right icon + status label (600 10, status color). Row 2: title 600 13 (ellipsis). Row 3: sha7 (mono 500 10.5, `#A9B2C6`, "—" when none) left; meta right (500 10.5 `#A9B2C6`): merged "merged 3h ago", running "34m left", expired "expired 22m ago", waiting "← C-004, C-006" (blocked-by ids), needs human "feedback sent", ready "start now".
- **Badges** sit OUTSIDE the card, above its top edge (top -22px), never overlapping text: left `START` (ready cells only: bg `#FFC857`, text `#261A00`, 700 10, letter-spacing .03em, padding 3 8, radius 8, play icon 9px); left owner chip: any running or lease expired cell, whoever started it: "AL · Open chat" (initials + holder name; bg `#1B2745`, border `#4A5F94`, text `#DDE6FF`; the chip is clickable for everyone, mine and others' alike); right `BLOCKS 8` on the bottleneck (bg `#FF6B5E`, text `#1A0B09`, 700 10, padding 3 8, radius 8). Merged cells never show Open chat.
- **Selected** card: `outline 2px solid #fff; outline-offset 2px`; bottleneck selected/idle also `box-shadow 0 0 0 6px rgba(255,107,94,.28)`.
- **Edges:** cubic bezier from the right edge middle of the source to the left edge middle of the target, control offset about 40px (`M x1 y1 C x1+40 y1, x2-40 y2, x2 y2`); stroke `#3A4560` 1.5; contract edges dashed `5 4`; edges leaving the bottleneck are `#FF6B5E`, width 2, opacity .85 (long edges use a wider bend).
- **Banner** (only when a bottleneck exists and its status is expired / needs attention), at the top of the graph pane, margin 12 16 0, height 44, padding 0 8 0 14, radius 10, bg `#2B1512`, border `#7A2E27`, text 500 13 `#FFD3CD`: warning icon, "**C-004 API core** is holding up 8 cells. Its lease expired 22 min ago (attempt 2 of 3).", right button "Release now" (height 32, padding 0 14, radius 8, bg `#FF6B5E`, text `#1A0B09`, 700 12.5). The button calls `actions.requestRelease(id)`.

## 4. Header usage chip

The mockup shows "acct-a over 90% of 5h limit · resets 2:40 AM". That data is NOT in the state contract, so render the chip only in mock mode. Do not invent a Worker field.

## 5. Inspector (320px, padding 20)

Top row: id (mono 600 12, status color) left; status pill right (icon + label, 600 11, border + tinted bg in the status family; for expired: bg `#2B1512` border `#7A2E27` text `#FF6B5E`, radius 99, padding 4 9). Title 700 22 (margin 8 0 4). Subline 500 12.5 `#A9B2C6`: "Critical cell · 5 direct, 8 total dependents" (or "5 direct, 8 total dependents"). Lease bar 8px radius 99 on line track, fill = status color (red when expired, full width); caption 500 11.5 (`#FFB4AB` when expired): expired "Lease expired 22 min ago · attempt 2 of 3", running "34 min left · attempt 1 of 3". Key/value rows (padding 9 0, top border line, 500 12.5; key `#9AA3B8`, value `#E8ECF5` right-aligned, mono for shas/branch): Branch `cell/C-004`, Lock sha, Tip sha, Last commit "subject · 52m ago", Next step, Holder, Files "N allowed paths". Buttons (column, gap 10, margin-top 18, height 44, radius 10, 13.5): "Open chat" (bg `#5B9DFF`, text `#06142B`, 700), "Release cell" (bg `#FF6B5E`, border `#FF6B5E`, text `#1A0B09`, 600), "Open branch on GitHub" (bg `#18213A`, border `#33405E`, 600). Hide buttons that do not apply to the status. Help text 500 11.5/1.5 `#8A93A8`: "Click selects. Double-click opens details. Release writes one empty commit so any chat can adopt the cell at once." Release keeps the existing confirm dialog with the typed admin key.

## 6. Launcher windows (WinForms, not a web page)

Dark, rounded look to match artboards 2 and 4 (`docs/design/2-launcher-start.png`, `4-launcher-open.png`).
- **Start window** ~780 x 640 client, bg `#111827`-like panel (`#0F1424`), title bar text "Blueprint Launcher · local window on your PC". Content padding 32: id mono + status pill ("Ready", yellow), title 700 22 "Start Docs scaffold", subline "owner/repo · wave 2 · reserved for you for 10 minutes". Step 1 caption "OPEN IN WHICH BROWSER PROFILE?" (600 11, letter-spacing .08em, with numbered circle): three radio cards (Chrome · Work / Profile folder: Profile 2, ...) each 714 x 52, selected one has border `#5B9DFF` and bg `#16213D`. Step 2 caption "PROMPT THAT WILL BE PRE-FILLED (YOU REVIEW IT)": mono text box on `#0C101C` with border line showing the exact prompt. Lock note (green): "Works offline. Reads only profile names from Chrome. Sends nothing anywhere. You press Send in the chat." Buttons right: "Cancel" (raised) and "Open chat with this prompt" (accent, text `#06142B`, 700).
- **Open window** ~780 x 330: id + "Running · yours" pill (blue), title, "Started 21 minutes ago in Chrome · Work", full-width accent button "Open claude.ai in Chrome · Work" (height 48), caption "CHAT LINK (OPTIONAL, PASTE ONCE TO JUMP STRAIGHT TO THE CHAT)", mono input `https://claude.ai/chat/...` + "Save" button, lock note "Saved only on this PC. Deleted when C-006 turns green, or after 14 days."
- WinForms needs system fonts: use `Inter` if installed, else `Segoe UI`; mono `Consolas`. Keep all logic in `launcher/Core`; nothing here may use the network.

## 7. Settings dialog ("How Start works")

Opened by the sidebar "Settings" item. Contains the display name field (stored in localStorage by the launch slot; look up its key in `web/src/launch/index.tsx`) and the explainer from artboard 3 (`3-launch-flow.png`): title "What happens when a teammate clicks Start (Windows, local launcher, no extension)", six numbered steps: 1 Click Start in the panel (On a card, in the inspector, or double-click. The panel sends only repo and cell id.) 2 Panel reserves the cell (The Worker holds it for you for 10 minutes. It learns the cell id and your name, nothing from your browser.) 3 Launcher window opens (A small local Windows window lists your profiles, shows the prompt, and asks you to confirm.) 4 Chrome opens your profile (The chosen profile opens claude.ai/new with the prompt filled. You press Send.) 5 Chat claims the cell (next_cell with cell_id returns CLAIMED. The launcher already saved cell, profile and time on your PC.) 6 Card shows you (Open chat reopens that profile on claude.ai. Records are deleted when the cell turns green.). Three notes: STAYS ON YOUR PC (profile names read by the launcher and shown only in its own window; a small record per cell: cell id, profile, time, optional pasted chat link; the launcher opens no network connection), LEAVES YOUR PC (BY DESIGN) (repo and cell id and your name to the Worker for the reservation; the prompt, inside the claude.ai link, because that is the chat you asked for), HONEST LIMITS (Windows only, first click Chrome asks permission to open the launcher; no automatic chat link and no automatic release at the usage limit, use Release in the panel; the page that calls the launcher is untrusted, so the launcher validates it and always asks you to confirm).
