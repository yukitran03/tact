import type { Settings } from "../config";

export interface ChatTurn {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompleteOptions {
  /** JSON schema the reply must follow (Ollama structured outputs / OpenAI json_schema). */
  schema?: Record<string, unknown>;
  temperature?: number;
  maxTokens?: number;
}

export interface LLM {
  readonly label: string;
  complete(messages: ChatTurn[], opts?: CompleteOptions): Promise<string>;
  health(): Promise<{ ok: boolean; detail: string }>;
}

/** Strips a leaked <think>…</think> block from reasoning models such as Qwen3. */
export function stripThinking(s: string): string {
  return s.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^\s*<think>[\s\S]*$/g, "").trim();
}

/**
 * Local open-weight model through Ollama's native API. `think: false` turns off
 * Qwen3's reasoning trace, and `format` constrains the output to a JSON schema,
 * which is what lets a 1.7B model extract facts reliably.
 */
export class OllamaLLM implements LLM {
  constructor(private readonly baseUrl: string, private readonly model: string, private readonly timeoutMs: number) {}

  get label() {
    return `${this.model} (Ollama, local)`;
  }

  async complete(messages: ChatTurn[], opts: CompleteOptions = {}): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({
        model: this.model,
        messages,
        stream: false,
        think: false,
        format: opts.schema,
        keep_alive: "30m",
        options: { temperature: opts.temperature ?? 0.2, num_predict: opts.maxTokens ?? 400, num_ctx: 4096 },
      }),
    });
    if (!res.ok) throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { message?: { content?: string } };
    return stripThinking(data.message?.content ?? "");
  }

  async health() {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
      const data = (await res.json()) as { models?: { name: string }[] };
      const has = data.models?.some((m) => m.name === this.model || m.name.startsWith(`${this.model}:`));
      return { ok: !!has, detail: has ? this.label : `${this.model} not pulled (ollama pull ${this.model})` };
    } catch (err) {
      return { ok: false, detail: `ollama unreachable at ${this.baseUrl}` };
    }
  }
}

/** Any OpenAI-compatible endpoint: OpenRouter, Groq, Together, Gemini's OpenAI endpoint, vLLM, LM Studio. */
export class OpenAICompatibleLLM implements LLM {
  constructor(private readonly baseUrl: string, private readonly model: string, private readonly apiKey: string | undefined, private readonly timeoutMs: number) {}

  get label() {
    return `${this.model} (${new URL(this.baseUrl).host})`;
  }

  async complete(messages: ChatTurn[], opts: CompleteOptions = {}): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens ?? 400,
    };
    if (opts.schema) body.response_format = { type: "json_schema", json_schema: { name: "out", schema: opts.schema, strict: false } };
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`llm ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return stripThinking(data.choices?.[0]?.message?.content ?? "");
  }

  async health() {
    return { ok: !!this.apiKey, detail: this.apiKey ? this.label : "LLM_API_KEY not set" };
  }
}

/** Deterministic stand-in used by tests; it can be told to misbehave on purpose. */
export class ScriptedLLM implements LLM {
  readonly label = "scripted";
  calls: ChatTurn[][] = [];
  constructor(private readonly reply: (messages: ChatTurn[], opts?: CompleteOptions) => string) {}
  async complete(messages: ChatTurn[], opts?: CompleteOptions) {
    this.calls.push(messages);
    return this.reply(messages, opts);
  }
  async health() {
    return { ok: true, detail: this.label };
  }
}

export function createLLM(s: Settings["llm"]): LLM {
  return s.provider === "ollama"
    ? new OllamaLLM(s.baseUrl, s.model, s.timeoutMs)
    : new OpenAICompatibleLLM(s.baseUrl, s.model, s.apiKey, s.timeoutMs);
}

/** Parses a JSON reply, tolerating code fences and trailing prose. */
export function parseJson<T>(raw: string): T | null {
  const s = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(s) as T;
  } catch {
    const m = /\{[\s\S]*\}/.exec(s);
    if (!m) return null;
    try {
      return JSON.parse(m[0]) as T;
    } catch {
      return null;
    }
  }
}
