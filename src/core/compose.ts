import type { PlanResult, ScoredVenue } from "./planner";
import type { Fact, StoredFact, Tier } from "./types";
import { cuisineLabel, DAY_LABEL, formatMoney } from "./lexicon";
import type { LLM } from "../llm/provider";
import { scanForLeaks, type LeakHit, type SensitiveTerm } from "./firewall";

export type Lang = "en" | "vi";

const L = (lang: Lang, en: string, vi: string) => (lang === "vi" ? vi : en);

export function dayName(day: string, lang: Lang) {
  return DAY_LABEL[day]?.[lang] ?? day;
}

function venueLine(v: ScoredVenue, lang: Lang) {
  const parts = [v.venue.area, v.venue.price ? `~${formatMoney(v.venue.price, v.venue.currency ?? "VND")}/${L(lang, "person", "người")}` : null]
    .filter(Boolean).join(" · ");
  return `**${v.venue.name}**${parts ? ` (${parts})` : ""}`;
}

/** The group-visible facts about a plan. Nothing in here comes from a discreet or private memory. */
export interface PublicPlanContext {
  lang: Lang;
  choice: { name: string; area?: string; price?: string; cuisine: string[]; reasons: string[] } | null;
  alternatives: { name: string; area?: string }[];
  people: number;
  peopleWithoutMemory: string[];
  memoriesConsulted: number;
  ruledOutCount: number;
  dayNote?: { day: string; alternativeDay?: string; busyCount: number };
  unknownVenues: boolean;
  /** Set when the request named a cuisine that no place satisfying everyone serves. */
  cuisineMiss?: string;
}

export function publicContext(plan: PlanResult, lang: Lang): PublicPlanContext {
  const c = plan.choice;
  return {
    lang,
    choice: c ? {
      name: c.venue.name,
      area: c.venue.area,
      price: c.venue.price ? formatMoney(c.venue.price, c.venue.currency ?? "VND") : undefined,
      cuisine: c.venue.cuisine,
      // Planner reasons are already tier-aware: discreet likes become "fits someone's taste".
      reasons: c.reasons,
    } : null,
    alternatives: plan.alternatives.map((a) => ({ name: a.venue.name, area: a.venue.area })),
    people: plan.attendees.length,
    peopleWithoutMemory: plan.attendees.filter((a) => a.factCount === 0).map((a) => a.name),
    memoriesConsulted: plan.memoriesConsulted,
    ruledOutCount: plan.ruledOut.length,
    dayNote: plan.dayConflict ? { day: plan.dayConflict.day, alternativeDay: plan.dayConflict.alternativeDay, busyCount: plan.dayConflict.busyMemberIds.length } : undefined,
    unknownVenues: plan.unknownVenues,
    cuisineMiss: plan.request.cuisine && c && !c.venue.cuisine.includes(plan.request.cuisine) ? cuisineLabel(plan.request.cuisine) : undefined,
  };
}

