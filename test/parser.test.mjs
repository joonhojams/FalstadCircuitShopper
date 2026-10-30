import assert from "node:assert/strict";
import { bom, eng } from "../src/parser.js";

export const SAMPLE = `$ 1 0.000005 10.20027730826997 50 5 50 5e-11
v 176 176 176 80 0 1 60 5 0 0 0.5
r 176 80 304 80 0 1000
r 304 80 432 80 0 1000
r 432 80 432 176 0 4700
c 304 80 304 176 0 0.000001 0 0.001
c 432 176 304 176 0 0.000001 0 0.001
l 432 80 560 80 0 0.01 0
d 560 80 560 176 2 default
162 560 176 432 176 2 2.1024259 0
t 304 240 368 240 0 1 0 0 100
f 368 304 432 304 1 1.5 5.6 1
a 464 304 560 304 0 15 -15 1000000 0 0
w 176 176 304 176 0
g 176 176 176 208 0 0
o 1 64 0 4099 5 0.1 0 1
`;

// SI formatting
assert.equal(eng(1000, "Ω"), "1 kΩ");
assert.equal(eng(4700, "Ω"), "4.7 kΩ");
assert.equal(eng(0.000001, "F"), "1 µF");
assert.equal(eng(0.01, "H"), "10 mH");

// Full parse
const r = bom(SAMPLE);
assert.equal(r.count, 12);
assert.deepEqual(Object.keys(r.unknown), []);
const find = (c, v) => r.summary.find((s) => s.component === c && s.value === v);
assert.equal(find("Resistor", "1 kΩ").quantity, 2);
assert.equal(find("Resistor", "4.7 kΩ").quantity, 1);
assert.equal(find("Capacitor", "1 µF").quantity, 2);
assert.equal(find("Inductor", "10 mH").quantity, 1);
assert.equal(find("MOSFET", "P-channel").quantity, 1);
assert.equal(find("BJT Transistor", "NPN").quantity, 1);
assert.equal(r.summary.find((s) => s.component === "Voltage Source").details, "AC (sine), 60 Hz");
assert.deepEqual(r.parts.map((p) => p.ref),
  ["V1", "R1", "R2", "R3", "C1", "C2", "L1", "D1", "LED1", "Q1", "Q2", "U1"]);

// Share-URL input (circuit percent-encoded after '#')
const url = "https://www.falstad.com/circuit/circuitjs.html#" + encodeURIComponent(SAMPLE);
assert.equal(bom(url).count, 12);

// Unknown element types are reported, not dropped
const u = bom("r 0 0 10 0 0 100\nzzz 0 0 10 0 0 foo bar\n");
assert.equal(u.count, 2);
assert.deepEqual(u.unknown, { zzz: 1 });

// Garbage in -> nothing found
assert.equal(bom("hello world").count, 0);

console.log("parser tests passed");
