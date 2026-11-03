// index.ts: Cloudflare Worker entry. OAuth (auth.ts) in front of an MCP endpoint at /mcp.
// Tool schemas and handlers live in tools.ts; all logic lives in engine.ts.
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { AuthHandler } from "./auth.ts";
import { buildServer, type Env } from "./tools.ts";
import { handlePanelRequest } from "./panel/router.ts";
import type { PanelEnv } from "./panel/types.ts";

export type { Env };

const mcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return createMcpHandler(() => buildServer(env))(request, env, ctx);
  },
};

const oauth = new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: mcpApiHandler as any,
  defaultHandler: AuthHandler as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: ["mcp"],
});

// /panel/* is answered first (own cookie auth, same origin); everything else goes to OAuth + MCP as before.
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const panel = await handlePanelRequest(request, env as PanelEnv, ctx);
    if (panel) return panel;
    return (oauth as any).fetch(request, env, ctx);
  },
};
