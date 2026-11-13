import assert from "node:assert/strict";
import { tierOf, applyBrandRanking, TIERS, TIER_IDS } from "../src/brands.js";

// DigiKey's manufacturer names are long and decorated; matching is by the start of the name.
for (const [name, tier] of [
  ["Panasonic Electronic Components", "premium"], ["PANASONIC", "premium"], ["Nichicon", "premium"],
  ["United Chemi-Con", "premium"], ["Würth Elektronik", "premium"], ["Vishay Dale", "premium"],
  ["KYOCERA AVX", "premium"], ["Samsung Electro-Mechanics", "premium"], ["Murata Electronics", "premium"],
  ["Yageo", "standard"], ["Walsin Technology Corporation", "standard"],
  ["Teapo", "budget"], ["TEAPO Electronic", "budget"], ["CapXon", "budget"], ["Jamicon", "budget"],
  ["Acme Parts", "unrated"], ["", "unrated"], [undefined, "unrated"], [null, "unrated"],
  ["Panasonicx", "unrated"], ["Not Panasonic", "unrated"],
]) assert.equal(tierOf(name), tier, `${name} -> ${tier}`);

// A maker is only ever in one tier.
const seen = new Map();
for (const [tier, t] of Object.entries(TIERS)) for (const m of t.makers) {
  assert.ok(!seen.has(m), `${m} is in both ${seen.get(m)} and ${tier}`);
  seen.set(m, tier);
}
assert.deepEqual(TIER_IDS, ["premium", "standard", "budget", "unrated"]);

const opts = [
  { manufacturer: "Teapo", total: 1 }, { manufacturer: "Acme", total: 2 },
  { manufacturer: "Yageo", total: 3 }, { manufacturer: "Panasonic", total: 5 }, { manufacturer: "Nichicon", total: 6 },
];
const names = (r) => r.map((o) => o.manufacturer);

// No preference: unchanged order (cheapest first), tiers added, capped
assert.deepEqual(names(applyBrandRanking(opts, undefined)), ["Teapo", "Acme", "Yageo"]);
assert.deepEqual(names(applyBrandRanking(opts, [])), ["Teapo", "Acme", "Yageo"]);
assert.deepEqual(applyBrandRanking(opts, undefined, 5).map((o) => o.tier), ["budget", "unrated", "standard", "premium", "premium"]);
// Most-preferred tier first, cheapest first within it, other tiers dropped
assert.deepEqual(names(applyBrandRanking(opts, ["premium", "standard"], 5)), ["Panasonic", "Nichicon", "Yageo"]);
assert.deepEqual(names(applyBrandRanking(opts, ["standard", "premium", "unrated"], 5)), ["Yageo", "Panasonic", "Nichicon", "Acme"]);
assert.deepEqual(names(applyBrandRanking(opts, ["premium"], 1)), ["Panasonic"]);
assert.deepEqual(applyBrandRanking(opts, ["budget"], 5).map((o) => o.manufacturer), ["Teapo"]);
// Nothing acceptable -> empty, not a crash
assert.deepEqual(applyBrandRanking([{ manufacturer: "Teapo", total: 1 }], ["premium"]), []);
assert.deepEqual(applyBrandRanking([], ["premium"]), []);
// Inputs are not modified
assert.equal(opts[0].tier, undefined);

console.log("brands tests passed");
