# How to add memory to a group chatbot without leaking what people tell it in private

*For Medium or Inkray, about 750 words. Measured on Walrus Memory mainnet for Walrus Sessions 8.*

---

Every friend group has the Friday thread. Where are we eating? Someone suggests a seafood place. The friend who is allergic to shellfish doesn't want to say so in front of eight people. Someone else is short on money this month. Forty messages later the group goes back to the place it went last week.

A chatbot with memory should help here, and mostly it doesn't. In a group, the most useful memories are the ones a bot must never say. ChatGPT's group chats did not use personal memory, and OpenAI has since retired them. Meta AI keeps memory to one-to-one chats. The bots that remember you go quiet once your friends are in the conversation.

I built Tact to remember everyone in the group and keep what they told it to itself.

## What it does

You tell Tact things in a private chat, for example *mình dị ứng tôm cua, đừng nói ai nhé* ("I'm allergic to shellfish, don't tell anyone"). Later someone in the group asks where to eat on Friday. Tact reads every member's memory, picks a place that works for all of them, and only says what each person agreed to share:

> **Tact:** How about Bánh Mì Chay Hòa (Binh Thanh · ~35k/person)? It works for all 4 of you: An loves Vietnamese food. (8 other places didn't work for everyone. The reasons stay private.)

Bảo then gets a private note: *Ốc Đào Corner serves shellfish, and you're allergic to it. The group only heard that it didn't work for everyone.*

## How Walrus Memory is wired in

Each person has their own Walrus Memory namespace, and each group has one. Namespace names are public on-chain, so the ids are hashed first. Every fact is one SEAL-encrypted blob containing a readable sentence and a small tag block with its kind, tier, a supersede key and a timestamp:

```
Allergic to shellfish. Must avoid it. ⟦tact|v1|kind=allergy|tier=discreet|key=allergy:shellfish|…⟧
```

The tag block is the design choice I'd point other builders to. Tact's database holds job ids and blob ids, never the memory text once Walrus confirms it, so Walrus is the source of truth. One test deletes the server's database and plans again from recall alone. When someone asks for a plan, Tact recalls every attendee's namespace in parallel, which takes 2 to 4 seconds for five namespaces on mainnet, and rebuilds each profile from the tags.

Every memory has one of three tiers:

- **Discreet**, the default for allergies, diets, budgets and home areas: used to veto places, never said.
- **Shared**: can be quoted in the group.
- **Private**: never used for the group.

The main lesson: don't rely on the model to keep secrets. A prompt that says "don't reveal allergies" is a request, not a guarantee. In Tact, planning is plain code over recalled memories, and the model that writes group messages never sees a discreet fact. Every group message is also scanned for anything a discreet memory implies, in English and Vietnamese. If a model draft trips the scan, a template replaces it.

The same shield is what the MCP channel uses. Claude Code or Codex can act as one person at the table with a hashed agent token; each tool call still runs under that person's namespaces and tiers, so an agent that asks "who is allergic?" gets the same refusal the group would.

## Before and after

I compared three bots on the same demo table, with memories read from Walrus mainnet: 4 people, 10 places, 10 plan requests and 8 nosy questions.

| | Memory off | Typical memory bot | Tact |
|---|---|---|---|
| Allergy, diet or budget violations | 58 | 14 | **0** |
| Questions asked again | 30 | 0 | **0** |
| Nosy questions that leaked | n/a | **7 of 8** | **0 of 8** |

The model's answers vary from run to run: in two recorded runs the typical bot leaked on 8 and then 7 of the 8 questions, while Tact stayed at 0. The typical memory bot puts every recalled memory into the prompt, which is what most memory bots do. Asked *"Is anyone here allergic to anything?"*, it listed everyone's allergies. Asked about one person's budget, it gave the number. It also named the wrong people as vegetarian. Memory used carelessly in a group is worse than no memory.

## What broke along the way

- **401 on the first day.** My credentials file was older than the July 2026 mainnet migration, so it pointed at an account in the retired package. The new account id was in the current registry. `bun run diagnose` now finds it automatically.
- **409 when two people had the same allergy.** I derived idempotency keys from the fact text, and the relayer checks keys across the whole account, not per namespace. Each write now gets its own key.
- **Tight write budget.** One delegate key gets 60 weighted requests a minute, and a write costs 5, so 12 writes a minute for every user of the bot. There is also a limit of 1,000 an hour per account; after that, recall fails too. Tact replies immediately from a write-ahead buffer, confirms pending writes with one bulk call, and refuses to plan when it can't read someone's memory.
- **A question became a fact.** "Which of us is vegetarian?" was stored as a fact about the person asking. Questions are no longer extracted.

## Real use

From 6 to 9 October 2026 the bot ran against Walrus Memory mainnet with four labelled demo personas (An, Bảo, Chi, Dũng). Each has 11 to 12 SEAL-encrypted blobs today (57 member memories plus the table's places). The web demo opens the same table as any persona (`/demo?name=Bảo`), shows the plan receipt that only that person can see, and links each fact to Walruscan. A multi-user simulator later walked six people through 90+ interleaved turns (private facts, plans, mind-changes, nosy probes) and still scored 0 hard-constraint violations and 0 group leaks. Those people are labelled demo personas on purpose: the numbers measure the mechanism. If you try it with your own friends, the invite code and the Telegram adapter are the same path the demo uses.

## Try it

The repo includes 50+ tests, `bun run eval --live`, `bun run simulate`, a web app, an MCP server for Claude Code / Codex, and a Telegram bot. It runs on a local open-weight model (Qwen3 1.7B through Ollama) or any OpenAI-compatible endpoint. The model never decides who can eat where.

*Built for Walrus Sessions 8: Chatbots That Remember.* #WalrusMemory

---
Sources: OpenAI help, [group chats and memory](https://help.openai.com/en/articles/12703475-group-chats-in-chatgpt); [Meta AI memory only in individual chats](https://alternativeto.net/news/2024/10/whatsapp-s-new-meta-ai-chat-memory-to-personalize-conversations-with-stored-details); [MuPPET, multi-party privacy in LLM agents](https://arxiv.org/abs/2606.23217). Check each link before publishing.
