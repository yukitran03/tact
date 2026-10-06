import { createHmac, createHash } from "node:crypto";
import type { Fact, OwnerRef, StoredFact } from "../core/types";
import type { MemoryBackend, RecallOutcome } from "./backend";
import { decodeFact, encodeFact, resolveFacts } from "./codec";
import { Ledger, newId, nowIso, type MemoryRow } from "./ledger";

export interface ReadResult {
  facts: StoredFact[];
  /** Raw count of tagged memories read back before supersede resolution. */
  scanned: number;
  ms: number;
  failed: boolean;
  error?: string;
}

type Listener = (row: MemoryRow) => void;

/**
 * The only door to memory. Everything a person tells Tact goes through
 * writeFact() into their own Walrus Memory namespace, and every decision reads
 * it back through readFacts(), which recalls from Walrus, decodes the tag
 * blocks and resolves supersede chains. The ledger is bookkeeping, not storage.
 */
export class MemoryService {
  private cache = new Map<string, { at: number; result: ReadResult }>();
  private listeners = new Set<Listener>();
  private polling = new Set<string>();

  constructor(
    readonly backend: MemoryBackend,
    readonly ledger: Ledger,
    private readonly opts: { namespaceSecret: string; prefix: string; cacheMs?: number; pollMs?: number },
  ) {}

