# Architecture decisions

Fixed decisions every cell must follow. Agents cannot edit this file (protected); change it yourself, in a normal PR.

Source of truth: the Blueprint Panel build plan (blueprint-panel-build-plan.md). Contracts live in `docs/panel-contracts.md` once C-000 is merged.

- Worker: TypeScript, Cloudflare Workers, tests with `node --test test/*.test.ts` (Node 22). Cell logic (status, ready, locked) is reused from `src/plan.ts` `computeState()`; never duplicated.
- Panel web app: React 18 + TypeScript + Vite, Tailwind, Radix UI, `@xyflow/react` + dagre (rankdir LR), TanStack Query, Vitest. Lives in `web/`, built to `web/dist`, served by the Worker with Workers Static Assets. Same origin, no CORS headers.
- Launcher: C# .NET 8 WinForms, self-contained single exe, Windows only, opens no network connection. Lives in `launcher/`. Core logic in `launcher/Core` with tests in `launcher/Core.Tests`.
- Panel sends only `repo + cell id` to the launcher; the launcher builds the prompt from a fixed template. Prompt is pre-filled by default; auto-send is an opt-in helper for cell chats only, never for the Steward (see docs/autosend.md).
- Browser data (profiles, cookies, history) never reaches a web page or service.
- Status colors: done #3DD6A3, running #5B9DFF, ready #FFC857, waiting #9AA3B8, expired #FF6B5E, needs_human #C792FF, needs_split #FF8FB1. Every status also has an icon and a text label.
- CI setup (`.github/blueprint-setup.sh`) runs `npm ci` at the root and `npm --prefix web install` when `web/package.json` exists. Agents cannot run npm, so they never commit lockfiles for `web/`.
