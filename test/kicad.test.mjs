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

// ---- .kicad_pcb ----
import { parseSexp, kids, kid } from "../scripts/sexp.mjs";
import { FOOTPRINT_DATA } from "../src/footprint-data.js";
import { missingFootprints } from "../src/pcb.js";
import { resolve, icFootprint } from "../src/footprints.js";

const detUuid = () => { let k = 0; return () => `00000000-0000-4000-8000-${String(++k).padStart(12, "0")}`; };
const ampBuild = () => buildProject(extractNetlist(amp), { name: "amp", ics: { U1: "LM358", U2: "LM358", U3: "LM358" }, uuid: detUuid() });

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
  const rect = kid(pcb, "gr_rect");
  const [x0, y0] = kid(rect, "start").slice(1).map(Number), [x1, y1] = kid(rect, "end").slice(1).map(Number);
  assert.equal(kid(rect, "layer")[1], "Edge.Cuts");
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
  const cap = r.summary.parts.find((p) => p.ref.startsWith("C_DEC")).ref;
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

// ---- stage 2: routing ----
import { druText, netSettings } from "../src/rules.js";
import { checkBoard } from "../src/drc.js";

const demoCircuit = lines(
  "R 0 -20 0 -40 0 0 40 5 0 0 0.5", "r 0 0 60 0 0 1000", "c 60 0 120 0 0 1e-7 0", "g 120 0 120 20 0", "r 120 0 180 0 0 4700",
  "t 180 0 240 0 0 1 0.7 0 100", "g 240 20 240 40 0", "d 240 -20 240 0 2 default", "l 300 0 360 0 1 2 0 0",
  "a 400 300 500 300 0 15 -15 100 0.5 0 100000", "r 500 300 500 380 0 1000", "g 500 380 500 400 0");
const demoBuild = (mounting = "smd", extra = {}) => buildProject(extractNetlist(demoCircuit), { name: "demo", ics: { U1: "LM358" }, mounting, uuid: detUuid(), ...extra });

/** Re-derives connectivity from the written .kicad_pcb alone (not from the router's or checker's data). */
function connectivityFromFile(text) {
  const tree = parseSexp(text);
  const rect = kid(tree, "gr_rect");
  const [ox, oy] = kid(rect, "start").slice(1).map(Number);
  const pads = [];
  for (const f of kids(tree, "footprint")) {
    const [fx, fy, fr = 0] = kid(f, "at").slice(1).map(Number);
    const a = (-fr * Math.PI) / 180;                            // KiCad angles are counter-clockwise on a y-down screen
    for (const p of kids(f, "pad")) {
      const net = kid(p, "net");
      if (!net) continue;
      const [px, py] = kid(p, "at").slice(1, 3).map(Number), [w, h] = kid(p, "size").slice(1).map(Number);
      const x = fx + px * Math.cos(a) - py * Math.sin(a), y = fy + px * Math.sin(a) + py * Math.cos(a);
      const quarter = Math.round((Number(kid(p, "at")[3] ?? 0) % 180 + 180) % 180) === 90;      // a pad's angle in the file already includes its footprint's rotation
      const layers = kid(p, "layers").slice(1);
      pads.push({ net: net[2], x, y, hw: (quarter ? h : w) / 2, hh: (quarter ? w : h) / 2, f: layers.includes("F.Cu") || layers.includes("*.Cu"), b: layers.includes("B.Cu") || layers.includes("*.Cu"), tht: p[2] === "thru_hole", name: `${kid(f, "property") && kids(f, "property").find((q) => q[1] === "Reference")[2]}.${p[1]}` });
    }
  }
  const segs = kids(tree, "segment").map((s) => ({ net: kid(s, "net")[1], layer: kid(s, "layer")[1], a: kid(s, "start").slice(1).map(Number), b: kid(s, "end").slice(1).map(Number), w: Number(kid(s, "width")[1]) }));
  const vias = kids(tree, "via").map((v) => ({ net: kid(v, "net")[1], at: kid(v, "at").slice(1).map(Number) }));
  const netNames = new Map(kids(tree, "net").map((n) => [n[1], n[2]]));
  return { pads, segs, vias, netNames, origin: [ox, oy] };
}
const dps = (p, a, b) => {                                       // distance from point p to segment a-b
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
};
const incomplete = (c, skip = new Set(["/GND"])) => {
  const nodes = [];                                              // { net, layer, kind, ... }
  const parent = [];
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const add = (o) => { nodes.push(o); parent.push(nodes.length - 1); return nodes.length - 1; };
  const union = (i, j) => { parent[find(i)] = find(j); };
  const E = 0.02;
  const padNodes = c.pads.map((p) => add({ ...p, kind: "pad" }));
  const segNodes = c.segs.map((s) => add({ ...s, kind: "seg" }));
  const hits = (p, [x, y], layer) => (layer === "F.Cu" ? p.f : p.b) && Math.abs(x - p.x) <= p.hw + E && Math.abs(y - p.y) <= p.hh + E;
  c.segs.forEach((s, i) => {
    for (const [pi, p] of c.pads.entries()) if (p.net === c.netNames.get(s.net) && (hits(p, s.a, s.layer) || hits(p, s.b, s.layer))) union(segNodes[i], padNodes[pi]);
    c.segs.forEach((t, j) => {
      if (j <= i || t.net !== s.net || t.layer !== s.layer) return;
      // KiCad treats an endpoint that lands anywhere on another track's copper (a T junction) as connected
      if ([s.a, s.b].some((p) => dps(p, t.a, t.b) <= E) || [t.a, t.b].some((p) => dps(p, s.a, s.b) <= E)) union(segNodes[i], segNodes[j]);
    });
  });
  // layers are joined by vias and through-hole pads: treat a via as a node touching both layers' segment ends
  const viaNodes = c.vias.map((v) => add({ ...v, kind: "via" }));
  c.vias.forEach((v, vi) => {
    c.segs.forEach((s, i) => { if (s.net === v.net && dps(v.at, s.a, s.b) <= E) union(viaNodes[vi], segNodes[i]); });
  });
  c.pads.forEach((p, pi) => c.vias.forEach((v, vi) => { if (v.net && c.netNames.get(v.net) === p.net && Math.abs(v.at[0] - p.x) <= p.hw && Math.abs(v.at[1] - p.y) <= p.hh) union(viaNodes[vi], padNodes[pi]); }));
  const out = [];
  const byNet = new Map();
  c.pads.forEach((p, i) => (byNet.get(p.net) ?? byNet.set(p.net, []).get(p.net)).push(i));
  for (const [net, idx] of byNet) {
    if (skip.has(net) || idx.length < 2) continue;
    // a pad on one layer only is reached from segments on that layer; through-hole pads reach both
    const roots = new Set(idx.map((i) => find(padNodes[i])));
    if (roots.size > 1) out.push(`${net}: ${roots.size} separate pieces`);
  }
  return out;
};

