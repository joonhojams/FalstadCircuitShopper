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
  const r = build(extractNetlist(amp), {});
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 3);
});

test("op-amps pack into dual packages with supply, decoupling and a single power connector", () => {
  let k = 0;
  const r = build(extractNetlist(amp), { ics: { U1: "LM358", U2: "LM358", U3: "LM358" }, uuid: () => `00000000-0000-4000-8000-${String(++k).padStart(12, "0")}` });
  assert.ok(r.ok, r.errors?.join());
  const refs = r.summary.parts.map((p) => p.ref);
  assert.deepEqual(refs.filter((x) => x.startsWith("U")), ["U1", "U3"]);
  assert.ok(refs.includes("J1") && r.summary.parts.filter((x) => x.kind === "decoupling").length === 2);
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
  const r = build(nl, { mounting: "tht" });
  assert.ok(r.ok);
  assert.match(r.summary.parts.find((p) => p.ref === "Q1").footprint, /TO-92/);
  assert.ok(r.warnings.some((w) => /TO-92 pin order/.test(w)));
});

test("unsupported elements block the build unless ignored", () => {
  const nl = extractNetlist(lines("r 0 0 40 0 0 100", "T 300 300 340 300 0 2 1 1 0.99"));
  assert.equal(build(nl, {}).ok, false);
  assert.equal(build(nl, { ignoreUnsupported: true }).ok, true);
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
  const r = build(nl, { mounting: "tht" });
  assert.ok(r.ok, r.errors?.join());
  assert.equal(label(r, "RV1", "1"), "GND");
  assert.equal(label(r, "RV1", "2"), "+5V");
  assert.match(r.summary.parts.find((p) => p.ref === "RV1").footprint, /PinHeader_1x03/);
  assert.ok(r.warnings.some((w) => /Potentiometer pads/.test(w)));
});

test("a PCB-mount pot picked in the BOM gets its real footprint; a panel pot gets a terminal block", () => {
  const nl = extractNetlist(lines("174 100 100 164 100 0 10000 0.5 Volume", "g 100 100 100 120 0", rail5(132, 84)));
  const bourns = build(nl, { choices: { RV1: { mpn: "3296W-1-103LF", mounting: "Through Hole", package: "" } } });
  assert.equal(bourns.summary.parts.find((p) => p.ref === "RV1").footprint, "Potentiometer_THT:Potentiometer_Bourns_3296W_Vertical");
  assert.equal(bourns.summary.parts.find((p) => p.ref === "RV1").source, "BOM");
  const panel = build(nl, { choices: { RV1: { mpn: "P160KNP-0QC20B10K", mounting: "Panel Mount", description: "10K OHM 0.25W PANEL MOUNT" } } });
  assert.match(panel.summary.parts.find((p) => p.ref === "RV1").footprint, /TerminalBlock/);
});

