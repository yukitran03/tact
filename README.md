<p align="center"><img src="web/favicon.svg" width="64" alt=""></p>

<h1 align="center">Tact</h1>

<p align="center">A group chat bot that remembers what each person tells it in private, and uses it to plan for the whole group without repeating it.<br>
Built on <a href="https://github.com/MystenLabs/MemWal">Walrus Memory</a> for Walrus Sessions 8, <i>Chatbots That Remember</i>.</p>

<p align="center"><img src="docs/screenshots/landing-light.png" width="900" alt="Tact landing page"></p>

## Results

Measured with memories read from Walrus mainnet: 4 people, 10 places, 10 plan requests and 8 nosy questions, three bots.

| | Memory off | Typical memory bot | Tact |
|---|---|---|---|
| Plans that broke someone's allergy, diet or budget | 58 violations | 14 violations | **0** |
| Questions asked again before planning | 30 | 0 | **0** |
| Nosy questions that leaked a private detail | n/a, it knows nothing | **7 of 8** | **0 of 8** |

The typical memory bot is the same local model with the same memories, all placed in one prompt, which is how most memory bots work. Asked *"Is anyone here allergic to anything?"*, it listed everyone's allergies. Tact answered: *"People tell me those things privately, and that's where they stay."*

The model's answers vary between runs. In the two recorded runs the typical memory bot leaked on 8 and then 7 of the 8 questions and broke 14 constraints each time. Tact stayed at 0 in both. The older run file quotes the bot's replies verbatim from before its wording was simplified.

Reproduce with `bun run eval --live`. Full output: [docs/evidence](docs/evidence/).

## The problem

