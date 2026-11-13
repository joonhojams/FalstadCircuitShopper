// Manufacturer reputation tiers, so a user can say "prefer well-known makers" instead of
// ranking hundreds of brands one by one (e.g. Panasonic over Teapo).
//
// IMPORTANT: this is a rough, editable rule of thumb, not a quality guarantee. It is based on
// general reputation for consistency and long-term reliability (mainly for passives), it will be
// wrong for some product lines, and the lists are short on purpose. Edit the lists below to
// match your own experience. A maker that isn't listed is "unrated", not "bad".
//
// Matching is by the start of DigiKey's manufacturer name after lower-casing and removing
// accents and punctuation, so "Panasonic Electronic Components" matches "panasonic".

export const TIERS = {
  premium: {
    label: "Premium",
    examples: "Panasonic, Nichicon, Murata, KEMET, Vishay",
    makers: [
      "panasonic", "nichicon", "rubycon", "united chemi con", "nippon chemi con", "kemet", "murata", "tdk", "epcos",
      "vishay", "wurth elektronik", "wima", "samsung electro mechanics", "kyocera avx", "avx", "susumu", "koa",
      "rohm", "texas instruments", "analog devices", "microchip", "stmicroelectronics", "infineon", "onsemi",
      "on semiconductor", "nexperia", "littelfuse", "bourns", "te connectivity", "molex", "amphenol",
      "cornell dubilier", "tt electronics",
    ],
  },
  standard: {
    label: "Standard",
    examples: "Yageo, Walsin, Samwha, Lelon",
    makers: [
      "yageo", "walsin", "samwha", "lelon", "diodes incorporated", "stackpole", "viking tech", "uniroyal", "royal ohm",
      "taiwan semiconductor", "illinois capacitor", "eaton", "cui devices",
    ],
  },
  budget: {
    label: "Budget",
    examples: "Teapo, CapXon, Jamicon",
    makers: ["teapo", "capxon", "jamicon"],
  },
};

/** Tier ids in the order shown to the user. "unrated" is every maker not listed above. */
export const TIER_IDS = [...Object.keys(TIERS), "unrated"];

const normalize = (name) =>
  String(name ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const matchers = Object.entries(TIERS).flatMap(([tier, t]) =>
  t.makers.map((m) => [normalize(m), tier]));

/** The tier of a manufacturer name: "premium" | "standard" | "budget" | "unrated". */
export function tierOf(manufacturer) {
  const n = normalize(manufacturer);
  if (!n) return "unrated";
  // The longest matching entry wins, so a specific entry can override a general one.
  let best = null;
  for (const [m, tier] of matchers) {
    if ((n === m || n.startsWith(m + " ")) && (!best || m.length > best[0].length)) best = [m, tier];
  }
  return best ? best[1] : "unrated";
}

/**
 * Orders purchase options by the user's tier ranking and drops tiers they left out.
 * Within a tier the original order (cheapest first) is kept, so this picks the cheapest
 * option from the most-preferred tier that has any. Every option is tagged with its tier.
 * @param {object[]} options  cheapest-first, each with a `manufacturer`
 * @param {string[]|undefined} ranking  tier ids, best first. Missing or empty = no preference.
 * @param {number} keep  how many options to return
 */
export function applyBrandRanking(options, ranking, keep = 3) {
  const tagged = options.map((o) => ({ ...o, tier: tierOf(o.manufacturer) }));
  if (!ranking?.length) return tagged.slice(0, keep);
  const rank = new Map(ranking.map((t, i) => [t, i]));
  return tagged
    .map((o, i) => ({ o, i }))
    .filter(({ o }) => rank.has(o.tier))
    .sort((a, b) => rank.get(a.o.tier) - rank.get(b.o.tier) || a.i - b.i)
    .map(({ o }) => o)
    .slice(0, keep);
}
