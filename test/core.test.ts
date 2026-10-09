import { describe, expect, test } from "bun:test";
import { decodeFact, encodeFact, resolveFacts } from "../src/memory/codec";
import { extractByRules, extractVenue, extractVerdict } from "../src/core/extract";
import { foodGroupsIn, weekdaysIn, moneyIn, isVietnamese, areaIn } from "../src/core/lexicon";
import { plan, parsePlanRequest, planWithoutMemory, violations, type Attendee } from "../src/core/planner";
import { scanForLeaks, sensitiveTerms } from "../src/core/firewall";
import type { Fact, StoredFact } from "../src/core/types";

const at = (i: number) => new Date(Date.UTC(2026, 9, 7, 0, i)).toISOString();
const stored = (f: Fact, blob = "b"): StoredFact => ({ ...f, origin: "walrus", blobId: `${blob}-${f.key}` });

describe("codec", () => {
  test("round-trips a fact with attrs, quote and tier", () => {
    const f: Fact = { kind: "allergy", tier: "discreet", key: "allergy:shellfish", text: "Allergic to shellfish. Must avoid it.", attrs: { avoid: "shellfish" }, quote: "mình dị ứng tôm | cua", source: "dm", at: at(1) };
    const d = decodeFact(encodeFact(f))!;
    expect(d.kind).toBe("allergy");
    expect(d.tier).toBe("discreet");
    expect(d.attrs.avoid).toBe("shellfish");
    expect(d.text).toBe(f.text);
    expect(d.quote).toBe("mình dị ứng tôm   cua");
    expect(d.at).toBe(f.at);
  });

  test("ignores memories other tools wrote", () => {
    expect(decodeFact("User prefers dark mode.")).toBeNull();
  });

  test("newest per key wins and a retraction removes the key", () => {
    const base = { tier: "discreet" as const, attrs: {}, source: "dm" as const };
    const facts: Fact[] = [
      { ...base, kind: "diet", key: "diet", text: "Vegetarian", attrs: { diet: "vegetarian" }, at: at(1) },
      { ...base, kind: "diet", key: "diet", text: "Eats everything now", attrs: { diet: "omnivore" }, at: at(5) },
      { ...base, kind: "allergy", key: "allergy:peanut", text: "Allergic to peanut", attrs: { avoid: "peanut" }, at: at(2) },
      { ...base, kind: "allergy", key: "allergy:peanut", text: "Retracted", attrs: { avoid: "peanut" }, retract: true, at: at(6) },
    ];
    const r = resolveFacts(facts.reverse());
    expect(r.map((f) => f.text)).toEqual(["Eats everything now"]);
  });
});

describe("lexicon", () => {
  test("maps Vietnamese and English food words to groups", () => {
    expect(foodGroupsIn("mình dị ứng tôm cua")).toContain("shellfish");
    expect(foodGroupsIn("allergic to peanuts")).toEqual(["peanut"]);
    expect(foodGroupsIn("hải sản")).toEqual(expect.arrayContaining(["shellfish", "fish"]));
  });
  test("weekdays: Vietnamese numbered days, no false 'thu' in Vietnamese prose", () => {
    expect(weekdaysIn("thứ 5 mình bận")).toEqual(["thu"]);
    expect(weekdaysIn("I can't do Thursdays")).toEqual(["thu"]);
    expect(weekdaysIn("mùa thu Hà Nội đẹp")).toEqual([]);
  });
  test("money and areas", () => {
    expect(moneyIn("tầm 80k thôi")).toEqual({ amount: 80000, currency: "VND" });
    expect(moneyIn("under $15")).toEqual({ amount: 15, currency: "USD" });
    expect(areaIn("nhà mình ở Thủ Đức")).toBe("Thu Duc");
    expect(areaIn("I work in District 7")).toBe("District 7");
    expect(isVietnamese("Thứ 6 ăn gì?")).toBe(true);
    expect(isVietnamese("Where should we eat Friday?")).toBe(false);
  });
});

