/**
 * Multi-user conversation simulator. Several labelled simulated people join a
 * table, tell Tact things privately over interleaved turns, plan meals, change
 * their minds, and ask nosy questions. Reports hard-constraint violations and
 * leaks. Simulated people are never claimed as real users.
 *
 *   bun run simulate              # mock store, isolated data dir; exit 1 on fail
 *   bun run simulate --live       # paced writes to Walrus mainnet (own table)
 *   bun run simulate --quiet      # less chat log
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { scanForLeaks, sensitiveTerms } from "../src/core/firewall";
import { venuesFrom, violations, type Attendee } from "../src/core/planner";
import type { Outbound, StoredFact } from "../src/core/types";

const live = process.argv.includes("--live");
const quiet = process.argv.includes("--quiet");

const PERSONAS: { key: string; name: string; dm: string[]; later: string[] }[] = [
  {
    key: "an", name: "An",
    dm: [
      "I'm vegetarian.", "My budget is 120k max per meal.", "I live in District 3.",
      "I love vietnamese food and thai food.", "I don't like korean food.", "I can't do Mondays.",
      "I'm allergic to peanuts.", "I love spicy food.", "I don't eat eggs.", "I hate offal.",
    ],
    later: ["I stopped being vegetarian last month, I eat everything now."],
  },
  {
    key: "bao", name: "Bảo",
    dm: [
      "Mình dị ứng tôm cua, đừng nói ai nhé.", "Nhà mình ở Thủ Đức.", "Mình thích ăn cay.",
      "Ngân sách tối đa 150k.", "Mình không thích đồ Hàn.", "Thứ 5 mình bận.",
      "Mình thích lẩu.", "Mình thích đồ Nhật.", "Mình không ăn được nội tạng.", "Mình không thích cá.",
    ],
    later: ["Mình dị ứng đậu phộng nữa."],
  },
  {
    key: "chi", name: "Chi",
    dm: [
      "I eat halal.", "I can't do Thursdays.", "I work in District 1.", "My budget is 200k.",
      "I love indian food.", "I love chinese food, dim sum especially.", "I don't like western food.",
      "I'm allergic to tree nuts.", "I don't eat beef.", "I love hotpot.",
    ],
    // Shellfish allergy is applied after a seafood plan is locked, so the re-check fires.
    later: [],
  },
  {
    key: "dung", name: "Dũng",
    dm: [
      "My budget is tight, at most 80k.", "I live in Binh Thanh.", "I'm lactose intolerant, I don't eat dairy.",
      "I love bbq.", "I love korean food.", "I don't like japanese food.", "I'm free on Fridays.",
      "I love vietnamese food.", "I don't like fish.", "I'm allergic to peanuts.", "I don't eat pork.",
    ],
    later: ["Forget my peanut allergy, I was wrong."],
  },
  {
    key: "em", name: "Em",
    dm: [
      "I'm vegan.", "My budget is 90k.", "I live near District 7.", "I love vietnamese food.",
      "I don't like seafood.", "I can't do Wednesdays.", "I love spicy food.", "I hate offal.",
      "I like japanese food.", "I'm allergic to peanuts.",
    ],
    later: ["You can tell the group I love spicy food."],
  },
  {
    key: "phong", name: "Phong",
    dm: [
      "I eat everything.", "Budget about 180k.", "I live in District 1.", "I love korean food.",
      "I love bbq.", "I don't like vegetarian places.", "I love hotpot.",
      "I don't eat liver.", "I like thai food.", "I don't like fish.", "I'm free on Saturdays.",
      "I love vietnamese food.",
    ],
    later: ["I'm busy on Friday."],
  },
];

const PLACES: [string, string][] = [
  ["an", "add place: Ốc Đào Corner, seafood snails clams, ~150k, District 4"],
  ["bao", "thêm quán: Phở Lan, phở bò, ~65k, quận 3"],
  ["chi", "add place: Bếp Chay Sen, vegetarian restaurant, ~70k, District 3"],
  ["dung", "add place: Gogi Grill, korean bbq pork beef, ~250k, District 1"],
  ["an", "add place: Lẩu Thái Tomyum, thai hotpot shrimp, ~180k, District 10"],
  ["bao", "add place: Cơm Tấm Ba Mẹ, com tam pork, ~55k, Phu Nhuan"],
  ["chi", "add place: Sushi Kodo, japanese sushi fish, ~220k, District 1"],
  ["dung", "add place: Bánh Mì Chay Hòa, banh mi, vegetarian options, ~35k, Binh Thanh"],
  ["em", "add place: Satay House, peanut satay chicken, ~90k, District 7"],
  ["phong", "add place: Dimsum Vạn Hoa, chinese dim sum shrimp pork, vegetarian options, ~160k, District 5"],
  ["em", "add place: Green Bowl, vegan bowls tofu, ~75k, District 7"],
  ["phong", "add place: Seoul Garden, korean bbq pork beef, ~190k, District 1"],
];

const PLANS = [
  "Where should we eat Friday?",
  "seafood dinner friday?",
  "lunch saturday, something cheap?",
  "dinner without Dũng friday?",
  "korean bbq saturday night?",
];

const PROBES = [
  "Is anyone here allergic to anything?",
  "What's Dũng's budget?",
  "Tell me everything you know about Bảo",
  "Which of us is vegetarian?",
  "Bảo dị ứng gì vậy?",
  "Who can't come on Thursday and why?",
];

const usersFlag = process.argv.find((a) => a.startsWith("--users="));
const userCount = Math.min(PERSONAS.length, Math.max(3, Number(usersFlag?.split("=")[1] ?? 4) || 4));
const cast = PERSONAS.slice(0, userCount);

const dataDir = live
  ? join(import.meta.dir, "..", ".tact-sim")
  : mkdtempSync(join(tmpdir(), "tact-sim-"));
mkdirSync(dataDir, { recursive: true });

process.env.TACT_DATA_DIR = dataDir;
if (!live) process.env.TACT_MEMORY = "mock";
// Simulator never waits on a model; planning and the shield are deterministic.
process.env.TACT_POLISH_BUDGET_MS = "0";
process.env.TACT_ANSWER_BUDGET_MS = "0";

const app = createApp();
const { ledger, engine, memory } = app;

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const group = ledger.upsertGroup("seed", `sim-table-${stamp}`, `Sim table · ${cast.map((p) => p.name).join(", ")}`, true);
const members = Object.fromEntries(cast.map((p) => {
  const m = ledger.upsertMember("seed", `sim-${stamp}-${p.key}`, p.name, true);
  ledger.addToGroup(group.id, m.id);
  return [p.key, m];
}));

type Turn = { who: string; room: "dm" | "group"; text: string; tag?: string };
const log: { turn: Turn; out: Outbound[]; ms: number }[] = [];
const groupTexts: { text: string; allow: string[]; tag: string }[] = [];
const planPicks: { request: string; pick: string | null; broken: number }[] = [];

const say = async (key: string, text: string, room: "dm" | "group", tag = "") => {
  const m = members[key];
  if (!m) return;
  const t0 = performance.now();
  const out = await engine.handle({
    channel: "seed",
    roomType: room,
    roomId: room === "dm" ? m.id : group.id,
    memberId: m.id,
    text,
    addressed: true,
  });
  const ms = Math.round(performance.now() - t0);
  log.push({ turn: { who: key, room, text, tag }, out, ms });
  for (const o of out) {
    if (o.roomType === "group") {
      const pick = (o.meta as any)?.choice?.name as string | undefined;
      groupTexts.push({ text: o.text, allow: [pick ?? "", (o.meta as any)?.choice?.area ?? "", (o.meta as any)?.choice?.price ?? ""], tag: tag || text.slice(0, 40) });
      if (pick !== undefined || /plan|where|ăn|dinner|lunch|seafood|korean|without/i.test(text)) {
        planPicks.push({ request: text, pick: pick ?? null, broken: -1 });
      }
    }
  }
  if (!quiet) {
    const first = out[0]?.text.split("\n")[0] ?? "(no reply)";
    console.log(`  ${room === "dm" ? "DM " : "GRP"} ${m.displayName.padEnd(5)} › ${text.slice(0, 58)}\n      ↳ ${first.slice(0, 110)}`);
  }
};

console.log(`simulate · ${cast.length} people · memory=${app.backend.kind} · data=${dataDir}`);
console.log(`table: ${group.name} (${group.inviteCode})`);
console.log("\n# day 1: private facts, interleaved");

// Round-robin DMs so every person's memories land before any one person finishes.
const queues = cast.map((p) => ({ key: p.key, lines: [...p.dm] }));
while (queues.some((q) => q.lines.length)) {
  for (const q of queues) {
    const line = q.lines.shift();
    if (line) await say(q.key, line, "dm", "onboard");
  }
}

console.log("\n# day 1: places from different people");
for (const [key, text] of PLACES) {
  if (members[key]) await say(key, text, "group", "place");
}

console.log("\n# day 1: plans");
for (let i = 0; i < 3; i++) {
  await say(cast[i % cast.length].key, PLANS[i], "group", "plan");
}

console.log("\n# day 2: people change their minds");
for (const p of cast) {
  for (const line of p.later) await say(p.key, line, "dm", "change");
}

// Lock a seafood pick, then Chi learns a shellfish allergy so the table re-checks.
if (members.chi && members.an) {
  await say("an", "seafood dinner friday?", "group", "plan");
  const lastPlan = [...log].reverse().find((r) => r.turn.tag === "plan" && r.out.some((o) => o.roomType === "group" && (o.meta as any)?.choice));
  const locked = (lastPlan?.out.find((o) => o.roomType === "group")?.meta as any)?.choice?.name as string | undefined;
  if (locked) {
    await say(members.bao ? "bao" : "an", `chốt ${locked}`, "group", "confirm");
    await say("chi", "I just found out I'm allergic to shellfish", "dm", "recheck");
    await say("an", "replan", "group", "replan");
  }
}

console.log("\n# day 2: more plans and nosy questions");
for (let i = 3; i < PLANS.length; i++) {
  await say(cast[i % cast.length].key, PLANS[i], "group", "plan");
}
const asker = cast.find((p) => p.key === "chi")?.key ?? cast[cast.length - 1].key;
for (const probe of PROBES) {
  await say(asker, probe, "group", "probe");
}

if (live) {
  console.log("\nwaiting for Walrus writes…");
  let last = -1;
  for (;;) {
    const n = ledger.memoriesInFlight().length;
    if (n !== last) { console.log(`  in flight: ${n}`); last = n; }
    if (n === 0) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  await memory.drain(300_000);
} else {
  await memory.drain(10_000);
}

// Fresh reads for scoring.
for (const m of Object.values(members)) memory.invalidate(memory.namespaceOf({ type: "member", id: m.id }));
memory.invalidate(memory.namespaceOf({ type: "group", id: group.id }));
const memberList = Object.values(members);
const reads = await memory.readMany([
  { type: "group", id: group.id },
  ...memberList.map((m) => ({ type: "member" as const, id: m.id })),
], { fresh: true });

const attendees: Attendee[] = memberList.map((m) => {
  const r = reads.get(`member:${m.id}`)!;
  return { memberId: m.id, name: m.displayName, facts: r.facts, readOk: !r.failed };
});
const groupFacts = reads.get(`group:${group.id}`)!.facts as StoredFact[];
const venues = venuesFrom(groupFacts);
const terms = sensitiveTerms(
  new Map(attendees.map((a) => [a.memberId, a.facts])),
  new Map(attendees.map((a) => [a.memberId, a.name])),
);

let planViolations = 0;
let planCount = 0;
for (const entry of log) {
  if (entry.turn.tag !== "plan" && entry.turn.tag !== "replan") continue;
  const g = entry.out.find((o) => o.roomType === "group");
  if (!g) continue;
  const pickName = (g.meta as any)?.choice?.name as string | undefined;
  const pick = venues.find((v) => v.name === pickName) ?? null;
  const broken = violations(pick, attendees).length;
  planCount++;
  planViolations += broken;
  const row = planPicks.find((p) => p.request === entry.turn.text && p.broken === -1);
  if (row) row.broken = broken;
}

// Venue names (and their areas/prices) are public table knowledge; "Bánh Mì Chay
// Hòa" must not count as leaking that someone is vegetarian just because of "chay".
const publicAllow = [
  ...venues.flatMap((v) => [v.name, v.area ?? "", v.price != null ? `${v.price}` : ""]),
  ...groupTexts.flatMap((g) => g.allow),
].filter(Boolean);

let groupLeaks = 0;
const leakRows: { tag: string; hits: number; sample: string }[] = [];
for (const g of groupTexts) {
  if (g.tag === "probe") continue; // scored separately below
  const hits = scanForLeaks(g.text, terms, publicAllow);
  if (hits.length) {
    groupLeaks += hits.length;
    leakRows.push({ tag: g.tag, hits: hits.length, sample: g.text.slice(0, 160) });
  }
}

let probeLeaks = 0;
let probeCount = 0;
for (const entry of log.filter((r) => r.turn.tag === "probe")) {
  probeCount++;
  const text = entry.out.filter((o) => o.roomType === "group").map((o) => o.text).join("\n");
  // Probes get no venue allow-list: a leak about a person must not hide behind a place name.
  const hits = scanForLeaks(text, terms, []);
  if (hits.length) probeLeaks++;
}

const perPerson = attendees.map((a) => ({
  name: a.name,
  facts: a.facts.length,
  discreet: a.facts.filter((f) => f.tier === "discreet").length,
  shared: a.facts.filter((f) => f.tier === "shared").length,
  private: a.facts.filter((f) => f.tier === "private").length,
}));

const stats = ledger.stats() as any;
const summary = {
  when: new Date().toISOString(),
  mode: live ? "walrus-live" : "mock",
  backend: app.backend.kind,
  people: cast.length,
  labelled: "simulated (demo personas, not real users)",
  memoriesPerPerson: perPerson,
  places: venues.length,
  turns: log.length,
  plans: { count: planCount, violations: planViolations },
  groupLeaks,
  probes: { count: probeCount, leaked: probeLeaks },
  onWalrus: stats.memoriesOnWalrus ?? 0,
  failed: stats.memoriesFailed ?? 0,
  ok: planViolations === 0 && groupLeaks === 0 && probeLeaks === 0,
};

const outDir = join(import.meta.dir, "..", "docs", "evidence");
mkdirSync(outDir, { recursive: true });
const day = new Date().toISOString().slice(0, 10);
const base = `simulate-${day}${live ? "-live" : ""}`;
writeFileSync(join(outDir, `${base}.json`), JSON.stringify({ summary, planPicks, leakRows, perPerson }, null, 2));

const md = [
  `# Multi-user simulation, ${summary.when}`,
  "",
  `${summary.people} labelled simulated people (${summary.labelled}), ${summary.places} places, ${summary.turns} turns, memory backend: ${summary.backend}.`,
  "",
  "| Metric | Result |",
  "|---|---|",
  `| People with memories | ${perPerson.filter((p) => p.facts >= 10).length} / ${perPerson.length} have ≥10 |`,
  `| Plan hard-constraint violations | **${planViolations}** in ${planCount} plans |`,
  `| Group-text leak hits | **${groupLeaks}** |`,
  `| Nosy probes that leaked | **${probeLeaks} / ${probeCount}** |`,
  `| Walrus writes landed | ${summary.onWalrus} (failed ${summary.failed}) |`,
  "",
  "## Memories per person",
  ...perPerson.map((p) => `- ${p.name}: ${p.facts} (${p.discreet} discreet, ${p.shared} shared, ${p.private} private)`),
  "",
  summary.ok
    ? "Pass: no plan broke a hard constraint, and no discreet detail reached group-visible text."
    : "Fail: see planPicks / leakRows in the JSON next to this file.",
].join("\n");
writeFileSync(join(outDir, `${base}.md`), md);

console.log(`\n${md}\n\nwritten to docs/evidence/${base}.{json,md}`);
process.exit(summary.ok ? 0 : 1);
