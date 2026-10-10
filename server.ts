/**
 * Vercel entry (Hono + Bun). Locally keep using `bun run start` (src/server/main.ts).
 *
 * On Vercel the ledger lives under /tmp and is re-seeded from data/demo-fixture.json
 * on cold start so /demo?name=Bảo still points at the same Walrus namespaces.
 */
import { Hono } from "hono";
import { createApp } from "./src/app";
import { createRequestHandler } from "./src/server/handler";
import { ensureDemoFixture } from "./src/server/fixture";

if (process.env.VERCEL) {
  process.env.TACT_DATA_DIR ??= "/tmp/tact";
  process.env.TACT_POLISH_BUDGET_MS ??= "0";
  process.env.NODE_ENV ??= "production";
}

const app = createApp();
ensureDemoFixture(app);
const handle = createRequestHandler(app);

if ("warm" in app.backend) {
  void (app.backend as { warm(): Promise<number> }).warm().then((ms) => console.log(`[tact] SEAL warm ${ms} ms`));
}
app.memory.resumeInFlight();
app.memory.retryFailed();

const hono = new Hono();
hono.all("*", (c) => handle(c.req.raw));

export default hono;
