import test from "node:test";
import assert from "node:assert/strict";
import { extractNetlist } from "../src/netlist.js";
import { buildProject } from "../src/kicad.js";
import { zip, crc32 } from "../src/zip.js";
import { ICS } from "../src/ics.js";

const netOf = (nl, ref, pin) => nl.parts.find((p) => p.ref === ref).pins.find((x) => x.name === pin).net;
const lines = (...l) => l.join("\n");

test("NPN pins: base at point1, collector above and emitter below point2", () => {
  const nl = extractNetlist(lines(
    "R 360 84 360 60 0 0 40 5 0 0 0.5",   // rail on the collector
    "g 360 116 360 136 0",                 // ground on the emitter
    "r 240 100 300 100 0 10000",           // resistor ends on the base
    "t 300 100 360 100 0 1 0.7 0 100"));
  assert.equal(netOf(nl, "Q1", "C"), "+5V");
  assert.equal(netOf(nl, "Q1", "E"), "GND");
  assert.equal(netOf(nl, "Q1", "B"), netOf(nl, "R1", "2"));
  assert.notEqual(netOf(nl, "Q1", "B"), "GND");
});

test("PNP flips collector and emitter", () => {
  const nl = extractNetlist(lines(
    "R 360 84 360 60 0 0 40 5 0 0 0.5",      // PNP emitter is the upper pin
    "g 360 116 360 140 0",
    "t 300 100 360 100 0 -1 0.7 0 100"));
  assert.equal(netOf(nl, "Q1", "E"), "+5V");
  assert.equal(netOf(nl, "Q1", "C"), "GND");
});

test("N-channel MOSFET: source below, drain above; P-channel swaps them", () => {
  const n = extractNetlist(lines("g 560 116 560 136 0", "R 560 84 560 60 0 0 40 5 0 0 0.5", "f 500 100 560 100 0 1.5 0.02"));
  assert.equal(netOf(n, "Q1", "S"), "GND");
  assert.equal(netOf(n, "Q1", "D"), "+5V");
  const p = extractNetlist(lines("R 560 116 560 140 0 0 40 5 0 0 0.5", "g 560 84 560 60 0", "f 500 100 560 100 1 -1.5 0.02"));
  assert.equal(netOf(p, "Q1", "S"), "GND");
  assert.equal(netOf(p, "Q1", "D"), "+5V");
});

test("op-amp: inverting input on the upper side, output at point2", () => {
  const nl = extractNetlist(lines(
    "R 400 284 400 260 0 0 40 5 0 0 0.5",
    "g 400 316 400 336 0",
    "r 500 300 500 380 0 1000",
    "g 500 380 500 400 0",
    "a 400 300 500 300 0 15 -15 100 0.5 0 100000"));
  assert.equal(netOf(nl, "U1", "-"), "+5V");
  assert.equal(netOf(nl, "U1", "+"), "GND");
  assert.equal(netOf(nl, "U1", "OUT"), netOf(nl, "R1", "1"));
});

test("wires and labeled nodes join nets; unsupported elements are reported", () => {
  const nl = extractNetlist(lines(
    "r 0 0 40 0 0 100", "w 40 0 80 0 0", "r 80 0 120 0 0 100",
    "207 120 0 120 16 0 SIG", "207 200 0 200 16 0 SIG", "c 200 0 240 0 0 1e-7 0",
    "T 300 300 340 300 0 2 1 1 0.99"));
  assert.equal(netOf(nl, "R1", "2"), netOf(nl, "R2", "1"));
  assert.equal(netOf(nl, "R2", "2"), "SIG");
  assert.equal(netOf(nl, "C1", "1"), "SIG");
  assert.deepEqual(nl.unsupported.map((u) => u.name), ["Transformer"]);
});

test("all 5 V rails merge into one net, other voltages stay separate", () => {
  const src = lines("R 0 0 0 -20 0 0 40 5 0 0 0.5", "R 100 0 100 -20 0 0 40 5 0 0 0.5", "R 200 0 200 -20 0 0 40 3.3 0 0 0.5",
    "r 0 0 40 40 0 100", "r 100 0 140 40 0 100", "r 200 0 240 40 0 100");
  const nl = extractNetlist(src);
  assert.equal(netOf(nl, "R1", "1"), "+5V");
  assert.equal(netOf(nl, "R2", "1"), "+5V");
  assert.equal(netOf(nl, "R3", "1"), "+3.3V");
  assert.deepEqual(nl.rails.map((r) => r.net), ["+3.3V", "+5V"]);
  // Not merged: two nets are kept apart (the second gets a suffix).
  const un = extractNetlist(src, { mergeRails: false });
  assert.notEqual(netOf(un, "R1", "1"), netOf(un, "R2", "1"));
});

