import { join } from "node:path";
import { createApp } from "../app";
import { createApi } from "./api";

const app = createApp();
const api = createApi(app);
const root = join(import.meta.dir, "..", "..");

async function buildWeb(): Promise<string> {
  const out = await Bun.build({
    entrypoints: [join(root, "web", "app.tsx")],
    minify: process.env.NODE_ENV === "production",
    target: "browser",
    define: { "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "development") },
  });
  if (!out.success) {
    for (const l of out.logs) console.error(l);
    throw new Error("web build failed");
  }
  return await out.outputs[0].text();
}

let bundle = await buildWeb();
const html = await Bun.file(join(root, "web", "index.html")).text();
const css = await Bun.file(join(root, "web", "styles.css")).text();

const server = Bun.serve({
  port: app.settings.port,
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);
    try {
      const res = await api(req, url);
      if (res) return res;
    } catch (err) {
      console.error("[api]", err);
      return new Response(JSON.stringify({ error: "server error" }), { status: 500, headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/app.js") {
      if (process.env.NODE_ENV !== "production") bundle = await buildWeb();
      return new Response(bundle, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } });
    }
    if (url.pathname === "/styles.css") {
      const fresh = process.env.NODE_ENV !== "production" ? await Bun.file(join(root, "web", "styles.css")).text() : css;
      return new Response(fresh, { headers: { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" } });
    }
    if (url.pathname === "/favicon.svg") {
      return new Response(Bun.file(join(root, "web", "favicon.svg")), { headers: { "content-type": "image/svg+xml" } });
    }
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
});

const resumed = app.memory.resumeInFlight();
const [mem, llm] = await Promise.all([app.backend.health(), app.llm.health()]);
console.log(`Tact on http://localhost:${server.port}`);
console.log(`  memory: ${app.backend.kind} — ${mem.detail}${resumed ? ` (resumed ${resumed} in-flight writes)` : ""}`);
console.log(`  model:  ${llm.ok ? "" : "(unavailable) "}${llm.detail}`);
