import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TelegramBot, toTelegramHtml } from "../src/channels/telegram";
import { Engine } from "../src/core/engine";
import { MemoryService } from "../src/memory/service";
import { MockBackend } from "../src/memory/backend";
import { Ledger } from "../src/memory/ledger";
import type { App } from "../src/app";

/** A fake Bot API that records every sendMessage. */
const sent: { chat_id: string; text: string }[] = [];
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const method = url.pathname.split("/").pop();
      const body = (await req.json().catch(() => ({}))) as any;
      if (method === "getMe") return Response.json({ ok: true, result: { id: 999, is_bot: true, username: "tact_test_bot", first_name: "Tact" } });
      if (method === "sendMessage") { sent.push({ chat_id: String(body.chat_id), text: body.text }); return Response.json({ ok: true, result: {} }); }
      return Response.json({ ok: true, result: true });
    },
  });
});
afterAll(() => server.stop(true));

function app(): App {
  const ledger = new Ledger(":memory:");
  const backend = new MockBackend();
  const memory = new MemoryService(backend, ledger, { namespaceSecret: "t", prefix: "tg", pollMs: 5 });
  const engine = new Engine(memory, ledger, null, { polishBudgetMs: 0, answerBudgetMs: 0 });
  return { ledger, backend, memory, engine, llm: null as any, settings: {} as any };
}

const user = (id: number, first_name: string) => ({ id, first_name });
let uid = 1;
const dm = (from: { id: number; first_name: string }, text: string) => ({ update_id: uid++, message: { message_id: uid, from, chat: { id: from.id, type: "private" as const }, text } });
const grp = (from: { id: number; first_name: string }, text: string) => ({ update_id: uid++, message: { message_id: uid, from, chat: { id: -100123, type: "supergroup" as const, title: "Lunch crew" }, text } });

describe("telegram", () => {
  test("markdown becomes safe HTML", () => {
    expect(toTelegramHtml("**Phở** <script> `x` _quiet_")).toBe("<b>Phở</b> &lt;script&gt; <code>x</code> <i>quiet</i>");
  });

  test("private facts in DM, plan in group, shield note back in the owner's DM only", async () => {
    const a = app();
    const bot = new TelegramBot(a, "TOKEN", `http://localhost:${server.port}`);
    await bot.init();
    const linh = user(11, "Linh"), minh = user(22, "Minh");
    await bot.handleUpdate(dm(linh, "/start"));
    await bot.handleUpdate(dm(linh, "I'm allergic to shrimp and crab"));
    await bot.handleUpdate(dm(minh, "/start"));
    await bot.handleUpdate(grp(linh, "/addplace Ốc Đào, seafood snails, ~150k, District 4"));
    await bot.handleUpdate(grp(minh, "/addplace Phở Lan, pho, vegetarian options, ~65k, District 3"));
    await a.memory.drain(5000);
    sent.length = 0;
    await bot.handleUpdate(grp(minh, "/plan@tact_test_bot friday"));
    const toGroup = sent.filter((s) => s.chat_id === "-100123");
    const toLinh = sent.filter((s) => s.chat_id === "11");
    expect(toGroup.length).toBe(1);
    expect(toGroup[0].text).toContain("Phở Lan");
    expect(toGroup[0].text.toLowerCase()).not.toContain("allerg");
    expect(toGroup[0].text.toLowerCase()).not.toContain("shrimp");
    expect(toLinh.length).toBe(1);
    expect(toLinh[0].text).toContain("allergic");
    expect(sent.some((s) => s.chat_id === "22")).toBe(false);
  });

  test("unaddressed group chatter gets no reply", async () => {
    const a = app();
    const bot = new TelegramBot(a, "TOKEN", `http://localhost:${server.port}`);
    await bot.init();
    sent.length = 0;
    await bot.handleUpdate(grp(user(33, "Huy"), "haha see you all tomorrow"));
    expect(sent.length).toBe(0);
  });
});
