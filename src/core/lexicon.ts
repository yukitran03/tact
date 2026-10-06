/**
 * Food vocabulary in English and Vietnamese. Matching is done on folded text
 * (lowercase, no diacritics) so "Tôm", "tom" and "shrimp" all land on shellfish.
 */

export function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
}

/** Ingredient groups. The first entry is the canonical English label. */
export const FOOD_GROUPS: Record<string, string[]> = {
  shellfish: [
    "shellfish", "shrimp", "prawn", "crab", "lobster", "clam", "mussel", "oyster", "scallop", "snail",
    "tom", "cua", "ghe", "oc", "ngheu", "ngao", "so diep", "hau", "hen", "tom hum", "hai san co vo",
  ],
  fish: ["fish", "salmon", "tuna", "sashimi", "sushi", "ca hoi", "ca ngu", "ca kho", "lau ca"],
  peanut: ["peanut", "peanuts", "dau phong", "lac rang", "satay"],
  treenut: ["tree nut", "tree nuts", "cashew", "almond", "walnut", "hat dieu", "hanh nhan", "oc cho"],
  dairy: ["dairy", "milk", "cheese", "lactose", "butter", "cream", "sua", "pho mai", "bo sua"],
  gluten: ["gluten", "wheat", "lua mi"],
  egg: ["egg", "eggs", "trung"],
  pork: ["pork", "bacon", "ham", "thit heo", "thit lon", "heo", "lon", "suon", "ba chi"],
  beef: ["beef", "steak", "thit bo", "bo kho", "pho bo"],
  chicken: ["chicken", "thit ga", "ga"],
  alcohol: ["alcohol", "beer", "wine", "liquor", "bia", "ruou", "nhau"],
  spicy: ["spicy", "chili", "chilli", "hot pot spicy", "cay", "ot"],
  offal: ["offal", "organ meat", "long", "noi tang", "tiet canh"],
};

/** "seafood" is shellfish plus fish; we expand it rather than keep a third list. */
const ALIASES: Record<string, string[]> = {
  seafood: ["shellfish", "fish"],
  "hai san": ["shellfish", "fish"],
  meat: ["pork", "beef", "chicken"],
  thit: ["pork", "beef", "chicken"],
  nuts: ["peanut", "treenut"],
};

function wordHit(haystack: string, needle: string): boolean {
  // Short Vietnamese syllables ("oc", "ga", "bo") must match as whole words.
  const re = new RegExp(`(^|[^a-z])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z])`);
  return re.test(haystack);
}

/** Single Vietnamese syllables that are only unambiguous with their diacritics ("cá" fish vs "cả" all). */
const RAW_SYLLABLES: [RegExp, string][] = [
  [/(^|[\s,.;:!?(])cá(?=$|[\s,.;:!?)])/iu, "fish"],
  [/(^|[\s,.;:!?(])gà(?=$|[\s,.;:!?)])/iu, "chicken"],
  [/(^|[\s,.;:!?(])bò(?=$|[\s,.;:!?)])/iu, "beef"],
];

/** Every ingredient group mentioned in a piece of text. */
export function foodGroupsIn(text: string): string[] {
  const t = fold(text);
  const found = new Set<string>();
  for (const [re, g] of RAW_SYLLABLES) if (re.test(text)) found.add(g);
  for (const [alias, groups] of Object.entries(ALIASES)) {
    if (wordHit(t, alias)) groups.forEach((g) => found.add(g));
  }
  for (const [group, words] of Object.entries(FOOD_GROUPS)) {
    if (words.some((w) => wordHit(t, w))) found.add(group);
  }
  return [...found];
}

/** Every surface word (both languages) for a set of groups, for leak scanning. */
export function surfaceWords(groups: string[]): string[] {
  const out = new Set<string>();
  for (const g of groups) {
    out.add(g);
    for (const w of FOOD_GROUPS[g] ?? []) if (w.length >= 3) out.add(w);
  }
  return [...out];
}

export type Diet = "vegetarian" | "vegan" | "halal" | "pescatarian" | "kosher" | "omnivore";

