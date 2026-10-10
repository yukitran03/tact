/**
 * Shared HTTP handler used by the local Bun.serve entry and the Vercel/Hono entry.
 * On Vercel, static assets come from embedded.ts (generated at build time).
 */
import { join } from "node:path";
import type { App } from "../app";
import { createApi } from "./api";
import { handleMcpHttp } from "../channels/mcp";
import { ROOT } from "../config";
import { EMBEDDED_APP_JS, EMBEDDED_CSS, EMBEDDED_FAVICON, EMBEDDED_HTML } from "./embedded";

export function createRequestHandler(app: App) {
  const api = createApi(app);
  const root = ROOT;

  async function buildWeb(): Promise<string> {
    if (process.env.VERCEL) return EMBEDDED_APP_JS;
    const out = await Bun.build({
      entrypoints: [join(root, "web", "app.tsx")],
      minify: false,
      target: "browser",
      define: { "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "development") },
    });
    if (!out.success) {
      for (const l of out.logs) console.error(l);
      throw new Error("web build failed");
    }
    return await out.outputs[0].text();
  }

  let bundlePromise = buildWeb();

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/demo") return Response.redirect(`${url.origin}/api/demo/open${url.search}`, 302);
    if (url.pathname === "/mcp") {
      try {
        return await handleMcpHttp(app, req);
      } catch (err) {
        console.error("[mcp]", err);
        return Response.json({ jsonrpc: "2.0", error: { code: -32603, message: "internal error" }, id: null }, { status: 500 });
      }
    }
    try {
      const res = await api(req, url);
      if (res) return res;
    } catch (err) {
      console.error("[api]", err);
      return new Response(JSON.stringify({ error: "server error" }), { status: 500, headers: { "content-type": "application/json" } });
    }

    const vercel = !!process.env.VERCEL;
    if (url.pathname === "/app.js") {
      if (!vercel && process.env.NODE_ENV !== "production") bundlePromise = buildWeb();
      const bundle = vercel ? EMBEDDED_APP_JS : await bundlePromise;
      return new Response(bundle, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": vercel ? "public, max-age=60" : "no-store" } });
    }
    if (url.pathname === "/styles.css") {
      if (vercel) return new Response(EMBEDDED_CSS, { headers: { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=60" } });
      return new Response(Bun.file(join(root, "web", "styles.css")), { headers: { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" } });
    }
    if (url.pathname === "/favicon.svg") {
      if (vercel) return new Response(EMBEDDED_FAVICON, { headers: { "content-type": "image/svg+xml" } });
      return new Response(Bun.file(join(root, "web", "favicon.svg")), { headers: { "content-type": "image/svg+xml" } });
    }
    if (vercel) return new Response(EMBEDDED_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    return new Response(Bun.file(join(root, "web", "index.html")), { headers: { "content-type": "text/html; charset=utf-8" } });
  };
}
