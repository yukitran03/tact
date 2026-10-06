import type { Fact, Kind, Tier } from "../core/types";

/**
 * Every memory Tact writes is one self-describing line: a readable sentence
 * followed by a tag block. The tag block is what makes Walrus the source of
 * truth — a fresh server with an empty database can rebuild every profile,
 * tier and supersede chain from recall alone.
 *
 *   Allergic to shellfish (shrimp, crab, clams). ⟦tact|v1|kind=allergy|tier=discreet|key=allergy:shellfish|a.avoid=shellfish|at=2026-10-07T01:30:00.000Z⟧
 */
const OPEN = "⟦tact|v1|";
const CLOSE = "⟧";
const TAG_RE = /⟦tact\|v1\|([^⟧]*)⟧/;

const KINDS: readonly Kind[] = [
  "allergy", "diet", "avoid", "budget", "area", "availability",
  "like", "dislike", "note", "venue", "verdict", "event",
];
const TIERS: readonly Tier[] = ["private", "discreet", "shared"];

function esc(v: string): string {
  return v.replace(/[|⟦⟧=\n\r]/g, " ").trim();
}

export function encodeFact(f: Fact): string {
  const parts = [`kind=${f.kind}`, `tier=${f.tier}`, `key=${esc(f.key)}`];
  for (const [k, v] of Object.entries(f.attrs)) {
    if (v !== undefined && v !== "") parts.push(`a.${esc(k)}=${esc(String(v))}`);
  }
  if (f.retract) parts.push("retract=1");
  if (f.source) parts.push(`src=${f.source}`);
  if (f.by) parts.push(`by=${esc(f.by)}`);
  parts.push(`at=${f.at}`);
  const quote = f.quote ? ` (said: “${esc(f.quote).slice(0, 160)}”)` : "";
  return `${f.text.trim()}${quote} ${OPEN}${parts.join("|")}${CLOSE}`;
}

export function isTactMemory(text: string): boolean {
  return TAG_RE.test(text);
}

export function decodeFact(text: string): Fact | null {
  const m = TAG_RE.exec(text);
  if (!m) return null;
  const fields = new Map<string, string>();
  const attrs: Record<string, string> = {};
  for (const part of m[1].split("|")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const k = part.slice(0, i);
    const v = part.slice(i + 1);
    if (k.startsWith("a.")) attrs[k.slice(2)] = v;
    else fields.set(k, v);
  }
  const kind = fields.get("kind") as Kind;
  const tier = fields.get("tier") as Tier;
  const key = fields.get("key");
  if (!KINDS.includes(kind) || !TIERS.includes(tier) || !key) return null;
  const head = text.slice(0, m.index).trim();
  const qm = /\s*\(said: “([^”]*)”\)\s*$/.exec(head);
  const sentence = qm ? head.slice(0, qm.index).trim() : head;
  const src = fields.get("src");
  return {
    kind,
    tier,
    key,
    text: sentence,
    attrs,
    retract: fields.get("retract") === "1" || undefined,
    quote: qm?.[1],
    source: src === "dm" || src === "group" || src === "seed" ? src : undefined,
    by: fields.get("by"),
    at: fields.get("at") ?? new Date(0).toISOString(),
  };
}

/** Newest fact per key wins; a retraction removes the key. Input order does not matter. */
export function resolveFacts<T extends Fact & { createdAt?: string }>(facts: T[]): T[] {
  const latest = new Map<string, T>();
  const stamp = (f: T) => Date.parse(f.at) || Date.parse(f.createdAt ?? "") || 0;
  for (const f of facts) {
    const prev = latest.get(f.key);
    if (!prev || stamp(f) >= stamp(prev)) latest.set(f.key, f);
  }
  return [...latest.values()].filter((f) => !f.retract).sort((a, b) => stamp(b) - stamp(a));
}
