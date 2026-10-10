/**
 * Loads the committed demo table into an empty ledger so a fresh Vercel
 * instance can open /demo?name=Bảo against the same Walrus namespaces that
 * were written locally (member ids must match the HMAC'd namespaces).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { App } from "../app";
import { ROOT } from "../config";
import bundledFixture from "./demo-fixture.json";

interface Fixture {
  members: any[];
  groups: any[];
  memberships: any[];
  memories: any[];
  groupMemories: any[];
  kv: any[];
}

export function ensureDemoFixture(app: App): void {
  const n = (app.ledger.db.query("SELECT COUNT(*) AS c FROM members WHERE demo = 1").get() as { c: number }).c;
  if (n > 0) return;

  const path = join(ROOT, "data", "demo-fixture.json");
  const dump = (existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8"))
    : bundledFixture) as Fixture;
  if (!dump?.members?.length) {
    console.warn("[fixture] no demo fixture available");
    return;
  }
  const db = app.ledger.db;

  const insertMember = db.query(
    "INSERT OR IGNORE INTO members (id, display_name, channel, external_id, created_at, demo) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const m of dump.members) {
    insertMember.run(m.id, m.display_name, m.channel, m.external_id, m.created_at, m.demo ? 1 : 0);
  }

  const insertGroup = db.query(
    "INSERT OR IGNORE INTO groups (id, name, channel, external_id, invite_code, created_at, demo) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  for (const g of dump.groups) {
    insertGroup.run(g.id, g.name, g.channel, g.external_id, g.invite_code, g.created_at, g.demo ? 1 : 0);
  }

  const insertMem = db.query(
    "INSERT OR IGNORE INTO group_members (group_id, member_id, joined_at) VALUES (?, ?, ?)",
  );
  for (const r of dump.memberships) insertMem.run(r.group_id, r.member_id, r.joined_at);

  const insertMemory = db.query(
    `INSERT OR IGNORE INTO memories
      (id, owner_type, owner_id, namespace, kind, tier, key, text_hash, pending_text, job_id, blob_id, status, error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const x of [...dump.memories, ...dump.groupMemories]) {
    insertMemory.run(
      x.id, x.owner_type, x.owner_id, x.namespace, x.kind, x.tier, x.key, x.text_hash,
      x.pending_text, x.job_id, x.blob_id, x.status, x.error, x.created_at, x.updated_at,
    );
  }

  const insertKv = db.query("INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)");
  for (const row of dump.kv ?? []) insertKv.run(row.k, row.v);

  console.log(`[fixture] loaded ${dump.members.length} demo personas, ${dump.memories.length + dump.groupMemories.length} memory rows`);
}
