import { loadMemWalCredentials, loadSettings, type Settings } from "./config";
import { Engine } from "./core/engine";
import { createLLM, type LLM } from "./llm/provider";
import { MockBackend, WalrusBackend, type MemoryBackend } from "./memory/backend";
import { Ledger } from "./memory/ledger";
import { MemoryService } from "./memory/service";

export interface App {
  settings: Settings;
  ledger: Ledger;
  backend: MemoryBackend;
  memory: MemoryService;
  llm: LLM;
  engine: Engine;
}

/** Wires the whole bot from environment. Shared by the web server, Telegram worker and scripts. */
export function createApp(overrides: Partial<Settings> = {}): App {
  const settings = { ...loadSettings(), ...overrides };
  const ledger = new Ledger(settings.dataDir);
  const creds = loadMemWalCredentials();
  const backend: MemoryBackend = settings.memoryMode === "walrus" && creds
    ? new WalrusBackend(creds, settings.recallTimeoutMs)
    : new MockBackend();
  const memory = new MemoryService(backend, ledger, {
    namespaceSecret: settings.namespaceSecret,
    prefix: settings.namespacePrefix,
  });
  const llm = createLLM(settings.llm);
  const engine = new Engine(memory, ledger, llm, {
    polishBudgetMs: Number(process.env.TACT_POLISH_BUDGET_MS ?? 12_000),
    answerBudgetMs: Number(process.env.TACT_ANSWER_BUDGET_MS ?? 30_000),
  });
  return { settings, ledger, backend, memory, llm, engine };
}
