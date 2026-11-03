// auth.ts: defaultHandler for @cloudflare/workers-oauth-provider. Only /health and the owner-consent
// /authorize page (password = MCP_AUTH_TOKEN). Nothing else is exposed: no webhooks, no dashboard.
import { extFetch } from "./ext.ts";
import type { Env } from "./index.ts";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(body: string, status = 200): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>blueprint-mcp</title>
<style>body{font:15px/1.5 -apple-system,Segoe UI,sans-serif;max-width:420px;margin:80px auto;padding:0 20px;color:#1a1a1a}
input{width:100%;padding:10px;font-size:15px;box-sizing:border-box;border:1px solid #ccc;border-radius:6px;margin:12px 0}
button{width:100%;padding:10px;font-size:15px;background:#1a1a1a;color:#fff;border:none;border-radius:6px;cursor:pointer}.err{color:#b00020}.meta{color:#666;font-size:13px}</style>
</head><body>${body}</body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY" } },
  );
}

/** Constant-time string comparison (hash both sides so lengths do not leak). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

const form = (req: string, err = "") => `
  <h1>Authorize</h1>${err}
  <form method="POST" action="/authorize">
    <input type="hidden" name="oauth_req" value="${esc(req)}">
    <input type="password" name="password" placeholder="Server password" autofocus required>
    <button type="submit">Approve</button>
  </form>`;

export const AuthHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/ext/")) return extFetch(request, env);
    if (url.pathname === "/" || url.pathname === "/health") return new Response("blueprint-mcp: ok\n");

    if (url.pathname === "/authorize" && request.method === "GET") {
      if (!env.MCP_AUTH_TOKEN) return new Response("MCP_AUTH_TOKEN is not set (wrangler secret put MCP_AUTH_TOKEN)", { status: 500 });
      const info = await env.OAUTH_PROVIDER.parseAuthRequest(request);
      const client = await env.OAUTH_PROVIDER.lookupClient(info.clientId);
      return page(`<h1>Authorize ${esc(client?.clientName || info.clientId)}</h1>
        <p class="meta">Grants access to the Blueprint cell tools of ${esc(env.DEFAULT_REPO ?? "your repository")}.</p>${form(JSON.stringify(info)).replace("<h1>Authorize</h1>", "")}`);
    }

    if (url.pathname === "/authorize" && request.method === "POST") {
      const f = await request.formData();
      const password = String(f.get("password") || "");
      const raw = String(f.get("oauth_req") || "");
      let info;
      try {
        info = JSON.parse(raw);
      } catch {
        return page(`<h1>Bad request</h1><p class="err">Malformed authorization request.</p>`, 400);
      }
      if (!env.MCP_AUTH_TOKEN || !(await safeEqual(password, env.MCP_AUTH_TOKEN))) {
        return page(form(raw, `<p class="err">Incorrect password.</p>`), 401);
      }
      const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
        request: info,
        userId: "owner",
        metadata: { label: "blueprint-mcp" },
        scope: info.scope,
        props: {},
      });
      return Response.redirect(redirectTo, 302);
    }
    return new Response("Not found", { status: 404 });
  },
};
