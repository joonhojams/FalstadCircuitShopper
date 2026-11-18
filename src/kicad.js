// Turns an extracted netlist into a KiCad 9 project: a schematic (.kicad_sch) where every pin
// carries a net label, plus a project file. Nets are connected by name (labels placed on the pin
// ends) rather than by drawn wires, which is exact and keeps the generator simple. In KiCad:
// open the project, then "Update PCB from Schematic" (F8) in the PCB editor to start layout.
//
// Not validated against a real KiCad install by the test-suite here; see the structural checks in
// the tests. Footprints use KiCad's standard library names.

import { ICS, icsFor, icFromChoice, defaultIc, packagePins } from "./ics.js";
import { resolve, icFootprint } from "./footprints.js";

const q = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const n = (x) => Number(x.toFixed(3));
const FONT = "(effects (font (size 1.27 1.27)))";
const FONT_HIDE = "(effects (font (size 1.27 1.27)) (hide yes))";

export const FOOTPRINTS = {
  resistor:  { smd: "Resistor_SMD:R_0805_2012Metric", tht: "Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal" },
  capacitor: { smd: "Capacitor_SMD:C_0805_2012Metric", tht: "Capacitor_THT:C_Disc_D5.0mm_W2.5mm_P5.00mm" },
  inductor:  { smd: "Inductor_SMD:L_0805_2012Metric", tht: "Inductor_THT:L_Axial_L5.3mm_D2.2mm_P10.16mm_Horizontal" },
  diode:     { smd: "Diode_SMD:D_SOD-123", tht: "Diode_THT:D_DO-35_SOD27_P7.62mm_Horizontal" },
  led:       { smd: "LED_SMD:LED_0805_2012Metric", tht: "LED_THT:LED_D5.0mm" },
  switch:    { smd: "Button_Switch_THT:SW_PUSH_6mm", tht: "Button_Switch_THT:SW_PUSH_6mm" },
  bjt:       { smd: "Package_TO_SOT_SMD:SOT-23", tht: "Package_TO_SOT_THT:TO-92_Inline" },
  mosfet:    { smd: "Package_TO_SOT_SMD:SOT-23", tht: "Package_TO_SOT_THT:TO-220-3_Vertical" },
};

// Which Falstad pin lands on which footprint pad number.
const PADS = {
  two: { "1": "1", "2": "2" },
  diode: { A: "2", K: "1" },
  bjt: { smd: { B: "1", E: "2", C: "3" }, tht: { E: "1", B: "2", C: "3" } },
  mosfet: { smd: { G: "1", S: "2", D: "3" }, tht: { G: "1", D: "2", S: "3" } },
};

const padsFor = (kind, mounting) => {
  if (kind === "diode" || kind === "zener" || kind === "led") return PADS.diode;
  if (kind === "bjt" || kind === "mosfet") return PADS[kind][mounting];
  return PADS.two;
};

// ---- symbol definitions (one generic box symbol per pin layout) ----

/** spec: { id, ref, left: [{num,name,type}], right: [...] } */
function symbolDef(spec) {
  const rows = Math.max(spec.left.length, spec.right.length, 1);
  const hw = spec.wide ? 7.62 : 5.08;
  const hh = (rows * 2.54) / 2 + 1.27;
  const pins = (list, side) => list.map((p, i) => {
    const y = n(((rows - 1) * 2.54) / 2 - i * 2.54);
    const x = side === "L" ? -(hw + 2.54) : hw + 2.54;
    return `      (pin ${p.type ?? "passive"} line (at ${n(x)} ${y} ${side === "L" ? 0 : 180}) (length 2.54)
        (name ${q(p.name)} (effects (font (size 1.016 1.016))))
        (number ${q(p.num)} (effects (font (size 1.016 1.016)))))`;
  }).join("\n");
  return `    (symbol ${q(`CJS:${spec.id}`)} (pin_names (offset 1.016)) (exclude_from_sim no) (in_bom yes) (on_board yes)
      (property "Reference" ${q(spec.ref)} (at 0 ${n(hh + 1.27)} 0) ${FONT})
      (property "Value" "" (at 0 ${n(-hh - 1.27)} 0) ${FONT})
      (property "Footprint" "" (at 0 0 0) ${FONT_HIDE})
      (property "Datasheet" "" (at 0 0 0) ${FONT_HIDE})
      (symbol ${q(`${spec.id}_0_1`)}
        (rectangle (start ${n(-hw)} ${n(hh)}) (end ${n(hw)} ${n(-hh)}) (stroke (width 0.254) (type default)) (fill (type background))))
      (symbol ${q(`${spec.id}_1_1`)}
${pins(spec.left, "L")}
${pins(spec.right, "R")}))`;
}

const spec = {
  two: (id, ref, l, r) => ({ id, ref, left: [{ num: "1", name: l }], right: [{ num: "2", name: r }] }),
};