  /** Namespaces are public on-chain (blob attribute memwal_namespace), so ids are HMAC'd first. */
  namespaceOf(owner: OwnerRef): string {
    const tag = owner.type === "member" ? "m" : "g";
    const h = createHmac("sha256", this.opts.namespaceSecret).update(`${owner.type}:${owner.id}`).digest("hex").slice(0, 20);
    return `${this.opts.prefix}:${tag}:${h}`;
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Stores one fact. Returns as soon as the relayer has accepted the job; the
   * blob id arrives in the background (about 20 s on mainnet) and the ledger
   * row flips from pending to done.
   */
  async writeFact(owner: OwnerRef, fact: Fact): Promise<MemoryRow> {
    const namespace = this.namespaceOf(owner);
    const text = encodeFact(fact);
    const hash = createHash("sha256").update(`${fact.key}|${fact.tier}|${fact.retract ? 1 : 0}|${fact.text}|${JSON.stringify(fact.attrs)}`).digest("hex");
    const dup = this.ledger.memoryByHash(namespace, hash);
    if (dup && !fact.retract) return dup;

    const row: Omit<MemoryRow, "updated_at"> = {
      id: newId(), owner_type: owner.type, owner_id: owner.id, namespace, kind: fact.kind, tier: fact.tier, key: fact.key,
      text_hash: hash, pending_text: text, job_id: null, blob_id: null, status: "queued", error: null, created_at: nowIso(),
    };
    this.ledger.insertMemory(row);
    this.invalidate(namespace);
    this.emit(row.id);
    try {
      const { jobId } = await this.backend.remember(text, namespace, `tact-${hash.slice(0, 40)}`);
      this.ledger.updateMemory(row.id, { job_id: jobId, status: "pending" });
      this.emit(row.id);
      void this.poll(row.id, jobId);
    } catch (err) {
      this.ledger.updateMemory(row.id, { status: "failed", error: String((err as Error).message).slice(0, 300) });
      this.emit(row.id);
    }
    return this.rowById(row.id)!;
  }

  private rowById(id: string): MemoryRow | null {
    return (this.ledger.db.query("SELECT * FROM memories WHERE id = ?").get(id) as MemoryRow) ?? null;
  }

  private emit(id: string) {
    const row = this.rowById(id);
    if (row) for (const fn of this.listeners) fn(row);
  }

  private async poll(rowId: string, jobId: string): Promise<void> {
    if (this.polling.has(rowId)) return;
    this.polling.add(rowId);
    const started = Date.now();
    const every = this.opts.pollMs ?? 2500;
    try {
      while (Date.now() - started < 180_000) {
        const s = await this.backend.status(jobId).catch(() => ({ status: "pending" as const }));
        if (s.status === "done" && "blobId" in s && s.blobId) {
          this.ledger.updateMemory(rowId, { status: "done", blob_id: s.blobId, pending_text: null });
          const row = this.rowById(rowId);
          if (row) this.invalidate(row.namespace);
          this.emit(rowId);
          return;
        }
        if (s.status === "failed" || s.status === "not_found") {
          this.ledger.updateMemory(rowId, { status: "failed", error: ("error" in s && s.error) || s.status });
          this.emit(rowId);
          return;
        }
        await new Promise((r) => setTimeout(r, every));
      }
      this.ledger.updateMemory(rowId, { status: "failed", error: "timed out waiting for Walrus" });
      this.emit(rowId);
    } finally {
      this.polling.delete(rowId);
    }
  }

  /** Re-attach pollers after a restart, so writes in flight still get their blob ids. */
  resumeInFlight(): number {
    const rows = this.ledger.memoriesInFlight();
    for (const r of rows) if (r.job_id) void this.poll(r.id, r.job_id);
    return rows.length;
  }

  /** Resolves when nothing is in flight (or the timeout passes). */
  async drain(timeoutMs = 240_000): Promise<{ done: boolean; inFlight: number }> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const n = this.ledger.memoriesInFlight().length;
      if (n === 0) return { done: true, inFlight: 0 };
      await new Promise((r) => setTimeout(r, 1500));
    }
    return { done: false, inFlight: this.ledger.memoriesInFlight().length };
  }

  invalidate(namespace: string) {
    this.cache.delete(namespace);
  }

  /**
   * Reads an owner's whole profile back from Walrus. Tact's namespaces are
   * small (tens of facts), so a broad recall with a high limit returns all of
   * them; facts still landing are merged from the write-ahead buffer so a
   * correction counts the moment it is said.
   */
  async readFacts(owner: OwnerRef, opts: { fresh?: boolean; query?: string } = {}): Promise<ReadResult> {
    const namespace = this.namespaceOf(owner);
    const ttl = this.opts.cacheMs ?? 45_000;
    const hit = this.cache.get(namespace);
    if (!opts.fresh && hit && Date.now() - hit.at < ttl) return hit.result;

    const query = opts.query ?? (owner.type === "member"
      ? "food allergies diet budget area availability likes dislikes preferences"
      : "places venues restaurants verdicts events the group");
    const outcome: RecallOutcome = await this.backend.recall(query, namespace, 60);
    const fromWalrus: StoredFact[] = [];
    for (const m of outcome.results) {
      const f = decodeFact(m.text);
      if (f) fromWalrus.push({ ...f, blobId: m.blobId, origin: "walrus", createdAt: m.createdAt, distance: m.distance });
    }
    const landed = new Set(fromWalrus.map((f) => f.blobId));
    const pending: StoredFact[] = [];
    for (const row of this.ledger.memoriesOf(owner.type, owner.id)) {
      // pending_text is cleared the moment Walrus confirms the blob.
      if (!row.pending_text || row.status === "failed") continue;
      if (row.blob_id && landed.has(row.blob_id)) continue;
      const f = decodeFact(row.pending_text);
      if (f) pending.push({ ...f, origin: "pending", blobId: row.blob_id ?? undefined });
    }
    const facts = resolveFacts([...fromWalrus, ...pending]);
    const result: ReadResult = {
      facts, scanned: fromWalrus.length + pending.length, ms: outcome.ms, failed: outcome.failed, error: outcome.error,
    };
    if (!outcome.failed) this.cache.set(namespace, { at: Date.now(), result });
    return result;
  }

  /** Several owners at once; recall runs in parallel because each costs 1–10 s on mainnet. */
  async readMany(owners: OwnerRef[], opts: { fresh?: boolean } = {}): Promise<Map<string, ReadResult>> {
    const results = await Promise.all(owners.map((o) => this.readFacts(o, opts)));
    const out = new Map<string, ReadResult>();
    owners.forEach((o, i) => out.set(`${o.type}:${o.id}`, results[i]));
    return out;
  }
}
