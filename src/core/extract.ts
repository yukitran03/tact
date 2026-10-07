import type { Fact, Kind, Tier } from "./types";
import {
  areaIn, cuisineLabel, cuisinesIn, DAY_LABEL, dietIn, fold, foodGroupsIn, formatMoney, isVietnamese, moneyIn, weekdaysIn,
} from "./lexicon";

export type Said = "dm" | "group";

/** Defaults: what you tell Tact privately is used but not repeated; preferences you'd say out loud are shareable. */
export function defaultTier(kind: Kind, said: Said): Tier {
  if (said === "group") return "shared";
  switch (kind) {
    case "like":
      return "shared";
    case "note":
      return "private";
    default:
      return "discreet";
  }
}

/** Explicit privacy cues override the default tier. */
export function tierCue(text: string): Tier | null {
  const t = fold(text);
  if (/(only for me|just for you|don.t use (it|this)|chi minh (toi|tao|tui) biet|dung dung|khong duoc dung)/.test(t)) return "private";
  if (/(don.t tell|keep (it|this) (private|secret|between us)|secret|dung noi|bi mat|giu kin|dung ke)/.test(t)) return "discreet";
  if (/(you can tell|tell the group|share (it|this) with|ok to share|cu noi|noi voi moi nguoi|chia se duoc)/.test(t)) return "shared";
  return null;
}

const DIET_TEXT: Record<string, string> = {
  vegetarian: "Follows a vegetarian diet (no meat, no fish).",
  vegan: "Is vegan (no meat, fish, dairy or eggs).",
  halal: "Eats halal (no pork, no alcohol).",
  kosher: "Keeps kosher (no pork, no shellfish).",
  pescatarian: "Is pescatarian (fish yes, meat no).",
  omnivore: "Eats everything now; no diet restrictions.",
};

function fact(kind: Kind, key: string, text: string, attrs: Record<string, string>, said: Said, quote: string, now: string): Fact {
  return { kind, key, text, attrs, tier: defaultTier(kind, said), quote: quote.slice(0, 160), source: said, at: now };
}

/**
 * Deterministic extraction for the facts that decide a plan. It runs before any
 * model, so allergies, diets and budgets are caught even if the LLM is down or
 * small; the model only adds what these rules miss.
 */
