import type { StoredFact } from "./types";
import { DIET_EXCLUDES, fold, formatMoney, surfaceWords, type Diet } from "./lexicon";

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
}

const GENERIC_BY_KIND: Record<string, string[]> = {
  allergy: ["allergy", "allergic", "allergies", "di ung", "intoleran", "anaphyla", "epipen"],
  avoid: ["can't eat", "cannot eat", "doesn't eat", "does not eat", "khong an duoc", "kieng"],
  diet: ["diet", "an kieng", "che do an"],
  budget: ["budget", "ngan sach", "afford", "tight on money", "tiet kiem", "broke", "cheap for"],
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
export function sensitiveTerms(factsByMember: Map<string, StoredFact[]>): SensitiveTerm[] {
  const out: SensitiveTerm[] = [];
  const add = (term: string, ownerId: string, factKey: string) => {
    const t = fold(term).trim();
    if (t.length >= 3) out.push({ term: t, ownerId, factKey });
  };
  for (const [ownerId, facts] of factsByMember) {
    for (const f of facts) {
      if (f.tier === "shared") continue;
      for (const g of GENERIC_BY_KIND[f.kind] ?? []) add(g, ownerId, f.key);
      if (f.attrs.avoid) for (const w of surfaceWords([f.attrs.avoid])) add(w, ownerId, f.key);
      if (f.kind === "diet" && f.attrs.diet && f.attrs.diet !== "omnivore") {
        for (const w of DIET_WORDS[f.attrs.diet] ?? [f.attrs.diet]) add(w, ownerId, f.key);
        for (const w of surfaceWords(DIET_EXCLUDES[f.attrs.diet as Diet] ?? [])) if (w.length >= 4) add(w, ownerId, f.key);
      }
      if (f.kind === "budget" && f.attrs.max) {
        const n = Number(f.attrs.max);
        add(formatMoney(n, f.attrs.currency ?? "VND"), ownerId, f.key);
        add(String(n), ownerId, f.key);
        add(n.toLocaleString("vi-VN"), ownerId, f.key);
      }
      if (f.kind === "area" && f.attrs.area) add(f.attrs.area, ownerId, f.key);
      if (f.kind === "note" || f.kind === "dislike") {
        // Private notes and dislikes are matched on their distinctive words.
        for (const w of fold(f.text).split(/[^a-z0-9]+/).filter((w) => w.length >= 6)) add(w, ownerId, f.key);
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
export function scanForLeaks(text: string, terms: SensitiveTerm[], publicAllow: string[] = []): LeakHit[] {
  const t = fold(text);
  const allow = fold(publicAllow.join(" \n "));
  const hits: LeakHit[] = [];
  for (const s of terms) {
    if (allow.includes(s.term)) continue;
    const re = new RegExp(`(^|[^a-z0-9])${s.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`);
    const m = re.exec(t);
    if (m) hits.push({ ...s, index: m.index });
  }
  return hits;
}

/** Facts a group-facing reply may cite: shared tier only. */
export function shareable(facts: StoredFact[]): StoredFact[] {
  return facts.filter((f) => f.tier === "shared");
}
