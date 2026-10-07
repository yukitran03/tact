import { MemWal } from "@mysten-incubation/memwal";
import type { MemWalCredentials } from "../config";

export interface RecalledMemory {
  blobId: string;
  text: string;
  distance: number;
  createdAt?: string;
}

export interface RecallOutcome {
  results: RecalledMemory[];
  dropped: number;
  ms: number;
  /** True when every attempt failed or timed out; callers must not treat this as "no memories". */
  failed: boolean;
  error?: string;
}

export type JobStatus = "pending" | "running" | "uploaded" | "done" | "failed" | "not_found";

export interface MemoryBackend {
  readonly kind: "walrus" | "mock";
  remember(text: string, namespace: string, idempotencyKey?: string): Promise<{ jobId: string }>;
  status(jobId: string): Promise<{ status: JobStatus; blobId?: string; error?: string }>;
  /** One request for many jobs; status polls count against the relayer's rate limit too. */
  statusMany(jobIds: string[]): Promise<Map<string, { status: JobStatus; blobId?: string; error?: string }>>;
  recall(query: string, namespace: string, limit: number): Promise<RecallOutcome>;
  health(): Promise<{ ok: boolean; detail: string }>;
  identity(): Promise<{ accountId: string; agentId: string; serverUrl: string }>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function retryAfterMs(err: unknown): number | null {
  const e = err as { status?: number; message?: string; retryAfterSeconds?: number };
  const msg = String(e?.message ?? "");
  if (e?.status === 429 || /429|rate.?limit|too many/i.test(msg)) {
    const m = /retry[_ -]?after[^0-9]*(\d+)/i.exec(msg);
    return (e.retryAfterSeconds ?? (m ? Number(m[1]) : 6)) * 1000;
  }
  if ((e?.status ?? 0) >= 500 || /ECONNRESET|fetch failed|timeout|timed out|socket|503|502|500/i.test(msg)) return 1500;
  return null;
}

/**
 * Walrus Memory through the managed mainnet relayer.
 *
 * Writes go through a paced queue. The relayer budgets 60 weighted requests a
 * minute per delegate key (measured: a 429 names `layer: delegate_key`), and a
 * remember() weighs 5, so one key gets 12 writes a minute, shared by every
 * user of the bot, minus the recalls and status polls that weigh 1 each. Ten a
 * minute leaves room for those; a burst of onboarding answers queues instead
 * of failing.
 */
export class WalrusBackend implements MemoryBackend {
  readonly kind = "walrus" as const;
  private readonly mw: MemWal;
  private queue: Promise<unknown> = Promise.resolve();
  private lastWrite = 0;
  private readonly minGapMs: number;

  constructor(private readonly creds: MemWalCredentials, private readonly recallTimeoutMs = 14_000, writesPerMinute = Number(process.env.TACT_WRITES_PER_MINUTE ?? 10)) {
    this.mw = MemWal.create({ key: creds.key, accountId: creds.accountId, serverUrl: creds.serverUrl, requestTimeoutMs: 30_000 });
    this.minGapMs = Math.ceil(60_000 / writesPerMinute);
  }

  remember(text: string, namespace: string, idempotencyKey?: string): Promise<{ jobId: string }> {
    const run = async () => {
      const wait = this.lastWrite + this.minGapMs - Date.now();
      if (wait > 0) await sleep(wait);
      for (let attempt = 0; ; attempt++) {
        try {
          this.lastWrite = Date.now();
          const r = await this.mw.remember(text, namespace, idempotencyKey ? { idempotencyKey } : undefined);
          return { jobId: r.job_id };
        } catch (err) {
          const backoff = retryAfterMs(err);
          if (backoff === null || attempt >= 4) throw err;
          await sleep(backoff * (attempt + 1));
        }
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  async status(jobId: string) {
    try {
      const s = await this.mw.getRememberStatus(jobId);
      return { status: s.status as JobStatus, blobId: s.blob_id, error: s.error };
    } catch (err) {
      if (retryAfterMs(err) !== null) return { status: "pending" as JobStatus };
      throw err;
    }
  }

  async statusMany(jobIds: string[]) {
    const out = new Map<string, { status: JobStatus; blobId?: string; error?: string }>();
    for (let i = 0; i < jobIds.length; i += 50) {
      try {
        const r = await this.mw.getRememberBulkStatus(jobIds.slice(i, i + 50));
        for (const it of r.results) out.set(it.job_id, { status: it.status as JobStatus, blobId: it.blob_id, error: it.error });
      } catch (err) {
        if (retryAfterMs(err) === null) throw err;
      }
    }
    return out;
  }

  async recall(query: string, namespace: string, limit: number): Promise<RecallOutcome> {
    const t0 = performance.now();
    let lastError: string | undefined;
    // An all-dropped page comes back as HTTP 200 with results: [] (MemWal #1036);
    // that is a transient failure, not an empty memory, so it gets retried.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await withTimeout(
          this.mw.recall({ query, namespace, limit }),
          this.recallTimeoutMs,
        );
        const dropped = r.dropped_count ?? 0;
        if (r.results.length === 0 && dropped > 0 && attempt < 2) {
          lastError = `all ${dropped} matches dropped`;
          await sleep(800 * (attempt + 1));
          continue;
        }
        return {
          results: r.results.map((m) => ({ blobId: m.blob_id, text: m.text, distance: m.distance, createdAt: m.created_at })),
          dropped,
          ms: Math.round(performance.now() - t0),
          failed: false,
        };
      } catch (err) {
        lastError = String((err as Error)?.message ?? err).slice(0, 200);
        console.warn(`[walrus] recall ${namespace} attempt ${attempt + 1}: ${lastError}`);
        const backoff = retryAfterMs(err);
        if (backoff === null && !/timed out/.test(lastError)) break;
        await sleep(Math.min(backoff ?? 1000, 4000));
      }
    }
    return { results: [], dropped: 0, ms: Math.round(performance.now() - t0), failed: true, error: lastError };
  }