/** What each diet rules out. Venues tagged with any of these groups conflict. */
export const DIET_EXCLUDES: Record<Diet, string[]> = {
  vegetarian: ["pork", "beef", "chicken", "fish", "shellfish", "offal"],
  vegan: ["pork", "beef", "chicken", "fish", "shellfish", "offal", "dairy", "egg"],
  halal: ["pork", "alcohol", "offal"],
  kosher: ["pork", "shellfish"],
  pescatarian: ["pork", "beef", "chicken", "offal"],
  omnivore: [],
};

export function dietIn(text: string): Diet | null {
  const t = fold(text);
  if (/\b(vegan|thuan chay)\b/.test(t)) return "vegan";
  if (/(vegetarian|an chay|\bchay\b|khong an thit|plant.based)/.test(t)) return "vegetarian";
  if (/\bhalal\b/.test(t)) return "halal";
  if (/\bkosher\b/.test(t)) return "kosher";
  if (/pescatarian/.test(t)) return "pescatarian";
  if (/(no longer vegetarian|not vegetarian any ?more|eat everything|an het|an duoc het|khong an chay nua)/.test(t)) return "omnivore";
  return null;
}

const VI_DAYS: [RegExp, string][] = [
  [/\bthu (2|hai)\b/, "mon"], [/\bthu (3|ba)\b/, "tue"], [/\bthu (4|tu)\b/, "wed"],
  [/\bthu (5|nam)\b/, "thu"], [/\bthu (6|sau)\b/, "fri"], [/\bthu (7|bay)\b/, "sat"],
  [/\b(chu nhat|cn)\b/, "sun"],
];
const EN_DAYS: [RegExp, string][] = [
  [/\bmon(days?)?\b/, "mon"], [/\btue(s|sdays?)?\b/, "tue"], [/\bwed(nesdays?)?\b/, "wed"],
  [/\bthu(rs|rsdays?)?\b/, "thu"], [/\bfri(days?)?\b/, "fri"], [/\bsat(urdays?)?\b/, "sat"],
  [/\bsun(days?)?\b/, "sun"],
];

/**
 * Weekdays mentioned in text. Vietnamese "thứ 5" is matched first and removed,
 * because a bare "thu" is also the Vietnamese word for "autumn"; the English
 * short forms only count when the text is not Vietnamese.
 */
export function weekdaysIn(text: string): string[] {
  const t = fold(text);
  const out = new Set<string>();
  for (const [re, d] of VI_DAYS) if (re.test(t)) out.add(d);
  const rest = t.replace(/\bthu (2|3|4|5|6|7|hai|ba|tu|nam|sau|bay)\b/g, " ");
  const longOnly = isVietnamese(text);
  for (const [re, d] of EN_DAYS) {
    const m = re.exec(rest);
    if (m && (!longOnly || m[0].length > 3)) out.add(d);
  }
  return [...out];
}

export const DAY_LABEL: Record<string, { en: string; vi: string }> = {
  mon: { en: "Monday", vi: "Thứ Hai" },
  tue: { en: "Tuesday", vi: "Thứ Ba" },
  wed: { en: "Wednesday", vi: "Thứ Tư" },
  thu: { en: "Thursday", vi: "Thứ Năm" },
  fri: { en: "Friday", vi: "Thứ Sáu" },
  sat: { en: "Saturday", vi: "Thứ Bảy" },
  sun: { en: "Sunday", vi: "Chủ Nhật" },
};

