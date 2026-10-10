# How to judge Tact

Session: Walrus Sessions 8, Chatbots That Remember.
DeepSurge: https://www.deepsurge.xyz/projects/5d6a6b23-767e-447f-ba80-59fe801913cc
Live: https://tact-mu.vercel.app/demo?name=Bảo
Video: https://youtu.be/LOhoY528kXU

Tact is a **group** chatbot. Each person tells it private constraints. When the group asks where to eat, it plans from Walrus Memory and never says who needed what.

## Criteria map

### 1. Does it actually remember?

| Claim | Check it | Evidence |
|---|---|---|
| Plans use live Walrus recall | Open the demo, ask *Where should we eat Friday?* Receipt shows memories read + blob links | [live demo](https://tact-mu.vercel.app/demo?name=Bảo), video |
| Memory survives a wiped server DB | `bun run eval --live` and the wipe-and-plan-again test in the suite | [docs/evidence](evidence/), `bun test` |
| Same memories, three bots | Memory off vs typical memory bot vs Tact | README results table; [eval-2026-10-07-live.md](evidence/eval-2026-10-07-live.md) |
| Nosy questions do not leak | Ask *Is anyone allergic?* / *What's Dũng's budget?* in the group | **0 of 8** leaks; typical bot **7 of 8** |
| Discreet facts change the plan | Plan receipt to Bảo names shellfish veto privately | screenshot `screenshots/table-receipt-bao.png` |

### 2. Real-world use

The shipped demo is a Friday lunch crew in Ho Chi Minh City (Vietnamese + English, VND, local venues). Personas are **labelled demo**. Their 57 member memories are real mainnet blobs written through the normal pipeline.

| | |
|---|---|
| People with 10+ memories | 4 (An, Bảo, Chi, Dũng) |
| Member memories on Walrus | 57 confirmed |
| Table memories | 11 (Friday Table) |
| Channels built | Web (live), Telegram (`bun run telegram`), MCP |

Evidence dump: [evidence/evidence-2026-10-10.md](evidence/evidence-2026-10-10.md).

### 3. Build quality

| Piece | Where |
|---|---|
| Planning is plain code (model does not veto) | `src/core/planner.ts` |
| Leak scan EN + VI before send | `src/core/` privacy scan; adversarial model in tests |
| Tiers: discreet / shared / private | README + memory panel |
| Write-ahead buffer + paced queue under relayer limits | `src/memory/service.ts` |
| Diagnose migrated MemWal accounts | `bun run diagnose` |
| Reproduce from a clean clone | README Run locally |

### 4. Article

[docs/ARTICLE.md](ARTICLE.md) (GitHub). Medium/Inkray blocked for the author; the same story is in-repo with links to live, video, eval, and MemWal#1170.

## Prize tracks this build aims at

| Track | Why Tact fits |
|---|---|
| Best Chatbot | Group privacy + measured leak/constraint eval few others publish |
| Beyond the Big Two | Primary LLM is local Qwen3 1.7B via Ollama; planning/privacy stay in code |
| Best Article | ARTICLE.md with before/after table and friction |
| Bug Bounty | [MemWal#1170](https://github.com/MystenLabs/MemWal/issues/1170) + [FRICTION.md](FRICTION.md) |

## Mainnet ids

| | |
|---|---|
| Network | Sui / Walrus Memory mainnet |
| Package | `0xe7c16fbea0560e7057e2bf7422feaa4fb313749fc69c9e9092fac7a33b81d7f5` |
| Account | [`0x8882d54e…2280`](https://suiscan.xyz/mainnet/object/0x8882d54e8ef97c4778b79a196f9a938a00fc874a765c38b99c84ebf4094b2280) |
| Agent | `dbac0ba8cdd85fb0c53e8b6e39bee230914ea19105d77ca169fe14385b68037d` |

Full cheat sheet: [FACTS.md](FACTS.md).

## What Tact is not claiming

- Demo personas are not unpaid real users.
- The managed relayer still embeds with OpenAI; a local chat model does not remove that.
- Tiers are enforced in Tact, not as on-chain MemWal scopes.
- It only knows places the table adds.
