/**
 * Screenshots of the running app through the Chrome DevTools Protocol, with no
 * extra dependencies: Bun's WebSocket talks to a headless Chrome. Each shot
 * waits for a real condition in the page instead of a fixed delay.
 *
 *   bun run start &            # the app on :8787 with the demo table seeded
 *   bun scripts/screenshots.ts [outDir]
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const BASE = process.env.TACT_URL ?? "http://localhost:8787";
const OUT = process.argv[2] ?? join(import.meta.dir, "..", "docs", "screenshots");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333;
mkdirSync(OUT, { recursive: true });
const profile = join(tmpdir(), `tact-shots-${Date.now()}`);

const chrome = Bun.spawn([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--window-size=1440,920", "about:blank"], { stdout: "ignore", stderr: "ignore" });

async function target(): Promise<string> {
  for (let i = 0; i < 60; i++) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
      const page = list.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await Bun.sleep(500);
  }
  throw new Error("chrome did not start");
}

const ws = new WebSocket(await target());
await new Promise((r) => (ws.onopen = r));
let seq = 0;
const pending = new Map<number, (v: any) => void>();
ws.onmessage = (e) => {
  const msg = JSON.parse(String(e.data));
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)!(msg.result ?? msg.error); pending.delete(msg.id); }
};
const send = (method: string, params: Record<string, unknown> = {}) =>
  new Promise<any>((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expr: string) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }))?.result?.value;

async function waitFor(expr: string, timeoutMs = 30_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await evaluate(`!!(${expr})`)) return true;
    await Bun.sleep(300);
  }
  console.warn(`  timed out waiting for ${expr}`);
  return false;
}

async function viewport(width: number, height: number, mobile = false) {
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
}

async function shot(name: string) {
  await Bun.sleep(400);
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.data, "base64"));
  console.log(`  ${name}.png`);
}

async function go(path: string) {
  await send("Page.navigate", { url: `${BASE}${path}` });
  await waitFor("document.readyState === 'complete'");
}

const theme = (t: "light" | "dark") => evaluate(`localStorage.setItem('tact-theme', '${t}'); document.documentElement.setAttribute('data-theme', '${t}'); true`);
const click = (sel: string, text?: string) => evaluate(`(() => { const els = [...document.querySelectorAll(${JSON.stringify(sel)})]; const el = ${text ? `els.find((e) => e.textContent.includes(${JSON.stringify(text)}))` : "els[0]"}; if (el) el.click(); return !!el; })()`);

await send("Page.enable");
await send("Runtime.enable");

for (const t of ["light", "dark"] as const) {
  await viewport(1440, 920);
  await go("/api/session/logout"); // clears nothing on GET, harmless
  await send("Network.clearBrowserCookies");
  await go("/");
  await theme(t);
  await go("/");
  await waitFor("document.querySelector('.hero h1')");
  await shot(`landing-${t}`);
}

await theme("light");
await go("/demo?name=B%E1%BA%A3o");
await waitFor("document.querySelector('.side-item.active') && document.querySelectorAll('.msg').length > 3");
await waitFor("document.querySelector('.plan-card')");
await evaluate("document.querySelector('.feed').scrollTo({ top: 1e6 }); true");
await click(".tabs button", "Receipt");
await waitFor("document.querySelector('.stat-grid')");
await shot("table-receipt-bao");
await click(".tabs button", "Memory");
await waitFor("document.querySelectorAll('.fact').length > 3");
await shot("table-memory-bao");
await click(".side-item", "Private with Tact");
await waitFor("document.querySelector('.shield-note') || document.querySelectorAll('.msg').length > 3");
await evaluate("document.querySelector('.feed').scrollTo({ top: 1e6 }); true");
await click(".tabs button", "Shield");
await waitFor("document.querySelectorAll('.fact').length > 0");
await shot("dm-shield-bao");

await theme("dark");
await go("/demo?name=Chi");
await waitFor("document.querySelector('.plan-card')");
await evaluate("document.querySelector('.feed').scrollTo({ top: 1e6 }); true");
await click(".tabs button", "Table");
await waitFor("document.querySelectorAll('.venue-row').length > 3");
await shot("table-chi-dark");

await viewport(390, 844, true);
await theme("light");
await go("/demo?name=Dũng");
await waitFor("document.querySelector('.plan-card')");
await evaluate("document.querySelector('.feed').scrollTo({ top: 1e6 }); true");
await shot("mobile-table-dung");
await click(".mobile-tabs button", "Memory");
await waitFor("document.querySelectorAll('.fact').length > 3");
await shot("mobile-memory-dung");

ws.close();
chrome.kill();
rmSync(profile, { recursive: true, force: true });
process.exit(0);
