import { describe, expect, test, beforeEach } from "bun:test";
import { Engine } from "../src/core/engine";
import { MemoryService } from "../src/memory/service";
import { MockBackend } from "../src/memory/backend";
import { Ledger } from "../src/memory/ledger";
import { ScriptedLLM } from "../src/llm/provider";
import { fold } from "../src/core/lexicon";

/** A model that tries its hardest to leak: it names everyone's allergies and budgets in every group reply. */
const leakyLLM = () => new ScriptedLLM((messages) => {
  const user = messages[messages.length - 1].content;
  return `Going to ${/"name":"([^"]+)"/.exec(user)?.[1] ?? "somewhere"} — skipped Ốc Đào because Bảo is allergic to shrimp and An is vegetarian with a 120k budget.`;
});

function setup(llm = leakyLLM()) {
  const ledger = new Ledger(":memory:");
  const backend = new MockBackend();
  const memory = new MemoryService(backend, ledger, { namespaceSecret: "test", prefix: "tact-test", pollMs: 5 });
  const engine = new Engine(memory, ledger, llm, { polishBudgetMs: 2000, answerBudgetMs: 0 });
  const group = ledger.upsertGroup("web", "g1", "Friday Table");
  const an = ledger.upsertMember("web", "an", "An");
  const bao = ledger.upsertMember("web", "bao", "Bảo");
  const chi = ledger.upsertMember("web", "chi", "Chi");
  for (const m of [an, bao, chi]) ledger.addToGroup(group.id, m.id);
  const say = (memberId: string, text: string, room: "group" | "dm" = "group") =>
    engine.handle({ channel: "web", roomType: room, roomId: room === "group" ? group.id : memberId, memberId, text });
  return { ledger, backend, memory, engine, group, an, bao, chi, say };
}

async function seed(s: ReturnType<typeof setup>) {
  await s.say(s.an.id, "I'm vegetarian. My budget is 120k max.", "dm");
  await s.say(s.bao.id, "Mình dị ứng tôm cua. Nhà mình ở Thủ Đức.", "dm");
  await s.say(s.chi.id, "I can't do Thursdays and I love vietnamese food", "dm");
  await s.say(s.an.id, "add place: Ốc Đào, seafood snails, ~150k, District 4");
  await s.say(s.bao.id, "thêm quán: Phở Hòa, phở bò, có món chay, ~70k, quận 3");
  await s.say(s.chi.id, "add place: Gogi House, korean bbq pork beef, ~250k, District 1");
  await s.memory.drain(5000);
}

const SENSITIVE = ["allerg", "di ung", "shrimp", "tom", "vegetarian", "an chay", "120k", "budget", "ngan sach", "thu duc"];