/** Parses "120k", "150.000đ", "$15", "under 100k" into a number + currency. */
export function moneyIn(text: string): { amount: number; currency: "VND" | "USD" } | null {
  const t = fold(text).replace(/,/g, "");
  const usd = /\$\s?(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s?(?:usd|dollars?)/.exec(t);
  if (usd) return { amount: Number(usd[1] ?? usd[2]), currency: "USD" };
  const k = /(\d+(?:\.\d+)?)\s?(k|nghin|ngan)\b/.exec(t);
  if (k) return { amount: Math.round(Number(k[1]) * 1000), currency: "VND" };
  const tr = /(\d+(?:\.\d+)?)\s?(tr|trieu)\b/.exec(t);
  if (tr) return { amount: Math.round(Number(tr[1]) * 1_000_000), currency: "VND" };
  const vnd = /(\d{1,3}(?:\.\d{3})+|\d{4,})\s?(?:d|vnd|dong)?\b/.exec(t);
  if (vnd) return { amount: Number(vnd[1].replace(/\./g, "")), currency: "VND" };
  return null;
}

export function formatMoney(amount: number, currency: string): string {
  if (currency === "USD") return `$${amount}`;
  return amount >= 1000 ? `${Math.round(amount / 1000)}k` : `${amount}đ`;
}

/** Ho Chi Minh City areas, plus a few Hanoi ones, folded. Used for area facts and venues. */
const AREAS = [
  "district 1", "district 2", "district 3", "district 4", "district 5", "district 6", "district 7",
  "district 8", "district 10", "district 11", "district 12", "binh thanh", "phu nhuan", "tan binh",
  "go vap", "thu duc", "tan phu", "binh tan", "nha be", "thao dien",
  "quan 1", "quan 2", "quan 3", "quan 4", "quan 5", "quan 6", "quan 7", "quan 8", "quan 10", "quan 11", "quan 12",
  "hoan kiem", "ba dinh", "tay ho", "cau giay", "dong da", "hai ba trung",
];

export function canonicalArea(raw: string): string {
  const t = fold(raw).trim();
  const q = /^quan (\d+)$/.exec(t);
  if (q) return `District ${q[1]}`;
  const d = /^d(?:istrict)?\.?\s?(\d+)$/.exec(t);
  if (d) return `District ${d[1]}`;
  return t.replace(/\b\w/g, (c) => c.toUpperCase());
}

export function areaIn(text: string): string | null {
  const t = fold(text);
  for (const a of AREAS) if (t.includes(a)) return canonicalArea(a);
  const q = /\b(?:q|d)\.?\s?(\d{1,2})\b/.exec(t);
  if (q) return `District ${q[1]}`;
  return null;
}

export const CUISINES: Record<string, string[]> = {
  vietnamese: ["vietnamese", "viet", "com tam", "bun", "pho", "banh mi", "com", "quan com"],
  japanese: ["japanese", "sushi", "ramen", "nhat", "do nhat"],
  korean: ["korean", "kbbq", "han quoc", "do han"],
  thai: ["thai", "thai lan", "do thai"],
  chinese: ["chinese", "dim sum", "hoa", "do hoa"],
  indian: ["indian", "curry", "an do"],
  western: ["western", "burger", "pizza", "pasta", "steakhouse", "au"],
  hotpot: ["hotpot", "hot pot", "lau"],
  bbq: ["bbq", "barbecue", "nuong", "do nuong"],
  vegetarian: ["vegetarian restaurant", "quan chay", "nha hang chay", "com chay"],
  seafood: ["seafood", "quan oc", "oc", "hai san"],
  cafe: ["cafe", "coffee", "ca phe"],
};

export function cuisinesIn(text: string): string[] {
  const t = fold(text);
  const out: string[] = [];
  for (const [c, words] of Object.entries(CUISINES)) {
    if (words.some((w) => wordHit(t, w))) out.push(c);
  }
  return out;
}

/**
 * Language of a message, by counting function words rather than spotting one
 * diacritic: "add place: Ốc Đào Corner" is English with a Vietnamese name in it.
 */
export function isVietnamese(text: string): boolean {
  const t = fold(text);
  const en = (t.match(/\b(the|and|what|where|should|we|i|i'm|my|is|are|you|to|for|place|add|why|did|skip|dinner|lunch|eat|how|about|was|great|with|in|at|on|do|does|can't|don't|love|like|budget|live|work)\b/g) ?? []).length;
  const vi = (t.match(/\b(minh|tui|ban|quan|an|gi|di|khong|nhe|nha|thich|ghet|cho|voi|gio|nay|mai|la|va|cua|duoc|nhom|moi|nguoi|them|sao|chon|biet|nho|o|toi|dau|nao)\b/g) ?? []).length;
  const marks = (text.match(/[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹáàãéèíìóòõúùý]/gi) ?? []).length;
  if (en >= 2 && en > vi) return false;
  return vi >= 2 || (marks >= 2 && vi >= 1) || (marks >= 3 && en === 0);
}
