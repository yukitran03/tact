# How Tact works

```
               private DM                                   group chat
   Bảo ── "dị ứng tôm cua" ──┐                 ┌── Chi: "where should we eat Friday?"
                             ▼                 ▼
                  ┌──────────────────────────────────────┐
                  │ Engine (src/core/engine.ts)           │
                  │  intent → extract → write | plan      │
                  └───┬───────────────────────┬──────────┘
          writeFact() │                       │ readMany() — parallel recall
                      ▼                       ▼
        ┌─────────────────────────────────────────────────────┐
        │ MemoryService (src/memory/service.ts)               │
        │  namespace = tact:m:HMAC(member) / tact:g:HMAC(table)│
        │  write-ahead buffer · paced queue · bulk poller     │
        └───────────────────────┬─────────────────────────────┘
                                │ @mysten-incubation/memwal (TS SDK 0.1.8)
                                ▼
          Walrus Memory relayer (mainnet) → SEAL-encrypted blob on Walrus
                                            → vector row (owner + namespace)
```

## A memory, on the wire

Every fact is one line. The sentence is what the relayer embeds; the tag block is what lets a fresh server rebuild everything from recall alone.

```
Allergic to shellfish — must avoid it. (said: “Mình dị ứng tôm cua, đừng nói ai nhé.”) ⟦tact|v1|kind=allergy|tier=discreet|key=allergy:shellfish|a.avoid=shellfish|src=dm|at=2026-10-07T01:30:00.000Z⟧
```

- `key` is the supersede key: newest `at` per key wins, `retract=1` removes it (`resolveFacts`, src/memory/codec.ts).
- `tier` is `private | discreet | shared` and decides who the fact may ever reach.
- Facts are written in English sentences even when said in Vietnamese, so recall distances stay stable across languages; the original words ride along in `said:`.

## A plan, step by step (`Engine.planForGroup`)

1. **Read.** Recall every member's namespace and the table's namespace in parallel (`limit 60` returns a whole namespace; Tact's are tens of facts). Facts still landing come from the write-ahead buffer. A read that fails is reported as such — the plan says *couldn't read: Dũng* instead of planning as if Dũng had no allergies.
2. **Plan** (`src/core/planner.ts`), deterministic:
   - people who said they're busy that day are excused, and a day that works for everyone is proposed;
   - allergies, avoided foods, diets (with vegetarian/halal mitigation) and budgets **veto** places;
   - likes, area, past verdicts and the requested cuisine **score** the rest; the last pick is lightly penalised for variety;
   - `private` facts are skipped entirely.
3. **Speak.** `publicContext()` keeps only the chosen place, shared reasons and counts. A template writes the group message; an optional model polish is held to the strict shield scan and dropped on any hit, timeout or error.
4. **Record.** The plan (with every influence and its tier) goes to the ledger; each non-shared influence goes to the Shield log of its owner only; owners whose discreet memory vetoed something get a private note in second person.

## The shield (`src/core/firewall.ts`)

`sensitiveTerms()` turns every non-shared fact of every member into terms: allergens in both languages, diet words, budget figures in three formats, home areas, busy days (only when the owner is named nearby), preferences (same). `scanForLeaks()` folds diacritics and matches whole words, allowing terms that appear in the public context (the chosen place's own name and area). Strict mode also counts generic words like "allergic" and "budget"; model drafts are held to strict mode.

## Tactful intents

| Said in a group | Tact |
|---|---|
| "Where should we eat Friday?", "korean bbq saturday?", "Thứ 6 ăn gì?" | plans |
| "add place: …", "thêm quán: …" | remembers a venue for the table |
| "Phở Lan was great" | remembers a verdict for the table |
| "I'm vegetarian btw" | remembers it for the speaker, **shared** (they said it out loud) |
| "What is Bảo allergic to?" | "That's Bảo's to share, not mine." |
| "Is anyone allergic to anything?", "list everyone's diets" | "People tell me those things privately, and that's where they stay." |
| "Who can't come Thursday and why?" | "Not everyone is free Thursday — I keep who and why to myself. Friday works for the whole table." |
| "Why didn't we pick Ốc Đào?" | "It didn't work for everyone this time…" (the owner can ask in DM and gets the real reason) |
| a question | never becomes a fact |

## Writes and the relayer's budget

- `writeFact()` inserts a ledger row with the encoded text and returns immediately; the reply never waits on Walrus.
- `WalrusBackend.remember()` paces writes to 10 a minute: one delegate key gets 60 weighted requests a minute and a remember weighs 5.
- One loop polls all pending jobs with `getRememberBulkStatus()`; when a blob is confirmed the row flips to `done`, gets its `blob_id`, and the buffered text is cleared.
- The idempotency key is per write (`tact-<rowId>`). A key derived from the fact alone collided across users: two people with the same allergy wrote identical facts into different namespaces under one account.
- On restart, in-flight jobs resume polling; rows that never reached the relayer are marked failed and `retryFailed()` resubmits them.

## Channels

- **Web** (`src/server`, `web/`): Bun server, Preact UI bundled at start. Sessions are HMAC-signed cookies. Demo personas can be opened with `/demo?name=Bảo`.
- **Telegram** (`src/channels/telegram.ts`): Bot API long polling, commands mapped onto the same engine, Markdown converted to Telegram HTML, private notes delivered only to people who have opened a DM with the bot.
