// Routes /panel/*: login, authenticated JSON API, static SPA. Returns null for every path outside /panel.
import { resolveRepo } from "../engine.ts";
import { handlePanelAction } from "./actions.ts";
import { handleLogin, json, readBounded, requirePanelAuth } from "./auth.ts";
import { buildPanelState, type PanelDeps } from "./state.ts";
import type { PanelEnv } from "./types.ts";

async function serveAsset(req: Request, env: PanelEnv): Promise<Response> {
  if (!env.ASSETS) return json(503, { error: "assets_not_configured" });
  if (req.method !== "GET" && req.method !== "HEAD") return json(405, { error: "method_not_allowed" }, { allow: "GET, HEAD" });
  const url = new URL(req.url);
  if (url.pathname === "/panel") return Response.redirect(`${url.origin}/panel/${url.search}`, 302);
  // The SPA is built flat into web/dist, so /panel/x is the asset /x. Unknown paths without a file extension get the SPA shell.
  const rel = url.pathname.slice("/panel".length) || "/";
  let res = await env.ASSETS.fetch(new Request(new URL(rel + url.search, url.origin), req));
  if (res.status === 404 && !/\.[A-Za-z0-9]+$/.test(rel)) res = await env.ASSETS.fetch(new Request(new URL("/", url.origin), req));
  return res;
}

export async function handlePanelRequest(req: Request, env: PanelEnv, ctx: ExecutionContext, deps: PanelDeps = {}): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname;
  if (path !== "/panel" && !path.startsWith("/panel/")) return null;
  if (path !== "/panel/api" && !path.startsWith("/panel/api/")) return serveAsset(req, env);

  let r = req;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const body = await readBounded(req);
    if (body === null) return json(413, { error: "body_too_large" });
    r = new Request(req.url, { method: req.method, headers: req.headers, body });
  }
  if (path === "/panel/api/login") return handleLogin(r, env);

  const denied = await requirePanelAuth(r, env);
  if (denied) return denied;

  if (path === "/panel/api/state") {
    if (r.method !== "GET") return json(405, { error: "method_not_allowed" }, { allow: "GET" });
    const resolved = resolveRepo(env, url.searchParams.get("repo") ?? undefined);
    if ("error" in resolved) return json(resolved.error.startsWith("REPO_NOT_ALLOWED") ? 403 : 400, { error: resolved.error.slice(0, 200) });
    try {
      return json(200, await buildPanelState(env, resolved.repo, deps));
    } catch (e) {
      return json(502, { error: String((e as Error)?.message ?? e).slice(0, 200) });
    }
  }

  const res = await handlePanelAction(r, env, ctx, path);
  return res ?? json(404, { error: "not_found" });
}
