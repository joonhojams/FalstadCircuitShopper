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
    const pins = [ic.vpos, ic.vneg, ...ic.units.flat()];
    assert.equal(new Set(pins).size, pins.length, ic.name);
    assert.equal(pins.length, ic.pins, ic.name);
  }
});