const amp = lines(
  "R 400 284 400 260 0 0 40 5 0 0 0.5", "g 400 316 400 336 0",
  "r 500 300 500 380 0 1000", "g 500 380 500 400 0",
  "a 400 300 500 300 0 15 -15 100 0.5 0 100000",
  "R 600 284 600 260 0 0 40 5 0 0 0.5", "g 600 316 600 336 0",
  "a 600 300 700 300 0 15 -15 100 0.5 0 100000",
  "a 800 300 900 300 0 15 -15 100 0.5 0 100000");

test("build refuses until every op-amp has an IC", () => {
  const r = buildProject(extractNetlist(amp), {});
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 3);
});

test("op-amps pack into dual packages with supply, decoupling and a single power connector", () => {
  let k = 0;
  const r = buildProject(extractNetlist(amp), { ics: { U1: "LM358", U2: "LM358", U3: "LM358" }, uuid: () => `00000000-0000-4000-8000-${String(++k).padStart(12, "0")}` });
  assert.ok(r.ok, r.errors?.join());
  const refs = r.summary.parts.map((p) => p.ref);
  assert.deepEqual(refs.filter((x) => x.startsWith("U")), ["U1", "U3"]);
  assert.ok(refs.includes("J1") && refs.filter((x) => x.startsWith("C_DEC")).length === 2);
  assert.deepEqual(r.summary.supplyNets, ["+5V", "GND"]);
  assert.ok(r.warnings.some((w) => /spare channel/.test(w)));
  const sch = r.files["circuit.kicad_sch"];
  // balanced parentheses (ignoring those inside strings)
  let depth = 0, inStr = false;
  for (let i = 0; i < sch.length; i++) {
    const c = sch[i];
    if (c === "\\" && inStr) { i++; continue; }
    if (c === '"') inStr = !inStr;
    else if (!inStr) { if (c === "(") depth++; else if (c === ")") depth--; assert.ok(depth >= 0); }
  }
  assert.equal(depth, 0);
  // power pins of the first package: V+ (8) on +5V, V- (4) on GND
  const label = (ref, num) => r.labels.find((l) => l.ref === ref && l.num === num)?.net;
  assert.equal(label("U1", "8"), "+5V");
  assert.equal(label("U1", "4"), "GND");
  assert.equal(label("U1", "2"), "+5V");   // U1 "-" input is the +5V rail
  assert.equal(label("U1", "3"), "GND");
  // all uuids unique
  const ids = sch.match(/\(uuid "[^"]+"\)/g);
  assert.equal(new Set(ids).size, ids.length);
});

test("through-hole choice changes footprints and warns about transistor pinouts", () => {
  const nl = extractNetlist(lines("R 360 84 360 60 0 0 40 5 0 0 0.5", "g 360 116 360 136 0", "t 300 100 360 100 0 1 0.7 0 100", "r 240 100 300 100 0 1000"));
  const r = buildProject(nl, { mounting: "tht" });
  assert.ok(r.ok);
  assert.match(r.summary.parts.find((p) => p.ref === "Q1").footprint, /TO-92/);
  assert.ok(r.warnings.some((w) => /TO-92 pin order/.test(w)));
});

test("unsupported elements block the build unless ignored", () => {
  const nl = extractNetlist(lines("r 0 0 40 0 0 100", "T 300 300 340 300 0 2 1 1 0.99"));
  assert.equal(buildProject(nl, {}).ok, false);
  assert.equal(buildProject(nl, { ignoreUnsupported: true }).ok, true);
});

test("zip has valid structure and checksums", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  const z = zip({ "a.txt": "hello", "b/c.txt": "world" });
  assert.equal(z[0], 0x50);
  assert.equal(new DataView(z.buffer, z.byteLength - 22).getUint16(10, true), 2);
});

test("IC library pinouts are consistent", () => {
  for (const ic of Object.values(ICS)) {
    const pins = [...ic.units.flatMap((u) => Object.values(u)), ic.power.pos, ic.power.neg];
    const total = Math.max(...pins.map(Number));
    assert.equal(new Set(pins).size, total, ic.name);
    for (const u of ic.units) {
      const flat = Object.values(u);
      assert.equal(new Set(flat).size, flat.length, `${ic.name} unit`);
    }
  }
});

const rail5 = (x, y) => `R ${x} ${y} ${x} ${y - 24} 0 0 40 5 0 0 0.5`;
const label = (r, ref, num) => r.labels.find((l) => l.ref === ref && l.num === num)?.net;

