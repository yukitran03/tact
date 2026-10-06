/** Repro for docs/FRICTION.md §2: idempotency keys are account-scoped. Writes two small blobs on mainnet. */
import { MemWal } from "@mysten-incubation/memwal";
import { loadMemWalCredentials } from "../src/config";
const c = loadMemWalCredentials()!;
const mw = MemWal.create({ key: c.key, accountId: c.accountId, serverUrl: c.serverUrl });
const key = `tact-repro-${Date.now()}`;
const text = "Repro: identical fact written for two different users.";
const a = await mw.remember(text, "tact-repro:user-a", { idempotencyKey: key });
console.log("namespace A accepted:", a.job_id, a.status);
try {
  const b = await mw.remember(text, "tact-repro:user-b", { idempotencyKey: key });
  console.log("namespace B accepted:", b.job_id, b.status, b.job_id === a.job_id ? "(SAME job id — replayed A's write)" : "(new job)");
} catch (e) { console.log("namespace B rejected:", String((e as Error).message).slice(0, 220)); }
const t2 = text + " (different text)";
try {
  const d = await mw.remember(t2, "tact-repro:user-a", { idempotencyKey: key });
  console.log("same ns, different text:", d.job_id, d.status);
} catch (e) { console.log("same ns, different text rejected:", String((e as Error).message).slice(0, 220)); }
process.exit(0);
