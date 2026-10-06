/**
 * Prints what the submission form asks for, from the ledger and the relayer:
 * account, MEMWAL_AGENT_ID, blobs on mainnet, memories per person, example
 * Walruscan links, and what the shield has withheld. Writes docs/evidence/evidence-<date>.md.
 *
 *   bun run evidence
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/app";

const app = createApp();
const { ledger } = app;
const id = await app.backend.identity();
const stats = ledger.stats() as any;
const q = (sql: string, ...args: any[]) => ledger.db.query(sql).all(...args) as any[];

const people = q(`SELECT m.display_name name, m.demo demo, m.channel channel,
    SUM(CASE WHEN x.status='done' THEN 1 ELSE 0 END) stored,
    SUM(CASE WHEN x.status='done' AND x.tier='discreet' THEN 1 ELSE 0 END) discreet,
    SUM(CASE WHEN x.status='done' AND x.tier='shared' THEN 1 ELSE 0 END) shared,
    SUM(CASE WHEN x.status='done' AND x.tier='private' THEN 1 ELSE 0 END) private
  FROM members m LEFT JOIN memories x ON x.owner_type='member' AND x.owner_id=m.id GROUP BY m.id ORDER BY stored DESC`);
const groups = q(`SELECT g.name name, g.demo demo, COUNT(x.id) stored FROM groups g
  LEFT JOIN memories x ON x.owner_type='group' AND x.owner_id=g.id AND x.status='done' GROUP BY g.id`);
const samples = q(`SELECT m.display_name name, x.kind kind, x.tier tier, x.blob_id blob FROM memories x
  JOIN members m ON m.id = x.owner_id WHERE x.status='done' ORDER BY x.updated_at DESC LIMIT 8`);
const shield = q(`SELECT action, COUNT(*) n FROM shield_log GROUP BY action`);
const turns = q(`SELECT intent, COUNT(*) n FROM turn_log GROUP BY intent ORDER BY n DESC`);
const tenPlus = people.filter((p) => p.stored >= 10);

const lines = [
  `# Tact evidence — ${new Date().toISOString()}`,
  "",
  `- Relayer: ${id.serverUrl} (${app.backend.kind})`,
  `- MemWalAccount: \`${id.accountId}\` — https://suiscan.xyz/mainnet/object/${id.accountId}`,
  `- MEMWAL_AGENT_ID (delegate public key): \`${id.agentId}\``,
  `- Memories confirmed on Walrus: **${stats.memoriesOnWalrus}** · in flight: ${stats.memoriesInFlight} · failed: ${stats.memoriesFailed}`,
  `- People with 10+ memories: **${tenPlus.length}** (${tenPlus.map((p) => `${p.name}${p.demo ? " [demo persona]" : ""}`).join(", ") || "none"})`,
  `- Plans made: ${stats.plans} · discreet memories that changed a plan without being said: ${stats.withheld} · model drafts blocked by the shield: ${stats.leaksBlocked}`,
  "",
  "## Per person",
  "| Person | Channel | On Walrus | Discreet | Shared | Private |",
  "|---|---|---|---|---|---|",
  ...people.map((p) => `| ${p.name}${p.demo ? " (demo persona)" : ""} | ${p.channel} | ${p.stored} | ${p.discreet} | ${p.shared} | ${p.private} |`),
  "",
  "## Tables (shared memory)",
  ...groups.map((g) => `- ${g.name}${g.demo ? " (demo)" : ""}: ${g.stored} memories`),
  "",
  "## Latest blobs",
  ...samples.map((s) => `- ${s.name} · ${s.kind} · ${s.tier} — https://walruscan.com/mainnet/blob/${s.blob}`),
  "",
  "## Shield",
  ...shield.map((s) => `- ${s.action}: ${s.n}`),
  "",
  "## Turns by intent",
  ...turns.map((t) => `- ${t.intent}: ${t.n}`),
];
const md = lines.join("\n");
console.log(md);
const dir = join(import.meta.dir, "..", "docs", "evidence");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `evidence-${new Date().toISOString().slice(0, 10)}.md`), md);
process.exit(0);