  /**
   * The first signed call builds a SEAL session (key-server round trips), which
   * can take seconds; doing it once at startup keeps the first plan from paying
   * for it inside its recall timeout.
   */
  async warm(): Promise<number> {
    const t0 = performance.now();
    await this.mw.recall({ query: "warm-up", namespace: "tact-warmup", limit: 1 }).catch(() => undefined);
    return Math.round(performance.now() - t0);
  }

  async health() {
    try {
      const h = await this.mw.health();
      return { ok: h.status === "ok", detail: `${this.creds.serverUrl} ${h.status} v${h.version}` };
    } catch (err) {
      return { ok: false, detail: String((err as Error).message).slice(0, 160) };
    }
  }

  async identity() {
    return { accountId: this.creds.accountId, agentId: await this.mw.getPublicKeyHex(), serverUrl: this.creds.serverUrl };
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`recall timed out after ${ms} ms`)), ms);
    p.then((v) => (clearTimeout(t), resolve(v)), (e) => (clearTimeout(t), reject(e)));
  });
}

/**
 * In-process stand-in for tests and offline demos. Ranking is token overlap,
 * which is enough because Tact reads whole profiles rather than relying on
 * semantic nearness for anything that decides a plan.
 */
export class MockBackend implements MemoryBackend {
  readonly kind = "mock" as const;
  private store = new Map<string, { blobId: string; text: string; createdAt: string }[]>();
  private jobs = new Map<string, { status: JobStatus; blobId?: string; namespace: string; text: string }>();
  private seq = 0;

  constructor(private readonly opts: { indexLagMs?: number; failRecall?: boolean } = {}) {}

  private keys = new Map<string, string>();

  async remember(text: string, namespace: string, idempotencyKey?: string): Promise<{ jobId: string }> {
    // Same rule as the relayer: an idempotency key reused with different content is a 409.
    if (idempotencyKey) {
      const prev = this.keys.get(idempotencyKey);
      if (prev !== undefined && prev !== `${namespace}\n${text}`) {
        throw Object.assign(new Error("Walrus Memory server error (409): idempotency_key was already used for a request with different content"), { status: 409 });
      }
      this.keys.set(idempotencyKey, `${namespace}\n${text}`);
    }
    const jobId = `mock-job-${++this.seq}`;
    const blobId = `mockblob${String(this.seq).padStart(6, "0")}${Math.random().toString(36).slice(2, 10)}`;
    this.jobs.set(jobId, { status: "pending", blobId, namespace, text });
    const land = () => {
      const list = this.store.get(namespace) ?? [];
      list.push({ blobId, text, createdAt: new Date().toISOString() });
      this.store.set(namespace, list);
      this.jobs.set(jobId, { status: "done", blobId, namespace, text });
    };
    if (this.opts.indexLagMs) setTimeout(land, this.opts.indexLagMs);
    else land();
    return { jobId };
  }

  async status(jobId: string) {
    const j = this.jobs.get(jobId);
    return j ? { status: j.status, blobId: j.status === "done" ? j.blobId : undefined } : { status: "not_found" as JobStatus };
  }

  async statusMany(jobIds: string[]) {
    const out = new Map<string, { status: JobStatus; blobId?: string; error?: string }>();
    for (const id of jobIds) out.set(id, await this.status(id));
    return out;
  }

  async recall(query: string, namespace: string, limit: number): Promise<RecallOutcome> {
    if (this.opts.failRecall) return { results: [], dropped: 0, ms: 0, failed: true, error: "mock failure" };
    const q = new Set(query.toLowerCase().split(/\W+/).filter(Boolean));
    const scored = (this.store.get(namespace) ?? []).map((m) => {
      const words = m.text.toLowerCase().split(/\W+/);
      const overlap = words.filter((w) => q.has(w)).length;
      return { blobId: m.blobId, text: m.text, createdAt: m.createdAt, distance: 1 - Math.min(0.99, overlap / Math.max(4, q.size)) };
    });
    scored.sort((a, b) => a.distance - b.distance);
    return { results: scored.slice(0, limit), dropped: 0, ms: 0, failed: false };
  }

  async health() {
    return { ok: true, detail: "in-memory mock store (nothing is written to Walrus)" };
  }

  async identity() {
    return { accountId: "mock", agentId: "mock", serverUrl: "mock://" };
  }

  /** Test helper: everything stored in a namespace. */
  dump(namespace: string) {
    return [...(this.store.get(namespace) ?? [])];
  }
}
