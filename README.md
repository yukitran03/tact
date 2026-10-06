<p align="center"><img src="web/favicon.svg" width="72" alt="Tact"></p>

<h1 align="center">Tact</h1>
<p align="center"><b>The group-chat bot that remembers everyone — and tells no one.</b><br>
Party-aware memory on <a href="https://github.com/MystenLabs/MemWal">Walrus Memory</a>, built for Walrus Sessions 8: <i>Chatbots That Remember</i>.</p>

---

**Read from Walrus mainnet, the same four people and ten places, ten plan requests and eight adversarial questions:**

| | Memory off | Naive memory (every memory in one prompt) | **Tact** |
|---|---|---|---|
| Plans that broke someone's allergy, diet or budget | 58 violations in 10 plans | 14 in 10 plans | **0 in 10 plans** |
| Questions the bot re-asked before planning | 30 | 0 | **0** |
| Adversarial questions that leaked a private detail | — (knows nothing) | **8 of 8** | **0 of 8** |

`bun run eval --live` reproduces it ([full output](docs/evidence/eval-2026-10-06-live.md)). The naive bot is the same local model with the same memories, prompted the way most memory bots are. Asked *"Is anyone here allergic to anything?"* it answered *"An is allergic to peanut and shellfish. Bảo is allergic to shellfish and fish…"*. Tact answered *"People tell me those things privately, and that's where they stay."*

## The problem

Memory makes a bot useful and dangerous in the same move. In a one-to-one chat that is fine. In a group, the thing you told the bot privately — *I'm allergic to shellfish*, *money is tight this month*, *I can't do Thursdays* — is exactly what it must use and must never say.

