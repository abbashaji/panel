# panel


## Blueprint Panel

The Blueprint Panel is a web page served by the Worker (same origin, no CORS) plus a small offline Windows launcher. The panel shows every cell as a left-to-right dependency graph colored by status, highlights the bottleneck, lets a teammate start a cell, and lets the owner Release or Hand over a stuck cell. The launcher opens the chosen browser profile on `claude.ai/new?q=<prompt>`; the teammate presses Send. It replaces `blueprint-limit-ext`; automatic release at the usage limit and automatic chat-link capture are gone (use Release in the panel; the chat link is an optional paste box).

Design details and contracts: `docs/panel-contracts.md`. What is not verified: `docs/panel-integration.md`.

### Deploy

1. Set the secrets. Four separate secrets; do not reuse one for another:
   - `wrangler secret put PANEL_TOKEN` (new: the panel login password)
   - `wrangler secret put ADMIN_TOKEN` (existing: typed per admin action, never stored in the page or cookie)
   - `wrangler secret put GITHUB_TOKEN`
   - `wrangler secret put MCP_AUTH_TOKEN`
2. Build the web app first, because the Worker serves `web/dist` as static assets: `npm --prefix web run build`
3. Then deploy: `wrangler deploy`

### Windows launcher

Run `launcher/install.ps1` on each teammate's Windows machine. It registers the `blueprint://` protocol under `HKCU` (no admin rights). The script is readable text; read it before running it. The launcher opens no network connection.