test("potentiometer: ends and wiper land on the right nets and pads", () => {
  // horizontal pot from (100,100) to (164,100): wiper is 16 px above the middle
  const nl = extractNetlist(lines("174 100 100 164 100 0 10000 0.5 Volume", "g 100 100 100 120 0", rail5(132, 84)));
  const pot = nl.parts.find((p) => p.kind === "pot");
  const net = Object.fromEntries(pot.pins.map((p) => [p.name, p.net]));
  assert.equal(net.A, "GND");
  assert.equal(net.W, "+5V");
  const r = buildProject(nl, { mounting: "tht" });
  assert.ok(r.ok, r.errors?.join());
  assert.equal(label(r, "RV1", "1"), "GND");
  assert.equal(label(r, "RV1", "2"), "+5V");
  assert.match(r.summary.parts.find((p) => p.ref === "RV1").footprint, /PinHeader_1x03/);
  assert.ok(r.warnings.some((w) => /Potentiometer pads/.test(w)));
});

test("a PCB-mount pot picked in the BOM gets its real footprint; a panel pot gets a terminal block", () => {
  const nl = extractNetlist(lines("174 100 100 164 100 0 10000 0.5 Volume", "g 100 100 100 120 0", rail5(132, 84)));
  const bourns = buildProject(nl, { choices: { RV1: { mpn: "3296W-1-103LF", mounting: "Through Hole", package: "" } } });
  assert.equal(bourns.summary.parts.find((p) => p.ref === "RV1").footprint, "Potentiometer_THT:Potentiometer_Bourns_3296W_Vertical");
  assert.equal(bourns.summary.parts.find((p) => p.ref === "RV1").source, "BOM");
  const panel = buildProject(nl, { choices: { RV1: { mpn: "P160KNP-0QC20B10K", mounting: "Panel Mount", description: "10K OHM 0.25W PANEL MOUNT" } } });
  assert.match(panel.summary.parts.find((p) => p.ref === "RV1").footprint, /TerminalBlock/);
});

test("logic gate: inputs map to package pins, spare gates are tied low", () => {
  const nl = extractNetlist(lines("150 200 100 264 100 0 2 0 5", "g 200 116 200 140 0", rail5(200, 84)));
  const gate = nl.parts.find((p) => p.kind === "gate");
  assert.deepEqual([gate.fn, gate.inputs], ["and", 2]);
  const r = buildProject(nl, {});
  assert.ok(r.ok, r.errors?.join());
  const u = r.summary.packages[0];
  assert.equal(u.ic, "74HC08");
  assert.equal(label(r, "U1", "1"), "GND");   // input A on the lower pin
  assert.equal(label(r, "U1", "2"), "+5V");   // input B
  assert.equal(label(r, "U1", "14"), "+5V");
  assert.equal(label(r, "U1", "7"), "GND");
  assert.equal(label(r, "U1", "4"), "GND");   // spare gate input tied low
  assert.match(r.files["circuit.kicad_sch"], /no_connect/);
});

test("the IC and package follow the part picked in the BOM", () => {
  const nl = extractNetlist(lines("151 200 100 264 100 0 2 0 5", "g 200 116 200 140 0", rail5(200, 84)));
  const nand = (c) => buildProject(nl, { choices: { U1: c } });
  const dip = nand({ mpn: "SN74HC00N", package: "14-DIP (0.300\", 7.62mm)", mounting: "Through Hole" });
  assert.equal(dip.summary.packages[0].ic, "74HC00");
  assert.equal(dip.summary.parts.find((p) => p.ref === "U1").footprint, "Package_DIP:DIP-14_W7.62mm");
  assert.equal(dip.summary.parts.find((p) => p.ref === "U1").value, "SN74HC00N");
  const soic = nand({ mpn: "SN74HC00D", package: "14-SOIC (0.154\", 3.90mm Width)", mounting: "Surface Mount" });
  assert.match(soic.summary.parts.find((p) => p.ref === "U1").footprint, /SOIC-14/);
  // a pick that is a different gate type is ignored rather than building the wrong function
  const wrong = buildProject(extractNetlist(lines("150 200 100 264 100 0 2 0 5", "g 200 116 200 140 0", rail5(200, 84))), { choices: { U1: { mpn: "SN74HC00N" } } });
  assert.equal(wrong.summary.packages[0].ic, "74HC08");
});

test("three-input gates use triple-gate ICs; four inputs are blocked", () => {
  const three = buildProject(extractNetlist(lines("152 200 100 264 100 0 3 0 5", rail5(200, 84))), {});
  assert.equal(three.ok, false); // OR3 has no catalog IC: an error, not a wrong board
  const nand3 = buildProject(extractNetlist(lines("151 200 100 264 100 0 3 0 5", rail5(200, 100))), {});
  assert.equal(nand3.summary.packages[0].ic, "74HC10");
  const four = extractNetlist(lines("150 200 100 264 100 0 4 0 5"));
  assert.ok(four.unsupported.length);
});

