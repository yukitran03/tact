/**
 * One live round trip against the Walrus Memory mainnet relayer:
 * health → remember (wait for the blob) → recall it back.
 *
 *   bun run smoke            # health + recall only
 *   bun run smoke --write    # also writes one fact into the "tact-smoke" namespace
 */
import { MemWal } from "@mysten-incubation/memwal";
import { loadMemWalCredentials } from "../src/config";

const creds = loadMemWalCredentials();
if (!creds) {
  console.error("No Walrus Memory credentials. Set MEMWAL_KEY + MEMWAL_ACCOUNT_ID or create ~/.memwal/credentials.json.");
  process.exit(1);
}
const mw = MemWal.create({ key: creds.key, accountId: creds.accountId, serverUrl: creds.serverUrl });
const ns = "tact-smoke";
const t0 = performance.now();
const ms = () => `${Math.round(performance.now() - t0)} ms`;

const health = await mw.health();
console.log(`relayer ${creds.serverUrl} → ${health.status} v${health.version} (${ms()})`);
console.log(`account ${creds.accountId} (credentials from ${creds.source})`);
console.log(`delegate public key (MEMWAL_AGENT_ID) ${await mw.getPublicKeyHex()}`);

if (process.argv.includes("--write")) {
  const fact = "Tact smoke test: the relayer accepted this fact and stored it on Walrus.";
  const w0 = performance.now();
  const r = await mw.rememberAndWait(fact, ns, { timeoutMs: 90_000 });
  console.log(`remembered → blob ${r.blob_id} in ${Math.round(performance.now() - w0)} ms`);
  console.log(`  https://walruscan.com/mainnet/blob/${r.blob_id}`);
}

const r0 = performance.now();
const rec = await mw.recall({ query: "Did the smoke test store a fact?", namespace: ns, limit: 3 });
console.log(`recall → ${rec.results.length} result(s), dropped ${rec.dropped_count ?? 0}, ${Math.round(performance.now() - r0)} ms`);
for (const m of rec.results) console.log(`  d=${m.distance.toFixed(3)} ${m.blob_id.slice(0, 12)}… ${m.text.slice(0, 80)}`);
mw.destroy();
