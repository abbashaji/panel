// index.ts: Cloudflare Worker entry. OAuth (auth.ts) in front of an MCP endpoint at /mcp.
// Tool schemas and handlers live in tools.ts; all logic lives in engine.ts.
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { AuthHandler } from "./auth.ts";
import { buildServer, type Env } from "./tools.ts";

export type { Env };

const mcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return createMcpHandler(() => buildServer(env))(request, env, ctx);
  },
};

export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: mcpApiHandler as any,
  defaultHandler: AuthHandler as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: ["mcp"],
});