test("555 timer: pins follow the Falstad chip layout and map to DIP-8 pins", () => {
  // flags 6 = reset + ground pin; chip at (300,100): Vin on top at (364,68), gnd on bottom at (396,260)
  const nl = extractNetlist(lines("165 300 100 396 100 6 0", rail5(364, 68), "g 396 260 396 280 0"));
  const t = nl.parts.find((p) => p.kind === "timer");
  assert.equal(t.pins.length, 8);
  const r = buildProject(nl, {});
  assert.ok(r.ok, r.errors?.join());
  assert.equal(r.summary.packages[0].ic, "NE555");
  assert.equal(label(r, "U1", "8"), "+5V");
  assert.equal(label(r, "U1", "1"), "GND");
  assert.match(r.summary.parts.find((p) => p.ref === "U1").footprint, /SOIC-8/);
  assert.equal(buildProject(nl, { mounting: "tht" }).summary.parts.find((p) => p.ref === "U1").footprint, "Package_DIP:DIP-8_W7.62mm");
});

test("a 555 without ground or reset pins gets them wired on the board", () => {
  const nl = extractNetlist(lines("165 300 100 396 100 0 0", rail5(364, 68)));
  const r = buildProject(nl, {});
  assert.ok(r.ok, r.errors?.join());
  assert.equal(label(r, "U1", "1"), "GND");
  assert.equal(label(r, "U1", "4"), "+5V");  // reset tied high
});

test("resistor and BJT footprints follow the BOM pick over the global setting", () => {
  const nl = extractNetlist(lines(rail5(360, 84), "g 360 116 360 136 0", "t 300 100 360 100 0 1 0.7 0 100", "r 240 100 300 100 0 1000"));
  const r = buildProject(nl, {
    mounting: "tht",
    choices: {
      R1: { mpn: "RC0603FR-071KL", package: "0603 (1608 Metric)", mounting: "Surface Mount" },
      Q1: { mpn: "BC547BTA", package: "TO-92-3", mounting: "Through Hole" },
    },
  });
  assert.ok(r.ok, r.errors?.join());
  assert.equal(r.summary.parts.find((p) => p.ref === "R1").footprint, "Resistor_SMD:R_0603_1608Metric");
  assert.equal(r.summary.parts.find((p) => p.ref === "Q1").footprint, "Package_TO_SOT_THT:TO-92_Inline");
  assert.ok(!r.warnings.some((w) => /TO-92 pin order/.test(w)), "BC547 pinout is known");
  assert.equal(label(r, "Q1", "2"), "N001");  // base on pad 2
});

test("DigiKey parameters reach the price options", async () => {
  const { cheapestOptions } = await import("../src/pricing.js");
  const [o] = cheapestOptions([{
    ManufacturerProductNumber: "X", Manufacturer: { Name: "M" }, QuantityAvailable: 99,
    Parameters: [{ ParameterText: "Mounting Type", ValueText: "Surface Mount" }, { ParameterText: "Package / Case", ValueText: "0805 (2012 Metric)" }],
    ProductVariations: [{ DigiKeyProductNumber: "D", StandardPricing: [{ BreakQuantity: 1, UnitPrice: 0.1 }], QuantityAvailableforPackageType: 99 }],
  }], 1);
  assert.equal(o.mounting, "Surface Mount");
  assert.equal(o.package, "0805 (2012 Metric)");
});

test("board preview: every part gets a body and a spot inside the board outline, no overlaps", async () => {
  const { layoutBoard, bodyFor } = await import("../src/board.js");
  assert.deepEqual([bodyFor("Resistor_SMD:R_0805_2012Metric").w, bodyFor("Resistor_SMD:R_0805_2012Metric").l], [2, 1.2]);
  assert.equal(bodyFor("Capacitor_THT:CP_Radial_D5.0mm_P2.00mm").shape, "cyl");
  const nl = extractNetlist(lines("R 0 0 0 -20 0 0 40 5 0 0 0.5", "r 0 0 60 0 0 1000", "c 60 0 120 0 0 1e-7 0", "g 120 0 120 20 0"));
  const built = buildProject(nl, {});
  assert.ok(built.ok);
  const b = layoutBoard(built.summary.parts);
  assert.equal(b.parts.length, built.summary.parts.length);
  for (const p of b.parts) {
    assert.ok(p.x - p.w / 2 >= 0 && p.x + p.w / 2 <= b.w && p.y - p.l / 2 >= 0 && p.y + p.l / 2 <= b.l, `${p.ref} inside board`);
  }
  for (const [i, a] of b.parts.entries()) for (const c of b.parts.slice(i + 1)) {
    assert.ok(Math.abs(a.x - c.x) >= (a.w + c.w) / 2 || Math.abs(a.y - c.y) >= (a.l + c.l) / 2, `${a.ref} and ${c.ref} do not overlap`);
  }
});