/** Deterministic group reply. Always safe; the LLM version must beat the shield to replace it. */
export function planTemplate(ctx: PublicPlanContext): string {
  const { lang } = ctx;
  if (ctx.unknownVenues) {
    return L(lang,
      "I don't know any places for this group yet. Add one like: `add place: Phở Hòa, pho, ~70k, District 3` — I'll remember it on Walrus and check it against everyone next time.",
      "Mình chưa biết quán nào của nhóm. Thêm quán kiểu: `thêm quán: Phở Hòa, phở, ~70k, Quận 3` — mình sẽ nhớ trên Walrus và kiểm tra với mọi người lần sau.");
  }
  const lines: string[] = [];
  if (ctx.dayNote) {
    const alt = ctx.dayNote.alternativeDay ? dayName(ctx.dayNote.alternativeDay, lang) : null;
    lines.push(L(lang,
      `Heads up: not everyone is free ${dayName(ctx.dayNote.day, lang)}.${alt ? ` ${alt} works for the whole table.` : ""}`,
      `Lưu ý: ${dayName(ctx.dayNote.day, lang)} không phải ai cũng rảnh.${alt ? ` ${alt} thì cả nhóm đều được.` : ""}`));
  }
  if (!ctx.choice) {
    lines.push(L(lang,
      `None of the places I know works for everyone this time (${ctx.ruledOutCount} checked). Add another spot and I'll check it quietly against everyone's notes.`,
      `Lần này không quán nào mình biết hợp với tất cả mọi người (đã xét ${ctx.ruledOutCount} quán). Thêm quán khác nhé, mình sẽ âm thầm kiểm tra với ghi chú của mọi người.`));
    return lines.join("\n");
  }
  const c = ctx.choice;
  const name = `**${c.name}**${[c.area, c.price ? `~${c.price}/${L(lang, "person", "người")}` : null].filter(Boolean).length ? ` (${[c.area, c.price ? `~${c.price}/${L(lang, "person", "người")}` : null].filter(Boolean).join(" · ")})` : ""}`;
  if (ctx.cuisineMiss) {
    lines.push(L(lang, `No ${ctx.cuisineMiss} place I know works for everyone this time.`, `Lần này không có quán ${ctx.cuisineMiss} nào hợp với cả nhóm.`));
  }
  lines.push(L(lang, `How about ${name}?`, `Đi ${name} nhé?`));
  const why = c.reasons.filter((r) => r !== "fits someone's taste").slice(0, 2);
  const tasteNote = c.reasons.includes("fits someone's taste");
  lines.push(L(lang,
    `It works for all ${ctx.people} of you${why.length ? ` — ${why.join(", ")}` : ""}${tasteNote ? (why.length ? ", and it fits someone's taste" : " and fits someone's taste") : ""}.`,
    `Hợp với cả ${ctx.people} người${why.length ? ` — ${why.join(", ")}` : ""}${tasteNote ? ", và hợp khẩu vị của một bạn trong nhóm" : ""}.`));
  if (ctx.alternatives.length) {
    lines.push(L(lang, `Backup: ${ctx.alternatives.map((a) => a.name).join(" or ")}.`, `Dự phòng: ${ctx.alternatives.map((a) => a.name).join(" hoặc ")}.`));
  }
  if (ctx.ruledOutCount) {
    lines.push(L(lang,
      `(${ctx.ruledOutCount} other place${ctx.ruledOutCount > 1 ? "s" : ""} didn't work for everyone — I keep the reasons private.)`,
      `(${ctx.ruledOutCount} quán khác chưa hợp với tất cả — lý do mình giữ kín.)`));
  }
  if (ctx.peopleWithoutMemory.length) {
    lines.push(L(lang,
      `${ctx.peopleWithoutMemory.join(", ")}: I don't know your preferences yet — DM me anything you can't eat and I'll quietly take it into account.`,
      `${ctx.peopleWithoutMemory.join(", ")}: mình chưa biết khẩu vị của bạn — nhắn riêng cho mình món nào không ăn được, mình sẽ âm thầm tính vào.`));
  }
  return lines.join("\n");
}

export interface Polished {
  text: string;
  source: "llm" | "template";
  leakHits: LeakHit[];
  llmMs?: number;
}

/**
 * Optional model polish. The model sees only the public context; its output
 * is shield-scanned, and on any hit, timeout or error the template is used.
 */
