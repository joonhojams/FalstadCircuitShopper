// Pinouts of ICs the board can use for op-amps, logic gates and 555 timers.
// Pin numbers are the standard industry pinouts; check the datasheet of the exact part and package
// before ordering boards. Each unit maps a circuit pin name to a package pin number.

const DIP8 = "Package_DIP:DIP-8_W7.62mm", SOIC8 = "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm";
const DIP14 = "Package_DIP:DIP-14_W7.62mm", SOIC14 = "Package_SO:SOIC-14_3.9x8.7mm_P1.27mm";
const FP8 = { tht: DIP8, smd: SOIC8 }, FP14 = { tht: DIP14, smd: SOIC14 };

const opamp = (name, desc, units, pos, neg, fp) => ({
  name, kind: "opamp", desc, units, inputs: ["-", "+"], outputs: ["OUT"], power: { pos, neg }, footprints: fp,
});
const DUAL = [{ "-": "2", "+": "3", OUT: "1" }, { "-": "6", "+": "5", OUT: "7" }];
const QUAD = [...DUAL.slice(0, 2), { "-": "9", "+": "10", OUT: "8" }, { "-": "13", "+": "12", OUT: "14" }];

// Quad 2-input gates (74xx00 pinout) and the NOR variant (74xx02), hex inverter, triple 3-input.
const Q00 = [["1", "2", "3"], ["4", "5", "6"], ["10", "9", "8"], ["13", "12", "11"]];
const Q02 = [["2", "3", "1"], ["5", "6", "4"], ["8", "9", "10"], ["11", "12", "13"]];
const T10 = [["1", "2", "13", "12"], ["3", "4", "5", "6"], ["9", "10", "11", "8"]];
const gate = (name, fn, desc, rows, names) => ({
  name, kind: "gate", fn, inputsPerGate: names.length - 1, desc,
  units: rows.map((r) => Object.fromEntries(names.map((nm, i) => [nm, r[i]]))),
  inputs: names.slice(0, -1), outputs: ["Y"], power: { pos: "14", neg: "7" }, footprints: FP14,
});
const AB = ["A", "B", "Y"], ABC = ["A", "B", "C", "Y"];

export const ICS = {
  LM358:   opamp("LM358",   "Dual, single-supply, 3-32 V", DUAL, "8", "4", FP8),
  TL072:   opamp("TL072",   "Dual JFET-input, low noise, +/-18 V", DUAL, "8", "4", FP8),
  MCP6002: opamp("MCP6002", "Dual rail-to-rail, 1.8-6 V", DUAL, "8", "4", FP8),
  LM324:   opamp("LM324",   "Quad, single-supply, 3-32 V", QUAD, "4", "11", FP14),

  "74HC08": gate("74HC08", "and",  "Quad 2-input AND", Q00, AB),
  "74HC00": gate("74HC00", "nand", "Quad 2-input NAND", Q00, AB),
  "74HC32": gate("74HC32", "or",   "Quad 2-input OR", Q00, AB),
  "74HC86": gate("74HC86", "xor",  "Quad 2-input XOR", Q00, AB),
  "74HC02": gate("74HC02", "nor",  "Quad 2-input NOR", Q02, AB),
  "74HC04": gate("74HC04", "not",  "Hex inverter", [["1", "2"], ["3", "4"], ["5", "6"], ["9", "8"], ["11", "10"], ["13", "12"]], ["A", "Y"]),
  "74HC11": gate("74HC11", "and",  "Triple 3-input AND", T10, ABC),
  "74HC10": gate("74HC10", "nand", "Triple 3-input NAND", T10, ABC),
  "74HC27": gate("74HC27", "nor",  "Triple 3-input NOR", T10, ABC),

  NE555: {
    name: "NE555", kind: "timer", desc: "Single 555 timer (also LM555, TLC555, LMC555)",
    units: [{ GND: "1", TRIG: "2", OUT: "3", RST: "4", CTL: "5", THR: "6", DIS: "7", VCC: "8" }],
    inputs: ["TRIG", "THR", "RST", "CTL", "DIS"], outputs: ["OUT"], power: { pos: "8", neg: "1" }, footprints: FP8,
  },
};

/** Which catalog ICs can implement a circuit part. */
export function icsFor(part) {
  if (part.kind === "opamp") return Object.values(ICS).filter((i) => i.kind === "opamp");
  if (part.kind === "timer") return Object.values(ICS).filter((i) => i.kind === "timer");
  if (part.kind === "gate") {
    return Object.values(ICS).filter((i) => i.kind === "gate" && i.fn === part.fn && i.inputsPerGate === part.inputs);
  }
  return [];
}

/** The picker list for one part. */
export const icCatalog = (part) => icsFor(part).map((i) => ({ id: i.name, desc: i.desc, channels: i.units.length }));

// Part numbers a user may have picked in the BOM -> catalog IC.
const FAMILY_FN = { "00": "74HC00", "02": "74HC02", "04": "74HC04", "08": "74HC08", "10": "74HC10", "11": "74HC11", "27": "74HC27", "32": "74HC32", "86": "74HC86" };
export function matchIc(text) {
  const t = String(text ?? "");
  for (const id of ["LM358", "TL072", "MCP6002", "LM324"]) if (new RegExp(`${id}`, "i").test(t)) return id;
  const logic = /74[A-Z]{0,5}(\d{2})(?!\d)/i.exec(t);
  if (logic && FAMILY_FN[logic[1]]) return FAMILY_FN[logic[1]];
  if (/(?:NE|LM|TLC|LMC|ICM|TS|SA)?7?555(?!\d)/i.test(t) && /555/.test(t)) return "NE555";
  return null;
}

/** The IC the BOM selection points at, if it can implement this part; otherwise null. */
export function icFromChoice(part, choice) {
  if (!choice) return null;
  const id = matchIc(`${choice.mpn ?? ""} ${choice.description ?? ""}`);
  return id && icsFor(part).some((i) => i.name === id) ? id : null;
}

/** The default IC for parts where only one sensible choice exists (gates and 555). */
export const defaultIc = (part) => (part.kind === "opamp" ? null : icsFor(part)[0]?.name ?? null);

/** Pin names and positions of a whole package, used to draw its symbol. */
export function packagePins(ic) {
  const left = [], right = [];
  const multi = ic.units.length > 1;
  ic.units.forEach((u, i) => {
    const l = multi ? String.fromCharCode(65 + i) : "";
    for (const nm of ic.inputs) if (u[nm]) left.push({ num: u[nm], name: `${l}${nm}`, type: "input" });
    for (const nm of ic.outputs) if (u[nm]) right.push({ num: u[nm], name: `${l}${nm}`, type: "output" });
  });
  const [pn, nn] = ic.kind === "opamp" ? ["V+", "V-"] : ["VCC", "GND"];
  left.push({ num: ic.power.pos, name: pn, type: "power_in" }, { num: ic.power.neg, name: nn, type: "power_in" });
  return { left, right };
}