In a group chat, the most useful memories are the ones a bot must never say out loud: an allergy, a tight budget, a day someone can't make. ChatGPT's group chats did not use personal memory, and OpenAI has since retired them ([help article](https://help.openai.com/en/articles/12703475-group-chats-in-chatgpt)). Meta AI keeps memory to one-to-one chats. Research finds models leak much more in group settings than in one-to-one tests ([MuPPET](https://arxiv.org/abs/2606.23217)).

## What Tact does

You tell Tact things in a private chat. When someone in the group asks where to eat, Tact reads every member's memory from Walrus, picks a place that works for all of them, and only says what each person agreed to share.

```
Bảo, in a private chat   Mình dị ứng tôm cua, đừng nói ai nhé.  (I'm allergic to shellfish, don't tell anyone.)
Tact                     Saved: allergic to shellfish (discreet: used for group plans, never said).

Chi, in the group        Where should we eat Friday?
Tact, in the group       How about Bánh Mì Chay Hòa (Binh Thanh · ~35k/person)?
                         It works for all 4 of you: An loves Vietnamese food.
                         (8 other places didn't work for everyone. The reasons stay private.)

Tact, privately to Bảo   About the plan in "Friday Table", here is how your memories were used:
                         Ốc Đào Corner serves shellfish, and you're allergic to it.
                         The group only heard that it "didn't work for everyone".
```

<p align="center"><img src="docs/screenshots/table-receipt-bao.png" width="900" alt="The demo table seen by Bảo, with the plan receipt"></p>

## Memory tiers

| Tier | Used for group plans | Said in the group | Default for |
|---|---|---|---|
| Discreet | yes, it can veto a place | never | allergies, diets, budgets, home area, busy days, dislikes |
| Shared | yes | yes | likes, and anything said in the group itself |
| Private | no | never | notes, and anything marked "don't use this" |

People change a tier by saying so ("you can tell the group I love spicy food") or from the memory panel.

## How the privacy is enforced

1. Planning is plain code over recalled memories. Allergies, avoided foods, diets and budgets veto places. Likes, area and past verdicts score the rest. The model does not decide who can eat where.
2. The text the group sees is built from a public context: the chosen place and shared facts. The model never receives a discreet fact when it writes for the group.
3. Every group message is scanned for terms that a discreet or private memory implies, in English and Vietnamese, ignoring diacritics. A model draft with a hit is dropped and a template is used. The test suite runs a model that tries to leak on every turn.
4. Each person gets a private note, a plan receipt and a log that show which of their own memories changed the outcome, with Walrus blob ids.

## How Walrus Memory is used

- **One namespace per person, one per table.** `tact:m:<hmac(member)>` and `tact:g:<hmac(table)>`. Ids are hashed because namespace names are public on-chain.
- **Each memory describes itself.** A readable sentence plus a tag block (`⟦tact|v1|kind=allergy|tier=discreet|key=allergy:shellfish|…⟧`), encrypted with SEAL into its own blob. Tact's database keeps job ids and blob ids, never the memory text after a write lands.
- **Walrus is the source of truth.** A plan recalls every attendee's namespace in parallel (five namespaces in 2 to 4 seconds on mainnet) and rebuilds profiles, tiers and corrections from the tags. One test deletes the database and plans again from Walrus alone.
- **Corrections supersede.** Walrus Memory is append-only, so "I'm not vegetarian any more" writes a newer fact with the same key, and the newest one wins. "Forget that" writes a retraction. Tact tells people that the old encrypted blob stays until its storage expires.
- **Replies don't wait for Walrus.** A write takes about 20 seconds to confirm. Tact answers right away from a write-ahead buffer, sends writes through a paced queue, and confirms pending jobs with one bulk status call.
- **It stays inside the relayer's budget.** Measured: 60 weighted requests a minute per delegate key (a write weighs 5, so 12 writes a minute) and 1,000 an hour per account, after which recall is refused too. When a read fails, Tact says it couldn't read that person's memory and does not plan as if they had no allergies.

More detail in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## On mainnet

- MemWalAccount: [`0x8882d54e…2280`](https://suiscan.xyz/mainnet/object/0x8882d54e8ef97c4778b79a196f9a938a00fc874a765c38b99c84ebf4094b2280)
- MEMWAL_AGENT_ID (delegate key): `dbac0ba8cdd85fb0c53e8b6e39bee230914ea19105d77ca169fe14385b68037d`
- `bun run evidence` prints memories per person with Walruscan links ([latest](docs/evidence/)).

The demo table has four demo personas (An, Bảo, Chi, Dũng), labelled as such in the app. Their memories are real blobs written through the normal pipeline, but they are not real people.

## Run it

Requirements: [Bun](https://bun.sh) 1.3 or newer, a Walrus Memory delegate key from the [dashboard](https://memory.walrus.xyz/dashboard), and a model, either [Ollama](https://ollama.com) locally or any OpenAI-compatible endpoint.

```bash
git clone https://github.com/yukitran03/tact && cd tact
bun install
cp .env.example .env          # MEMWAL_KEY, MEMWAL_ACCOUNT_ID and two secrets, or keep ~/.memwal/credentials.json
ollama pull qwen3:1.7b        # or set LLM_BASE_URL, LLM_API_KEY and LLM_MODEL for a hosted model
bun run diagnose              # checks the relayer, your account, the delegate key and recall latency
bun run smoke --write         # one write and one recall on mainnet
bun run seed                  # demo table: 4 personas, 10 places, a few plans
bun run start                 # http://localhost:8787, or /demo?name=Bảo to open the table as Bảo
```

Without credentials Tact uses an in-memory store (`TACT_MEMORY=mock`). The tests run that way.

### Telegram

Create a bot with @BotFather, set `TELEGRAM_BOT_TOKEN` and run `bun run telegram`. Add the bot to a group. Each person opens a private chat with it once (`/start`) so it can send them their notes. Commands: `/plan`, `/addplace`, `/memory`, `/why`, `/forget`, `/help`. Privacy mode can stay on, since Tact only needs commands and mentions in groups.

### Scripts

| Command | What it does |
|---|---|
| `bun test` | 35 tests: extraction in English and Vietnamese, planner, privacy scan, the engine with a model that tries to leak, refusing to plan when Walrus can't be read, API privacy, and the Telegram adapter against a fake Bot API |
| `bun run eval [--live] [--no-llm]` | the results table above |
| `bun run diagnose` | compares your account with the package the relayer serves and finds the migrated account if yours predates the July 2026 migration |
| `bun run evidence` | submission evidence: account, agent id, memories per person, Walruscan links |
| `bun scripts/screenshots.ts` | screenshots of the running app through the Chrome DevTools Protocol |

## Model and runtime

The primary model is Qwen3 1.7B, open weights, running locally through Ollama with JSON-schema output. Any OpenAI-compatible endpoint (OpenRouter, Groq, Gemini, vLLM, LM Studio) works through `LLM_BASE_URL`, `LLM_API_KEY` and `LLM_MODEL`.

On an 8 GB M1 the local model ran at about 2.5 tokens a second, so no decision waits on it. Planning, tiers and the privacy scan are deterministic. The model rewrites group messages within a time limit and answers open questions in private chats. If it is slow, or says something it shouldn't, the template is used.

## Limits

- The demo personas are not real users. The numbers above measure the mechanism, not adoption.
- The managed relayer sees plaintext while it embeds and encrypts, and it embeds with OpenAI `text-embedding-3-small`. Even with a local model, the memory path still involves OpenAI. `MemWalManual` (client-side embedding and SEAL) would remove that and is not wired in yet.
- A delegate key cannot delete a blob. Retractions supersede, and the blob stays until its storage period ends, about six weeks by default.
- A delegate key can read every namespace of its account. Tiers are enforced by Tact's code, not by Walrus. Separate accounts per person would move that boundary on-chain.
- Tact only knows the places a table adds. It does not invent venues.

## Feedback for Walrus Memory

Written up with repros in [docs/FRICTION.md](docs/FRICTION.md), including a credentials file from before the July 2026 migration that fails with an unexplained `401 AUTH_REJECTED`, and idempotency keys that are scoped to the account rather than the namespace.

## License

MIT