describe("extraction", () => {
  test("Vietnamese DM: allergy, budget and area become discreet facts", () => {
    const facts = extractByRules("Mình dị ứng tôm cua, tháng này tiết kiệm nên tối đa 80k thôi. Nhà mình ở Thủ Đức.", "dm");
    const keys = facts.map((f) => f.key);
    expect(keys).toContain("allergy:shellfish");
    expect(keys).toContain("budget");
    expect(keys).toContain("area");
    expect(facts.every((f) => f.tier === "discreet")).toBe(true);
  });
  test("English: diet, likes, availability", () => {
    const facts = extractByRules("I'm vegetarian, I love spicy food and Thai, and I can't do Thursdays.", "dm");
    const byKey = Object.fromEntries(facts.map((f) => [f.key, f]));
    expect(byKey.diet.attrs.diet).toBe("vegetarian");
    expect(byKey["like:spicy"].tier).toBe("shared");
    expect(byKey["like:thai"]).toBeDefined();
    expect(byKey.availability.attrs.busy).toBe("thu");
  });
  test("said in the group means shared", () => {
    const facts = extractByRules("btw I'm allergic to peanuts", "group");
    expect(facts[0].tier).toBe("shared");
  });
  test("privacy cues override the default tier", () => {
    expect(extractByRules("I'm vegan but you can tell the group", "dm")[0].tier).toBe("shared");
    expect(extractByRules("I'm allergic to peanuts, don't use this", "dm")[0].tier).toBe("private");
  });
  test("questions never become facts", () => {
    expect(extractByRules("Which of us is vegetarian?", "group")).toEqual([]);
    expect(extractByRules("Is anyone allergic to peanuts", "group")).toEqual([]);
    expect(extractByRules("Bảo có ăn chay không?", "group")).toEqual([]);
    expect(extractByRules("I'm vegetarian", "group").length).toBe(1);
  });
  test("diet changes are read as changes, not as the old diet", () => {
    expect(extractByRules("I'm no longer vegetarian", "dm")[0].attrs.diet).toBe("omnivore");
    expect(extractByRules("Mình không còn ăn chay nữa", "dm")[0].attrs.diet).toBe("omnivore");
    expect(extractByRules("I stopped being vegan last month", "dm")[0].attrs.diet).toBe("omnivore");
    expect(extractByRules("I'm vegetarian now", "dm")[0].attrs.diet).toBe("vegetarian");
  });
  test("retraction", () => {
    const f = extractByRules("I'm no longer allergic to peanuts", "dm")[0];
    expect(f.key).toBe("allergy:peanut");
    expect(f.retract).toBe(true);
  });
  test("venues and verdicts", () => {
    const v = extractVenue("add place: Ốc Đào, seafood snails, ~150k, District 4", "An")!;
    expect(v.attrs.name).toBe("Ốc Đào");
    expect(v.attrs.tags).toContain("shellfish");
    expect(v.attrs.price).toBe("150000");
    expect(v.attrs.area).toBe("District 4");
    const vi = extractVenue("thêm quán: Phở Hòa, phở bò, có món chay, ~70k, quận 3", "Bảo")!;
    expect(vi.attrs.veg).toBe("1");
    expect(vi.attrs.area).toBe("District 3");
    const verdict = extractVerdict("Phở Hòa hôm qua hơi mặn", [{ slug: "pho-hoa", name: "Phở Hòa" }], "Chi")!;
    expect(verdict.attrs.rating).toBe("-1");
    expect(extractVerdict("Phở Hòa was great, do recommend", [{ slug: "pho-hoa", name: "Phở Hòa" }], "Chi")!.attrs.rating).toBe("1");
  });
});