test("routing: every non-ground net in the written .kicad_pcb is one connected piece (checked from the file alone)", () => {
  for (const m of ["smd", "tht"]) {
    const r = demoBuild(m);
    assert.ok(r.ok, r.errors?.join());
    const c = connectivityFromFile(r.files["demo.kicad_pcb"]);
    assert.ok(c.segs.length > 5, `${m}: has tracks`);
    assert.deepEqual(incomplete(c), [], `${m}: nets left open`);
  }
});

test("routing: the connectivity check is not vacuous (removing a track opens a net)", () => {
  const r = demoBuild("tht");
  const c = connectivityFromFile(r.files["demo.kicad_pcb"]);
  assert.deepEqual(incomplete(c), []);
  // drop the longest non-ground track
  const idx = c.segs.map((s, i) => [i, Math.hypot(s.a[0] - s.b[0], s.a[1] - s.b[1]), c.netNames.get(s.net)]).filter(([, , n]) => n !== "/GND").sort((a, b) => b[1] - a[1])[0][0];
  const cut = { ...c, segs: c.segs.filter((_, i) => i !== idx) };
  assert.ok(incomplete(cut).length > 0, "a missing track must be noticed");
});

test("routing: the independent checker passes and clearance/width limits hold on the written copper", () => {
  for (const m of ["smd", "tht"]) {
    const r = demoBuild(m);
    assert.equal(r.drc.errors.length, 0, r.drc.errors.map((e) => e.msg).join("; "));
    assert.equal(r.drc.unrouted.length, 0);
    const c = connectivityFromFile(r.files["demo.kicad_pcb"]);
    const minW = Math.min(...c.segs.map((s) => s.w));
    assert.ok(minW >= 0.25 - 1e-9, `${m}: narrowest track ${minW} mm`);
    for (const s of c.segs) for (const p of [s.a, s.b]) {
      assert.ok(p[0] > c.origin[0] && p[1] > c.origin[1], "tracks stay inside the outline");
    }
  }
});

test("routing: the checker really catches a short and a missing track", () => {
  const r = demoBuild("tht");
  const classes = r.classes;
  // a track straight across two different nets' pads
  const pads = r.layout.parts.flatMap((p) => p.pads).filter((p) => p.net);
  const a = pads.find((p) => p.net === "+5V"), b = pads.find((p) => p.net !== "+5V" && p.net !== "GND");
  const short = { tracks: [...r.routing.tracks, { net: "+5V", layer: "F.Cu", w: 0.6, pts: [[a.x, a.y], [b.x, b.y]] }], vias: r.routing.vias };
  assert.ok(checkBoard(r.layout, short, { classes, pour: "GND" }).errors.some((e) => e.type === "clearance"), "short is reported");
  const open = { tracks: r.routing.tracks.slice(1), vias: r.routing.vias };
  assert.ok(checkBoard(r.layout, open, { classes, pour: "GND" }).unrouted.length > 0, "an open net is reported");
  const wide90 = { tracks: [{ net: "N001", layer: "F.Cu", w: 0.35, pts: [[5, 5], [10, 5], [10, 10]] }], vias: [] };
  assert.ok(checkBoard(r.layout, wide90, { classes, pour: "GND" }).errors.some((e) => e.type === "corner"), "a 90 degree corner is reported");
});

