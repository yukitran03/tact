import type { StoredFact, Tier } from "./types";
import { areaIn, cuisineLabel, cuisinesIn, DIET_EXCLUDES, fold, moneyIn, weekdaysIn, type Diet } from "./lexicon";

export interface Attendee {
  memberId: string;
  name: string;
  facts: StoredFact[];
  /** False when this person's memory could not be read; the plan says so instead of guessing. */
  readOk: boolean;
}

export interface Venue {
  slug: string;
  name: string;
  cuisine: string[];
  tags: string[];
  veg: boolean;
  halal: boolean;
  price?: number;
  currency?: string;
  area?: string;
  fact: StoredFact;
}

export interface PlanRequest {
  text: string;
  day?: string;
  meal?: "lunch" | "dinner" | "drinks" | "coffee";
  cuisine?: string;
  area?: string;
  maxPrice?: number;
}

/** One way a memory shaped the plan. `tier` decides who may ever see this line. */
export interface Influence {
  memberId: string | null;
  blobId?: string;
  factKey: string;
  kind: string;
  tier: Tier;
  effect: "vetoed" | "boosted" | "lowered" | "checked" | "excused";
  venue?: string;
  detail: string;
}

export interface ScoredVenue {
  venue: Venue;
  score: number;
  reasons: string[];
}

export interface PlanResult {
  request: PlanRequest;
  attendees: { memberId: string; name: string; readOk: boolean; factCount: number }[];
  choice: ScoredVenue | null;
  alternatives: ScoredVenue[];
  ruledOut: { venue: Venue; by: Influence[] }[];
  influences: Influence[];
  /** Attendees who said they are busy on the requested day; names never leave the shield log. */
  dayConflict?: { day: string; busyMemberIds: string[]; alternativeDay?: string };
  memoriesConsulted: number;
  unknownVenues: boolean;
}

const MEAL_RE: [RegExp, PlanRequest["meal"]][] = [
  [/(lunch|trua|an trua|com trua)/, "lunch"],
  [/(dinner|toi nay|an toi|bua toi|supper)/, "dinner"],
  [/(drinks|beer|nhau|bia|cocktail)/, "drinks"],
  [/(coffee|cafe|ca phe)/, "coffee"],
];

export function parsePlanRequest(text: string): PlanRequest {
  const t = fold(text);
  const req: PlanRequest = { text };
  const days = weekdaysIn(text);
  if (days.length) req.day = days[0];
  for (const [re, meal] of MEAL_RE) if (re.test(t)) { req.meal = meal; break; }
  const cuisines = cuisinesIn(text).filter((c) => c !== "cafe" || req.meal === "coffee");
  if (cuisines.length) req.cuisine = cuisines[0];
  const area = areaIn(text);
  if (area) req.area = area;
  if (/(under|below|duoi|toi da|max|budget)/.test(t)) {
    const m = moneyIn(text);
    if (m) req.maxPrice = m.amount;
  }
  return req;
}

export function venuesFrom(groupFacts: StoredFact[]): Venue[] {
  return groupFacts
    .filter((f) => f.kind === "venue" && f.attrs.name)
    .map((f) => ({
      slug: f.attrs.slug || fold(f.attrs.name).replace(/[^a-z0-9]+/g, "-"),
      name: f.attrs.name,
      cuisine: (f.attrs.cuisine ?? "").split(",").filter(Boolean),
      tags: (f.attrs.tags ?? "").split(",").filter(Boolean),
      veg: f.attrs.veg === "1",
      halal: f.attrs.halal === "1",
      price: f.attrs.price ? Number(f.attrs.price) : undefined,
      currency: f.attrs.currency,
      area: f.attrs.area,
      fact: f,
    }));
}

const usable = (f: StoredFact) => f.tier !== "private";

/**
 * Deterministic planning over recalled memories. The model never decides who
 * can eat where: hard constraints veto, soft preferences score. That is what
 * makes memory load-bearing — with no memory, every veto below disappears.
 */