function table() {
  const v = (s: string) => stored(extractVenue(s, "seed")!);
  const groupFacts = [
    v("add place: Ốc Đào, seafood snails, ~150k, District 4"),
    v("add place: Phở Hòa, pho beef, has vegetarian options, ~70k, District 3"),
    v("add place: Gogi House, korean bbq pork beef, ~250k, District 1"),
    v("add place: Cơm Chay Âu Lạc, vegetarian restaurant, ~60k, District 3"),
  ];
  const person = (id: string, name: string, text: string): Attendee => ({
    memberId: id, name, readOk: true, facts: extractByRules(text, "dm").map((f) => stored(f, id)),
  });
  const attendees = [
    person("an", "An", "I'm vegetarian. My budget is 120k max."),
    person("bao", "Bảo", "Mình dị ứng tôm cua. Mình thích ăn cay."),
    person("chi", "Chi", "I can't do Thursdays. I love vietnamese food."),
  ];
  return { groupFacts, attendees };
}

describe("planner", () => {
  test("vetoes from discreet memories pick a place that works for everyone", () => {
    const { groupFacts, attendees } = table();
    const r = plan(parsePlanRequest("where should we eat friday?"), attendees, groupFacts);
    expect(r.choice).not.toBeNull();
    expect(["Phở Hòa", "Cơm Chay Âu Lạc"]).toContain(r.choice!.venue.name);
    const ruled = r.ruledOut.map((x) => x.venue.name);
    expect(ruled).toContain("Ốc Đào"); // shellfish (Bảo) and vegetarian (An)
    expect(ruled).toContain("Gogi House"); // vegetarian (An) and budget (An)
    const vetoKinds = r.influences.filter((i) => i.effect === "vetoed").map((i) => i.kind);
    expect(vetoKinds).toEqual(expect.arrayContaining(["allergy", "diet", "budget"]));
  });

  test("without memory the same request lands on a place that breaks constraints", () => {
    const { groupFacts, attendees } = table();
    const v = planWithoutMemory(parsePlanRequest("dinner?"), groupFacts);
    expect(violations(v, attendees).length).toBeGreaterThan(0);
  });

  test("availability excuses busy people and proposes a day that works", () => {
    const { groupFacts, attendees } = table();
    const r = plan(parsePlanRequest("dinner thursday?"), attendees, groupFacts);
    expect(r.dayConflict?.busyMemberIds).toEqual(["chi"]);
    expect(r.dayConflict?.alternativeDay).toBe("fri");
  });

  test("private facts never influence a group plan", () => {
    const { groupFacts } = table();
    const f = extractByRules("I'm allergic to peanuts, don't use this", "dm").map((x) => stored(x, "d"));
    const r = plan(parsePlanRequest("dinner?"), [{ memberId: "d", name: "Dũng", readOk: true, facts: f }],
      [stored(extractVenue("add place: Satay Corner, peanut satay, ~90k", "seed")!)]);
    expect(r.choice?.venue.name).toBe("Satay Corner");
  });
});

describe("firewall", () => {
  test("flags discreet terms in outgoing text but allows the chosen venue's own words", () => {
    const { attendees } = table();
    const terms = sensitiveTerms(new Map(attendees.map((a) => [a.memberId, a.facts])));
    expect(scanForLeaks("We skipped Ốc Đào because Bảo is allergic to shrimp", terms).length).toBeGreaterThan(0);
    expect(scanForLeaks("An is vegetarian so let's go to Phở Hòa", terms).length).toBeGreaterThan(0);
    expect(scanForLeaks("How about Phở Hòa (District 3, ~70k/person)?", terms, ["Phở Hòa", "District 3", "70k"]).length).toBe(0);
  });
  test("shared facts are not sensitive", () => {
    const terms = sensitiveTerms(new Map([["x", extractByRules("I love spicy food", "dm").map((f) => stored(f))]]));
    expect(scanForLeaks("Minh loves spicy food", terms)).toEqual([]);
  });
  test("folded Vietnamese function words are not shellfish leaks", () => {
    const terms = sensitiveTerms(new Map([["bao", extractByRules("Mình dị ứng tôm cua", "dm").map((f) => stored(f))]]));
    // "của" → "cua", "nghe" sits next to "ghe"; neither must trip the shield.
    expect(scanForLeaks("Mình ghi vào trí nhớ của nhóm. Kể mình nghe quán thế nào.", terms)).toEqual([]);
    expect(scanForLeaks("Bảo can't eat shrimp or crab", terms).length).toBeGreaterThan(0);
  });
});
