# Facts for judges

| | |
|---|---|
| Live app | https://tact-mu.vercel.app |
| Open as Bảo | https://tact-mu.vercel.app/demo?name=Bảo |
| Demo video | https://youtu.be/LOhoY528kXU |
| Repo | https://github.com/yukitran03/tact |
| Story | [ARTICLE.md](ARTICLE.md) |
| Eval evidence | [evidence/](evidence/) |
| Architecture | [ARCHITECTURE.md](ARCHITECTURE.md) |
| MemWal friction | [FRICTION.md](FRICTION.md) · [MemWal#1170](https://github.com/MystenLabs/MemWal/issues/1170) |

## Mainnet

| | |
|---|---|
| Network | Sui mainnet / Walrus Memory mainnet |
| Package ID | `0xe7c16fbea0560e7057e2bf7422feaa4fb313749fc69c9e9092fac7a33b81d7f5` |
| MemWalAccount | [`0x8882d54e…2280`](https://suiscan.xyz/mainnet/object/0x8882d54e8ef97c4778b79a196f9a938a00fc874a765c38b99c84ebf4094b2280) |
| MEMWAL_AGENT_ID | `dbac0ba8cdd85fb0c53e8b6e39bee230914ea19105d77ca169fe14385b68037d` |
| Relayer | https://relayer.memory.walrus.xyz |
| SDK | `@mysten-incubation/memwal` 0.1.8 |
| Example blob | https://walruscan.com/mainnet/blob/xqkNrcCHUEi1Pnhbq9SdtlPk97hHax0RI6E_QpXS5uo |

Four labelled demo personas (An, Bảo, Chi, Dũng), each with 10+ memories on mainnet. Run `bun run evidence` for the full list with Walruscan links. Latest dump: [evidence/evidence-2026-10-10.md](evidence/evidence-2026-10-10.md).

## Model

Qwen3 1.7B via Ollama locally. Planning and the privacy check are plain code. The model only polishes text. On Vercel, polish is off when Ollama is unreachable; plans still run from Walrus recall.
