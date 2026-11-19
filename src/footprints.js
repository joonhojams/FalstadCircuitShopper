// Chooses a KiCad footprint for each board part from the part picked in the BOM (its DigiKey
// package and part number). The board-wide SMD/through-hole choice always decides the mounting
// style, so one board never mixes the two; a BOM pick of the other style is reported, not followed.
//
// `choice` is { mpn, package, supplierPackage, mounting, description } or undefined.

const txt = (c) => `${c?.package ?? ""} ${c?.supplierPackage ?? ""} ${c?.description ?? ""} ${c?.mpn ?? ""}`.toLowerCase();

/** "smd" | "tht" | null from DigiKey's Mounting Type, falling back to package words. */
export function mountOf(choice) {
  const m = String(choice?.mounting ?? "").toLowerCase();
  if (/surface/.test(m)) return "smd";
  if (/through|panel|chassis|pc pin/.test(m)) return "tht";
  const t = txt(choice);
  if (/\b(0201|0402|0603|0805|1206|1210|1812|2010|2512|sot-?23|sot-?223|sod-?\d+|soic|tssop|msoic|msop|dpak|to-252|smd)\b/.test(t)) return "smd";
  if (/\b(axial|radial|dip|to-92|to-220|to-247|do-35|do-41|through)\b/.test(t)) return "tht";
  return null;
}

const CHIP = { "0201": "0603Metric", "0402": "1005Metric", "0603": "1608Metric", "0805": "2012Metric", "1206": "3216Metric", "1210": "3225Metric", "1812": "4532Metric", "2010": "5025Metric", "2512": "6332Metric" };
const chipSize = (t) => /\b(0201|0402|0603|0805|1206|1210|1812|2010|2512)\b/.exec(t)?.[1] ?? null;

const SMD_DEFAULT = { resistor: "0805", capacitor: "0805", inductor: "0805" };
const DEFAULT = {
  resistor:  { tht: "Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal" },
  capacitor: { tht: "Capacitor_THT:C_Disc_D5.0mm_W2.5mm_P5.00mm" },
  inductor:  { tht: "Inductor_THT:L_Axial_L5.3mm_D2.2mm_P10.16mm_Horizontal_Vishay_IM-1" },
  diode:     { smd: "Diode_SMD:D_SOD-123", tht: "Diode_THT:D_DO-35_SOD27_P7.62mm_Horizontal" },
  led:       { smd: "LED_SMD:LED_0805_2012Metric", tht: "LED_THT:LED_D5.0mm" },
  switch:    { smd: "Button_Switch_THT:SW_PUSH_6mm", tht: "Button_Switch_THT:SW_PUSH_6mm" },
};
const PREFIX = { resistor: "R", capacitor: "C", inductor: "L" };
const STYLE = { smd: "surface-mount", tht: "through-hole" };

// Transistor packages: footprint + which pad each pin lands on (BJT B/C/E, MOSFET G/D/S).
const TRANSISTOR = {
  "sot-23":  { fp: "Package_TO_SOT_SMD:SOT-23", mount: "smd", bjt: { B: "1", E: "2", C: "3" }, mos: { G: "1", S: "2", D: "3" } },
  "sot-223": { fp: "Package_TO_SOT_SMD:SOT-223-3_TabPin2", mount: "smd", bjt: { B: "1", C: "2", E: "3" }, mos: { G: "1", D: "2", S: "3" } },
  "to-252":  { fp: "Package_TO_SOT_SMD:TO-252-2", mount: "smd", bjt: { B: "1", C: "2", E: "3" }, mos: { G: "1", D: "2", S: "3" } },
  "to-92":   { fp: "Package_TO_SOT_THT:TO-92_Inline", mount: "tht", bjt: { E: "1", B: "2", C: "3" }, mos: { S: "1", G: "2", D: "3" }, guess: true },
  "to-220":  { fp: "Package_TO_SOT_THT:TO-220-3_Vertical", mount: "tht", bjt: { B: "1", C: "2", E: "3" }, mos: { G: "1", D: "2", S: "3" } },
};
// Known TO-92 pinouts, front view left to right.
const TO92_KNOWN = [
  [/\b(2n3904|2n3906|pn2222|mps2222|2n4401|2n4403|mmbt3904)/, "bjt", { E: "1", B: "2", C: "3" }],
  [/\b(bc5[0-9]{2}|bc3[0-9]{2}|bc2[0-9]{2}|2sc945|2n5551)/, "bjt", { C: "1", B: "2", E: "3" }],
  [/\b2n7000\b/, "mos", { S: "1", G: "2", D: "3" }],
  [/\b(bs170|bs250)\b/, "mos", { D: "1", G: "2", S: "3" }],
];
const DEFAULT_PKG = { smd: "sot-23", tht: { bjt: "to-92", mosfet: "to-220" } };

