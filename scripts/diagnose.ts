/**
 * What the chain says, what the relayer says, and where they disagree.
 *
 *   bun run diagnose
 *
 * 1. Relayer health and the package id it serves (/config).
 * 2. The configured account: which package it belongs to. An account created
 *    before the July 2026 mainnet migration lives in the retired package, and
 *    every signed call answers 401 AUTH_REJECTED with no hint why. If so, this
 *    looks up the migrated account for the same owner in the current registry.
 * 3. Whether the delegate key is registered on the account.
 * 4. Recall latency for the demo table at a few limits.
 */
import { MemWal } from "@mysten-incubation/memwal";
import { loadMemWalCredentials } from "../src/config";
import { createApp } from "../src/app";

const REGISTRY = "0x8bf82c9e09e36b8d1c38298f68b7cb68e7b8762887e7592add9986d5e9cf199f";

const creds = loadMemWalCredentials();
if (!creds) {
  console.error("No credentials (MEMWAL_KEY + MEMWAL_ACCOUNT_ID or ~/.memwal/credentials.json).");
  process.exit(1);
}
const cfg = (await (await fetch(`${creds.serverUrl}/config`)).json()) as { packageId: string; network: string; suiRpcUrl: string };
console.log(`relayer   ${creds.serverUrl} · ${cfg.network} · package ${cfg.packageId.slice(0, 10)}…`);

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(cfg.suiRpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const data = (await res.json()) as { result?: T; error?: { message: string } };
  if (!data.result) throw new Error(data.error?.message ?? "rpc failed");
  return data.result;
}

const obj = await rpc<any>("sui_getObject", [creds.accountId, { showType: true, showContent: true }]);
const type: string = obj.data?.type ?? "";
const fields = obj.data?.content?.fields ?? {};
const pkg = type.split("::")[0];
const mw = MemWal.create({ key: creds.key, accountId: creds.accountId, serverUrl: creds.serverUrl });
const pub = await mw.getPublicKeyHex();
console.log(`account   ${creds.accountId} (from ${creds.source})`);
console.log(`  package ${pkg ? pkg.slice(0, 10) + "…" : "not found"} ${pkg === cfg.packageId ? "✓ current" : "✗ NOT the package the relayer serves"}`);
const keys: string[] = (fields.delegate_keys ?? []).map((k: any) => Buffer.from(k.fields.public_key).toString("hex"));
console.log(`  delegate ${pub.slice(0, 16)}… ${keys.includes(pub) ? "✓ registered" : "✗ not on this account"}`);

if (pkg && pkg !== cfg.packageId && fields.owner) {
  const reg = await rpc<any>("sui_getObject", [REGISTRY, { showContent: true }]);
  const table = reg.data.content.fields.accounts.fields.id.id;
  const df = await rpc<any>("suix_getDynamicFieldObject", [table, { type: "address", value: fields.owner }]).catch(() => null);
  const migrated = df?.data?.content?.fields?.value;
  console.log(migrated
    ? `  → migrated account for owner ${fields.owner.slice(0, 10)}…: ${migrated}\n    set MEMWAL_ACCOUNT_ID=${migrated}`
    : `  → no migrated account found for owner ${fields.owner}`);
}

const health = await mw.health().catch((e) => ({ status: `error ${e.message}` }));
console.log(`health    ${health.status}`);

const app = createApp();
const m = app.ledger.db.query("SELECT id, display_name FROM members WHERE demo = 1 ORDER BY created_at LIMIT 1").get() as { id: string; display_name: string } | null;
if (m) {
  const ns = app.memory.namespaceOf({ type: "member", id: m.id });
  for (const limit of [3, 12, 30, 60]) {
    const t0 = performance.now();
    try {
      const r = await mw.recall({ query: "food allergies diet budget area availability likes dislikes preferences", namespace: ns, limit });
      console.log(`recall    ${m.display_name} limit ${String(limit).padStart(2)} → ${r.results.length} results, dropped ${r.dropped_count ?? 0}, ${Math.round(performance.now() - t0)} ms`);
    } catch (e) {
      console.log(`recall    ${m.display_name} limit ${String(limit).padStart(2)} → ERROR after ${Math.round(performance.now() - t0)} ms: ${String((e as Error).message).slice(0, 160)}`);
    }
  }
}
process.exit(0);