describe("engine", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => { s = setup(); });

  test("DM facts are written to the member's own namespace and listed back", async () => {
    const out = await s.say(s.bao.id, "Mình dị ứng tôm cua, tối đa 80k thôi", "dm");
    expect(out[0].text).toContain("Walrus");
    await s.memory.drain(5000);
    const list = await s.say(s.bao.id, "bạn biết gì về mình?", "dm");
    expect(list[0].text).toContain("shellfish");
    const ns = s.memory.namespaceOf({ type: "member", id: s.bao.id });
    expect(ns.startsWith("tact-test:m:")).toBe(true);
    expect(ns).not.toContain(s.bao.id);
    expect(s.backend.dump(ns).length).toBeGreaterThanOrEqual(2);
  });

  test("group plan honours discreet constraints and leaks none of them, even with a leaky model", async () => {
    await seed(s);
    const out = await s.say(s.chi.id, "Where should we eat Friday?");
    const groupMsg = out.find((o) => o.roomType === "group")!;
    expect(groupMsg.text).toContain("Phở Hòa");
    const folded = fold(groupMsg.text);
    for (const w of SENSITIVE) expect(folded.includes(w)).toBe(false);
    expect(groupMsg.meta?.composer).toBe("template");
    expect(Number(groupMsg.meta?.leakBlocked)).toBeGreaterThan(0);
    // Owners get a private note about their own vetoes, nobody else's.
    const dms = out.filter((o) => o.roomType === "dm");
    const baoNote = dms.find((d) => d.roomId === s.bao.id)!;
    expect(baoNote.text).toContain("allergic");
    expect(dms.find((d) => d.roomId === s.chi.id)).toBeUndefined();
    for (const d of dms) {
      if (d.roomId !== s.bao.id) expect(fold(d.text)).not.toContain("allergic");
    }
  });

  test("asking about someone in the group returns only what they shared", async () => {
    await seed(s);
    const out = await s.say(s.chi.id, "What is Bảo allergic to?");
    expect(fold(out[0].text)).not.toContain("shellfish");
    expect(out[0].text).toContain("Bảo");
    await s.say(s.bao.id, "you can tell the group I love spicy food", "dm");
    await s.memory.drain(5000);
    s.memory.invalidate(s.memory.namespaceOf({ type: "member", id: s.bao.id }));
    const again = await s.say(s.chi.id, "What does Bảo like?");
    expect(again[0].text).toContain("spicy");
    expect(fold(again[0].text)).not.toContain("shellfish");
  });

  test("the owner can ask why, and gets their own reasons with memory ids", async () => {
    await seed(s);
    await s.say(s.chi.id, "dinner friday?");
    const why = await s.say(s.bao.id, "why did you skip Ốc Đào?", "dm");
    expect(why[0].text).toContain("allergic");
    const chiWhy = await s.say(s.chi.id, "why did you skip Ốc Đào?", "dm");
    expect(fold(chiWhy[0].text)).not.toContain("allergic");
  });

  test("forget retracts a fact and the next plan stops using it", async () => {
    await seed(s);
    await s.say(s.bao.id, "forget shellfish", "dm");
    await s.memory.drain(5000);
    s.memory.invalidate(s.memory.namespaceOf({ type: "member", id: s.bao.id }));
    const list = await s.say(s.bao.id, "what do you know about me", "dm");
    expect(fold(list[0].text)).not.toContain("allergic to shellfish");
  });

  test("memory off: the bot has to ask, and its pick breaks a constraint", async () => {
    await seed(s);
    s.engine.setMode(s.group.id, "off");
    // A memory-less bot takes the request at face value: seafood means Ốc Đào.
    const out = await s.say(s.chi.id, "seafood dinner friday?");
    expect(out[0].meta?.mode).toBe("off");
    expect(Number(out[0].meta?.violations)).toBeGreaterThan(0);
    expect(out[0].text).toContain("allergies");
  });

  test("availability: the busy person is not named in the group", async () => {
    await seed(s);
    const out = await s.say(s.an.id, "dinner thursday?");
    const g = out.find((o) => o.roomType === "group")!;
    expect(g.text).toMatch(/not everyone is free Thursday/);
    expect(g.text).not.toContain("Chi");
  });

  test("a fresh server rebuilds everything from Walrus alone", async () => {
    await seed(s);
    // New ledger (empty database), same backend: the "wipe the server" test.
    const ledger2 = new Ledger(":memory:");
    const memory2 = new MemoryService(s.backend, ledger2, { namespaceSecret: "test", prefix: "tact-test" });
    const facts = await memory2.readFacts({ type: "member", id: s.bao.id });
    expect(facts.facts.map((f) => f.key)).toContain("allergy:shellfish");
    expect(facts.facts.every((f) => f.origin === "walrus" && f.blobId)).toBe(true);
  });

  test("two people with the same allergy both get their own blob (no idempotency collision)", async () => {
    await s.say(s.an.id, "I'm allergic to peanuts", "dm");
    await s.say(s.chi.id, "I'm allergic to peanuts", "dm");
    await s.memory.drain(5000);
    const rows = [...s.ledger.memoriesOf("member", s.an.id), ...s.ledger.memoriesOf("member", s.chi.id)];
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.status === "done" && r.blob_id)).toBe(true);
  });

  test("when Walrus can't be read, Tact says so instead of planning blind", async () => {
    await seed(s);
    const ledger = s.ledger;
    const failing = new MemoryService(new MockBackend({ failRecall: true }), ledger, { namespaceSecret: "test", prefix: "tact-test" });
    const blind = new Engine(failing, ledger, null, { polishBudgetMs: 0, answerBudgetMs: 0 });
    const out = await blind.handle({ channel: "web", roomType: "group", roomId: s.group.id, memberId: s.chi.id, text: "where should we eat friday?" });
    expect(out[0].text).toMatch(/won't guess/);
    expect(out[0].text).not.toMatch(/works for/i);
  });
});