export function plan(req: PlanRequest, attendees: Attendee[], groupFacts: StoredFact[], opts: { lastVenueSlug?: string } = {}): PlanResult {
  const venues = venuesFrom(groupFacts);
  const verdicts = groupFacts.filter((f) => f.kind === "verdict");
  const influences: Influence[] = [];
  const ruledOut: PlanResult["ruledOut"] = [];
  const scored: ScoredVenue[] = [];

  let dayConflict: PlanResult["dayConflict"];
  const present = attendees.filter((a) => {
    if (!req.day) return true;
    const busy = a.facts.find((f) => usable(f) && f.kind === "availability" && (f.attrs.busy ?? "").split(",").includes(req.day!));
    if (!busy) return true;
    dayConflict ??= { day: req.day, busyMemberIds: [] };
    dayConflict.busyMemberIds.push(a.memberId);
    influences.push({ memberId: a.memberId, blobId: busy.blobId, factKey: busy.key, kind: busy.kind, tier: busy.tier, effect: "excused", detail: `${a.name} is busy on ${req.day}` });
    return false;
  });
  if (dayConflict) {
    const allDays = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
    const start = allDays.indexOf(req.day!);
    for (let i = 1; i <= 7; i++) {
      const d = allDays[(start + i) % 7];
      const someoneBusy = attendees.some((a) => a.facts.some((f) => usable(f) && f.kind === "availability" && (f.attrs.busy ?? "").split(",").includes(d)));
      if (!someoneBusy) { dayConflict.alternativeDay = d; break; }
    }
  }

  for (const v of venues) {
    const vetoes: Influence[] = [];
    let score = 0;
    const reasons: string[] = [];

    for (const a of present) {
      for (const f of a.facts.filter(usable)) {
        const veto = (detail: string) => vetoes.push({ memberId: a.memberId, blobId: f.blobId, factKey: f.key, kind: f.kind, tier: f.tier, effect: "vetoed", venue: v.slug, detail });
        if ((f.kind === "allergy" || f.kind === "avoid") && f.attrs.avoid && v.tags.includes(f.attrs.avoid)) {
          veto(`${v.name} serves ${f.attrs.avoid}; ${a.name} ${f.kind === "allergy" ? "is allergic" : "doesn't eat it"}`);
        }
        if (f.kind === "diet" && f.attrs.diet) {
          const diet = f.attrs.diet as Diet;
          const excluded = (DIET_EXCLUDES[diet] ?? []).filter((g) => v.tags.includes(g));
          const mitigated = ((diet === "vegetarian" || diet === "vegan") && v.veg) || (diet === "halal" && v.halal);
          if (excluded.length && !mitigated) veto(`${v.name} is built around ${excluded.join(", ")}; ${a.name} is ${diet}`);
          if ((diet === "vegetarian" || diet === "vegan") && !v.veg && !excluded.length && v.cuisine.length && !v.cuisine.includes("vegetarian") && !v.cuisine.includes("cafe")) {
            veto(`${v.name} has no known vegetarian options; ${a.name} is ${diet}`);
          }
        }
        if (f.kind === "budget" && f.attrs.max && v.price !== undefined && (!f.attrs.currency || !v.currency || f.attrs.currency === v.currency) && v.price > Number(f.attrs.max)) {
          veto(`${v.name} costs about ${v.price}, above ${a.name}'s limit`);
        }
        if (f.kind === "like") {
          const hit = (f.attrs.cuisine && v.cuisine.includes(f.attrs.cuisine)) || (f.attrs.food && v.tags.includes(f.attrs.food));
          if (hit) {
            score += 2;
            reasons.push(f.tier === "shared" ? `${a.name} loves ${f.attrs.cuisine ? cuisineLabel(f.attrs.cuisine) : f.attrs.food}` : "fits someone's taste");
            influences.push({ memberId: a.memberId, blobId: f.blobId, factKey: f.key, kind: f.kind, tier: f.tier, effect: "boosted", venue: v.slug, detail: `${a.name} likes ${f.attrs.cuisine ?? f.attrs.food}` });
          }
        }
        if (f.kind === "dislike") {
          const hit = (f.attrs.cuisine && v.cuisine.includes(f.attrs.cuisine)) || (f.attrs.food && v.tags.includes(f.attrs.food));
          if (hit) {
            score -= 2;
            influences.push({ memberId: a.memberId, blobId: f.blobId, factKey: f.key, kind: f.kind, tier: f.tier, effect: "lowered", venue: v.slug, detail: `${a.name} doesn't enjoy ${f.attrs.cuisine ?? f.attrs.food}` });
          }
        }
        if (f.kind === "area" && f.attrs.area && v.area && fold(f.attrs.area) === fold(v.area)) {
          score += 1;
          influences.push({ memberId: a.memberId, blobId: f.blobId, factKey: f.key, kind: f.kind, tier: f.tier, effect: "boosted", venue: v.slug, detail: `close to ${a.name}` });
        }
      }
    }

    if (req.maxPrice !== undefined && v.price !== undefined && v.price > req.maxPrice) {
      vetoes.push({ memberId: null, factKey: "request:price", kind: "request", tier: "shared", effect: "vetoed", venue: v.slug, detail: `${v.name} is above the requested price` });
    }
    if (vetoes.length) {
      ruledOut.push({ venue: v, by: vetoes });
      influences.push(...vetoes);
      continue;
    }

    for (const vd of verdicts.filter((x) => x.attrs.venue === v.slug)) {
      const r = Number(vd.attrs.rating) || 0;
      score += r * 1.5;
      if (r > 0) reasons.push(`${vd.by ?? "someone"} liked it last time`);
      influences.push({ memberId: null, blobId: vd.blobId, factKey: vd.key, kind: vd.kind, tier: vd.tier, effect: r > 0 ? "boosted" : "lowered", venue: v.slug, detail: vd.text });
    }
    if (req.cuisine && v.cuisine.includes(req.cuisine)) { score += 3; reasons.push(`it's ${cuisineLabel(req.cuisine)}, as asked`); }
    if (req.area && v.area && fold(req.area) === fold(v.area)) { score += 2; reasons.push(`it's in ${v.area}`); }
    if (opts.lastVenueSlug && opts.lastVenueSlug === v.slug) { score -= 2; }
    scored.push({ venue: v, score, reasons: [...new Set(reasons)] });
  }

  scored.sort((a, b) => b.score - a.score || a.venue.name.localeCompare(b.venue.name));
  const consulted = new Set<string>();
  for (const a of attendees) for (const f of a.facts.filter(usable)) consulted.add(f.blobId ?? `${a.memberId}:${f.key}`);
  for (const f of groupFacts) consulted.add(f.blobId ?? `group:${f.key}`);

  return {
    request: req,
    attendees: attendees.map((a) => ({ memberId: a.memberId, name: a.name, readOk: a.readOk, factCount: a.facts.length })),
    choice: scored[0] ?? null,
    alternatives: scored.slice(1, 3),
    ruledOut,
    influences,
    dayConflict,
    memoriesConsulted: consulted.size,
    unknownVenues: venues.length === 0,
  };
}

/** What a memory-less bot does: same venues, no constraints, first match on the request wins. */
export function planWithoutMemory(req: PlanRequest, groupFacts: StoredFact[]): Venue | null {
  const venues = venuesFrom(groupFacts);
  const match = venues.find((v) => (req.cuisine ? v.cuisine.includes(req.cuisine) : true));
  return match ?? venues[0] ?? null;
}

/** Hard-constraint violations of a venue for a set of attendees (used by evals and the "without memory" panel). */
export function violations(v: Venue | null, attendees: Attendee[]): Influence[] {
  if (!v) return [];
  const res = plan({ text: "" }, attendees, [v.fact]);
  return res.ruledOut.flatMap((r) => r.by);
}