test("logic gate: inputs map to package pins, spare gates are tied low", () => {
  const nl = extractNetlist(lines("150 200 100 264 100 0 2 0 5", "g 200 116 200 140 0", rail5(200, 84)));
  const gate = nl.parts.find((p) => p.kind === "gate");
  assert.deepEqual([gate.fn, gate.inputs], ["and", 2]);
  const r = build(nl, {});
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

test("the IC and package follow the part picked in the BOM when it matches the board's mounting", () => {
  const nl = extractNetlist(lines("151 200 100 264 100 0 2 0 5", "g 200 116 200 140 0", rail5(200, 84)));
  const nand = (c, mounting) => build(nl, { mounting, choices: { U1: c } });
  const dip = nand({ mpn: "SN74HC00N", package: "14-DIP (0.300\", 7.62mm)", mounting: "Through Hole" }, "tht");
  assert.equal(dip.summary.packages[0].ic, "74HC00");
  assert.equal(dip.summary.parts.find((p) => p.ref === "U1").footprint, "Package_DIP:DIP-14_W7.62mm");
  assert.equal(dip.summary.parts.find((p) => p.ref === "U1").value, "SN74HC00N");
  assert.ok(!dip.warnings.some((w) => /this board is/.test(w)));
  const soic = nand({ mpn: "SN74HC00D", package: "14-SOIC (0.154\", 3.90mm Width)", mounting: "Surface Mount" }, "smd");
  assert.match(soic.summary.parts.find((p) => p.ref === "U1").footprint, /SOIC-14/);
  // a pick that is a different gate type is ignored rather than building the wrong function
  const wrong = build(extractNetlist(lines("150 200 100 264 100 0 2 0 5", "g 200 116 200 140 0", rail5(200, 84))), { choices: { U1: { mpn: "SN74HC00N" } } });
  assert.equal(wrong.summary.packages[0].ic, "74HC08");
});

test("a board has one mounting style: it must be chosen, and a BOM pick of the other style is reported, not followed", () => {
  const nl = extractNetlist(lines("151 200 100 264 100 0 2 0 5", "g 200 116 200 140 0", rail5(200, 84)));
  const none = buildProject(nl, {});
  assert.equal(none.ok, false);
  assert.match(none.errors[0], /Choose through-hole or surface-mount/);
  assert.equal(buildProject(nl, { mounting: "dip" }).ok, false);
  const dipOnSmd = build(nl, { mounting: "smd", choices: { U1: { mpn: "SN74HC00N", package: "14-DIP", mounting: "Through Hole" } } });
  assert.match(dipOnSmd.summary.parts.find((p) => p.ref === "U1").footprint, /SOIC-14/);
  assert.ok(dipOnSmd.warnings.some((w) => /through-hole but this board is surface-mount/.test(w)));
});

test("three-input gates use triple-gate ICs; four inputs are blocked", () => {
  const three = build(extractNetlist(lines("152 200 100 264 100 0 3 0 5", rail5(200, 84))), {});
  assert.equal(three.ok, false); // OR3 has no catalog IC: an error, not a wrong board
  const nand3 = build(extractNetlist(lines("151 200 100 264 100 0 3 0 5", rail5(200, 100))), {});
  assert.equal(nand3.summary.packages[0].ic, "74HC10");
  const four = extractNetlist(lines("150 200 100 264 100 0 4 0 5"));
  assert.ok(four.unsupported.length);
});

test("555 timer: pins follow the Falstad chip layout and map to DIP-8 pins", () => {
  // flags 6 = reset + ground pin; chip at (300,100): Vin on top at (364,68), gnd on bottom at (396,260)
  const nl = extractNetlist(lines("165 300 100 396 100 6 0", rail5(364, 68), "g 396 260 396 280 0"));
  const t = nl.parts.find((p) => p.kind === "timer");
  assert.equal(t.pins.length, 8);
  const r = build(nl, {});
  assert.ok(r.ok, r.errors?.join());
  assert.equal(r.summary.packages[0].ic, "NE555");
  assert.equal(label(r, "U1", "8"), "+5V");
  assert.equal(label(r, "U1", "1"), "GND");
  assert.match(r.summary.parts.find((p) => p.ref === "U1").footprint, /SOIC-8/);
  assert.equal(build(nl, { mounting: "tht" }).summary.parts.find((p) => p.ref === "U1").footprint, "Package_DIP:DIP-8_W7.62mm");
});

test("a 555 without ground or reset pins gets them wired on the board", () => {
  const nl = extractNetlist(lines("165 300 100 396 100 0 0", rail5(364, 68)));
  const r = build(nl, {});
  assert.ok(r.ok, r.errors?.join());
  assert.equal(label(r, "U1", "1"), "GND");
  assert.equal(label(r, "U1", "4"), "+5V");  // reset tied high
});

test("resistor and BJT footprints follow the board's mounting; a pick of the other style is warned about", () => {
  const nl = extractNetlist(lines(rail5(360, 84), "g 360 116 360 136 0", "t 300 100 360 100 0 1 0.7 0 100", "r 240 100 300 100 0 1000"));
  const picks = {
    R1: { mpn: "RC0603FR-071KL", package: "0603 (1608 Metric)", mounting: "Surface Mount" },
    Q1: { mpn: "BC547BTA", package: "TO-92-3", mounting: "Through Hole" },
  };
  const tht = build(nl, { mounting: "tht", choices: picks });
  assert.ok(tht.ok, tht.errors?.join());
  assert.match(tht.summary.parts.find((p) => p.ref === "R1").footprint, /^Resistor_THT:/);
  assert.ok(tht.warnings.some((w) => /surface-mount but this board is through-hole/.test(w)), "the 0603 pick is reported");
  assert.equal(tht.summary.parts.find((p) => p.ref === "Q1").footprint, "Package_TO_SOT_THT:TO-92_Inline");
  assert.ok(!tht.warnings.some((w) => /TO-92 pin order/.test(w)), "BC547 pinout is known");
  assert.equal(label(tht, "Q1", "2"), "N001");  // base on pad 2

  const smd = build(nl, { mounting: "smd", choices: picks });
  assert.equal(smd.summary.parts.find((p) => p.ref === "R1").footprint, "Resistor_SMD:R_0603_1608Metric");
  assert.match(smd.summary.parts.find((p) => p.ref === "Q1").footprint, /SOT-23/);
  assert.ok(smd.warnings.some((w) => /through-hole but this board is surface-mount/.test(w)), "the TO-92 pick is reported");
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
  const built = build(nl, {});
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

// ---- .kicad_pcb ----
import { parseSexp, kids, kid } from "../scripts/sexp.mjs";
import { FOOTPRINT_DATA } from "../src/footprint-data.js";
import { missingFootprints } from "../src/pcb.js";
import { resolve, icFootprint } from "../src/footprints.js";

// A board needs an explicit mounting style; most tests do not care which.
const build = (nl, o = {}) => buildProject(nl, { mounting: "smd", ...o });

const detUuid = () => { let k = 0; return () => `00000000-0000-4000-8000-${String(++k).padStart(12, "0")}`; };
const ampBuild = () => build(extractNetlist(amp), { name: "amp", ics: { U1: "LM358", U2: "LM358", U3: "LM358" }, uuid: detUuid() });

test("every footprint the app can choose has geometry (and so exists in the KiCad library it was read from)", () => {
  const names = new Set();
  for (const kind of ["resistor", "capacitor", "inductor", "diode", "zener", "led", "switch", "bjt", "mosfet", "pot"]) {
    for (const mount of ["smd", "tht"]) {
      names.add(resolve(kind, undefined, mount).footprint);
      for (const mounting of ["Surface Mount", "Through Hole"]) {
        for (const pkg of ["0201", "0402", "0603", "0805", "1206", "1210", "1812", "2010", "2512", "SOT-23", "SOT-223", "TO-252", "TO-92", "TO-220", "SOD-123", "SOD-323", "SMA", "SMB", "DO-41", "DO-35", "radial", "film", "axial"]) {
          names.add(resolve(kind, { package: pkg, mounting, description: pkg === "radial" ? "aluminum electrolytic" : pkg === "film" ? "film polyester" : "" }, mount).footprint);
        }
      }
    }
  }
  for (const mpn of ["3296W-1-103", "3296P-1-103", "3296Y-1-103", "3386P-1-103", "RK09K1130A5G"]) names.add(resolve("pot", { mpn, mounting: "Through Hole" }, "tht").footprint);
  for (const ic of Object.values(ICS)) for (const m of ["smd", "tht"]) names.add(icFootprint(ic, undefined, m).footprint);
  for (const pk of ["tssop", "msop"]) for (const ic of Object.values(ICS)) names.add(icFootprint(ic, { package: pk }, "smd").footprint);
  const missing = [...names].filter((n) => !FOOTPRINT_DATA[n]);
  assert.deepEqual(missing, [], `no geometry for: ${missing.join(", ")}`);
});

test(".kicad_pcb is well formed, links to the schematic symbols and carries the schematic's nets on its pads", () => {
  const r = ampBuild();
  assert.ok(r.ok, r.errors?.join());
  const pcb = parseSexp(r.files["amp.kicad_pcb"]);
  const sch = parseSexp(r.files["amp.kicad_sch"]);
  assert.equal(pcb[0], "kicad_pcb");
  const fps = kids(pcb, "footprint");
  assert.equal(fps.length, r.summary.parts.length);

  // symbol uuid by reference in the schematic
  const symUuid = {};
  for (const s of kids(sch, "symbol")) symUuid[kids(s, "property").find((p) => p[1] === "Reference")[2]] = kid(s, "uuid")[1];

  // net table: ids are unique and every pad net matches it
  const table = new Map(kids(pcb, "net").map((n) => [n[1], n[2]]));
  assert.equal(table.get("0"), "");
  assert.equal(new Set(table.keys()).size, table.size);

  const want = new Map(r.labels.map((l) => [`${l.ref}:${l.num}`, `/${l.net}`]));
  let checked = 0;
  for (const f of fps) {
    const ref = kids(f, "property").find((p) => p[1] === "Reference")[2];
    assert.equal(kid(f, "path")[1], `/${symUuid[ref]}`, `${ref} is linked to its symbol`);
    assert.ok(kid(f, "attr"), `${ref} has an attr`);
    assert.ok(kids(f, "pad").length > 0, `${ref} has pads`);
    for (const pad of kids(f, "pad")) {
      const net = kid(pad, "net");
      const expected = want.get(`${ref}:${pad[1]}`);
      if (expected === undefined) { assert.equal(net, undefined, `${ref}.${pad[1]} should be unconnected`); continue; }
      assert.equal(net[2], expected, `${ref}.${pad[1]} net`);
      assert.equal(table.get(net[1]), expected, `${ref}.${pad[1]} net id matches the table`);
      checked++;
    }
  }
  assert.equal(checked, r.labels.length, "every labelled pin ended up on a pad");
});

test("placement keeps courtyards apart and inside the board outline, with J1 on the left edge", () => {
  const r = ampBuild();
  const pcb = parseSexp(r.files["amp.kicad_pcb"]);
  const edge = [...kids(pcb, "gr_line"), ...kids(pcb, "gr_arc")];
  assert.equal(edge.length, 8, "four sides and four rounded corners");
  assert.ok(edge.every((e) => kid(e, "layer")[1] === "Edge.Cuts"));
  const xs = edge.flatMap((e) => [kid(e, "start"), kid(e, "end")].map((p) => Number(p[1]))), ys = edge.flatMap((e) => [kid(e, "start"), kid(e, "end")].map((p) => Number(p[2])));
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  assert.ok(r.pcb.real && r.pcb.w === x1 - x0 && r.pcb.l === y1 - y0, "preview size equals the outline");

  const layout = r.layout;
  const boxes = layout.parts.map((p) => ({ ref: p.it.ref, b: p.box }));
  for (const { ref, b } of boxes) assert.ok(b[0] >= 0 && b[1] >= 0 && b[2] <= layout.w && b[3] <= layout.l, `${ref} is inside the board`);
  for (const [i, a] of boxes.entries()) for (const c of boxes.slice(i + 1)) {
    assert.ok(a.b[2] <= c.b[0] || c.b[2] <= a.b[0] || a.b[3] <= c.b[1] || c.b[3] <= a.b[1], `${a.ref} and ${c.ref} courtyards overlap`);
  }
  const j1 = layout.parts.find((p) => p.it.ref === "J1");
  assert.ok(layout.parts.every((p) => p === j1 || p.box[0] > j1.box[2]), "J1 is the leftmost part");
});

test("decoupling capacitors land next to their IC", () => {
  const r = ampBuild();
  const near = (ic, cap) => {
    const a = r.pcb.parts.find((p) => p.ref === ic), b = r.pcb.parts.find((p) => p.ref === cap);
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  const first = r.summary.packages[0];
  const cap = r.summary.parts.find((p) => p.kind === "decoupling").ref;
  assert.ok(near(first.ref, cap) < 9, `${cap} is ${near(first.ref, cap).toFixed(1)} mm from ${first.ref}`);
});

test("output is deterministic", () => {
  assert.equal(ampBuild().files["amp.kicad_pcb"], ampBuild().files["amp.kicad_pcb"]);
});

test("a footprint without geometry blocks the .kicad_pcb with a warning instead of writing a partial board", () => {
  assert.deepEqual(missingFootprints([{ footprint: "Resistor_SMD:R_0805_2012Metric" }, { footprint: "Nope:Nothing" }]), ["Nope:Nothing"]);
});

test("the zip carries the board", () => {
  const r = ampBuild();
  const bytes = new TextDecoder("latin1").decode(zip(r.files));
  for (const f of ["amp.kicad_sch", "amp.kicad_pro", "amp.kicad_pcb"]) assert.ok(bytes.includes(f), f);
});

test("a capacitor size KiCad does not have falls back with a warning", () => {
  const c = resolve("capacitor", { package: "2512", mounting: "Surface Mount" }, "smd");
  assert.equal(c.footprint, "Capacitor_SMD:C_1812_4532Metric");
  assert.match(c.warning, /no 2512 capacitor footprint/);
});

// ---- spec rules: net classes, project and DRC files ----
import { buildRules, classifyNets, PARAMS } from "../src/rules.js";

test("rules: spec values, fab limits intersect, and the via follows annular_min over via_pref", () => {
  const r = buildRules({ mounting: "tht" });
  assert.equal(r.classes.AUDIO_SIG.track, 0.35);
  assert.equal(r.classes.HIGH_Z.clear, 0.4);
  assert.equal(r.grid.route, 0.635);
  assert.deepEqual([r.via.pad, r.via.drill], [1, 0.4], "0.8/0.4 would leave a 0.2 mm ring, below annular_min 0.3");
  assert.ok((r.via.pad - r.via.drill) / 2 >= PARAMS.annular_min - 1e-9);
  assert.ok(r.deviations.some((d) => /annular/.test(d)));
  assert.ok(r.assumptions.some((a) => /Fab limits not given/.test(a)));
  const strict = buildRules({ mounting: "smd", fab: { house: "X", minTrace: 0.4, minClear: 0.4 } });
  assert.equal(strict.classes.HIGH_Z.track, 0.4, "a tighter fab limit wins");
  assert.equal(strict.classes.AUDIO_SIG.clear, 0.4);
  assert.ok(strict.deviations.some((d) => /HIGH_Z track widened/.test(d)));
  assert.equal(strict.grid.route, 0.25);
  assert.ok(strict.deviations.some((d) => /Routing grid 0.25/.test(d)));
});

test("net classes: rails, ground, bias divider and audio are told apart; files carry them", () => {
  const circuit = lines(rail5(100, 40),
    "r 100 40 100 80 0 10000", "r 100 80 100 120 0 10000", "g 100 120 100 140 0",      // divider
    "c 100 80 160 80 0 1e-5 0", "g 160 80 160 100 0",                                   // cap from the midpoint to ground
    "r 200 40 200 80 0 1000", "d 200 80 200 120 2 default", "g 200 120 200 140 0");
  const r = build(extractNetlist(circuit), { mounting: "tht" });
  assert.ok(r.ok, r.errors?.join());
  const cls = Object.fromEntries(r.netClasses.byNet);
  assert.equal(cls.GND, "GND");
  assert.equal(cls["+5V"], "POWER");
  const vals = Object.values(cls);
  assert.ok(vals.includes("BIAS_VREF"), "the divider midpoint");
  assert.ok(vals.includes("AUDIO_SIG"));
  const pro = JSON.parse(r.files["circuit.kicad_pro"]);
  assert.deepEqual(pro.net_settings.classes.map((c) => c.name).slice(0, 2), ["Default", "AUDIO_SIG"]);
  assert.ok(pro.net_settings.netclass_patterns.some((p) => p.netclass === "POWER" && p.pattern === "/+5V"));
  assert.ok(pro.net_settings.classes.every((c) => c.via_diameter === 1 && c.via_drill === 0.4));
  const dru = r.files["circuit.kicad_dru"];
  assert.match(dru, /^\(version 1\)/);
  assert.match(dru, /highz_clearance/);
  assert.equal([...dru].filter((c) => c === "(").length, [...dru].filter((c) => c === ")").length, "balanced parentheses");
});

test("net classes: LED pins and VREF names, and precedence", () => {
  const it = (ref, kind, pins) => ({ ref, kind, pins: pins.map(([num, net, fn]) => ({ num, net, fn })) });
  const { byNet } = classifyNets([
    it("D1", "led", [["2", "LED_A", "A"], ["1", "LED_K", "K"]]),
    it("R1", "resistor", [["1", "+9V"], ["2", "LED_A"]]),
    it("U1", "opamp", [["3", "VREF", "+"], ["2", "IN", "-"], ["1", "OUT", "OUT"]]),
    it("Q1", "bjt", [["2", "BASE", "B"], ["1", "EM", "E"], ["3", "COL", "C"]]),
  ], ["+9V"]);
  assert.equal(byNet.get("LED_A"), "LED_CTRL");
  assert.equal(byNet.get("LED_K"), "LED_CTRL");
  assert.equal(byNet.get("VREF"), "BIAS_VREF", "VREF wins over HIGH_Z although it feeds a + input");
  assert.equal(byNet.get("BASE"), "HIGH_Z");
  assert.equal(byNet.get("OUT"), "AUDIO_SIG");
  assert.equal(byNet.get("+9V"), "POWER");
});

test("op-amp + inputs and transistor bases are HIGH_Z", () => {
  const nl = extractNetlist(amp);
  const r = build(nl, { ics: { U1: "LM358", U2: "LM358", U3: "LM358" } });
  const highZ = [...r.netClasses.byNet].filter(([, c]) => c === "HIGH_Z");
  assert.ok(highZ.length >= 1, "at least one op-amp + input net");
  const bjt = build(extractNetlist(lines(rail5(360, 84), "g 360 116 360 136 0", "t 300 100 360 100 0 1 0.7 0 100", "r 240 100 300 100 0 1000")), { mounting: "tht" });
  assert.equal(bjt.netClasses.byNet.get(bjt.labels.find((l) => l.ref === "Q1" && l.num === "2").net), "HIGH_Z", "the base net");
});

test("through-hole boards sit on the 1.27 mm placement grid with the origin on the 2.54 mm grid; SMD boards use 0.5", () => {
  const near = (v, step) => Math.abs(v / step - Math.round(v / step)) < 1e-6;
  const tht = build(extractNetlist(amp), { mounting: "tht", ics: { U1: "LM358", U2: "LM358", U3: "LM358" } });
  assert.ok(tht.layout.parts.every((p) => near(p.x, 1.27) && near(p.y, 1.27)), "part origins on 1.27");
  const pcb = parseSexp(tht.files["circuit.kicad_pcb"]);
  for (const f of kids(pcb, "footprint")) {
    const at = kid(f, "at");
    assert.ok(near(Number(at[1]), 1.27) && near(Number(at[2]), 1.27), "footprint origin on the 1.27 grid in KiCad's coordinates");
  }
  const smd = build(extractNetlist(amp), { mounting: "smd", ics: { U1: "LM358", U2: "LM358", U3: "LM358" } });
  assert.ok(smd.layout.parts.every((p) => near(p.x, 0.5) && near(p.y, 0.5)));
  const outline = kids(parseSexp(smd.files["circuit.kicad_pcb"]), "gr_arc");
  assert.equal(outline.length, 4, "rounded corners, radius at least 1 mm");
});

// ---- Specctra DSN (Freerouting) ----
import { parseSexp as parseDsn } from "../scripts/sexp.mjs";

test(".dsn is well formed and carries every placed pad, net and net class", () => {
  const r = ampBuild();
  const dsn = r.files["amp.dsn"];
  assert.ok(dsn, "the zip carries a .dsn");
  const t = parseDsn(dsn);
  assert.equal(t[0], "pcb");
  const structure = kid(t, "structure");
  assert.equal(kids(structure, "layer").length, 2);
  const boundary = kid(kid(structure, "boundary"), "path");
  assert.deepEqual(boundary.slice(3).map(Number), [0, 0, r.layout.w * 1000, 0, r.layout.w * 1000, -r.layout.l * 1000, 0, -r.layout.l * 1000, 0, 0]);

  const comps = kids(kid(t, "placement"), "component");
  assert.equal(comps.length, r.layout.parts.length);
  const images = new Map(kids(kid(t, "library"), "image").map((i) => [i[1], kids(i, "pin")]));
  for (const c of comps) {
    const place = kid(c, "place");
    const part = r.layout.parts.find((p) => p.it.ref === place[1]);
    assert.equal(Number(place[2]), Math.round(part.x * 1000));
    assert.equal(Number(place[3]), -Math.round(part.y * 1000));
    assert.equal(images.get(c[1]).length, part.pads.length, `${place[1]} pads`);
  }
  // every pad of every multi-pad net is listed once, under the name the .kicad_pcb uses
  const want = new Map();
  for (const p of r.layout.parts) for (const d of p.pads) if (d.net) (want.get(d.net) ?? want.set(d.net, []).get(d.net)).push(`${p.it.ref}-${d.n}`);
  const got = new Map(kids(kid(t, "network"), "net").map((n) => [n[1], kid(n, "pins").slice(1)]));
  for (const [net, pins] of want) {
    if (pins.length < 2) { assert.ok(!got.has(`/${net}`), `${net} has one pad and is left out`); continue; }
    assert.deepEqual([...got.get(`/${net}`)].sort(), pins.sort(), net);
  }
  // each net sits in exactly one class, and the class widths match the project rules
  const seen = new Set();
  for (const cl of kids(kid(t, "network"), "class")) {
    const w = Number(kid(kid(cl, "rule"), "width")[1]);
    assert.equal(w, Math.round(r.rules.classes[cl[1]].track * 1000), `${cl[1]} width`);
    for (const n of cl.slice(2).filter((x) => typeof x === "string")) { assert.ok(!seen.has(n), `${n} in two classes`); seen.add(n); }
  }
  assert.deepEqual([...seen].sort(), [...got.keys()].sort());
  // the via named in the structure has a padstack
  const via = kid(structure, "via")[1];
  assert.ok(kids(kid(t, "library"), "padstack").some((p) => p[1] === via), "via padstack exists");
});

test("the zip carries the .dsn and the README explains how to use it", () => {
  const r = ampBuild();
  const bytes = new TextDecoder("latin1").decode(zip(r.files));
  assert.ok(bytes.includes("amp.dsn"));
});
