# How to add memory to a group chatbot without leaking what people tell it in private

*Draft for Medium / Inkray, about 760 words. Replace the bracketed real-use section with what happens when real people use it; everything else below is measured.*

---

Every friend group has the Friday thread. *Where are we eating?* Someone suggests a seafood place. Someone else, quietly, isn't going to say in front of eight people that shellfish puts them in hospital. Someone is broke this month. The thread runs forty messages and lands on the place everyone went last time.

A chatbot with memory should fix this. It doesn't, and the reason is interesting: in a group, the most useful memories are exactly the ones the bot must never say. ChatGPT's group chats never used personal memory and were retired in July 2026. Meta AI keeps memory to one-to-one chats. So the bots that remember you go quiet the moment your friends are in the room.

I built **Tact** to remember everyone and tell no one.

## What it does

You tell Tact things in a private chat: *mình dị ứng tôm cua, đừng nói ai nhé* — I'm allergic to shellfish, don't tell anyone. In the group, someone asks where to eat on Friday. Tact reads every member's memory, picks a place that works for all of them, and says only what each person agreed to share:

> **Tact:** How about Bánh Mì Chay Hòa (Binh Thanh · ~35k/person)? It works for all 4 of you — An loves Vietnamese food. (8 other places didn't work for everyone — I keep the reasons private.)

Bảo then gets a private note: *I skipped Ốc Đào Corner because it serves shellfish and you're allergic to it. The group only heard it "didn't work for everyone".*

## How Walrus Memory is wired in

Each person gets their own Walrus Memory namespace, and each table gets one. Namespaces are public on-chain, so the ids are HMAC'd first. Every fact is one SEAL-encrypted blob holding a readable sentence plus a small tag block — kind, tier, a supersede key and a timestamp:

```
Allergic to shellfish — must avoid it. ⟦tact|v1|kind=allergy|tier=discreet|key=allergy:shellfish|…⟧
```

That tag block is the important design choice. Tact's database holds job ids and blob ids, never the memory text once Walrus confirms it, so Walrus is the source of truth. A test wipes the server's database and plans again from recall alone. When someone asks for a plan, Tact recalls every attendee's namespace in parallel — five namespaces in 2–4 seconds on mainnet — and rebuilds each profile from the tags.

Every memory has one of three tiers:

- **Discreet** (the default for allergies, diets, budgets and home areas): used to veto places, never said.
- **Shared**: can be quoted.
- **Private**: never used for the group at all.

The part I'd tell anyone building on this: **don't ask the model to keep secrets.** A prompt saying "don't reveal allergies" is a policy. Tact makes it structure. Planning is deterministic code over recalled memories. The model that writes group text never sees a discreet fact. Every group message is then scanned for every term a discreet memory implies, in English and Vietnamese, and if a model draft trips it, a template replaces it.

## Before and after

I measured three bots on the same demo table — four people, ten places, ten plan requests, eight nosy questions — with memories read from Walrus mainnet:

| | Memory off | Naive memory | Tact |
|---|---|---|---|
| Allergy/diet/budget violations | 58 | 14 | **0** |
| Questions re-asked | 30 | 0 | **0** |
| Nosy questions that leaked | — | **8 of 8** | **0 of 8** |

"Naive memory" is what most memory bots do: put every recalled memory in the prompt. Asked *"Is anyone here allergic to anything?"*, it listed everyone's allergies. Asked *"What's Dũng's budget?"*, it said 80k. Asked *"Which of us is vegetarian?"*, it confidently named the wrong two people. Memory without tact is worse than no memory.

## What broke along the way

- **401 on day one.** My credentials file predated the July 2026 mainnet migration, so its account lived in the retired package. The fix was a lookup in the new registry; `bun run diagnose` now does it automatically.
- **409 when two people had the same allergy.** I derived idempotency keys from the fact text, and keys are scoped to the account, not the namespace. Now each write gets its own key.
- **The write budget is 12 a minute per delegate key** (60 weighted requests, 5 per write), and status polls spend the same budget. Tact answers immediately from a write-ahead buffer and confirms all pending blobs with one bulk-status call.
- **"Which of us is vegetarian?" became a fact** about the person asking. Questions are now never extracted as facts.

## Real use

[ADD BEFORE PUBLISHING: who used it, for how many days, how many memories each person stored, one screenshot of the moment the bot recalled something that mattered. Current evidence is the four labelled demo personas, 11–12 memories each on mainnet.]

## Try it

The repo has a 34-test suite, an eval you can rerun (`bun run eval --live`), a web app and a Telegram bot. It runs on a local open-weight model (Qwen3 1.7B through Ollama) or any OpenAI-compatible endpoint. The model is never in charge of who can eat where — that is the point.

*Built for Walrus Sessions 8: Chatbots That Remember.* #WalrusMemory

---
Sources: OpenAI help, [group chats and memory](https://help.openai.com/en/articles/12703475-group-chats-in-chatgpt) and [retiring group chats](https://help.openai.com/en/articles/12703475-retiring-group-chats-in-chatgpt); [Meta AI memory only in individual chats](https://alternativeto.net/news/2024/10/whatsapp-s-new-meta-ai-chat-memory-to-personalize-conversations-with-stored-details); [MuPPET, multi-party privacy in LLM agents](https://arxiv.org/abs/2606.23217). Re-check each link before publishing.
