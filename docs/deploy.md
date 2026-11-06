# Deploy

## One command

Bash:

```bash
bash scripts/release.sh
```

Windows PowerShell:

```powershell
.\scripts\release.ps1
```

Both run, in order: `npm ci`, `npm test`, `npm --prefix web ci`, `npm --prefix web test`,
`npm --prefix web run build`, a secret check, then `npx wrangler deploy`. They stop at the first
failure and name the failing step. On success they print the panel path `<worker-url>/panel/`.

You must be logged in to Cloudflare first: `npx wrangler login`.

## Required secrets

Set once with `npx wrangler secret put <NAME>`. The scripts only check that the names exist
(`wrangler secret list`); they never read the values.

| Secret | Purpose |
| --- | --- |
| `GITHUB_TOKEN` | GitHub access for the cell engine |
| `ADMIN_TOKEN` | Owner key for takeover and publish_plan |
| `MCP_AUTH_TOKEN` | Auth token for the MCP connector |
| `PANEL_TOKEN` | Panel login password |

Optional: `EXT_TOKEN` (browser extension bearer token). It is not required for a release.

## Roll back

```bash
npx wrangler deployments list
npx wrangler rollback            # previous version
npx wrangler rollback <VERSION_ID>
```

## Launcher (Windows)

Build, test, publish and register `blueprint://` for the current user:

```powershell
.\launcher\build-install.ps1
```

This runs `dotnet test launcher/Core.Tests`, publishes to `launcher\out`, runs
`launcher\install.ps1 -ExePath <full path to blueprint-launcher.exe>`, prints the registered
protocol command, and runs a `--self-test` on a sample `blueprint://sync` URL if the launcher
supports that switch (otherwise it is skipped).

### Uninstall the launcher

```powershell
.\launcher\install.ps1 -Uninstall
```

or remove the registry key `HKCU\Software\Classes\blueprint` by hand:

```powershell
Remove-Item -Path 'HKCU:\Software\Classes\blueprint' -Recurse -Force
```