test("routing: output is deterministic, and route:false keeps the old placement-only board", () => {
  assert.equal(demoBuild("smd").files["demo.kicad_pcb"], demoBuild("smd").files["demo.kicad_pcb"]);
  const plain = demoBuild("smd", { route: false });
  assert.equal(kids(parseSexp(plain.files["demo.kicad_pcb"]), "segment").length, 0);
  assert.equal(plain.routing, null);
  assert.ok(!plain.files["demo.kicad_dru"]);
});

test("routing: ground is a pour on both layers, with its net, thermal settings from the spec and stitching vias", () => {
  const r = demoBuild("tht");
  const tree = parseSexp(r.files["demo.kicad_pcb"]);
  const zones = kids(tree, "zone");
  assert.deepEqual(zones.map((z) => kid(z, "layer")[1]).sort(), ["B.Cu", "F.Cu"]);
  for (const z of zones) {
    assert.equal(kid(z, "net_name")[1], "/GND");
    const fill = kid(z, "fill");
    assert.equal(kid(fill, "thermal_gap")[1], "0.3");
    assert.equal(kid(fill, "thermal_bridge_width")[1], "0.4");
    assert.equal(kid(kid(z, "connect_pads"), "clearance")[1], "0.3");
  }
  assert.ok(r.routing.vias.filter((v) => v.stitch).length >= 4, "stitching vias along the edge");
});

test("rules: .kicad_dru is balanced and carries every net class; net classes cover every net", () => {
  const dru = druText();
  parseSexp(`(${dru.replace(/^\(version 1\)\n/, "")})`);          // the rules, wrapped, must be balanced
  for (const c of ["AUDIO_SIG", "HIGH_Z", "POWER", "GND", "BIAS_VREF", "LED_CTRL"]) assert.match(dru, new RegExp(`NetClass == '${c}'`));
  assert.match(druText(0.5), /clearance_AUDIO_SIG.*min 0\.5mm/);            // a coarser fab limit wins
  const r = demoBuild("smd");
  const pro = JSON.parse(r.files["demo.kicad_pro"]);
  assert.equal(pro.net_settings.classes.length, 7);
  const patterns = new Set(pro.net_settings.netclass_patterns.map((p) => p.pattern));
  const pcb = parseSexp(r.files["demo.kicad_pcb"]);
  for (const n of kids(pcb, "net")) if (n[2]) assert.ok(patterns.has(n[2]), `${n[2]} has a net class`);
  assert.ok(pro.net_settings.netclass_patterns.some((p) => p.netclass === "HIGH_Z"), "the transistor base is high impedance");
});

test("dsn: structure balances and lists every pad of every net with the right net class", () => {
  const r = demoBuild("tht");
  const dsn = r.files["demo.dsn"];
  const body = dsn.replace(/\(string_quote "\)/, "(string_quote q)");
  parseSexp(body.replace(/"([^"]*)"/g, (m, s) => `"${s}"`));
  const netBlocks = [...dsn.matchAll(/\(net "([^"]+)"\s+\(pins ([^)]*)\)/g)];
  const pcb = parseSexp(r.files["demo.kicad_pcb"]);
  const padCount = new Map();
  for (const f of kids(pcb, "footprint")) for (const p of kids(f, "pad")) { const n = kid(p, "net"); if (n) padCount.set(n[2], (padCount.get(n[2]) ?? 0) + 1); }
  for (const [, name, pins] of netBlocks) assert.equal(pins.trim().split(/\s+/).length, padCount.get(name), `${name} pad count`);
  assert.ok(netBlocks.length >= 5);
  assert.match(dsn, /\(class HIGH_Z /);
  assert.match(dsn, /\(boundary \(path pcb 0 0 0 /);
});

test("report: has the spec's sections, names what was not checked, and lists what could not be routed", () => {
  const md = demoBuild("smd").files["report.md"];
  for (const s of ["inputs_received", "questions_asked", "assumptions", "deviations", "checks_table", "unresolved[V]", "drill_changes", "risk_flags"]) assert.match(md, new RegExp(`## ${s.replace(/[[\]]/g, "\\$&")}`));
  assert.match(md, /NOT IMPLEMENTED/);
  assert.match(md, /kicad-cli ERC\/DRC was not run/);
});

test("the zip carries the rules, the Specctra file and the report", () => {
  const bytes = new TextDecoder("latin1").decode(zip(demoBuild("smd").files));
  for (const f of ["demo.kicad_pcb", "demo.kicad_dru", "demo.dsn", "report.md"]) assert.ok(bytes.includes(f), f);
});
