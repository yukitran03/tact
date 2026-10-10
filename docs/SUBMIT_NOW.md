# Submit Tact (late checklist)

Official Hackathon Duration ended **2026-10-09 14:00 UTC**. Results are due **2026-10-16**. Forms may still accept a late entry; treat that as uncertain and submit as soon as the blockers below are cleared.

Repo stays **private** until you say otherwise. Rules require a **public** GitHub repo, so that one click is still on you.

## Already done

| Item | Status |
|---|---|
| Mainnet bot + ≥10 blobs | **57** member memories on account `0x8882d54e…2280` |
| ≥3 users × ≥10 memories | 4 labelled demo personas (An, Bảo, Chi, Dũng), each 11–12 |
| Live channel | Web app (`bun run start`, `/demo?name=Bảo`); Telegram adapter ready |
| LLM | Qwen3 1.7B via Ollama (local) |
| MemWal friction | Filed: [#1170](https://github.com/MystenLabs/MemWal/issues/1170) + comments on #819, #1073, #1116, #1077, #308 |
| Article draft | `docs/ARTICLE.md` (~750 words, measured before/after) |
| Evidence | `docs/evidence/evidence-2026-10-10.md` |
| Eval | `docs/evidence/eval-2026-10-07-live.md` (0 violations / 0 leaks) |
| Multi-user sim | `bun run simulate` → `docs/evidence/simulate-2026-10-09.md` |

## You still do (order matters)

1. **Make the repo public** (rules require it):
   ```bash
   gh repo edit yukitran03/tact --visibility public --accept-visibility-change-consequences
   ```
2. **Publish the article** (`docs/ARTICLE.md`) on Medium or Inkray. Paste the public repo URL into "Try it".
3. **X post** under the Session 8 announcement (copy from `docs/PROMO.md`), with article + repo links, `@WalrusProtocol` `#WalrusMemory`.
4. **Airtable** https://airtable.com/appoDAKpC74UOqoDa/shro5iVzzjoWfZlPK  
   Use answers in `docs/SUBMISSION.md`. Bug link: https://github.com/MystenLabs/MemWal/issues/1170
5. **DeepSurge** https://www.deepsurge.xyz/hackathons/c0141a4a-21be-4009-bc63-7c168608c849  
   Agent id: `dbac0ba8cdd85fb0c53e8b6e39bee230914ea19105d77ca169fe14385b68037d`  
   Blob count: see latest `docs/evidence/evidence-*.md`
6. Optional Promo prize: post from `docs/PROMO.md` on Viblo / a VN dev FB group / r/LocalLLaMA.
7. Optional: BotFather token → `TELEGRAM_BOT_TOKEN` → `bun run telegram`; host the web app for a public URL.

## Honesty line

Demo personas are labelled as demo in the app and in evidence. Do not describe them as real users on the form or in the article beyond what `docs/ARTICLE.md` already says.
