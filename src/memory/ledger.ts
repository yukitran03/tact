import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ChatMessage, Channel, Group, Kind, Member, RoomType, Tier } from "../core/types";

/**
 * Local bookkeeping only. Memory *text* is never kept here once a write lands:
 * a fact sits in `pending_text` for the ~20 s between the relayer accepting it
 * and Walrus confirming the blob, then it is cleared. Everything Tact knows
 * about a person is read back from Walrus.
 */
export interface MemoryRow {
  id: string;
  owner_type: "member" | "group";
  owner_id: string;
  namespace: string;
  kind: Kind;
  tier: Tier;
  key: string;
  text_hash: string;
  pending_text: string | null;
  job_id: string | null;
  blob_id: string | null;
  status: "queued" | "pending" | "done" | "failed";
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface PlanRow {
  id: string;
  group_id: string;
  requested_by: string;
  request: string;
  mode: string;
  decision: string;
  created_at: string;
}

export interface ShieldRow {
  id: string;
  plan_id: string | null;
  group_id: string;
  owner_member_id: string;
  fact_key: string;
  fact_kind: string;
  blob_id: string | null;
  action: string;
  detail: string;
  created_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY, display_name TEXT NOT NULL, channel TEXT NOT NULL, external_id TEXT NOT NULL,
  created_at TEXT NOT NULL, demo INTEGER NOT NULL DEFAULT 0, UNIQUE(channel, external_id));
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, channel TEXT NOT NULL, external_id TEXT NOT NULL,
  invite_code TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, demo INTEGER NOT NULL DEFAULT 0, UNIQUE(channel, external_id));
CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL, member_id TEXT NOT NULL, joined_at TEXT NOT NULL, PRIMARY KEY (group_id, member_id));
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY, owner_type TEXT NOT NULL, owner_id TEXT NOT NULL, namespace TEXT NOT NULL,
  kind TEXT NOT NULL, tier TEXT NOT NULL, key TEXT NOT NULL, text_hash TEXT NOT NULL, pending_text TEXT,
  job_id TEXT, blob_id TEXT, status TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS memories_owner ON memories(owner_type, owner_id);
