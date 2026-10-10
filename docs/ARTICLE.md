# How to add memory to a group chatbot without leaking what people tell it in private

Measured on Walrus Memory mainnet for Walrus Sessions 8.

Every friend group has the Friday thread. Where are we eating? Someone suggests seafood. The friend who is allergic to shellfish does not want to say so in front of eight people. Someone else is short on money this month. Forty messages later the group goes back to last week's place.

A chatbot with memory should help here, and mostly it does not. In a group, the most useful memories are the ones a bot must never say. ChatGPT's group chats did not use personal memory. Meta AI keeps memory to one-to-one chats. I built Tact to remember everyone in the group and keep what they told it to itself.

## What it does

You tell Tact things in a private chat, for example *mình dị ứng tôm cua, đừng nói ai nhé* ("I'm allergic to shellfish, don't tell anyone"). Later the group asks where to eat on Friday. Tact reads every member's memory, picks a place that works for all of them, and only says what each person agreed to share:

> **Tact:** How about Bánh Mì Chay Hòa (Binh Thanh · ~35k/person)? It works for all 4 of you: An loves Vietnamese food. (8 other places didn't work for everyone. The reasons stay private.)

Bảo then gets a private note: *Ốc Đào Corner serves shellfish, and you're allergic to it. The group only heard that it didn't work for everyone.*

## How Walrus Memory is wired in

Each person has their own Walrus Memory namespace, and each group has one. Namespace names are public on-chain, so the ids are hashed first. Every fact is one SEAL-encrypted blob: a readable sentence plus a tag block with kind, tier, supersede key and timestamp.

```
Allergic to shellfish. Must avoid it. ⟦tact|v1|kind=allergy|tier=discreet|key=allergy:shellfish|…⟧
```

Tact's database keeps job ids and blob ids, never the memory text once Walrus confirms it. One test deletes the server database and plans again from recall alone. A plan recalls every attendee's namespace in parallel (about 2 to 4 seconds for five namespaces on mainnet) and rebuilds each profile from the tags.

Tiers: **discreet** (default for allergies, diets, budgets, areas: used to veto, never said), **shared** (can be quoted), or **private** (never used for the group). Planning is plain code. The model that writes group messages never sees a discreet fact, and every group message is scanned in English and Vietnamese; a leaking draft is replaced by a template.

## Before and after

Same demo table on Walrus mainnet: 4 people, 10 places, 10 plan requests, 8 nosy questions.

| | Memory off | Typical memory bot | Tact |
|---|---|---|---|
| Allergy, diet or budget violations | 58 | 14 | **0** |
| Questions asked again | 30 | 0 | **0** |
| Nosy questions that leaked | n/a | **7 of 8** | **0 of 8** |

The typical bot puts every recalled memory into one prompt. Asked "Is anyone allergic?", it listed everyone's allergies. Asked for one person's budget, it gave the number. Memory used carelessly in a group is worse than no memory.

## What broke along the way

- **401 on day one.** The MCP credentials file still named a pre-migration account in the retired package. `bun run diagnose` finds the migrated id.
- **409 when two people shared an allergy.** Idempotency keys are account-wide, not per namespace. Each write now gets its own key ([MemWal#1170](https://github.com/MystenLabs/MemWal/issues/1170)).
- **Tight write budget.** One key gets about 12 writes a minute; the account caps around 200 an hour, and then recall fails too. Tact answers from a write-ahead buffer and refuses to plan blind.
- **A question became a fact.** "Which of us is vegetarian?" was stored about the asker. Questions are no longer extracted.

## Real use

From 6 to 9 October 2026 the bot ran on mainnet with four labelled demo personas (11 to 12 blobs each, 57 member memories total). The web demo opens the table as any of them (`/demo?name=Bảo`) with plan receipts and Walruscan links. A multi-user simulator later ran 90+ interleaved turns for six people with 0 violations and 0 leaks. They are labelled demo on purpose: the numbers measure the mechanism.

## Try it

- Live: https://tact-mu.vercel.app/demo?name=Bảo
- Video: https://youtu.be/LOhoY528kXU
- Repo: https://github.com/yukitran03/tact

Primary model: local Qwen3 1.7B via Ollama (or any OpenAI-compatible endpoint). The model never decides who can eat where.

*Built for Walrus Sessions 8: Chatbots That Remember.* #WalrusMemory

Sources: [OpenAI group chats](https://help.openai.com/en/articles/12703475-group-chats-in-chatgpt); [Meta AI memory](https://alternativeto.net/news/2024/10/whatsapp-s-new-meta-ai-chat-memory-to-personalize-conversations-with-stored-details); [MuPPET](https://arxiv.org/abs/2606.23217).