export async function polishGroupReply(
  llm: LLM | null, ctx: PublicPlanContext, terms: SensitiveTerm[], budgetMs: number,
): Promise<Polished> {
  const template = planTemplate(ctx);
  const allow = [ctx.choice?.name ?? "", ctx.choice?.area ?? "", ctx.choice?.price ?? "", ...ctx.alternatives.map((a) => `${a.name} ${a.area ?? ""}`)];
  const templateHits = scanForLeaks(template, terms, allow);
  if (!llm || budgetMs <= 0 || !ctx.choice) return { text: template, source: "template", leakHits: templateHits };
  const t0 = performance.now();
  try {
    const out = await Promise.race([
      llm.complete([
        {
          role: "system",
          content: `You are Tact, a warm, brief assistant in a group chat. Write the group message in ${ctx.lang === "vi" ? "Vietnamese" : "English"}, at most 3 short sentences, no emoji spam. Use ONLY the JSON facts given. Never mention allergies, diets, health, budgets, money worries, where anyone lives, or why a place was ruled out — say only that it didn't work for everyone.`,
        },
        { role: "user", content: JSON.stringify(ctx) },
      ], { temperature: 0.4, maxTokens: 160 }),
      new Promise<string>((_, rej) => setTimeout(() => rej(new Error("polish budget exceeded")), budgetMs)),
    ]);
    const text = out.trim();
    // Model drafts are held to the strict scan: even generic words like "allergic" disqualify them.
    const hits = scanForLeaks(text, terms, allow, { strict: true });
    if (!text || hits.length) return { text: template, source: "template", leakHits: hits, llmMs: Math.round(performance.now() - t0) };
    const mentionsChoice = text.toLowerCase().includes(ctx.choice.name.toLowerCase().slice(0, 6));
    return mentionsChoice
      ? { text, source: "llm", leakHits: [], llmMs: Math.round(performance.now() - t0) }
      : { text: template, source: "template", leakHits: [], llmMs: Math.round(performance.now() - t0) };
  } catch {
    return { text: template, source: "template", leakHits: templateHits, llmMs: Math.round(performance.now() - t0) };
  }
}

const TIER_LABEL: Record<Tier, { en: string; vi: string }> = {
  private: { en: "private — only used when you talk to me", vi: "riêng tư — chỉ dùng khi bạn nói chuyện với mình" },
  discreet: { en: "discreet — I'll use it for group plans but never say it", vi: "kín đáo — mình dùng để chọn cho nhóm nhưng không bao giờ nói ra" },
  shared: { en: "shared — fine to mention in the group", vi: "công khai — có thể nhắc trong nhóm" },
};

export function tierLabel(t: Tier, lang: Lang) {
  return TIER_LABEL[t][lang];
}

export function confirmFacts(facts: Fact[], lang: Lang): string {
  if (!facts.length) return "";
  const lines = facts.map((f) => `• ${f.retract ? L(lang, "Removed: ", "Đã gỡ: ") : ""}${f.text} — _${tierLabel(f.tier, lang)}_`);
  return L(lang, `Got it, saved to your memory on Walrus:\n${lines.join("\n")}`, `Đã ghi nhớ trên Walrus:\n${lines.join("\n")}`);
}

