# Walrus Memory friction found while building Tact

Filed from `yukitran03` on 2026-10-10 against https://github.com/MystenLabs/MemWal/issues (checked for duplicates on 2026-10-07).

| § | Filed as |
|---|---|
| 1 migrated-account 401 | comment on #819 → https://github.com/MystenLabs/MemWal/issues/819#issuecomment-6095666837 |
| 2 idempotency scope | **new** #1170 → https://github.com/MystenLabs/MemWal/issues/1170 |
| 3 rate-limit numbers | comments on #1073 and #1116 |
| 4 OpenAI on memory path | comment on #1077 |
| 5 discreet read scope | comment on #308 |

Environment for all: `@mysten-incubation/memwal` 0.1.8, Bun 1.3.10, macOS 14 (arm64), managed mainnet relayer `https://relayer.memory.walrus.xyz` (`/health` ok, package `0xe7c16fbe…d7f5`), model Qwen3 1.7B via Ollama 0.35.1 (local).

---

## 1. Comment on #819: a recipe that resolves the migrated account automatically

#819 reports that accounts minted under the retired package fail with a generic `401 AUTH_REJECTED`. We hit the same thing from a different door: **the credentials file the official MCP wrote in July 2026 still names the pre-migration account**, so any tool that reads `~/.memwal/credentials.json` (our bot, the MCP itself) gets 401 with no hint.

What resolved it, in four reads, no signing:

1. `GET /config` → `packageId` (current: `0xe7c16fbe…`).
2. `sui_getObject(accountId)` → type `0xcee7a6fd…::account::MemWalAccount` (retired package) and `owner`.
3. `sui_getObject(<registry 0x8bf82c9e…199f>)` → `accounts` table id.
4. `suix_getDynamicFieldObject(table, {type: "address", value: owner})` → the migrated account id. Its `delegate_keys` contain the same public key, so the same key works once the id is swapped.

`scripts/diagnose.ts` in this repo does exactly that and prints `set MEMWAL_ACCOUNT_ID=…`. Suggestion: the SDK could do steps 1 to 4 when it receives `AUTH_REJECTED` and say "this account belongs to the retired package; your migrated account is 0x…". The MCP could rewrite `accountId` in the credentials file on next login.

---

## 2. New issue: idempotency keys are scoped to the account, which the docs don't say

**Summary.** `remember(text, namespace, { idempotencyKey })` keys are deduplicated across the whole account, not per namespace. A multi-tenant app that derives keys from content (a natural choice: "same fact → same key") collides as soon as two users store the same fact.

**Repro** (`scripts/repro-idempotency.ts`):
```ts
const key = `repro-${Date.now()}`;
await mw.remember("Identical fact for two users.", "app:user-a", { idempotencyKey: key });
await mw.remember("Identical fact for two users.", "app:user-b", { idempotencyKey: key });
```
**Verified on mainnet 2026-10-07** (`bun scripts/repro-idempotency.ts`), identical text, same key, two namespaces:
```
namespace A accepted: cdf6082a-6d2b-4b7f-8331-65b180011a85 running
namespace B rejected: Walrus Memory server error (409): {"error":"idempotency_key was already used for a request with different content"}
```
So the key is looked up account-wide and the namespace counts as part of the "content". In real use, two users each said "I'm allergic to peanuts"; with content-derived keys the second write failed the same way: six of 57 writes in our first seed.

**Expected:** either keys scoped per `(owner, namespace)`, or the docs and the `idempotencyKey` JSDoc stating the scope and recommending a per-write id. Related: #1057 (reuse with different content is a permanent lockout), #1083 (default key derivation).

---

## 3. Comment on #1116 / #1073: what the per-key budget means for a bot, in numbers

A 429 from the mainnet relayer names the layer: `{"error":"Rate limit exceeded","layer":"delegate_key","limit":"60 weighted-requests/min","retry_after_seconds":60}`. With `remember` weighing 5, **one delegate key gets 12 writes a minute** for every user of a server-side bot. Status polls (weight 1) spend the same budget, so one poller per pending write (what `rememberAndWait` does per call) hits the limit by itself once ten writes are in flight.

There is a second, slower layer. After two demo seeds and an eval in the same hour, every call (recall included) answered `{"error":"Rate limit exceeded","layer":"account_sustained","limit":"1000 weighted-requests/hour","retry_after_seconds":300}`. **1,000 weighted requests an hour is about 200 writes an hour for the whole account**, before any reads or polls; a bot with fifty active users onboarding at once would exhaust it in minutes, and once it does, recall stops too, the bot loses its memory for everyone, not just its ability to write.

What worked for us: pace writes at 10/min, answer users from a write-ahead buffer, confirm all pending jobs with a single `getRememberBulkStatus()` every few seconds, and treat a failed recall as "couldn't read" in the reply rather than as "no memories". Suggestions: document the three layers (`delegate_key` per minute, account per minute, `account_sustained` per hour) and the weights; return `X-RateLimit-Remaining` per layer; consider a separate, larger budget for reads so a burst of writes cannot blind every recall.

---

## 4. Beyond the Big Two: the managed relayer keeps OpenAI in the memory path

Tact's primary model is local and open-weight (Qwen3 1.7B on Ollama), chosen so no conversation leaves the machine for a big-two API. The managed relayer, however, embeds every memory and every recall query with OpenAI `text-embedding-3-small` (relayer `embedder.rs`), and `analyze()` extracts facts with `gpt-4o-mini`. A builder who wants "no OpenAI anywhere" has two options, neither documented as such: avoid `analyze()` (we extract facts ourselves with the local model and rules), and move to `MemWalManual` with client-side embeddings, which then must match the relayer's 1536-dimension index. Suggestion: state the embedding and extraction models in the relayer docs and `/health`, and say whether `MemWalManual` accepts other dimensions. Related: #1077.

---

## 5. Improvement idea: a "shared but not quotable" read scope

Delegate keys have no scopes: any delegate can read every namespace of the account, and `seal_approve` ignores the namespace. Tact enforces "discreet" (use it to decide, never say it) in application code. A first-class way to share a memory with another account for *use* without *disclosure* (or simply per-namespace delegate scopes) would let group bots move that boundary on-chain. Related: #308 (shared-memory examples).