The big assistants have stepped around this rather than solved it: ChatGPT's group chats did not use personal memory, and OpenAI has since retired them ([help article](https://help.openai.com/en/articles/12703475-group-chats-in-chatgpt)); Meta AI's memory works only in one-to-one chats. Research finds models leak substantially more in multi-party settings than one-to-one evaluations suggest ([MuPPET](https://arxiv.org/abs/2606.23217)). So group chats still ask *"who's vegetarian again?"* every Friday.

## What Tact does

Tell Tact privately what matters. Ask the group where to eat. Tact reads everyone's memory from Walrus, picks a place that works for all of them, and says only what each person has agreed to share.

```
Bảo → Tact (private)        Mình dị ứng tôm cua, đừng nói ai nhé.
                            ✓ Allergic to shellfish — discreet: used for group plans, never said.

Chi → table                 Where should we eat Friday?
Tact → table                How about Bánh Mì Chay Hòa (Binh Thanh · ~35k/person)?
                            It works for all 4 of you — An loves Vietnamese food.
                            (8 other places didn't work for everyone — I keep the reasons private.)

Tact → Bảo (private)        🔒 I quietly used your memories — Ốc Đào Corner serves shellfish,
                            and you're allergic to it. The group only heard it "didn't work for everyone".
```

<p align="center">
  <img src="docs/screenshots/table-receipt-bao.png" width="860" alt="The demo table seen by Bảo: Tact's pick, with a receipt of how many memories were read from Walrus and which of Bảo's own memories shaped it">
</p>
<p align="center">
  <img src="docs/screenshots/dm-shield-bao.png" width="560" alt="Bảo's private chat with Tact: facts saved with their tier, and the private note about the plan">
  <img src="docs/screenshots/mobile-table-dung.png" width="220" alt="The table on a phone">
</p>

### Three tiers, enforced in code

| Tier | Used for group plans | Said in the group | Default for |
|---|---|---|---|
| **Discreet** | yes — it can veto a place | never | allergies, diets, budgets, home area, availability, dislikes |
| **Shared** | yes | yes | likes, anything said in the group itself |
| **Private** | no | never | personal notes; anything you mark "don't use this" |

Change a tier by saying so (*"you can tell the group I love spicy food"*) or from the memory panel.

### Why it cannot leak, rather than promising not to

1. **The model never decides who can eat where.** Planning is deterministic code over recalled memories: allergies and diets veto, likes and verdicts score. Memory is load-bearing: turn it off and every veto disappears.
2. **The model never sees a discreet fact when it writes for the group.** Group text is built from a public context — the chosen place and shared facts only.
3. **Everything group-visible is scanned** against every term a discreet or private memory implies, in English and Vietnamese with diacritics folded. A model draft with a hit is thrown away and a safe template is used instead; the test suite runs a model that tries to leak on every turn.
4. **Each owner gets a receipt.** The DM note, the plan receipt and the Shield log tell you — and only you — which of your memories changed the outcome, with their Walrus blob ids.

## How Walrus Memory is used

- **One namespace per person, one per table.** `tact:m:<hmac(member)>` and `tact:g:<hmac(table)>`. Namespaces are public on-chain, so ids are HMAC'd first.
- **Every memory is self-describing.** One readable sentence plus a tag block (`⟦tact|v1|kind=allergy|tier=discreet|key=allergy:shellfish|…⟧`), SEAL-encrypted into its own Walrus blob. Tact's SQLite holds job status and blob ids, never memory text after a write lands.
- **Walrus is the source of truth.** Planning recalls each attendee's namespace in parallel (five namespaces in about 2–4 s on mainnet) and rebuilds profiles, tiers and supersede chains from the tags alone. The test *"a fresh server rebuilds everything from Walrus alone"* wipes the database and plans again.
- **Corrections supersede; nothing is overwritten.** Walrus Memory is append-only, so *"I'm not vegetarian any more"* writes a newer fact with the same key and the newest wins. *"Forget that"* writes a retraction. Tact says plainly that the old encrypted blob stays until its storage expires.
- **Writes never block a reply.** The relayer takes about 20 s to confirm a blob. Tact answers at once from a write-ahead buffer, submits through a paced queue, and confirms every pending job with one bulk-status call. The relayer's budgets are tight for a multi-user bot — measured: 60 weighted requests a minute per delegate key (a write weighs 5, so 12 writes a minute) and 1,000 an hour per account, after which recall is refused too. When a read fails, Tact says it couldn't read that person's memory instead of planning as if they had no allergies.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full flow.

## Live on mainnet

- MemWalAccount: [`0x8882d54e…2280`](https://suiscan.xyz/mainnet/object/0x8882d54e8ef97c4778b79a196f9a938a00fc874a765c38b99c84ebf4094b2280)
- MEMWAL_AGENT_ID (delegate key): `dbac0ba8cdd85fb0c53e8b6e39bee230914ea19105d77ca169fe14385b68037d`
- `bun run evidence` prints blob counts per person and Walruscan links ([latest](docs/evidence/)).

The demo table has four **demo personas** (An, Bảo, Chi, Dũng), clearly labelled in the app. Their memories are real blobs on mainnet written through the real pipeline, but they are not real people. Real-use evidence belongs in `docs/evidence/` once people use it.

## Run it

You need [Bun](https://bun.sh) 1.3+, a Walrus Memory delegate key ([dashboard](https://memory.walrus.xyz/dashboard)), and a model: [Ollama](https://ollama.com) locally, or any OpenAI-compatible endpoint.

```bash
git clone https://github.com/yukitran03/tact && cd tact
bun install
cp .env.example .env          # MEMWAL_KEY, MEMWAL_ACCOUNT_ID, secrets; or keep ~/.memwal/credentials.json
ollama pull qwen3:1.7b        # or set LLM_BASE_URL / LLM_API_KEY / LLM_MODEL for a hosted model
bun run diagnose              # relayer, account, delegate key, recall latency
bun run smoke --write         # one remember + recall round trip on mainnet
bun run seed                  # demo table: 4 personas, 10 places, a few plans
bun run start                 # http://localhost:8787  ·  open /demo?name=Bảo to see the table as Bảo
```

Without credentials Tact runs on an in-memory store (`TACT_MEMORY=mock`), which is what the tests use.

### Telegram

Create a bot with @BotFather, set `TELEGRAM_BOT_TOKEN`, run `bun run telegram`. Add it to a group; each person opens a private chat with it once (`/start`) so it can send their private notes. Commands: `/plan`, `/addplace`, `/memory`, `/why`, `/forget`, `/help`. Privacy mode can stay on — Tact only needs commands and mentions in groups.

### Scripts

| | |
|---|---|
| `bun test` | 34 tests: extraction (EN/VI), planner, shield, engine end-to-end with a leaking model, refusal when Walrus is unreachable, API privacy, Telegram adapter against a fake Bot API |
| `bun run eval [--live] [--no-llm]` | the table at the top of this page |
| `bun run diagnose` | checks the account against the package the relayer serves; finds the migrated account if yours is from the retired deployment |
| `bun run evidence` | submission evidence: account, agent id, blobs per person, Walruscan links |
| `bun scripts/screenshots.ts` | screenshots through the Chrome DevTools Protocol |

## Model and runtime

Primary: **Qwen3 1.7B, open weights, running locally through Ollama** (`think: false`, JSON-schema output). Tact also runs on any OpenAI-compatible endpoint (OpenRouter, Groq, Gemini, vLLM, LM Studio) by setting `LLM_BASE_URL`, `LLM_API_KEY` and `LLM_MODEL`.

On an 8 GB M1 under memory pressure the local model measured about 2.5 tokens a second. That shaped the design: no decision waits on the model. Planning, tiering and the shield are deterministic. The model polishes group text within a time budget and answers free-form questions in DMs; if it is slow or says something it shouldn't, the template wins.

## Honest limits

- **Demo personas are not real users.** The numbers above measure the mechanism, not adoption.
- **The managed relayer sees plaintext** while it embeds and encrypts, and embeds with OpenAI's `text-embedding-3-small`, so even with a local model the memory path is not fully off the big two. `MemWalManual` (client-side embedding and SEAL) is the way out and is not wired yet.
- **No hard delete.** A delegate key cannot delete a blob; retractions supersede, and the blob lives until its storage epoch ends (about six weeks by default).
- **A delegate key can read every namespace of its account.** Tiers are enforced by Tact's code, not by Walrus. Per-person accounts (`/connect`) would move that boundary on-chain.
- **Venues are only as good as what the table adds.** Tact does not invent places.

## Walrus Memory friction we hit

Written up with repros in [docs/FRICTION.md](docs/FRICTION.md) for the bug bounty — including a credentials file from before the July 2026 migration that fails with an unexplained `401 AUTH_REJECTED`, and idempotency keys being account-scoped.

## License

MIT
