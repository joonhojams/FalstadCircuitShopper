import assert from "node:assert/strict";
import { buildQuery, parseValue } from "../src/queries.js";
import { cheapestOptions } from "../src/pricing.js";

// ---- value parsing ----
assert.equal(parseValue("4.7 kΩ"), 4700);
assert.equal(parseValue("1 MΩ"), 1e6);
assert.equal(parseValue("470 Ω"), 470);
assert.ok(Math.abs(parseValue("100 nF") - 1e-7) < 1e-20);
assert.equal(parseValue("1 µF"), 1e-6);
assert.equal(parseValue("10 mH"), 0.01);
assert.equal(parseValue("5 V amplitude"), 5);
assert.equal(parseValue("NPN"), null);
assert.equal(parseValue(""), null);

// ---- query building ----
const q = (component, value = "", details = "", pkg = "tht") => buildQuery({ component, value, details }, pkg);
assert.equal(q("Resistor", "10 kΩ").query, "RES 10K OHM 1/4W AXIAL");
assert.equal(q("Resistor", "4.7 kΩ").query, "RES 4.7K OHM 1/4W AXIAL");
assert.equal(q("Resistor", "1 MΩ").query, "RES 1M OHM 1/4W AXIAL");
assert.equal(q("Resistor", "470 Ω").query, "RES 470 OHM 1/4W AXIAL");
assert.equal(q("Resistor", "10 kΩ", "", "smd").query, "RES 10K OHM 1/8W 0805");
assert.equal(q("Resistor", "10 kΩ", "", "any").query, "RES 10K OHM");
assert.equal(q("Capacitor", "100 nF").query, "CAP CER 0.1UF 50V RADIAL");
assert.equal(q("Capacitor", "1 nF").query, "CAP CER 1000PF 50V RADIAL");
assert.equal(q("Capacitor", "1 µF").query, "CAP ALUM 1UF 25V RADIAL");
assert.equal(q("Capacitor", "100 µF", "", "smd").query, "CAP ALUM 100UF 25V SMD");
assert.equal(q("Capacitor", "100 nF").assumed, true);
assert.equal(q("Inductor", "10 mH").query, "FIXED IND 10MH");
assert.equal(q("Inductor", "4.7 µH").query, "FIXED IND 4.7UH");
assert.equal(q("Potentiometer", "100 kΩ").query, "POTENTIOMETER 100K OHM");
assert.deepEqual(q("Diode", "1N4148"), { query: "1N4148" });
assert.equal(q("Diode", "default").query, "1N4148");
assert.equal(q("Diode", "default").assumed, true);
assert.equal(q("BJT Transistor", "NPN").query, "2N3904");
assert.equal(q("BJT Transistor", "PNP").query, "2N3906");
assert.equal(q("BJT Transistor", "NPN", "2N2222").query, "2N2222");
assert.equal(q("MOSFET", "N-channel").query, "2N7000");
assert.equal(q("MOSFET", "P-channel").query, "BS250");
assert.equal(q("JFET", "default-jfet").query, "2N5457");
assert.equal(q("Op-Amp").query, "LM358 8-DIP");
assert.equal(q("Op-Amp", "", "", "smd").query, "LM358 8-SOIC");
assert.equal(q("555 Timer").query, "NE555 8-DIP");
assert.equal(q("Switch (SPST)", "", "Momentary").query, "SWITCH TACTILE SPST-NO");
assert.equal(q("Switch (SPDT)").query, "SWITCH TOGGLE SPDT");
assert.ok(q("Voltage Rail", "5 V").skip, "supply rails are not purchasable");
assert.ok(q("Voltage Source", "5 V amplitude").skip);
assert.equal(q("Transformer").query, null, "unmapped parts need a manual search");
assert.equal(q("Resistor", "").query, null);

// ---- choosing the cheapest option ----
const mk = (mpn, vars, extra = {}) => ({
  ManufacturerProductNumber: mpn, Manufacturer: { Name: "Acme" }, Description: { ProductDescription: `RES ${mpn}` },
  ProductUrl: `https://www.digikey.com/p/${mpn}`, QuantityAvailable: 1e5, ProductVariations: vars, ...extra,
});
const variation = (dkpn, name, moq, stock, breaks) => ({
  DigiKeyProductNumber: dkpn, PackageType: { Name: name }, MinimumOrderQuantity: moq,
  QuantityAvailableforPackageType: stock,
  StandardPricing: breaks.map(([BreakQuantity, UnitPrice]) => ({ BreakQuantity, UnitPrice, TotalPrice: BreakQuantity * UnitPrice })),
});