CREATE INDEX IF NOT EXISTS memories_status ON memories(status);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, room_type TEXT NOT NULL, room_id TEXT NOT NULL, member_id TEXT, role TEXT NOT NULL,
  text TEXT NOT NULL, meta TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS messages_room ON messages(room_type, room_id, created_at);
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY, group_id TEXT NOT NULL, requested_by TEXT NOT NULL, request TEXT NOT NULL,
  mode TEXT NOT NULL, decision TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS shield_log (
  id TEXT PRIMARY KEY, plan_id TEXT, group_id TEXT NOT NULL, owner_member_id TEXT NOT NULL,
  fact_key TEXT NOT NULL, fact_kind TEXT NOT NULL, blob_id TEXT, action TEXT NOT NULL, detail TEXT NOT NULL,
  created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS turn_log (
  id TEXT PRIMARY KEY, channel TEXT NOT NULL, room_type TEXT NOT NULL, member_id TEXT, intent TEXT NOT NULL,
  memories_used INTEGER NOT NULL DEFAULT 0, memories_written INTEGER NOT NULL DEFAULT 0, withheld INTEGER NOT NULL DEFAULT 0,
  leak_blocked INTEGER NOT NULL DEFAULT 0, ms INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

export const newId = () => crypto.randomUUID();
export const nowIso = () => new Date().toISOString();

function inviteCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

export class Ledger {
  readonly db: Database;

  constructor(dataDir: string | ":memory:") {
    if (dataDir === ":memory:") {
      this.db = new Database(":memory:");
    } else {
      mkdirSync(dataDir, { recursive: true });
      this.db = new Database(join(dataDir, "tact.sqlite"), { create: true });
      // The server, the Telegram worker and scripts may share one file.
      this.db.exec("PRAGMA busy_timeout = 8000;");
      this.db.exec("PRAGMA journal_mode = WAL;");
    }
    this.db.exec(SCHEMA);
  }

  // ── members & groups ─────────────────────────────────────────────
  upsertMember(channel: Channel, externalId: string, displayName: string, demo = false): Member {
    const existing = this.db.query("SELECT * FROM members WHERE channel = ? AND external_id = ?").get(channel, externalId) as any;
    if (existing) {
      if (displayName && existing.display_name !== displayName) {
        this.db.query("UPDATE members SET display_name = ? WHERE id = ?").run(displayName, existing.id);
        existing.display_name = displayName;
      }
      return toMember(existing);
    }
    const row = { id: newId(), display_name: displayName || "Friend", channel, external_id: externalId, created_at: nowIso(), demo: demo ? 1 : 0 };
    this.db.query("INSERT INTO members VALUES ($id,$display_name,$channel,$external_id,$created_at,$demo)")
      .run(prefix(row));
    return toMember(row);
  }

  member(id: string): Member | null {
    const r = this.db.query("SELECT * FROM members WHERE id = ?").get(id) as any;
    return r ? toMember(r) : null;
  }

  memberByExternal(channel: Channel, externalId: string): Member | null {
    const r = this.db.query("SELECT * FROM members WHERE channel = ? AND external_id = ?").get(channel, externalId) as any;
    return r ? toMember(r) : null;
  }

  upsertGroup(channel: Channel, externalId: string, name: string, demo = false): Group {
    const existing = this.db.query("SELECT * FROM groups WHERE channel = ? AND external_id = ?").get(channel, externalId) as any;
    if (existing) return toGroup(existing);
    const row = { id: newId(), name, channel, external_id: externalId, invite_code: inviteCode(), created_at: nowIso(), demo: demo ? 1 : 0 };
    this.db.query("INSERT INTO groups VALUES ($id,$name,$channel,$external_id,$invite_code,$created_at,$demo)").run(prefix(row));
    return toGroup(row);
  }

  group(id: string): Group | null {
    const r = this.db.query("SELECT * FROM groups WHERE id = ?").get(id) as any;
    return r ? toGroup(r) : null;
  }

  groupByInvite(code: string): Group | null {
    const r = this.db.query("SELECT * FROM groups WHERE invite_code = ?").get(code.trim().toUpperCase()) as any;
    return r ? toGroup(r) : null;
  }

  addToGroup(groupId: string, memberId: string): void {
    this.db.query("INSERT OR IGNORE INTO group_members VALUES (?, ?, ?)").run(groupId, memberId, nowIso());
  }

  groupMembers(groupId: string): Member[] {
    return (this.db.query(
      "SELECT m.* FROM members m JOIN group_members g ON g.member_id = m.id WHERE g.group_id = ? ORDER BY g.joined_at",
    ).all(groupId) as any[]).map(toMember);
  }

  groupsOf(memberId: string): Group[] {
    return (this.db.query(
      "SELECT g.* FROM groups g JOIN group_members gm ON gm.group_id = g.id WHERE gm.member_id = ? ORDER BY g.created_at",
    ).all(memberId) as any[]).map(toGroup);
  }

  isMember(groupId: string, memberId: string): boolean {
    return !!this.db.query("SELECT 1 FROM group_members WHERE group_id = ? AND member_id = ?").get(groupId, memberId);
  }

  // ── memory index ─────────────────────────────────────────────────
  insertMemory(r: Omit<MemoryRow, "updated_at">): void {
    this.db.query(`INSERT INTO memories VALUES ($id,$owner_type,$owner_id,$namespace,$kind,$tier,$key,$text_hash,
      $pending_text,$job_id,$blob_id,$status,$error,$created_at,$updated_at)`).run(prefix({ ...r, updated_at: r.created_at }));
  }

  updateMemory(id: string, patch: Partial<MemoryRow>): void {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    const sets = keys.map((k) => `${k} = $${k}`).join(", ");
    this.db.query(`UPDATE memories SET ${sets}, updated_at = $updated_at WHERE id = $id`)
      .run(prefix({ ...patch, id, updated_at: nowIso() }));
  }

  memoriesOf(ownerType: "member" | "group", ownerId: string): MemoryRow[] {
    return this.db.query("SELECT * FROM memories WHERE owner_type = ? AND owner_id = ? ORDER BY created_at DESC")
      .all(ownerType, ownerId) as MemoryRow[];
  }

  memoriesInFlight(): MemoryRow[] {
    return this.db.query("SELECT * FROM memories WHERE status IN ('queued','pending') ORDER BY created_at").all() as MemoryRow[];
  }

  memoryByHash(namespace: string, hash: string): MemoryRow | null {
    return (this.db.query("SELECT * FROM memories WHERE namespace = ? AND text_hash = ? AND status != 'failed' LIMIT 1")
      .get(namespace, hash) as MemoryRow) ?? null;
  }

  // ── chat ─────────────────────────────────────────────────────────
  addMessage(m: Omit<ChatMessage, "id" | "createdAt"> & { id?: string; createdAt?: string }): ChatMessage {
    const msg: ChatMessage = { id: m.id ?? newId(), createdAt: m.createdAt ?? nowIso(), ...m } as ChatMessage;
    this.db.query("INSERT INTO messages VALUES (?,?,?,?,?,?,?,?)").run(
      msg.id, msg.roomType, msg.roomId, msg.memberId, msg.role, msg.text, msg.meta ? JSON.stringify(msg.meta) : null, msg.createdAt,
    );
    return msg;
  }

  messages(roomType: RoomType, roomId: string, limit = 200): ChatMessage[] {
    const rows = this.db.query(
      "SELECT * FROM (SELECT * FROM messages WHERE room_type = ? AND room_id = ? ORDER BY created_at DESC LIMIT ?) ORDER BY created_at",
    ).all(roomType, roomId, limit) as any[];
    return rows.map((r) => ({
      id: r.id, roomType: r.room_type, roomId: r.room_id, memberId: r.member_id, role: r.role, text: r.text,
      createdAt: r.created_at, meta: r.meta ? JSON.parse(r.meta) : undefined,
    }));
  }

  updateMessageMeta(id: string, meta: Record<string, unknown>): void {
    this.db.query("UPDATE messages SET meta = ? WHERE id = ?").run(JSON.stringify(meta), id);
  }

  // ── plans & shield log ──────────────────────────────────────────
  addPlan(p: Omit<PlanRow, "id" | "created_at">): PlanRow {
    const row: PlanRow = { id: newId(), created_at: nowIso(), ...p };
    this.db.query("INSERT INTO plans VALUES ($id,$group_id,$requested_by,$request,$mode,$decision,$created_at)").run(prefix(row));
    return row;
  }

  plan(id: string): PlanRow | null {
    return (this.db.query("SELECT * FROM plans WHERE id = ?").get(id) as PlanRow) ?? null;
  }

  lastPlan(groupId: string): PlanRow | null {
    return (this.db.query("SELECT * FROM plans WHERE group_id = ? ORDER BY created_at DESC LIMIT 1").get(groupId) as PlanRow) ?? null;
  }

  addShield(s: Omit<ShieldRow, "id" | "created_at">): void {
    this.db.query("INSERT INTO shield_log VALUES ($id,$plan_id,$group_id,$owner_member_id,$fact_key,$fact_kind,$blob_id,$action,$detail,$created_at)")
      .run(prefix({ id: newId(), created_at: nowIso(), ...s }));
  }

  shieldFor(memberId: string, limit = 100): ShieldRow[] {
    return this.db.query("SELECT * FROM shield_log WHERE owner_member_id = ? ORDER BY created_at DESC LIMIT ?").all(memberId, limit) as ShieldRow[];
  }

  shieldForPlan(planId: string): ShieldRow[] {
    return this.db.query("SELECT * FROM shield_log WHERE plan_id = ?").all(planId) as ShieldRow[];
  }

  logTurn(t: { channel: string; roomType: string; memberId: string | null; intent: string; memoriesUsed?: number; memoriesWritten?: number; withheld?: number; leakBlocked?: number; ms?: number }): void {
    this.db.query("INSERT INTO turn_log VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(
      newId(), t.channel, t.roomType, t.memberId, t.intent, t.memoriesUsed ?? 0, t.memoriesWritten ?? 0,
      t.withheld ?? 0, t.leakBlocked ?? 0, t.ms ?? 0, nowIso(),
    );
  }

  stats(): Record<string, unknown> {
    const one = (sql: string) => (this.db.query(sql).get() as any) ?? {};
    return {
      members: one("SELECT COUNT(*) n FROM members").n,
      groups: one("SELECT COUNT(*) n FROM groups").n,
      memoriesOnWalrus: one("SELECT COUNT(*) n FROM memories WHERE status = 'done'").n,
      memoriesInFlight: one("SELECT COUNT(*) n FROM memories WHERE status IN ('queued','pending')").n,
      memoriesFailed: one("SELECT COUNT(*) n FROM memories WHERE status = 'failed'").n,
      plans: one("SELECT COUNT(*) n FROM plans").n,
      turns: one("SELECT COUNT(*) n FROM turn_log").n,
      withheld: one("SELECT COALESCE(SUM(withheld),0) n FROM turn_log").n,
      leaksBlocked: one("SELECT COALESCE(SUM(leak_blocked),0) n FROM turn_log").n,
      perMember: this.db.query(`SELECT m.display_name name, m.demo demo, COUNT(x.id) stored
        FROM members m LEFT JOIN memories x ON x.owner_type = 'member' AND x.owner_id = m.id AND x.status = 'done'
        GROUP BY m.id ORDER BY stored DESC`).all(),
    };
  }

  getKv(k: string): string | null {
    return ((this.db.query("SELECT v FROM kv WHERE k = ?").get(k) as any)?.v as string) ?? null;
  }

  setKv(k: string, v: string): void {
    this.db.query("INSERT INTO kv VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
  }
}

function prefix(o: object): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(o)) out[`$${k}`] = v === undefined ? null : v;
  return out;
}

function toMember(r: any): Member {
  return { id: r.id, displayName: r.display_name, channel: r.channel, externalId: r.external_id, createdAt: r.created_at, demo: !!r.demo };
}

function toGroup(r: any): Group {
  return { id: r.id, name: r.name, channel: r.channel, externalId: r.external_id, inviteCode: r.invite_code, createdAt: r.created_at, demo: !!r.demo };
}
