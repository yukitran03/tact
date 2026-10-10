# Submission answers: Walrus Sessions 8

Official duration ended **2026-10-09 14:00 UTC**. Results **2026-10-16**. Late forms may still work; see `docs/SUBMIT_NOW.md` for the click-through checklist.

`[YOU]` marks what only the account owner can supply. Repo is kept **private** until you flip it.

**Before submitting:**
1. `[YOU]` Make the repo public (`gh repo edit yukitran03/tact --visibility public --accept-visibility-change-consequences`). Rules require it.
2. Demo personas already meet the technical 3 × 10 memories on mainnet (`bun run evidence`). Real friends still help the story; the article is honest about demos.
3. `[YOU]` Publish `docs/ARTICLE.md` on Medium or Inkray; X post under the session announcement with @WalrusProtocol and #WalrusMemory (`docs/PROMO.md`).
4. MemWal friction **filed** 2026-10-10: https://github.com/MystenLabs/MemWal/issues/1170 (+ comments listed in `docs/FRICTION.md`).
5. `[YOU]` Optional Promo prize: Viblo, a Vietnamese dev Facebook group, or r/LocalLLaMA.

---

**Project name.** Tact

**What does your chatbot do and who is it for?**
> Tact is a group chat bot that keeps track of who told it what. Each person tells it privately what matters (allergies, diets, budget, the area they live in, days they're busy) and when the group asks where to eat, Tact reads everyone's memory from Walrus and picks a place that works for all of them, without ever saying who needed what. It is for friend groups, teams and families who plan things together in a chat and keep re-asking "who's vegetarian again?".

**What does it store and how does it use it?**
> One SEAL-encrypted Walrus blob per fact, in a namespace per person (and one per table for places and verdicts). Each fact carries a tier: discreet (used to decide, never said, the default for allergies, diets, budgets, areas, availability), shared (can be quoted), or private (never used for the group). Before every plan Tact recalls every attendee's namespace in parallel and rebuilds their profile from Walrus; deterministic code vetoes places that break an allergy, diet or budget and scores the rest by likes and past verdicts. The group only hears what is shared; each owner gets a private note about how their own memories were used.

**Use case.** Group planning (community / friends / team chat) with private constraints.

**Where is it deployed?** Web app (Bun server, `bun run start`; demo table at `/demo?name=Bảo`) and Telegram (`bun run telegram` with a BotFather token). Live: https://tact-mu.vercel.app (Vercel). Demo video: https://youtu.be/LOhoY528kXU. Telegram handle once the token exists.

**LLM / runtime.** Qwen3 1.7B (open weights) running locally through Ollama 0.35.1, `think: false`, JSON-schema outputs; any OpenAI-compatible endpoint by env. Runtime: Bun 1.3, TypeScript, `@mysten-incubation/memwal` 0.1.8 against the managed mainnet relayer.

**MEMWAL_AGENT_ID.** `dbac0ba8cdd85fb0c53e8b6e39bee230914ea19105d77ca169fe14385b68037d`

**MemWalAccount.** `0x8882d54e8ef97c4778b79a196f9a938a00fc874a765c38b99c84ebf4094b2280`, https://suiscan.xyz/mainnet/object/0x8882d54e8ef97c4778b79a196f9a938a00fc874a765c38b99c84ebf4094b2280

**Blobs on mainnet.** See `docs/evidence/evidence-*.md` (`bun run evidence`). Example: https://walruscan.com/mainnet/blob/xqkNrcCHUEi1Pnhbq9SdtlPk97hHax0RI6E_QpXS5uo

**Tool used to connect.** TypeScript SDK `@mysten-incubation/memwal` (relayer mode), server-side.

**Bug or friction point.**
> Idempotency keys are deduplicated across the whole account, not per namespace, and the docs don't say so. We derived keys from fact text, so when two people both said "I'm allergic to peanuts" the second write failed with `409 idempotency_key was already used for a request with different content`, six of our first 57 writes. Per-write keys fixed it. Filed: https://github.com/MystenLabs/MemWal/issues/1170

**Improvement idea.**
> When the relayer answers `AUTH_REJECTED` for an account in the retired package, have the SDK look up the migrated account in the current registry (four unsigned reads) and say so, and have the MCP refresh `accountId` in `~/.memwal/credentials.json`. Our credentials file predated the July migration and every call 401'd with no hint; `scripts/diagnose.ts` shows the recipe.

**Beyond the Big Two, integration friction.**
> The primary model is local and open-weight, but the managed relayer still embeds every memory and query with OpenAI `text-embedding-3-small` and `analyze()` extracts with `gpt-4o-mini`, so we avoid `analyze()` and extract facts ourselves. On an 8 GB M1 the local model ran at about 2.5 tokens/s, so Tact never waits on the model to decide anything: planning and the privacy shield are deterministic, the model only polishes text within a time budget.

**Communities outside web3 worth engaging.** Vietnamese developer communities (Viblo, J2TEAM and dev Facebook groups), r/LocalLLaMA for local-model memory, Telegram bot developer groups.

**X account / Sui address / Discord / email.** `[YOU]`
