import assert from "node:assert/strict";
import { analyse, nearest, isStandard, findPairs, suggestNetworks, format } from "../src/networks.js";

// Series tables: known members, and values that belong to a finer series only.
assert.equal(isStandard(4700, "E24"), true);
assert.equal(isStandard(4700, "E6"), true);
assert.equal(isStandard(3300, "E6"), true);
assert.equal(isStandard(2700, "E6"), false, "2.7 is E12, not E6");
assert.equal(isStandard(2700, "E12"), true);
assert.equal(isStandard(4990, "E24"), false);
assert.equal(isStandard(4990, "E96"), true, "4.99 is E96");
assert.equal(isStandard(9760, "E96"), true);
assert.equal(isStandard(1020, "E48"), false, "1.02 is E96 only");
assert.equal(isStandard(1000, "E48"), true);
assert.equal(isStandard(1e-6, "E12"), true);
assert.equal(isStandard(4.7e-8, "E12"), true);
assert.equal(isStandard(6.5e-8, "E12"), false);
assert.equal(isStandard(0.00033, "E6"), true, "works across decades");
assert.equal(nearest(4990, "E24").value, 5100);
assert.ok(Math.abs(nearest(4990, "E24").errPct - 2.2044) < 0.001);

// Every pair really makes the target within tolerance, for both element types and both topologies.
const check = (target, kind, series, tol) => {
  const pairs = findPairs(target, kind, series, tol);
  for (const p of pairs) {
    const [a, b] = p.parts;
    const expected = ((p.topology === "series") === (kind === "R")) ? a + b : (a * b) / (a + b);
    assert.ok(Math.abs(expected - p.value) / p.value < 1e-9, "stated value is the real network value");
    assert.ok(Math.abs((expected - target) / target) * 100 <= tol + 1e-9);
    assert.ok(a <= b);
    assert.ok(isStandard(a, series) && isStandard(b, series), "both parts are standard values");
  }
  return pairs;
};
assert.ok(check(4990, "R", "E24", 1).length > 0);
assert.ok(check(65e-9, "C", "E12", 2).length > 0);
assert.ok(check(1234, "R", "E12", 5).length > 0);
assert.ok(check(8.2e-12, "C", "E6", 5).length >= 0);

// Hand-checked answers.
const hasPair = (pairs, topology, a, b) => pairs.some((p) => p.topology === topology && p.parts[0] === a && p.parts[1] === b);
{
  assert.ok(hasPair(findPairs(2000, "R", "E12", 0.01), "series", 1000, 1000), "two 1k in series = 2k");
  assert.ok(hasPair(findPairs(500, "R", "E12", 0.01), "parallel", 1000, 1000), "two 1k in parallel = 500");
  assert.ok(hasPair(findPairs(2e-6, "C", "E12", 0.01), "parallel", 1e-6, 1e-6), "capacitors add in parallel");
  assert.ok(hasPair(findPairs(5e-7, "C", "E12", 0.01), "series", 1e-6, 1e-6), "two equal capacitors in series halve the value");
  assert.ok(hasPair(findPairs(3000, "R", "E6", 0.01), "parallel", 6800, 6800) === false, "6.8k || 6.8k is 3.4k, not 3k");
}

// Ranking: reusing values already on the BOM beats a slightly closer match with new values.
{
  const none = suggestNetworks(4990, "R", { series: "E24", tolerance: 1 });
  const reuse = suggestNetworks(4990, "R", { series: "E24", tolerance: 1, have: new Set([5100, 240000]) });
  assert.equal(reuse[0].newValues, 0);
  assert.deepEqual(reuse[0].parts, [5100, 240000]);
  assert.ok(none[0].newValues >= 1);
  assert.equal(suggestNetworks(4990, "R", { series: "E24", tolerance: 1, limit: 2 }).length, 2);
}

// Nothing within a tight tolerance: no options, no crash.
assert.deepEqual(findPairs(4990, "R", "E6", 0.01), []);

assert.equal(format(4990, "R"), "4.99 kΩ");
assert.equal(format(6.5e-8, "C"), "65 nF");
assert.equal(format(1e-6, "C"), "1 µF");
assert.equal(format(2.2e6, "R"), "2.2 MΩ");
assert.equal(format(47, "R"), "47 Ω");
assert.equal(format(4.7e-12, "C"), "4.7 pF");

// analyse(): only resistors/capacitors, standard values untouched, quantities and reuse reported.
{
  const out = analyse([
    { component: "Resistor", value: "1 kΩ", details: "", quantity: 2 },
    { component: "Resistor", value: "4.99 kΩ", details: "", quantity: 3 },
    { component: "Capacitor", value: "1 µF", details: "", quantity: 1 },
    { component: "Capacitor", value: "65 nF", details: "", quantity: 1 },
    { component: "Inductor", value: "10 mH", details: "", quantity: 1 },
    { component: "Resistor", value: "", details: "", quantity: 1 },
    { component: "Voltage Source", value: "5 V", details: "", quantity: 1 },
  ]);
  assert.deepEqual(out.settings, { resistorSeries: "E24", capacitorSeries: "E12", tolerance: 1 });
  assert.equal(out.checked, 4);
  assert.equal(out.standardCount, 2);
  assert.deepEqual(out.items.map((i) => i.value), ["4.99 kΩ", "65 nF"]);
  const r = out.items[0];
  assert.equal(r.quantity, 3);
  assert.equal(r.nearest.label, "5.1 kΩ");
  assert.equal(r.nearest.withinTolerance, false, "2.2% is outside 1%");
  assert.ok(r.options.length >= 1 && r.options.length <= 3);
  for (const o of r.options) {
    assert.equal(o.totalParts, 6, "2 parts x 3 units");
    assert.ok(Math.abs(o.errPct) <= 1);
    assert.ok(o.note.length > 10);
  }
  // 1 kΩ is on the BOM and standard, so it is reused when it fits: 4.99k needs no 1k part, so nothing flagged here,
  // but a target that 1k makes up is flagged as already on the BOM:
  const reuse = analyse([
    { component: "Resistor", value: "1 kΩ", details: "", quantity: 1 },
    { component: "Resistor", value: "2.02 kΩ", details: "", quantity: 1 },
  ], { tolerance: 1 });
  assert.ok(reuse.items[0].options.some((o) => o.newValues === 0), "1k + 1k (2k, +1%) uses only a value already on the BOM");
  assert.equal(reuse.items[0].nearest.withinTolerance, true, "a single 2k is within 1% of 2.02k");
  assert.equal(reuse.items[0].options[0].parts.every((p) => p.onBom), true);
  // series / tolerance settings are respected
  const fine = analyse([{ component: "Resistor", value: "4.99 kΩ", quantity: 1 }], { resistorSeries: "E96" });
  assert.equal(fine.items.length, 0);
  assert.equal(fine.standardCount, 1);
  // search cap
  const many = analyse(Array.from({ length: 50 }, (_, i) => ({ component: "Resistor", value: `${1000 + 13 * (i + 1)} Ω`, quantity: 1 })), { resistorSeries: "E6" });
  assert.equal(many.items.length, 30);
  assert.equal(many.truncated, true);
}

console.log("networks tests passed");
