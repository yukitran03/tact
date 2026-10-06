import type { StoredFact } from "./types";
import { DIET_EXCLUDES, fold, formatMoney, mentionsName, surfaceWords, type Diet } from "./lexicon";

/**
 * The shield. Group-visible text is assembled from a context that never
 * contains a discreet or private fact, and then scanned against every
 * sensitive term those facts imply. The model cannot leak what it never saw,
 * and if it invents something that matches anyway, the scan catches it.
 */

export interface SensitiveTerm {
  term: string;
  ownerId: string;
  factKey: string;
  /**
   * Specific terms identify the fact itself (an allergen, a diet, a budget
   * figure, a home area). Generic words ("budget", "allergic") are only
   * counted in strict mode, which is what model drafts are held to.
   */
  specific: boolean;
  /**
   * Low-sensitivity preferences ("doesn't enjoy Korean food") only leak when
   * the owner is named in the same sentence; on its own "Korean" is just a word.
   */
  ownerName?: string;
}

const GENERIC_BY_KIND: Record<string, string[]> = {
  allergy: ["allergy", "allergic", "allergies", "di ung", "intoleran", "anaphyla", "epipen"],
  avoid: ["can't eat", "cannot eat", "doesn't eat", "does not eat", "khong an duoc", "kieng"],
  diet: ["diet", "an kieng", "che do an"],
  budget: ["budget", "ngan sach", "afford", "tight on money", "tiet kiem", "broke"],
  area: ["lives in", "lives near", "home is", "nha o", "song o"],
};

const DIET_WORDS: Record<string, string[]> = {
  vegetarian: ["vegetarian", "an chay", "veggie", "plant-based"],
  vegan: ["vegan", "thuan chay"],
  halal: ["halal", "muslim"],
  kosher: ["kosher", "jewish"],
  pescatarian: ["pescatarian"],
};

/** Every word that would reveal a non-shared fact of any of these members. */
export function sensitiveTerms(factsByMember: Map<string, StoredFact[]>, names: Map<string, string> = new Map()): SensitiveTerm[] {
  const out: SensitiveTerm[] = [];
  const add = (term: string, ownerId: string, factKey: string, specific: boolean, needsOwner = false) => {
    const t = fold(term).trim();
    if (t.length >= 3) out.push({ term: t, ownerId, factKey, specific, ownerName: needsOwner ? names.get(ownerId) ?? ownerId : undefined });
  };
  for (const [ownerId, facts] of factsByMember) {
    for (const f of facts) {
      if (f.tier === "shared") continue;
      for (const g of GENERIC_BY_KIND[f.kind] ?? []) add(g, ownerId, f.key, false);
      if ((f.kind === "allergy" || f.kind === "avoid") && f.attrs.avoid) {
        for (const w of surfaceWords([f.attrs.avoid])) add(w, ownerId, f.key, true);
      }
      if (f.kind === "diet" && f.attrs.diet && f.attrs.diet !== "omnivore") {
        for (const w of DIET_WORDS[f.attrs.diet] ?? [f.attrs.diet]) add(w, ownerId, f.key, true);
        for (const w of surfaceWords(DIET_EXCLUDES[f.attrs.diet as Diet] ?? [])) if (w.length >= 4) add(w, ownerId, f.key, false);
      }
      if (f.kind === "budget" && f.attrs.max) {
        const n = Number(f.attrs.max);
        add(formatMoney(n, f.attrs.currency ?? "VND"), ownerId, f.key, true);
        add(String(n), ownerId, f.key, true);
        add(n.toLocaleString("vi-VN"), ownerId, f.key, true);
      }
      if (f.kind === "area" && f.attrs.area) add(f.attrs.area, ownerId, f.key, true);
      if (f.kind === "availability") {
        // Who is busy is the secret, not the weekday, so availability needs the owner's name.
        for (const d of (f.attrs.busy ?? "").split(",").filter(Boolean)) add(d === "thu" ? "thursday" : d, ownerId, f.key, true, true);
      }
      if (f.kind === "dislike" || f.kind === "like") {
        const v = f.attrs.cuisine ?? f.attrs.food;
        if (v) add(v, ownerId, f.key, true, true);
      }
      if (f.kind === "note") {
        for (const w of fold(f.text).split(/[^a-z0-9]+/).filter((w) => w.length >= 6)) add(w, ownerId, f.key, true, true);
      }
    }
  }
  return out;
}

export interface LeakHit extends SensitiveTerm {
  index: number;
}

/**
 * Scans outgoing group text. Terms that also appear in the public context
 * (the chosen venue's own name, area or price) are allowed, because saying
 * where we are going is the point.
 */
export function scanForLeaks(text: string, terms: SensitiveTerm[], publicAllow: string[] = [], opts: { strict?: boolean } = {}): LeakHit[] {
  const t = fold(text);
  const sentences = t.split(/(?<=[.!?\n])\s+/);
  const allow = fold(publicAllow.join(" \n "));
  const hits: LeakHit[] = [];
  for (const s of terms) {
    if (!s.specific && !opts.strict) continue;
    if (allow.includes(s.term)) continue;
    const re = new RegExp(`(^|[^a-z0-9])${s.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`);
    const m = re.exec(t);
    if (!m) continue;
    if (s.ownerName && !sentences.some((sent) => re.test(sent) && mentionsName(sent, s.ownerName!))) continue;
    hits.push({ ...s, index: m.index });
  }
  return hits;
}

/** Facts a group-facing reply may cite: shared tier only. */
export function shareable(facts: StoredFact[]): StoredFact[] {
  return facts.filter((f) => f.tier === "shared");
}
