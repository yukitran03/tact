import type { App } from "../app";
import type { Outbound } from "../core/types";

/**
 * Telegram adapter over the plain Bot API (long polling, no SDK). The same
 * engine serves groups and private chats:
 *
 * - In a group, Tact answers commands (/plan, /addplace, /memory, /help), an
 *   @mention, or a reply to one of its messages. With BotFather privacy mode on
 *   (the default) that is all Telegram delivers, which is the respectful setting.
 * - In a private chat, everything is for Tact: that's where discreet facts live.
 * - Private shield notes go to each owner's private chat, if they have started one.
 */

interface TgUser { id: number; first_name?: string; last_name?: string; username?: string; is_bot?: boolean }
interface TgChat { id: number; type: "private" | "group" | "supergroup" | "channel"; title?: string }
interface TgMessage { message_id: number; from?: TgUser; chat: TgChat; text?: string; reply_to_message?: { from?: TgUser } }
export interface TgUpdate { update_id: number; message?: TgMessage }

/** Our light markdown → Telegram HTML, escaping everything else. */
export function toTelegramHtml(text: string): string {
  return text
    .replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!))
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?]|$)/g, "$1<i>$2</i>")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:]|$)/g, "$1<i>$2</i>");
}

const COMMAND_MAP: [RegExp, (rest: string) => string][] = [
  [/^\/plan\b/i, (r) => `where should we eat ${r}`.trim()],
  [/^\/addplace\b/i, (r) => `add place: ${r}`],
  [/^\/memory\b/i, () => "@tact what do you remember?"],
  [/^\/help\b/i, () => "help"],
  [/^\/start\b/i, () => "/start"],
  [/^\/forget\b/i, (r) => `forget ${r}`],
  [/^\/why\b/i, (r) => `why did you skip ${r}`],
];

export class TelegramBot {
  private offset = 0;
  private me: TgUser | null = null;
  private stopped = false;

  constructor(private readonly app: App, private readonly token: string, private readonly apiBase = "https://api.telegram.org") {}

  private async call<T>(method: string, payload: Record<string, unknown>, timeoutMs = 40_000): Promise<T> {
    const res = await fetch(`${this.apiBase}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = (await res.json()) as { ok: boolean; result: T; description?: string };
    if (!data.ok) throw new Error(`telegram ${method}: ${data.description}`);
    return data.result;
  }

  async init(): Promise<TgUser> {
    this.me = await this.call<TgUser>("getMe", {});
    await this.call("setMyCommands", {
      commands: [
        { command: "plan", description: "Pick a place that works for everyone" },
        { command: "addplace", description: "Remember a place: name, food, ~price, area" },
        { command: "memory", description: "What this group remembers (shared only)" },
        { command: "why", description: "In private: why a place was skipped" },
        { command: "forget", description: "In private: retract something you told me" },
        { command: "help", description: "How Tact works" },
      ],
    }).catch(() => undefined);
    return this.me;
  }

  /** Normalises one update into an engine call and delivers the replies. Exposed for tests. */
  async handleUpdate(u: TgUpdate): Promise<Outbound[]> {
    const m = u.message;
    if (!m?.text || !m.from || m.from.is_bot) return [];
    const { ledger, engine } = this.app;
    const name = [m.from.first_name, m.from.last_name].filter(Boolean).join(" ") || m.from.username || "Friend";
    const member = ledger.upsertMember("telegram", String(m.from.id), name);
    const botName = this.me?.username ? `@${this.me.username}` : "";
    let text = m.text.trim();
    if (botName) text = text.replace(new RegExp(botName, "ig"), "").trim();
    let addressed = m.chat.type === "private";
    for (const [re, to] of COMMAND_MAP) {
      const cm = re.exec(text);
      if (cm) {
        text = to(text.slice(cm[0].length).replace(/^@\S+/, "").trim());
        addressed = true;
        break;
      }
    }
    if (botName && m.text.toLowerCase().includes(botName.toLowerCase())) addressed = true;
    if (m.reply_to_message?.from?.id && this.me && m.reply_to_message.from.id === this.me.id) addressed = true;

    let out: Outbound[];
    if (m.chat.type === "private") {
      ledger.setKv(`tg-dm:${member.id}`, String(m.chat.id));
      out = await engine.handle({ channel: "telegram", roomType: "dm", roomId: member.id, memberId: member.id, text });
    } else {
      // With privacy mode on, only addressed messages arrive; with it off, unaddressed chatter
      // is still read for venues, verdicts and self-stated facts but never answered with help.
      const group = ledger.upsertGroup("telegram", String(m.chat.id), m.chat.title ?? "Telegram group");
      ledger.addToGroup(group.id, member.id);
      out = await engine.handle({ channel: "telegram", roomType: "group", roomId: group.id, memberId: member.id, text: addressed && !/^@?tact/i.test(text) && !/^(add place|where should|help|forget|why)/i.test(text) ? `@tact ${text}` : text, addressed });
    }
    await this.deliver(out);
    return out;
  }

  private async deliver(out: Outbound[]) {
    const { ledger } = this.app;
    for (const o of out) {
      let chatId: string | null = null;
      if (o.roomType === "group") chatId = ledger.group(o.roomId)?.externalId ?? null;
      else chatId = ledger.getKv(`tg-dm:${o.roomId}`);
      if (!chatId) continue; // owner hasn't opened a private chat with the bot yet
      try {
        await this.call("sendMessage", { chat_id: chatId, text: toTelegramHtml(o.text), parse_mode: "HTML", disable_web_page_preview: true });
      } catch (err) {
        console.error("[telegram] send failed", (err as Error).message);
      }
    }
  }

  async run(): Promise<void> {
    await this.init();
    console.log(`Tact on Telegram as @${this.me?.username}`);
    while (!this.stopped) {
      try {
        const updates = await this.call<TgUpdate[]>("getUpdates", { offset: this.offset, timeout: 30, allowed_updates: ["message"] }, 45_000);
        for (const u of updates) {
          this.offset = u.update_id + 1;
          await this.handleUpdate(u).catch((err) => console.error("[telegram] update failed", err));
        }
      } catch (err) {
        console.error("[telegram] poll failed", (err as Error).message);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  stop() {
    this.stopped = true;
  }
}

if (import.meta.main) {
  const { createApp } = await import("../app");
  const app = createApp();
  if (!app.settings.telegramToken) {
    console.error("Set TELEGRAM_BOT_TOKEN (from @BotFather) to run the Telegram bot.");
    process.exit(1);
  }
  app.memory.resumeInFlight();
  await new TelegramBot(app, app.settings.telegramToken).run();
}
