# Launch kit

## X post (reply under the Session 8 announcement)

> Built Tact for #WalrusMemory Session 8: a group chat bot that remembers everyone and tells no one.
>
> Tell it privately "I'm allergic to shrimp". Ask the group "where should we eat Friday?". It picks a place that works for all, and never says why.
>
> Measured on Walrus mainnet: a typical memory bot leaked private details on 7 of 8 nosy questions (8 of 8 in an earlier run). Tact: 0 of 8, and 0 broken constraints.
>
> Runs on a local Qwen3 via Ollama. @WalrusProtocol
> Demo: https://youtu.be/LOhoY528kXU
> [article link] https://github.com/yukitran03/tact

## Community post (for the Promo prize, outside Walrus and Sui)

**Where:** Viblo (Vietnamese dev blog platform), a large Vietnamese developer Facebook group, or r/LocalLLaMA (local-model angle). X, r/sui and Walrus/Sui channels do not count.

**Title (EN):** I measured what happens when a memory chatbot joins a group chat: it leaked private details on 7 of 8 questions. Here's the fix.

**Title (VI):** Chatbot có trí nhớ vào group chat là lộ bí mật của mọi người: mình đo được 7/8 lần, và cách sửa

**Body (short):**
> Memory bots are built for one-to-one chats. In a group, the most useful memories (allergies, budgets, who can't come Thursday) are exactly what the bot must never say. I put every memory in the prompt the way most bots do, with a local Qwen3, and asked eight nosy questions: it leaked on seven of them, and in another run it named the wrong people as vegetarian.
>
> Tact keeps one encrypted memory namespace per person (Walrus Memory), gives every memory a tier (discreet: use it, never say it), plans in deterministic code, and scans every group message for anything a discreet memory implies. Same memories, same model: 0 of 8 leaked, 0 broken constraints.
>
> Code, eval you can rerun, and what broke along the way: [repo] · [article]

## Demo video (2 to 3 minutes, no AI voice-over)

**Published:** https://youtu.be/LOhoY528kXU

Storyboard (source for the recording):

1. **0:00 to 0:15** Hook: the Friday group thread and the friend who won't say "I'm allergic" in front of everyone.
2. **0:15 to 0:45** Bảo's private chat: type *"Mình dị ứng tôm cua, đừng nói ai nhé."* Show the saved fact marked Discreet, then the memory panel with its Walrus blob link; open Walruscan.
3. **0:45 to 1:20** Group: Chi asks *"Where should we eat Friday?"*. Show the plan card: 47 memories read from Walrus, 8 ruled out, reasons private. Cut to Bảo's private note.
4. **1:20 to 1:45** Nosy questions in the group: *"Is anyone allergic to anything?"*, *"What's Dũng's budget?"*, and Tact's answers.
5. **1:45 to 2:10** Flip the table to **Memory off**: it picks Ốc Đào and asks everyone again. Show the eval table: memory off 58 violations, typical memory bot 7 of 8 leaks, Tact 0.
6. **2:10 to 2:30** Wipe the server's database, ask again, same answer: the memory lives on Walrus. Close on the repo and article links.