/** Questions ask about facts; they never state them ("Which of us is vegetarian?"). */
export function isQuestion(raw: string): boolean {
  const t = fold(raw.trim());
  if (/\?\s*$/.test(raw.trim())) return true;
  return /^(who|which|what|whats|what's|is anyone|does anyone|do you|are you|is there|ai |cai gi|co ai|ban co|sao |tai sao|why |how )/.test(t) ||
    /\b(khong|ko|chua) ?\??$/.test(t) && /\b(co|da)\b/.test(t);
}

export function extractByRules(raw: string, said: Said, now = new Date().toISOString()): Fact[] {
  const text = raw.trim();
  if (isQuestion(text)) return [];
  const t = fold(text);
  const out: Fact[] = [];
  const cue = tierCue(text);

  // Allergies, and their retraction.
  const allergyRe = /(allergic to|allergy to|allergies?:|di ung (voi )?|bi di ung (voi )?)([^.!?\n]*)/;
  const am = allergyRe.exec(t);
  if (am) {
    const negated = /(no longer|not allergic|khong con|het di ung|khong (bi )?di ung)/.test(t);
    for (const g of foodGroupsIn(am[3] || text)) {
      out.push(fact("allergy", `allergy:${g}`, negated ? `No longer allergic to ${g}.` : `Allergic to ${g}. Must avoid it.`,
        { avoid: g }, said, text, now));
      if (negated) out[out.length - 1].retract = true;
    }
  }

  // Diets.
  const diet = dietIn(text);
  if (diet && !/(friend|ban (minh|toi)|vo|chong|my (wife|husband|partner))/.test(t)) {
    out.push(fact("diet", "diet", DIET_TEXT[diet], { diet }, said, text, now));
  }

  // Foods avoided for non-allergy reasons.
  const avoidRe = /(i don.t eat|i do not eat|i can.t eat|i avoid|no (pork|beef|alcohol)|khong an (duoc )?|kieng )([^.!?\n]*)/;
  const vm = avoidRe.exec(t);
  if (vm && !am) {
    const scope = vm[0];
    for (const g of foodGroupsIn(scope)) {
      if (out.some((f) => f.attrs.avoid === g)) continue;
      out.push(fact("avoid", `avoid:${g}`, `Doesn't eat ${g}.`, { avoid: g }, said, text, now));
    }
  }

  // Likes and dislikes (soft preferences).
  const dislikeRe = /(don.t like|do not like|dislike|hate|not a fan of|khong thich|ghet)([^.!?\n]*)/;
  const likeRe = /(i love|i like|i really like|big fan of|favou?rite|crave|minh thich|toi thich|thich an|thich|ghien)([^.!?\n]*)/;
  const dm = dislikeRe.exec(t);
  // fold() keeps NFC length, so the same offsets slice the original text, diacritics intact.
  const nfc = text.normalize("NFC");
  const dislikeScope = dm ? nfc.slice(dm.index + dm[1].length, dm.index + dm[0].length) : "";
  if (dm) {
    for (const c of cuisinesIn(dislikeScope)) {
      out.push(fact("dislike", `dislike:${c}`, `Doesn't enjoy ${cuisineLabel(c)}.`, { cuisine: c }, said, text, now));
    }
    for (const g of foodGroupsIn(dislikeScope)) {
      if (out.some((f) => f.attrs.avoid === g || f.attrs.food === g)) continue;
      out.push(fact("dislike", `dislike:${g}`, g === "spicy" ? "Doesn't like spicy food." : `Doesn't like ${g}.`, { food: g }, said, text, now));
    }
  }
  const likeHay = dm ? t.slice(0, dm.index) + " ".repeat(dm[0].length) + t.slice(dm.index + dm[0].length) : t;
  const lm = likeRe.exec(likeHay);
  if (lm && !/(khong thich)/.test(lm[0])) {
    const scope = nfc.slice(lm.index + lm[1].length, lm.index + lm[0].length);
    for (const c of cuisinesIn(scope)) {
      out.push(fact("like", `like:${c}`, `Loves ${cuisineLabel(c)}.`, { cuisine: c }, said, text, now));
    }
    for (const g of foodGroupsIn(scope)) {
      if (out.some((f) => f.attrs.avoid === g)) continue;
      out.push(fact("like", `like:${g}`, g === "spicy" ? "Loves spicy food." : `Loves ${g}.`, { food: g }, said, text, now));
    }
  }

  // Budget.
  if (/(budget|ngan sach|at most|max|maximum|under|below|no more than|toi da|duoi|khong qua|tam|per person|mot nguoi|1 nguoi)/.test(t)) {
    const money = moneyIn(text);
    if (money && money.amount > 0) {
      out.push(fact("budget", "budget", `Prefers to spend at most ${formatMoney(money.amount, money.currency)} per person on a meal out.`,
        { max: String(money.amount), currency: money.currency }, said, text, now));
    }
  }

  // Home / work area.
  if (/(live in|living in|work in|working in|based in|office (is )?in|near|nha (minh |toi )?o|o gan|lam (viec )?o|cong ty o|minh o|toi o|tui o|o quan|song o)/.test(t)) {
    const area = areaIn(text);
    if (area) out.push(fact("area", "area", `Lives or works around ${area}.`, { area }, said, text, now));
  }

  // Availability.
  const days = weekdaysIn(text);
  if (days.length) {
    const busy = /(can.t do|cannot do|can.t make|busy|not free|never free|unavailable|khong ranh|khong di duoc|khong tham gia duoc|vuong)/.test(t) || /bận/i.test(text);
    const free = /(free on|available on|free every|ranh|di duoc)/.test(t);
    const names = days.map((d) => DAY_LABEL[d].en).join(", ");
    if (busy) out.push(fact("availability", "availability", `Can't make it on ${names}.`, { busy: days.join(",") }, said, text, now));
    else if (free) out.push(fact("availability", "availability", `Usually free on ${names}.`, { free: days.join(",") }, said, text, now));
  }

  if (cue) for (const f of out) f.tier = cue;
  return dedupe(out);
}

function dedupe(facts: Fact[]): Fact[] {
  const seen = new Set<string>();
  return facts.filter((f) => (seen.has(f.key) ? false : (seen.add(f.key), true)));
}

/** "add place: Phở Hòa, pho, ~70k, District 3, has vegetarian options" → a venue fact for the group. */
export function extractVenue(raw: string, by: string, now = new Date().toISOString()): Fact | null {
  const m = /^\s*(?:\/addplace|\/add|add (?:a )?(?:place|venue|restaurant)|them quan|thêm quán|quan moi|quán mới)\s*:?\s*(.+)$/i.exec(raw);
  if (!m) return null;
  const body = m[1].trim();
  const [namePart, ...restParts] = body.split(/[,;\u2013\u2014]| - /);
  const name = namePart.trim();
  if (!name) return null;
  const rest = restParts.join(", ");
  const all = `${name} ${rest}`;
  const cuisines = cuisinesIn(all);
  const tags = new Set(foodGroupsIn(all));
  if (cuisines.includes("seafood")) { tags.add("shellfish"); tags.add("fish"); }
  const veg = /(vegetarian|vegan options|veg options|veg-friendly|co mon chay|có món chay|mon chay|chay)/i.test(fold(all)) || cuisines.includes("vegetarian");
  const halal = /halal/i.test(all);
  const money = moneyIn(rest);
  const area = areaIn(rest) ?? areaIn(name);
  const slug = fold(name).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const attrs: Record<string, string> = { name, slug };
  if (cuisines.length) attrs.cuisine = cuisines.join(",");
  if (tags.size) attrs.tags = [...tags].join(",");
  if (veg) attrs.veg = "1";
  if (halal) attrs.halal = "1";
  if (money) { attrs.price = String(money.amount); attrs.currency = money.currency; }
  if (area) attrs.area = area;
  const desc = [
    cuisines.length ? cuisines.join("/") : null,
    area,
    money ? `~${formatMoney(money.amount, money.currency)}/person` : null,
    tags.size ? `serves ${[...tags].join(", ")}` : null,
    veg ? "has vegetarian options" : null,
    halal ? "halal" : null,
  ].filter(Boolean).join("; ");
  return {
    kind: "venue", tier: "shared", key: `venue:${slug}`,
    text: `Place the group knows: ${name}${desc ? ` (${desc})` : ""}.`,
    attrs, by, source: "group", at: now, quote: raw.slice(0, 160),
  };
}

const POSITIVE = /\b(ngon|tuyet|ok lam|loved|love it|great|amazing|delicious|good|tasty|recommend|quay lai)\b|10\/10/;
const NEGATIVE = /\b(too salty|salty|bland|slow|overpriced|bad|awful|meh|never again|not great|khong ngon|khong quay lai|man qua|dat qua|cham qua)\b/;
const NEGATIVE_VI = /\b(do|man|nhat|te|chan|cham)\b/;

/** Feedback about a known venue → a verdict fact for the group. */
export function extractVerdict(raw: string, venues: { slug: string; name: string }[], by: string, now = new Date().toISOString()): Fact | null {
  const t = fold(raw);
  const venue = venues.find((v) => t.includes(fold(v.name)) || t.includes(v.slug.replace(/-/g, " ")));
  if (!venue) return null;
  // Judge the words around the venue, not its name: "Phở" alone must not make a sentence Vietnamese.
  const rest = raw.replace(new RegExp(venue.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), " ");
  const r = fold(rest);
  const neg = NEGATIVE.test(r) || (isVietnamese(rest) && NEGATIVE_VI.test(r)) || /dở|mặn|nhạt|tệ|chán/i.test(rest);
  const pos = POSITIVE.test(r) || /ngon|tuyệt|thích/i.test(rest);
  if (!neg && !pos) return null;
  const rating = neg && !/(khong (do|te)|not bad)/.test(r) ? -1 : 1;
  return {
    kind: "verdict", tier: "shared", key: `verdict:${venue.slug}:${fold(by).replace(/[^a-z0-9]+/g, "-")}`,
    text: `${by} ${rating > 0 ? "liked" : "did not like"} ${venue.name}: “${raw.trim().slice(0, 120)}”.`,
    attrs: { venue: venue.slug, rating: String(rating) }, by, source: "group", at: now,
  };
}
