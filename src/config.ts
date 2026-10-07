import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_RELAYER = "https://relayer.memory.walrus.xyz";

/** The repository root, so an MCP client that launches Tact from another directory finds the same data. */
export const ROOT = join(import.meta.dir, "..");

/**
 * Bun only reads .env from the working directory. Claude Code, Codex and
 * Cursor start the stdio MCP server from wherever they run, so the repo's own
 * .env is loaded explicitly; variables already set in the environment win.
 */
function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    const value = m[2].replace(/\s+#.*$/, "").replace(/^(['"])(.*)\1$/, "$2");
    if (process.env[m[1]] === undefined && value !== "") process.env[m[1]] = value;
  }
}
loadDotEnv(join(ROOT, ".env"));

export interface MemWalCredentials {
  key: string;
  accountId: string;
  serverUrl: string;
  source: "env" | "file";
}

/**
 * Loads the Walrus Memory delegate credentials.
 *
 * Order: MEMWAL_KEY + MEMWAL_ACCOUNT_ID env vars, then the credentials file the
 * official Walrus Memory MCP writes (~/.memwal/credentials.json, or the path in
 * MEMWAL_CREDENTIALS). Returns null when neither exists, so callers can fall
 * back to the in-memory mock store. The key never leaves this process.
 */
export function loadMemWalCredentials(): MemWalCredentials | null {
  const envKey = process.env.MEMWAL_KEY ?? process.env.MEMWAL_PRIVATE_KEY;
  if (envKey && process.env.MEMWAL_ACCOUNT_ID) {
    return {
      key: envKey,
      accountId: process.env.MEMWAL_ACCOUNT_ID,
      serverUrl: process.env.MEMWAL_SERVER_URL || DEFAULT_RELAYER,
      source: "env",
    };
  }
  const path = process.env.MEMWAL_CREDENTIALS || join(homedir(), ".memwal", "credentials.json");
  if (!existsSync(path)) return null;
  const c = JSON.parse(readFileSync(path, "utf8")) as Record<string, string | undefined>;
  const key = c.delegatePrivateKey ?? c.delegate_private_key ?? c.key ?? c.privateKey;
  // MEMWAL_ACCOUNT_ID overrides the file: a credentials file written before the
  // July 2026 mainnet migration still names the account in the retired package.
  const accountId = process.env.MEMWAL_ACCOUNT_ID ?? c.accountId ?? c.account_id;
  const serverUrl = c.relayerUrl ?? c.serverUrl ?? c.server_url ?? DEFAULT_RELAYER;
  if (!key || !accountId) return null;
  return { key, accountId, serverUrl, source: "file" };
}

export type MemoryMode = "walrus" | "mock";

export interface Settings {
  port: number;
  dataDir: string;
  memoryMode: MemoryMode;
  /** Secret for HMAC-ing user/group ids into namespaces (namespaces are public on-chain). */
  namespaceSecret: string;
  sessionSecret: string;
  namespacePrefix: string;
  llm: {
    provider: "ollama" | "openai-compatible";
    baseUrl: string;
    model: string;
    apiKey?: string;
    timeoutMs: number;
  };
  recallTimeoutMs: number;
  telegramToken?: string;
  publicUrl: string;
}

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

export function loadSettings(): Settings {
  const creds = loadMemWalCredentials();
  const forced = process.env.TACT_MEMORY as MemoryMode | undefined;
  const memoryMode: MemoryMode = forced ?? (creds ? "walrus" : "mock");
  const provider = (process.env.LLM_PROVIDER as Settings["llm"]["provider"]) ??
    (process.env.LLM_BASE_URL ? "openai-compatible" : "ollama");
  return {
    port: Number(env("PORT", "8787")),
    dataDir: env("TACT_DATA_DIR", join(ROOT, ".tact")),
    memoryMode,
    namespaceSecret: env("TACT_NAMESPACE_SECRET", "tact-dev-namespace-secret-change-me"),
    sessionSecret: env("TACT_SESSION_SECRET", "tact-dev-session-secret-change-me"),
    namespacePrefix: env("TACT_NAMESPACE_PREFIX", "tact"),
    llm: {
      provider,
      baseUrl: env("LLM_BASE_URL", provider === "ollama" ? "http://127.0.0.1:11434" : "https://openrouter.ai/api/v1"),
      model: env("LLM_MODEL", provider === "ollama" ? "qwen3:1.7b" : "google/gemini-2.5-flash"),
      apiKey: process.env.LLM_API_KEY,
      timeoutMs: Number(env("LLM_TIMEOUT_MS", "60000")),
    },
    recallTimeoutMs: Number(env("TACT_RECALL_TIMEOUT_MS", "14000")),
    telegramToken: process.env.TELEGRAM_BOT_TOKEN,
    publicUrl: env("TACT_PUBLIC_URL", "http://localhost:8787"),
  };
}