export function listFacts(facts: StoredFact[], lang: Lang): string {
  if (!facts.length) return L(lang, "I don't know anything about you yet. Tell me what you can't eat, your budget, or your favourite food.", "Mình chưa biết gì về bạn. Kể mình nghe bạn không ăn được gì, ngân sách, hay món khoái khẩu nhé.");
  const order: Tier[] = ["discreet", "shared", "private"];
  const out: string[] = [L(lang, `Here's everything I remember about you (${facts.length}):`, `Đây là tất cả những gì mình nhớ về bạn (${facts.length}):`)];
  // One running number across tiers, the same order pickFact() resolves "forget 3" against.
  let n = 0;
  order.forEach((tier) => {
    const fs = facts.filter((f) => f.tier === tier);
    if (!fs.length) return;
    out.push(`\n*${tierLabel(tier, lang)}*`);
    fs.forEach((f) => out.push(`${++n}. ${f.text}${f.origin === "pending" ? L(lang, " (still writing to Walrus)", " (đang ghi lên Walrus)") : f.blobId ? ` · \`${f.blobId.slice(0, 8)}\`` : ""}`));
  });
  out.push(L(lang, "\nSay “forget …” to retract one, or “make … shared/discreet/private” to change who it reaches.", "\nNói “quên …” để gỡ, hoặc “đổi … thành công khai/kín đáo/riêng tư” để đổi phạm vi."));
  return out.join("\n");
}

export const T = {
  welcome: (name: string, lang: Lang) => L(lang,
    `Hi ${name}! I'm Tact. I plan things for your group and remember what matters to each person — and I never repeat what you tell me privately.\n\nTo get started, tell me (any order, any words):\n1. Anything you can't or don't eat (allergies, diet)\n2. Your usual budget per meal\n3. The area you live or work in\n4. Food you love, food you'd rather skip\n5. Days you're usually busy\n\nAllergies, diets, budgets and areas stay *discreet* by default: I use them to pick places, but I never say them in the group.`,
    `Chào ${name}! Mình là Tact. Mình lên kế hoạch cho nhóm và nhớ điều quan trọng với từng người — và không bao giờ kể lại những gì bạn nói riêng với mình.\n\nĐể bắt đầu, kể mình nghe (thứ tự nào cũng được):\n1. Món bạn không ăn được (dị ứng, ăn kiêng)\n2. Ngân sách thường cho một bữa\n3. Khu vực bạn ở hoặc làm việc\n4. Món thích, món không thích\n5. Ngày nào bạn hay bận\n\nDị ứng, chế độ ăn, ngân sách và khu vực mặc định là *kín đáo*: mình dùng để chọn quán, nhưng không bao giờ nói ra trong nhóm.`),
  nothingNew: (lang: Lang) => L(lang,
    "I didn't catch anything I should remember there. Try “I'm allergic to peanuts” or “my budget is 100k”.",
    "Mình chưa thấy điều gì cần nhớ. Thử nói “mình dị ứng đậu phộng” hoặc “ngân sách tầm 100k” nhé."),
  refuseAbout: (name: string, lang: Lang) => L(lang,
    `That's ${name}'s to share, not mine. I can tell you what ${name} has said is fine to share in the group.`,
    `Chuyện đó để ${name} tự chia sẻ nhé. Mình chỉ kể những gì ${name} cho phép nói trong nhóm.`),
  whyNot: (lang: Lang) => L(lang,
    "It didn't work for everyone this time. I keep the reasons to myself — if it's about you, DM me and I'll explain.",
    "Lần này quán đó chưa hợp với tất cả. Lý do mình giữ kín — nếu liên quan đến bạn, nhắn riêng mình sẽ giải thích."),
  keepsPrivate: (lang: Lang) => L(lang,
    "People tell me those things privately, and that's where they stay. Ask me for a plan and I'll make sure it works for everyone — without saying who needed what.",
    "Mọi người kể riêng với mình những chuyện đó, và mình giữ kín. Cứ hỏi mình lên kế hoạch, mình sẽ chọn sao cho hợp với tất cả — không nói ai cần gì."),
  availability: (day: string, busy: number, alt: string | null, lang: Lang) => busy
    ? L(lang,
      `Not everyone is free ${day} — I keep who and why to myself.${alt ? ` ${alt} works for the whole table.` : ""}`,
      `${day} không phải ai cũng rảnh — ai và vì sao thì mình giữ kín.${alt ? ` ${alt} thì cả nhóm đều được.` : ""}`)
    : L(lang, `As far as I know, everyone is free ${day}.`, `Theo mình biết thì ${day} mọi người đều rảnh.`),
  help: (lang: Lang) => L(lang,
    "In the group: “where should we eat Friday?”, “add place: name, food, ~price, area”, feedback like “Phở Hòa was great”, “what do you remember about the group?”.\nIn DM: tell me what you can't eat, your budget, your area; “what do you know about me?”; “forget …”; “why did you skip …?”.",
    "Trong nhóm: “thứ 6 ăn gì?”, “thêm quán: tên, món, ~giá, khu vực”, nhận xét kiểu “Phở Hòa ngon”, “nhóm mình nhớ gì?”.\nNhắn riêng: món không ăn được, ngân sách, khu vực; “bạn biết gì về mình?”; “quên …”; “sao không chọn …?”."),
};

export { venueLine };
