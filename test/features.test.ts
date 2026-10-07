import { beforeEach, describe, expect, test } from "bun:test";
import { Engine, pickAttendees } from "../src/core/engine";
import { MemoryService } from "../src/memory/service";
import { MockBackend } from "../src/memory/backend";
import { Ledger } from "../src/memory/ledger";
import { fold } from "../src/core/lexicon";

function setup() {
  const ledger = new Ledger(":memory:");
  const backend = new MockBackend();
  const memory = new MemoryService(backend, ledger, { namespaceSecret: "t", prefix: "f", pollMs: 5 });
  const engine = new Engine(memory, ledger, null, { polishBudgetMs: 0, answerBudgetMs: 0 });
  const group = ledger.upsertGroup("web", "g", "Lunch crew");
  const an = ledger.upsertMember("web", "an", "An");
  const bao = ledger.upsertMember("web", "bao", "Bảo");
  const chi = ledger.upsertMember("web", "chi", "Chi");
  const dung = ledger.upsertMember("web", "dung", "Dũng");
  for (const m of [an, bao, chi, dung]) ledger.addToGroup(group.id, m.id);
  const say = (memberId: string, text: string, room: "group" | "dm" = "group") =>
    engine.handle({ channel: "web", roomType: room, roomId: room === "group" ? group.id : memberId, memberId, text });
  return { ledger, backend, memory, engine, group, an, bao, chi, dung, say };
}

async function places(s: ReturnType<typeof setup>) {
  await s.say(s.an.id, "add place: Ốc Đào, seafood snails, ~150k, District 4");
  await s.say(s.an.id, "add place: Phở Lan, pho beef, vegetarian options, ~65k, District 3");
  await s.say(s.an.id, "add place: Bếp Chay Sen, vegetarian restaurant, ~70k, District 3");
  await s.say(s.an.id, "add place: Gogi Grill, korean bbq pork beef, ~250k, District 1");
  await s.memory.drain(5000);
}

describe("import from another assistant", () => {
  test("keeps only food, budget, area and availability facts, as discreet", async () => {
    const s = setup();
    const paste = [
      "Here is what I remember about you:",
      "- Works as a product manager at a fintech startup",
      "- Is allergic to peanuts",
      "- Has a daughter named Mai",
      "- Is vegetarian",
      "- Usually keeps meals under 100k",
      "- Lives in District 7",
    ].join("\n");
    const out = await s.say(s.an.id, paste, "dm");
    expect(out[0].text).toMatch(/Imported 4 facts/);
    await s.memory.drain(5000);
    const r = await s.memory.readFacts({ type: "member", id: s.an.id }, { fresh: true });
    expect(r.facts.map((f) => f.key).sort()).toEqual(["allergy:peanut", "area", "budget", "diet"]);
    expect(r.facts.every((f) => f.tier === "discreet")).toBe(true);
    expect(JSON.stringify(r.facts)).not.toContain("fintech");
    expect(JSON.stringify(r.facts)).not.toContain("Mai");
  });
});

describe("plans for part of the table", () => {
  test("pickAttendees: with / without / for", () => {
    const s = setup();
    const members = s.ledger.groupMembers(s.group.id);
    const names = (ids: Set<string>) => members.filter((m) => ids.has(m.id)).map((m) => m.displayName).sort();
    expect(names(pickAttendees("dinner with Bảo and Chi friday?", members, s.an).ids)).toEqual(["An", "Bảo", "Chi"]);
    expect(names(pickAttendees("dinner friday without Dũng", members, s.an).ids)).toEqual(["An", "Bảo", "Chi"]);
    expect(names(pickAttendees("thứ 6 ăn gì, trừ Dũng nhé", members, s.an).ids)).toEqual(["An", "Bảo", "Chi"]);
    expect(names(pickAttendees("where should we eat friday?", members, s.an).ids)).toEqual(["An", "Bảo", "Chi", "Dũng"]);
  });

  test("an absent person's constraint doesn't veto, and their secret is still protected", async () => {
    const s = setup();
    await s.say(s.dung.id, "I'm allergic to shrimp and crab", "dm");
    await places(s);
    const all = await s.say(s.an.id, "seafood dinner friday?");
    expect(all[0].text).not.toContain("Ốc Đào**");
    const without = await s.say(s.an.id, "seafood dinner friday without Dũng?");
    expect(without[0].text).toContain("Ốc Đào");
    expect(without[0].text).toMatch(/you, Bảo and Chi/);
    expect(fold(without[0].text)).not.toContain("allerg");
    expect(fold(without[0].text)).not.toContain("shrimp");
  });
});

describe("decisions live on Walrus", () => {
  test("confirming writes an event to the table namespace and the next plan prefers something else", async () => {
    const s = setup();
    await places(s);
    const first = await s.say(s.an.id, "lunch friday?");
    const firstPick = (first[0].meta as any).choice.name;
    const lock = await s.say(s.bao.id, `chốt ${firstPick}`);
    expect(lock[0].text).toMatch(/Chốt|Locked in/);
    await s.memory.drain(5000);
    const g = await s.memory.readFacts({ type: "group", id: s.group.id }, { fresh: true });
    const events = g.facts.filter((f) => f.kind === "event");
    expect(events.length).toBe(1);
    expect(events[0].origin).toBe("walrus");
    const second = await s.say(s.an.id, "lunch saturday?");
    expect((second[0].meta as any).choice.name).not.toBe(firstPick);
  });
});

describe("memory that changes changes decisions", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(async () => {
    s = setup();
    await places(s);
  });

  test("a new allergy re-checks the locked-in place: the table hears it no longer fits, only the owner hears why", async () => {
    await s.say(s.an.id, "seafood dinner friday?");
    await s.say(s.an.id, "chốt Ốc Đào");
    await s.memory.drain(5000);
    const out = await s.say(s.chi.id, "I just found out I'm allergic to shellfish", "dm");
    const toGroup = out.find((o) => o.roomType === "group")!;
    const toChi = out.filter((o) => o.roomType === "dm" && o.roomId === s.chi.id);
    expect(toGroup.text).toMatch(/no longer works for everyone/);
    expect(fold(toGroup.text)).not.toContain("allerg");
    expect(fold(toGroup.text)).not.toContain("chi");
    expect(toChi.some((o) => /allergic/.test(o.text))).toBe(true);
    const replan = await s.say(s.an.id, "replan");
    expect((replan[0].meta as any).choice.name).not.toBe("Ốc Đào");
  });

  test("an unrelated fact does not trigger a re-check", async () => {
    await s.say(s.an.id, "lunch friday?");
    await s.say(s.an.id, "chốt Phở Lan");
    await s.memory.drain(5000);
    const out = await s.say(s.chi.id, "I love Thai food", "dm");
    expect(out.some((o) => o.roomType === "group")).toBe(false);
  });
});

describe("plan receipts", () => {
  test("private memories are counted as not consulted", async () => {
    const s = setup();
    await s.say(s.bao.id, "I'm allergic to peanuts, don't use this", "dm");
    await places(s);
    const out = await s.say(s.an.id, "dinner friday?");
    expect((out[0].meta as any).privateSkipped).toBe(1);
  });
});
