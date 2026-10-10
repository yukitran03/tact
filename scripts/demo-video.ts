/**
 * Records a short product demo of the running web app. Captures screenshots on
 * a fixed clock (more reliable than CDP screencast under Bun) and encodes them
 * with ffmpeg into an MP4. Default output: ~/Downloads/tact-demo.mp4
 *
 *   bun run start &
 *   bun scripts/demo-video.ts
 */
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";

const BASE = process.env.TACT_URL ?? "http://127.0.0.1:8787";
const OUT = process.argv[2] ?? join(homedir(), "Downloads", "tact-demo.mp4");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.TACT_DEMO_CDP_PORT ?? 9355);
const W = 1440;
const H = 900;
const FPS = 8;

mkdirSync(join(homedir(), "Downloads"), { recursive: true });
const profile = join(tmpdir(), `tact-demo-${Date.now()}`);
const framesDir = join(tmpdir(), `tact-frames-${Date.now()}`);
mkdirSync(profile, { recursive: true });
mkdirSync(framesDir, { recursive: true });

const chrome = Bun.spawn([
  CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  `--window-size=${W},${H}`, "about:blank",
], { stdout: "ignore", stderr: "ignore" });

async function target(): Promise<string> {
  for (let i = 0; i < 60; i++) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
      const page = list.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* starting */ }
    await Bun.sleep(400);
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
  const was = capturing;
  capturing = false; // pause screenshots so CDP is not congested
  try {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (await evaluate(`!!(${expr})`)) return true;
      await Bun.sleep(250);
    }
    console.warn(`  timed out: ${expr}`);
    return false;
  } finally {
    capturing = was;
  }
}
const click = (sel: string, text?: string) => evaluate(`(() => { const els = [...document.querySelectorAll(${JSON.stringify(sel)})]; const el = ${text ? `els.find((e) => (e.textContent||"").includes(${JSON.stringify(text)}))` : "els[0]"}; if (el) { el.scrollIntoView({ block: "center" }); el.click(); return true; } return false; })()`);

let frame = 0;
let capturing = false;
let captureTimer: ReturnType<typeof setInterval> | null = null;

async function snap() {
  if (!capturing) return;
  try {
    const r = await send("Page.captureScreenshot", { format: "jpeg", quality: 78, fromSurface: true });
    if (r?.data) {
      const n = String(++frame).padStart(5, "0");
      writeFileSync(join(framesDir, `f${n}.jpg`), Buffer.from(r.data, "base64"));
    }
  } catch { /* page mid-nav */ }
}

function startCapture() {
  capturing = true;
  captureTimer = setInterval(() => { void snap(); }, Math.round(1000 / FPS));
}
function stopCapture() {
  capturing = false;
  if (captureTimer) clearInterval(captureTimer);
  captureTimer = null;
}

const hold = (ms: number) => Bun.sleep(ms);

async function go(path: string) {
  const was = capturing;
  capturing = false;
  try {
    await send("Page.navigate", { url: `${BASE}${path}` });
    await waitFor("document.readyState === 'complete'");
    await Bun.sleep(500);
  } finally {
    capturing = was;
  }
}

async function typeCDP(text: string) {
  // Focus composer first.
  await evaluate(`(() => { const el = document.querySelector("textarea"); if (el) { el.focus(); return true; } return false; })()`);
  for (const ch of text) {
    await send("Input.dispatchKeyEvent", { type: "keyDown", text: ch });
    await send("Input.dispatchKeyEvent", { type: "keyUp", text: ch });
    await Bun.sleep(28);
  }
}

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });

console.log(`recording → ${OUT}`);
startCapture();

await go("/");
await evaluate(`localStorage.setItem("tact-theme","light"); document.documentElement.setAttribute("data-theme","light"); true`);
await go("/");
await waitFor('document.querySelector(".lp-hero h1")');
await hold(2400);
await evaluate("window.scrollTo({ top: 520, behavior: 'smooth' }); true");
await hold(1600);
await evaluate("window.scrollTo({ top: 1100, behavior: 'smooth' }); true");
await hold(1600);

await go("/demo?name=B%E1%BA%A3o");
await waitFor('document.querySelector(".side-item.active") && document.querySelectorAll(".msg").length > 0');
await hold(1600);
await evaluate("const f=document.querySelector('.feed'); if (f) f.scrollTo({ top: 1e6, behavior: 'smooth' }); true");
await hold(1800);
await click(".tabs button", "Receipt");
await hold(2200);
await click(".tabs button", "Memory");
await waitFor('document.querySelectorAll(".fact").length > 2');
await hold(2200);

await click(".side-item", "Private with Tact");
await hold(1400);
await evaluate("const f=document.querySelector('.feed'); if (f) f.scrollTo({ top: 1e6, behavior: 'smooth' }); true");
await hold(1400);
await click(".tabs button", "Shield");
await hold(1800);

if (await evaluate('!!document.querySelector("textarea")')) {
  await typeCDP("Mình dị ứng tôm cua, đừng nói ai nhé.");
  await hold(500);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await hold(2600);
}

await evaluate(`(() => { const el = [...document.querySelectorAll(".side-item")].find((e) => /Friday|Table|demo/i.test(e.textContent || "")); if (el) { el.click(); return true; } return false; })()`);
await hold(1000);
await click(".tabs button", "Chat");
await hold(600);
if (await evaluate('!!document.querySelector("textarea")')) {
  await typeCDP("Is anyone here allergic to anything?");
  await hold(400);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await hold(2800);
  await evaluate("const f=document.querySelector('.feed'); if (f) f.scrollTo({ top: 1e6, behavior: 'smooth' }); true");
  await hold(1800);
}

await go("/demo?name=Chi");
await waitFor('document.querySelector(".feed")');
await hold(1400);
await evaluate("const f=document.querySelector('.feed'); if (f) f.scrollTo({ top: 1e6, behavior: 'smooth' }); true");
await hold(1800);

await go("/");
await waitFor('document.querySelector(".lp-hero h1")');
await hold(2200);

stopCapture();
await snap();

const n = readdirSync(framesDir).filter((f) => f.endsWith(".jpg")).length;
console.log(`encoding ${n} frames…`);
const ff = Bun.spawn([
  "ffmpeg", "-y", "-v", "error",
  "-framerate", String(FPS),
  "-i", join(framesDir, "f%05d.jpg"),
  "-vf", `fps=${FPS},scale=${W}:${H}:flags=lanczos,format=yuv420p`,
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
  "-movflags", "+faststart", OUT,
], { stdout: "ignore", stderr: "pipe" });
const ffErr = await new Response(ff.stderr).text();
const code = await ff.exited;

ws.close();
chrome.kill();
rmSync(profile, { recursive: true, force: true });
rmSync(framesDir, { recursive: true, force: true });

if (code !== 0 || !existsSync(OUT)) {
  console.error(ffErr.slice(0, 1000));
  process.exit(1);
}
console.log(`done · ${n} frames · ${(Bun.file(OUT).size / 1e6).toFixed(1)} MB · ${OUT}`);
process.exit(0);
