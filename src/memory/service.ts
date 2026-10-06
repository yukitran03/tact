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
  private polling = false;

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
    // The reply never waits on the relayer: the fact is usable at once from the
    // write-ahead buffer, and the submit + blob confirmation run in the background.
    void this.submit(row.id, text, namespace);
    return this.rowById(row.id)!;
  }

  private async submit(rowId: string, text: string, namespace: string): Promise<void> {
    try {
      // The idempotency key names this one write, so a retry after a timeout
      // cannot mint a second blob. It must not be derived from the fact alone:
      // the relayer scopes keys per account, and two people with the same
      // allergy write identical facts into different namespaces.
      const { jobId } = await this.backend.remember(text, namespace, `tact-${rowId}`);
      this.ledger.updateMemory(rowId, { job_id: jobId, status: "pending" });
      this.emit(rowId);
      this.ensurePoller();
    } catch (err) {
      this.ledger.updateMemory(rowId, { status: "failed", error: String((err as Error).message).slice(0, 300) });
      this.emit(rowId);
    }
  }

  private rowById(id: string): MemoryRow | null {
    return (this.ledger.db.query("SELECT * FROM memories WHERE id = ?").get(id) as MemoryRow) ?? null;
  }

  private emit(id: string) {
    const row = this.rowById(id);
    if (row) for (const fn of this.listeners) fn(row);
  }

  /**
   * One loop polls every pending job with a single bulk-status request, instead
   * of one poller per write: status calls count against the same per-key rate
   * limit as writes, and ten parallel pollers alone would exceed it.
   */
  private ensurePoller(): void {
    if (this.polling) return;
    this.polling = true;
    const every = this.opts.pollMs ?? 3000;
    const loop = async () => {
      try {
        for (;;) {
          const inflight = this.ledger.memoriesInFlight();
          if (!inflight.length) return;
          const pending = inflight.filter((r) => r.job_id && r.status === "pending");
          if (pending.length) {
            const statuses = await this.backend.statusMany(pending.map((r) => r.job_id!)).catch(() => new Map());
            for (const row of pending) {
              const st = statuses.get(row.job_id!);
              const age = Date.now() - Date.parse(row.created_at);
              if (st?.status === "done" && st.blobId) {
                this.ledger.updateMemory(row.id, { status: "done", blob_id: st.blobId, pending_text: null });
                this.invalidate(row.namespace);
                this.emit(row.id);
              } else if (st?.status === "failed" || st?.status === "not_found" || age > 300_000) {
                this.ledger.updateMemory(row.id, { status: "failed", error: st?.error || st?.status || "timed out waiting for Walrus" });
                this.emit(row.id);
              }
            }
          }
          await new Promise((r) => setTimeout(r, every));
        }
      } finally {
        this.polling = false;
      }
    };
    void loop();
  }

  /** Re-attach pollers after a restart, so writes in flight still get their blob ids. */
  resumeInFlight(): number {
    const rows = this.ledger.memoriesInFlight();
    // A row that never reached the relayer (the process died while it was queued) is marked failed, not guessed.
    for (const r of rows) if (!r.job_id) this.ledger.updateMemory(r.id, { status: "failed", error: "process restarted before submit" });
    if (rows.some((r) => r.job_id)) this.ensurePoller();
    return rows.length;
  }

  /** Re-submits writes that failed but still hold their text (rate limits, relayer hiccups). */
  retryFailed(): number {
    const rows = this.ledger.db.query("SELECT * FROM memories WHERE status = 'failed' AND pending_text IS NOT NULL").all() as MemoryRow[];
    for (const r of rows) {
      this.ledger.updateMemory(r.id, { status: "queued", error: null, job_id: null });
      void this.submit(r.id, r.pending_text!, r.namespace);
    }
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