/**
 * @param {ReturnType<import("./netlist.js").extractNetlist>} netlist
 * @param {{name?: string, mounting?: "smd"|"tht", ics?: Record<string,string>, supply?: {pos?: string, neg?: string},
 *          decouple?: boolean, ignoreUnsupported?: boolean, uuid?: () => string}} opts  ics: op-amp ref -> IC id
 * @returns {{ok: true, files: Record<string,string>, summary: object, warnings: string[]} | {ok: false, errors: string[]}}
 */
export function buildProject(netlist, opts = {}) {
  const mounting = opts.mounting === "tht" ? "tht" : "smd";
  const name = (opts.name || "circuit").replace(/[^\w.-]+/g, "_").slice(0, 60) || "circuit";
  const uuid = opts.uuid ?? (() => crypto.randomUUID());
  const errors = [], warnings = [...netlist.warnings];

  // --- checks that must pass before anything is generated ---
  if (netlist.unsupported.length && !opts.ignoreUnsupported) {
    errors.push(`These elements can't be placed on a board yet: ${netlist.unsupported.map((u) => `${u.name} x${u.count}`).join(", ")}. They would be missing from the PCB.`);
  }
  const choices = opts.choices ?? {};     // ref -> the part picked in the BOM
  const LABEL = { opamp: "op-amp", gate: "logic gate", timer: "555 timer" };
  const icParts = netlist.parts.filter((p) => LABEL[p.kind]);
  const icOf = {};
  for (const p of icParts) {
    const id = opts.ics?.[p.ref] || icFromChoice(p, choices[p.ref]) || defaultIc(p);
    if (!id) errors.push(`Choose an IC for ${p.ref} (${LABEL[p.kind]}).`);
    else if (!ICS[id]) errors.push(`${p.ref}: unknown IC "${id}".`);
    else if (!icsFor(p).some((i) => i.name === id)) errors.push(`${p.ref}: ${id} can't be used for this ${LABEL[p.kind]}.`);
    else icOf[p.ref] = id;
  }
  const opamps = icParts.filter((p) => p.kind === "opamp");
  const gates = icParts.filter((p) => p.kind === "gate");
  // Supply nets for IC power pins.
  const volts = (net) => netlist.rails.find((r) => r.net === net)?.volts;
  let vpos = opts.supply?.pos, vneg = opts.supply?.neg ?? "GND";
  if ((opamps.length || gates.length) && !errors.length) {
    if (!vpos) vpos = [...netlist.rails].filter((r) => r.volts > 0).sort((a, b) => b.volts - a.volts)[0]?.net;
    if (!vpos) errors.push("The ICs need a positive supply, but no DC rail was found. Add a rail or a ground-referenced DC source to the circuit.");
    else if (volts(vpos) === undefined && !netlist.nets.some((x) => x.name === vpos)) errors.push(`Supply net "${vpos}" does not exist.`);
  }
  if (errors.length) return { ok: false, errors };
  // A logic gate runs from the rail closest to the voltage it was simulated at.
  const logicRail = (g) => [...netlist.rails].filter((r) => r.volts > 0).sort((a, b) => Math.abs(a.volts - g.highV) - Math.abs(b.volts - g.highV))[0]?.net ?? vpos;

  // --- board items: { ref, symbol, value, footprint, pins: [{num, name, net}] } ---
  const items = [];
  const symbols = new Map();
  const defineSymbol = (s) => { if (!symbols.has(s.id)) symbols.set(s.id, s); return s.id; };

  const used = {};
  for (const p of netlist.parts) {
    if (LABEL[p.kind]) continue;
    const choice = choices[p.ref];
    const fpKind = p.kind === "zener" ? "diode" : p.kind;
    const r = resolve(fpKind, choice, mounting);
    const by = Object.fromEntries(p.pins.map((x) => [x.name, x.net]));
    let symbol, pins;
    if (["diode", "zener", "led"].includes(p.kind)) {
      symbol = defineSymbol({ id: "D2", ref: "D", left: [{ num: "2", name: "A" }], right: [{ num: "1", name: "K" }] });
      pins = [{ num: "2", net: by.A }, { num: "1", net: by.K }];
    } else if (p.kind === "bjt" || p.kind === "mosfet") {
      const names = p.kind === "bjt" ? ["B", "C", "E"] : ["G", "D", "S"];
      const map = r.pads;
      const id = `${p.kind}_${names.map((nm) => map[nm]).join("")}`;
      symbol = defineSymbol({
        id, ref: "Q",
        left: [{ num: map[names[0]], name: names[0] }],
        right: [{ num: map[names[1]], name: names[1] }, { num: map[names[2]], name: names[2] }],
      });
      pins = names.map((nm) => ({ num: map[nm], net: by[nm] }));
    } else if (p.kind === "pot") {
      symbol = defineSymbol({ id: "pot", ref: "RV", left: [{ num: "1", name: "A" }], right: [{ num: "2", name: "W" }, { num: "3", name: "B" }] });
      pins = [{ num: "1", net: by.A }, { num: "2", net: by.W }, { num: "3", net: by.B }];
    } else {
      symbol = defineSymbol(spec.two(`${p.kind}2`, { resistor: "R", capacitor: "C", inductor: "L", switch: "SW" }[p.kind] ?? "X", "1", "2"));
      pins = [{ num: "1", net: by["1"] }, { num: "2", net: by["2"] }];
    }
    if (r.warning) warnings.push(`${p.ref}: ${r.warning}`);
    items.push({ ref: p.ref, symbol, value: choice?.mpn || p.value || p.details || "", footprint: r.footprint, source: r.fromBom ? "BOM" : "default", mpn: choice?.mpn ?? "", pins });
    used[p.kind] = (used[p.kind] ?? 0) + 1;
  }

  // Op-amps, gates and 555s are packed into the chosen ICs, channel by channel, in reference order.
  const packages = [];
  let uNum = 0;
  const refTaken = new Set(items.map((i) => i.ref).concat(netlist.parts.map((p) => p.ref)));
  const newRef = (prefix) => { let r; do { r = `${prefix}${++uNum}`; } while (refTaken.has(r)); refTaken.add(r); return r; };
  const byIc = {};
  for (const p of icParts) (byIc[icOf[p.ref]] ??= []).push(p);
  for (const [id, list] of Object.entries(byIc)) {
    const ic = ICS[id];
    for (let i = 0; i < list.length; i += ic.units.length) {
      const chunk = list.slice(i, i + ic.units.length);
      const nets = new Map();
      let pos = vpos, neg = vneg;
      if (ic.kind === "gate") { pos = logicRail(chunk[0]); neg = "GND"; }
      ic.units.forEach((unit, k) => {
        const part = chunk[k];
        if (part) {
          const by = Object.fromEntries(part.pins.map((x) => [x.name, x.net]));
          if (ic.kind === "timer") {
            by.GND ??= "GND";            // no ground pin in the simulation: it was circuit ground
            by.RST ??= by.VCC;           // no reset pin: it was never pulled low
            pos = by.VCC; neg = by.GND;
          }
          for (const [nm, num] of Object.entries(unit)) nets.set(num, by[nm] ?? null);
        } else if (ic.kind === "opamp") {
          // An unused channel: make it a unity-gain follower parked on the negative rail so it can't oscillate.
          const park = `UNUSED_${id}_${packages.length + 1}${String.fromCharCode(65 + k)}`;
          nets.set(unit["-"], park); nets.set(unit.OUT, park); nets.set(unit["+"], vneg);
        } else {
          // An unused gate: tie the inputs low (CMOS inputs must not float) and leave the output open.
          for (const nm of ic.inputs) nets.set(unit[nm], "GND");
          for (const nm of ic.outputs) nets.set(unit[nm], null);
        }
      });
      if (ic.kind !== "timer") { nets.set(ic.power.pos, pos); nets.set(ic.power.neg, neg); }
      const pp = packagePins(ic);
      defineSymbol({ id, ref: "U", wide: true, left: pp.left, right: pp.right });
      const pinList = [...pp.left, ...pp.right].map((p) => ({ num: p.num, net: nets.get(p.num) ?? null }));
      const choice = choices[chunk[0].ref];
      const fp = icFootprint(ic, choice, mounting);
      const ref = `U${chunk[0].ref.replace(/^\D+/, "")}`;
      const mpn = choice && icFromChoice(chunk[0], choice) === id ? choice.mpn : "";
      items.push({ ref, symbol: id, value: mpn || id, footprint: fp.footprint, source: fp.fromBom ? "BOM" : "default", mpn, pins: pinList });
      packages.push({ ic: id, ref, channels: chunk.map((c) => c.ref), unused: ic.units.length - chunk.length });
      if (ic.units.length - chunk.length) {
        warnings.push(`${id} ${ref}: ${ic.units.length - chunk.length} spare channel(s) are ${ic.kind === "gate" ? "tied low with open outputs" : "wired as parked followers"}.`);
      }
      if (opts.decouple !== false && pos && neg) {
        const cref = newRef("C_DEC");
        items.push({ ref: cref, symbol: defineSymbol(spec.two("capacitor2", "C", "1", "2")), value: "100nF", footprint: resolve("capacitor", undefined, fp.mounting).footprint,
          source: "default", mpn: "", pins: [{ num: "1", net: pos }, { num: "2", net: neg }] });
      }
    }
  }

  // One power connector carries every rail and ground, so the board has a single 5 V input.
  const supplyNets = [...netlist.rails.map((r) => r.net), "GND"].filter((v, i, a) => a.indexOf(v) === i);
  if (supplyNets.length > 1 || netlist.rails.length) {
    const jId = `J_PWR${supplyNets.length}`;
    defineSymbol({ id: jId, ref: "J", left: [], right: supplyNets.map((nm, i) => ({ num: String(i + 1), name: nm, type: "power_out" })) });
    items.push({
      ref: "J1", symbol: jId, value: `Power: ${supplyNets.join(" ")}`,
      footprint: `Connector_PinHeader_2.54mm:PinHeader_1x${String(supplyNets.length).padStart(2, "0")}_P2.54mm_Vertical`,
      pins: supplyNets.map((nm, i) => ({ num: String(i + 1), net: nm })),
    });
  }

  // --- emit ---
  const root = uuid();
  const COLS = 4, CELL_W = 63.5;
  const out = [];
  let rowY = 38.1, rowH = 0;
  const placed = [];
  items.forEach((it, i) => {
    const def = symbols.get(it.symbol);
    const rows = Math.max(def.left.length, def.right.length, 1);
    const h = rows * 2.54 + 17.78;
    const col = i % COLS;
    if (col === 0 && i) { rowY += rowH; rowH = 0; }
    rowH = Math.max(rowH, h);
    placed.push({ it, def, x: 38.1 + col * CELL_W, y: rowY + h / 2 - 7.62, rows });
  });

  const labels = [], noConnects = [];
  for (const { it, def, x, y } of placed) {
    const hw = def.wide ? 7.62 : 5.08;
    const rows = Math.max(def.left.length, def.right.length, 1);
    const hh = (rows * 2.54) / 2 + 1.27;
    const props = `
      (property "Reference" ${q(it.ref)} (at ${n(x)} ${n(y - hh - 1.27)} 0) ${FONT})
      (property "Value" ${q(it.value)} (at ${n(x)} ${n(y + hh + 1.27)} 0) ${FONT})
      (property "Footprint" ${q(it.footprint)} (at ${n(x)} ${n(y)} 0) ${FONT_HIDE})
      (property "Datasheet" "" (at ${n(x)} ${n(y)} 0) ${FONT_HIDE})`;
    out.push(`  (symbol (lib_id ${q(`CJS:${def.id}`)}) (at ${n(x)} ${n(y)} 0) (unit 1)
    (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no) (uuid ${q(uuid())})${props}
${it.pins.map((p) => `    (pin ${q(p.num)} (uuid ${q(uuid())}))`).join("\n")}
    (instances (project ${q(name)} (path ${q(`/${root}`)} (reference ${q(it.ref)}) (unit 1)))))`);

    const place = (list, side) => list.forEach((p, i) => {
      const pin = it.pins.find((x) => x.num === p.num);
      if (!pin) return;
      const px = side === "L" ? -(hw + 2.54) : hw + 2.54;
      const py = ((rows - 1) * 2.54) / 2 - i * 2.54;
      if (!pin.net) { noConnects.push({ x: n(x + px), y: n(y - py) }); return; }
      const net = pin.net;
      labels.push({ net, x: n(x + px), y: n(y - py), angle: side === "L" ? 180 : 0, ref: it.ref, num: p.num });
    });
    place(def.left, "L");
    place(def.right, "R");
  }
  const labelText = labels.map((l) => `  (label ${q(l.net)} (at ${l.x} ${l.y} ${l.angle}) (effects (font (size 1.27 1.27)) (justify ${l.angle === 180 ? "right" : "left"} bottom)) (uuid ${q(uuid())}))`);

  const sch = `(kicad_sch
  (version 20250114)
  (generator "circuitjs-bom")
  (generator_version "1.0")
  (uuid ${q(root)})
  (paper "A2")
  (lib_symbols
${[...symbols.values()].map(symbolDef).join("\n")}
  )
${out.join("\n")}
${labelText.join("\n")}
${noConnects.map((c) => `  (no_connect (at ${c.x} ${c.y}) (uuid ${q(uuid())}))`).join("\n")}
  (sheet_instances (path "/" (page "1")))
  (embedded_fonts no)
)
`;
  const pro = JSON.stringify({ meta: { filename: `${name}.kicad_pro`, version: 3 }, schematic: { drawing: { default_line_thickness: 6 } } }, null, 2) + "\n";

  const summary = {
    name, mounting,
    parts: items.map((i) => ({ ref: i.ref, value: i.value, footprint: i.footprint, source: i.source, mpn: i.mpn })),
    packages, supplyNets,
    rails: netlist.rails,
    nets: netlist.nets.length,
  };
  return { ok: true, files: { [`${name}.kicad_sch`]: sch, [`${name}.kicad_pro`]: pro }, summary, warnings, labels };
}
