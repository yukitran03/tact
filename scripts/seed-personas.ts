/**
 * Seeds the demo table through the real engine: four clearly labelled demo
 * personas tell Tact things privately, the table adds places, and Tact plans.
 * With Walrus credentials every fact becomes a real blob on mainnet.
 *
 *   bun run seed            # personas + places + two plans
 *   bun run seed --no-plan  # memories only
 */
import { createApp } from "../src/app";

const app = createApp();
const { ledger, engine, memory } = app;

const PERSONAS: { key: string; name: string; dm: string[] }[] = [
  {
    key: "an", name: "An",
    dm: [
      "I'm vegetarian.", "My budget is 120k max per meal.", "I live in District 3.",
      "I love vietnamese food and thai food.", "I don't like korean food.", "I can't do Mondays.",
      "I'm allergic to peanuts.", "I love spicy food.", "I don't eat eggs.", "I hate offal.", "I like japanese food.",
    ],
  },
  {
    key: "bao", name: "Bảo",
    dm: [
      "Mình dị ứng tôm cua, đừng nói ai nhé.", "Nhà mình ở Thủ Đức.", "Mình thích ăn cay.", "Ngân sách tối đa 150k.",
      "Mình không thích đồ Hàn.", "Thứ 5 mình bận.", "Mình thích lẩu.", "Mình thích đồ Nhật.",
      "Mình không ăn được nội tạng.", "Mình không thích cá.", "Mình thích đồ Thái.",
    ],
  },
  {
    key: "chi", name: "Chi",
    dm: [
      "I eat halal.", "I can't do Thursdays.", "I work in District 1.", "My budget is 200k.",
      "I love indian food.", "I love chinese food, dim sum especially.", "I don't like western food.",
      "I'm allergic to tree nuts.", "I don't eat beef.", "I love hotpot.", "I don't like spicy food.",
    ],
  },
  {
    key: "dung", name: "Dũng",
    dm: [
      "My budget is tight, at most 80k.", "I live in Binh Thanh.", "I'm lactose intolerant, I don't eat dairy.",
      "I love bbq.", "I love korean food.", "I don't like japanese food.", "I'm free on Fridays.",
      "I love vietnamese food.", "I don't like fish.", "I'm allergic to peanuts.", "I don't eat pork.",
    ],
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
  ["an", "add place: Satay House, peanut satay chicken, ~90k, District 7"],
  ["chi", "add place: Dimsum Vạn Hoa, chinese dim sum shrimp pork, vegetarian options, ~160k, District 5"],
];

const group = ledger.upsertGroup("seed", "demo-friday-table", "Friday Table · demo", true);
const members = Object.fromEntries(PERSONAS.map((p) => {
  const m = ledger.upsertMember("seed", `demo-${p.key}`, p.name, true);
  ledger.addToGroup(group.id, m.id);
  return [p.key, m];
}));

if (process.argv.includes("--topup")) {
  // Re-submit failed writes and add any fact the current extractor finds that the
  // ledger does not already hold — without replaying (and duplicating) the chats.
  const { extractByRules } = await import("../src/core/extract");
  const retried = memory.retryFailed();
  let added = 0;
  for (const p of PERSONAS) {
    const m = members[p.key];
    const have = new Set(ledger.memoriesOf("member", m.id).filter((r) => r.status !== "failed" || r.pending_text).map((r) => r.key));
    for (const line of p.dm) {
      for (const f of extractByRules(line, "dm")) {
        if (have.has(f.key)) continue;
        have.add(f.key);
        await memory.writeFact({ type: "member", id: m.id }, f);
        added++;
      }
    }
  }
  console.log(`retrying ${retried} failed writes, adding ${added} missing facts`);
  const r = await memory.drain(600_000);
  const stats = ledger.stats() as any;
  console.log(`drained: ${r.done} · on Walrus: ${stats.memoriesOnWalrus} · failed: ${stats.memoriesFailed}`);
  for (const row of stats.perMember) console.log(`  ${row.name.padEnd(6)} ${row.stored} memories${row.demo ? " (demo persona)" : ""}`);
  process.exit(0);
}

const say = async (key: string, text: string, room: "dm" | "group") => {
  const m = members[key];
  const out = await engine.handle({ channel: "seed", roomType: room, roomId: room === "dm" ? m.id : group.id, memberId: m.id, text, addressed: true });
  const first = out[0]?.text.split("\n")[0] ?? "(no reply)";
  console.log(`  ${room === "dm" ? "DM " : "GRP"} ${m.displayName.padEnd(5)} › ${text.slice(0, 60)}\n      ↳ ${first.slice(0, 110)}`);
};

console.log(`memory: ${app.backend.kind} · group ${group.name} (${group.inviteCode})`);
for (const p of PERSONAS) for (const t of p.dm) await say(p.key, t, "dm");
for (const [k, t] of PLACES) await say(k, t, "group");

console.log("\nwaiting for every write to land on Walrus…");
let last = -1;
for (;;) {
  const n = ledger.memoriesInFlight().length;
  if (n !== last) { console.log(`  in flight: ${n}`); last = n; }
  if (n === 0) break;
  await new Promise((r) => setTimeout(r, 3000));
}
for (const key of Object.keys(members)) memory.invalidate(memory.namespaceOf({ type: "member", id: members[key].id }));
memory.invalidate(memory.namespaceOf({ type: "group", id: group.id }));

if (!process.argv.includes("--no-plan")) {
  console.log("\nplanning:");
  await say("chi", "Where should we eat Friday?", "group");
  await say("dung", "Bếp Chay Sen was great last time, recommend!", "group");
  await say("an", "dinner thursday?", "group");
  await say("bao", "why did you skip Ốc Đào Corner?", "dm");
}

const stats = ledger.stats() as any;
console.log(`\non Walrus: ${stats.memoriesOnWalrus} · failed: ${stats.memoriesFailed}`);
for (const r of stats.perMember) console.log(`  ${r.name.padEnd(6)} ${r.stored} memories${r.demo ? " (demo persona)" : ""}`);
await memory.drain(120_000);
process.exit(0);
