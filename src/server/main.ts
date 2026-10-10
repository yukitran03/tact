import { createApp } from "../app";
import { createRequestHandler } from "./handler";
import { ensureDemoFixture } from "./fixture";

const app = createApp();
ensureDemoFixture(app);
const handle = createRequestHandler(app);

const server = Bun.serve({
  port: app.settings.port,
  idleTimeout: 120,
  fetch: handle,
});

const resumed = app.memory.resumeInFlight();
const retried = app.memory.retryFailed();
if ("warm" in app.backend) console.log(`  warmed SEAL session in ${await (app.backend as { warm(): Promise<number> }).warm()} ms`);
const [mem, llm] = await Promise.all([app.backend.health(), app.llm.health()]);
console.log(`Tact on http://localhost:${server.port}`);
console.log(`  memory: ${app.backend.kind}, ${mem.detail}${resumed ? ` (resumed ${resumed} in-flight writes)` : ""}${retried ? ` (retrying ${retried} failed writes)` : ""}`);
console.log(`  model:  ${llm.ok ? "" : "(unavailable) "}${llm.detail}`);
