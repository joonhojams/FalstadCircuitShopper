// Pinouts of ICs a user can pick for the op-amps in a circuit.
// Pin numbers are the standard industry pinouts for these packages; check the datasheet of the
// exact part and package before ordering boards.

const DIP8 = "Package_DIP:DIP-8_W7.62mm";
const SOIC8 = "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm";
const DIP14 = "Package_DIP:DIP-14_W7.62mm";
const SOIC14 = "Package_SO:SOIC-14_3.9x8.7mm_P1.27mm";

// A dual op-amp: units listed as [inverting, non-inverting, output] pin numbers.
const DUAL = { units: [["2", "3", "1"], ["6", "5", "7"]], vpos: "8", vneg: "4", pins: 8 };
const QUAD = { units: [["2", "3", "1"], ["6", "5", "7"], ["9", "10", "8"], ["13", "12", "14"]], vpos: "4", vneg: "11", pins: 14 };

export const ICS = {
  LM358:   { name: "LM358",   kind: "opamp", desc: "Dual, single-supply, 3-32 V", ...DUAL, footprints: { tht: DIP8, smd: SOIC8 } },
  TL072:   { name: "TL072",   kind: "opamp", desc: "Dual JFET-input, low noise, +/-18 V", ...DUAL, footprints: { tht: DIP8, smd: SOIC8 } },
  MCP6002: { name: "MCP6002", kind: "opamp", desc: "Dual rail-to-rail, 1.8-6 V", ...DUAL, footprints: { tht: DIP8, smd: SOIC8 } },
  LM324:   { name: "LM324",   kind: "opamp", desc: "Quad, single-supply, 3-32 V", ...QUAD, footprints: { tht: DIP14, smd: SOIC14 } },
};

/** The picker list for the UI. */
export const icCatalog = () => Object.values(ICS).map((i) => ({
  id: i.name, kind: i.kind, desc: i.desc, channels: i.units.length,
}));

/** Pin names and positions of a whole package, used to draw its symbol. */
export function packagePins(ic) {
  const left = [], right = [];
  ic.units.forEach(([inv, non, out], i) => {
    const l = String.fromCharCode(65 + i);
    left.push({ num: inv, name: `${l}-` }, { num: non, name: `${l}+` });
    right.push({ num: out, name: `${l}OUT` });
  });
  left.push({ num: ic.vpos, name: "V+" }, { num: ic.vneg, name: "V-" });
  return { left, right };
}