const products = [
  // Cut tape 0.10 each (4 -> 0.40); tape & reel needs 5000 pieces so is far more expensive.
  mk("P1", [variation("P1-CT", "Cut Tape (CT)", 1, 50000, [[1, 0.1], [10, 0.04], [100, 0.015]]),
            variation("P1-TR", "Tape & Reel (TR)", 5000, 100000, [[5000, 0.005]])]),
  // 4 x 0.08 = 0.32, and 10 x 0.02 = 0.20 is cheaper still.
  mk("P2", [variation("P2-CT", "Cut Tape (CT)", 1, 900, [[1, 0.08], [10, 0.02]])], { Description: "RES P2 plain string" }),
  mk("P3", [variation("P3-CT", "Cut Tape (CT)", 1, 2, [[1, 0.01]])]),                       // only 2 in stock
  mk("P4", [variation("P4-CT", "Cut Tape (CT)", 1, 5000, [[1, 0.001]])], { Discontinued: true }),
  mk("P5", [variation("P5-CT", "Cut Tape (CT)", 10, 5000, [[10, 0.05]])]),                  // MOQ 10 -> 0.50
];
const opts = cheapestOptions(products, 4);
assert.deepEqual(opts.map((o) => o.mpn), ["P2", "P1", "P5"]);
assert.equal(opts[0].unitPrice, 0.08);
assert.equal(opts[0].total, 0.32);
assert.equal(opts[0].orderQty, 4);
assert.deepEqual(opts[0].buyMore, { quantity: 10, unitPrice: 0.02, total: 0.2 });
assert.equal(opts[0].description, "RES P2 plain string", "plain-string descriptions are supported");
assert.equal(opts[1].packaging, "Cut Tape (CT)", "one option per part: cheapest packaging wins");
assert.equal(opts[1].dkpn, "P1-CT");
assert.equal(opts[2].orderQty, 10, "minimum order quantity raises the order size");
assert.equal(opts[2].total, 0.5);
assert.equal(opts[2].moq, 10);

// stock filter off: the 2-in-stock part is allowed, and cheapest first
const all = cheapestOptions(products, 4, { inStock: false, max: 10 });
assert.equal(all[0].mpn, "P3");
assert.ok(!all.some((o) => o.mpn === "P4"), "discontinued parts are never offered");

// price break applies at higher quantities
const many = cheapestOptions(products, 120, { max: 1 })[0];
assert.equal(many.unitPrice, 0.015);
assert.equal(many.total, 1.8);

// falls back to product UnitPrice when no pricing breaks are given
const fallback = cheapestOptions([{ ManufacturerProductNumber: "F1", UnitPrice: 0.25, QuantityAvailable: 100, ProductVariations: [{ DigiKeyProductNumber: "F1-ND" }] }], 2);
assert.equal(fallback[0].total, 0.5);

// empty / junk input
assert.deepEqual(cheapestOptions([], 4), []);
assert.deepEqual(cheapestOptions(undefined, 4), []);
assert.deepEqual(cheapestOptions([{ ManufacturerProductNumber: "X" }], 4), []);

// ---- tariff / usually-stocking / marketplace flags ----
{
  const mk = (mpn, unit, extra = {}, varExtra = {}) => ({
    ManufacturerProductNumber: mpn, Manufacturer: { Name: "Acme" }, QuantityAvailable: 5000,
    ProductVariations: [{ DigiKeyProductNumber: `${mpn}-ND`, MinimumOrderQuantity: 1, QuantityAvailableforPackageType: 5000,
      StandardPricing: [{ BreakQuantity: 1, UnitPrice: unit }], ...varExtra }],
    ...extra,
  });
  const products = [
    mk("TARIFF", 0.01, { TariffActive: true, NormallyStocking: true }),
    mk("NORMAL", 0.02, { TariffActive: false, NormallyStocking: true }),
    mk("SPECIAL", 0.03, { TariffActive: false, NormallyStocking: false }),
    mk("UNKNOWN", 0.04),
    mk("MARKET", 0.05, { TariffActive: false, NormallyStocking: true }, { MarketPlace: true }),
  ];
  const mpns = (o) => o.map((x) => x.mpn);
  assert.deepEqual(mpns(cheapestOptions(products, 1, { max: 10 })), ["TARIFF", "NORMAL", "SPECIAL", "UNKNOWN", "MARKET"], "no filters: everything");
  assert.deepEqual(mpns(cheapestOptions(products, 1, { max: 10, excludeTariffed: true })), ["NORMAL", "SPECIAL", "UNKNOWN", "MARKET"]);
  assert.deepEqual(mpns(cheapestOptions(products, 1, { max: 10, normallyOnly: true })), ["TARIFF", "NORMAL", "MARKET"], "only parts flagged as normally stocked");
  assert.deepEqual(mpns(cheapestOptions(products, 1, { max: 10, normallyOnly: true, excludeTariffed: true })), ["NORMAL", "MARKET"]);
  const all = cheapestOptions(products, 1, { max: 10 });
  assert.deepEqual(all.map((o) => [o.tariffed, o.normallyStocking, o.marketplace]), [
    [true, true, false], [false, true, false], [false, false, false], [false, false, false], [false, true, true]]);
  // filters apply before the cap, so a few tariffed parts can't crowd out the rest
  assert.deepEqual(mpns(cheapestOptions(products, 1, { max: 1, excludeTariffed: true })), ["NORMAL"]);
}

console.log("pricing tests passed");