// PCB-mount potentiometers by part number family; everything else falls back below.
const POTS = [
  [/^3296w/i, "Potentiometer_THT:Potentiometer_Bourns_3296W_Vertical"],
  [/^3296p/i, "Potentiometer_THT:Potentiometer_Bourns_3296P_Horizontal"],
  [/^3296y/i, "Potentiometer_THT:Potentiometer_Bourns_3296Y_Vertical"],
  [/^3386p/i, "Potentiometer_THT:Potentiometer_Bourns_3386P_Vertical"],
  [/^rk09k/i, "Potentiometer_THT:Potentiometer_Alps_RK09K_Single_Vertical"],
];

const ICPKG = [
  [/tssop|ssop/, { 8: "Package_SO:TSSOP-8_4.4x3mm_P0.65mm", 14: "Package_SO:TSSOP-14_4.4x5mm_P0.65mm" }],
  [/msop|vssop/, { 8: "Package_SO:MSOP-8_3x3mm_P0.65mm" }],
];

/**
 * @returns {{footprint: string, mounting: "smd"|"tht", fromBom: boolean, pads?: object, warning?: string}}
 */
export function resolve(kind, choice, globalMount) {
  const t = txt(choice);
  const picked = mountOf(choice);
  const mount = globalMount;
  const fromBom = Boolean(choice) && picked === mount;
  // Only said when the footprint really is the other style from the part picked in the BOM.
  const mismatch = (m) => (picked && picked !== m
    ? `The part picked in the BOM is ${STYLE[picked]} but this board is ${STYLE[m]}, so the footprint is ${STYLE[m]}. Pick a ${STYLE[m]} part in the price table or change the board's mounting.` : "");
  const out = (footprint, m = mount, extra = {}) => {
    const warning = [extra.warning, mismatch(m)].filter(Boolean).join(" ");
    return { footprint, mounting: m, fromBom: fromBom && picked === m, ...extra, ...(warning ? { warning } : {}) };
  };

  if (kind in PREFIX) {
    const P = PREFIX[kind];
    if (mount === "smd") {
      let size = chipSize(t) ?? SMD_DEFAULT[kind], warning;
      if (kind === "capacitor" && (size === "2010" || size === "2512")) {   // KiCad has no capacitor footprint this large
        warning = `KiCad has no ${size} capacitor footprint; the board uses 1812 (4.5 x 3.2 mm). Swap in the footprint for the part you ordered.`;
        size = "1812";
      }
      return out(`${kind === "resistor" ? "Resistor_SMD" : kind === "capacitor" ? "Capacitor_SMD" : "Inductor_SMD"}:${P}_${size}_${CHIP[size]}`, "smd", { fromBom: fromBom && Boolean(chipSize(t)), ...(warning ? { warning } : {}) });
    }
    if (kind === "capacitor" && /alumin|electrolytic|radial/.test(t)) {
      return out("Capacitor_THT:CP_Radial_D5.0mm_P2.00mm", "tht", { warning: "Electrolytic footprint assumes a 5 mm diameter, 2 mm lead spacing; change it to match the part. Pad 1 is +." });
    }
    if (kind === "capacitor" && /film|polyprop|polyester/.test(t)) return out("Capacitor_THT:C_Rect_L7.2mm_W2.5mm_P5.00mm_FKS2_FKP2_MKS2_MKP2", "tht");
    return out(DEFAULT[kind].tht, "tht");
  }

  if (kind === "diode" || kind === "zener") {
    const m = [[/sod-?323/, "Diode_SMD:D_SOD-323"], [/sod-?123/, "Diode_SMD:D_SOD-123"], [/\bsma\b|do-214ac/, "Diode_SMD:D_SMA"], [/\bsmb\b|do-214aa/, "Diode_SMD:D_SMB"],
      [/do-41/, "Diode_THT:D_DO-41_SOD81_P10.16mm_Horizontal"], [/do-35/, "Diode_THT:D_DO-35_SOD27_P7.62mm_Horizontal"]].find(([re]) => re.test(t));
    if (m) return out(m[1], /Diode_SMD/.test(m[1]) ? "smd" : "tht", { fromBom: true });
    return out(DEFAULT.diode[mount]);
  }

  if (kind === "led") {
    const size = chipSize(t);
    if (mount === "smd") return out(`LED_SMD:LED_${size ?? "0805"}_${CHIP[size ?? "0805"]}`, "smd", { fromBom: fromBom && Boolean(size) });
    return out(/\b3 ?mm\b/.test(t) ? "LED_THT:LED_D3.0mm" : DEFAULT.led.tht, "tht");
  }

  if (kind === "switch") return out(DEFAULT.switch[mount]);

  if (kind === "bjt" || kind === "mosfet") {
    const which = kind === "bjt" ? "bjt" : "mos";
    let key = Object.keys(TRANSISTOR).find((k) => t.includes(k) || t.includes(k.replace("-", "")));
    if (/dpak/.test(t)) key = "to-252";
    if (!key || TRANSISTOR[key].mount !== mount) key = mount === "smd" ? DEFAULT_PKG.smd : DEFAULT_PKG.tht[kind];
    const pk = TRANSISTOR[key];
    let pads = pk[which], warning;
    if (key === "to-92") {
      const known = TO92_KNOWN.find(([re, w]) => w === which && re.test(t));
      if (known) pads = known[2];
      else warning = `TO-92 pin order differs between parts. The board assumes ${Object.keys(pads).sort((a, b) => pads[a] - pads[b]).join("-")} (pads 1-3); check the datasheet of the exact part or pick it in the BOM.`;
    } else if (key === "to-220" && kind === "mosfet" && !choice) warning = "Assumes G-D-S for TO-220. Check the datasheet of the exact MOSFET.";
    const warn = [warning, mismatch(pk.mount)].filter(Boolean).join(" ");
    return { footprint: pk.fp, mounting: pk.mount, fromBom: fromBom && (t.includes(key.replace("-", "")) || t.includes(key)), pads, ...(warn ? { warning: warn } : {}) };
  }

  if (kind === "pot") {
    const mpn = String(choice?.mpn ?? "");
    const fam = POTS.find(([re]) => re.test(mpn));
    if (fam) return out(fam[1], "tht", { fromBom: true });
    if (/panel|chassis|shaft|wire/.test(`${choice?.mounting ?? ""} ${t}`) && !/pc pin|pcb/.test(t)) {
      return out("TerminalBlock:TerminalBlock_bornier-3_P5.08mm", "tht", { fromBom: true, warning: "Panel-mount potentiometer: the board gets a 3-way screw terminal so it can be wired off-board." });
    }
    if (mount === "smd") return out("Potentiometer_SMD:Potentiometer_Bourns_TC33X_Vertical", "smd", { warning: "Generic SMD trimmer footprint; change it to match the part you ordered." });
    return out("Connector_PinHeader_2.54mm:PinHeader_1x03_P2.54mm_Vertical", "tht", {
      warning: "Potentiometer pads are a generic 3 x 2.54 mm row of holes (pin 1 = one end, 2 = wiper, 3 = other end). Pick a known PCB-mount part in the BOM or swap in its footprint.",
    });
  }
  return out(DEFAULT.resistor.tht, "tht");
}

/** Footprint for a catalog IC given the BOM pick (package words decide DIP / SOIC / TSSOP). */
export function icFootprint(ic, choice, globalMount) {
  const t = txt(choice);
  const pins = ic.units.length ? Math.max(...ic.units.flatMap((u) => Object.values(u).map(Number)), Number(ic.power.pos)) : 8;
  const n = pins > 8 ? 14 : 8;
  const picked = mountOf(choice);
  const special = globalMount === "smd" && ICPKG.find(([re, m]) => re.test(t) && m[n]);
  if (special) return { footprint: special[1][n], mounting: "smd", fromBom: true };
  const fp = ic.footprints[globalMount];
  const warning = picked && picked !== globalMount
    ? `The ${ic.name} picked in the BOM is ${STYLE[picked]} but this board is ${STYLE[globalMount]}, so it gets the ${STYLE[globalMount]} package. Pick a ${STYLE[globalMount]} part in the price table or change the board's mounting.` : "";
  return { footprint: fp, mounting: globalMount, fromBom: picked === globalMount, ...(warning ? { warning } : {}) };
}
