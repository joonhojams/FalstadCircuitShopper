// Turns an extracted netlist into a KiCad 9 project: a schematic (.kicad_sch) where every pin
// carries a net label, plus a project file. Nets are connected by name (labels placed on the pin
// ends) rather than by drawn wires, which is exact and keeps the generator simple. In KiCad:
// open the project, then "Update PCB from Schematic" (F8) in the PCB editor to start layout.
//
// Not validated against a real KiCad install by the test-suite here; see the structural checks in
// the tests. Footprints use KiCad's standard library names.

import { ICS, icsFor, icFromChoice, defaultIc, packagePins } from "./ics.js";
import { resolve, icFootprint } from "./footprints.js";
import { missingFootprints, placeParts, writePcb, previewBoard } from "./pcb.js";
import { route } from "./router.js";
import { checkBoard } from "./drc.js";
import { classifyNets } from "./netclass.js";
import { druText, netSettings, reportMd } from "./rules.js";
import { dsnText } from "./dsn.js";
import { preparePedal, addPedalParts, placePedal } from "./pedal.js";
import { pedalOutputs, pedalSilk } from "./pedal-docs.js";

// Courtyard gaps (mm) tried in turn until every net routes; undefined = the placer's default.
const GAP_STEPS = [undefined, 1.0, 1.8, 2.8];
const q = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const n = (x) => Number(x.toFixed(3));
const FONT = "(effects (font (size 1.27 1.27)))";
const FONT_HIDE = "(effects (font (size 1.27 1.27)) (hide yes))";

export const FOOTPRINTS = {
  resistor:  { smd: "Resistor_SMD:R_0805_2012Metric", tht: "Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal" },
  capacitor: { smd: "Capacitor_SMD:C_0805_2012Metric", tht: "Capacitor_THT:C_Disc_D5.0mm_W2.5mm_P5.00mm" },
  inductor:  { smd: "Inductor_SMD:L_0805_2012Metric", tht: "Inductor_THT:L_Axial_L5.3mm_D2.2mm_P10.16mm_Horizontal_Vishay_IM-1" },
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
  if (!opts.pedal) return buildInner(netlist, opts, null);
  // Pedal mode (spec pedal_pcb_spec_for_model.md): validate the request first; missing physical inputs come back as numbered questions.
  const pedal = preparePedal(netlist, opts.pedal === true ? {} : opts.pedal, { mounting: opts.mounting === "tht" ? "tht" : "smd" });
  try {
    if (pedal.errors.length) return { ok: false, errors: pedal.errors, questions: pedal.questions, pedal: { assumptions: pedal.assumptions } };
    return buildInner(pedal.netlist, opts, pedal);
  } finally { pedal.cleanup(); }
}

function buildInner(netlist, opts, pedal) {
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
      pins = [{ num: "2", net: by.A, fn: "A" }, { num: "1", net: by.K, fn: "K" }];
    } else if (p.kind === "bjt" || p.kind === "mosfet") {
      const names = p.kind === "bjt" ? ["B", "C", "E"] : ["G", "D", "S"];
      const map = r.pads;
      const id = `${p.kind}_${names.map((nm) => map[nm]).join("")}`;
      symbol = defineSymbol({
        id, ref: "Q",
        left: [{ num: map[names[0]], name: names[0] }],
        right: [{ num: map[names[1]], name: names[1] }, { num: map[names[2]], name: names[2] }],
      });
      pins = names.map((nm) => ({ num: map[nm], net: by[nm], fn: nm }));
    } else if (p.kind === "pot") {
      symbol = defineSymbol({ id: "pot", ref: "RV", left: [{ num: "1", name: "A" }], right: [{ num: "2", name: "W" }, { num: "3", name: "B" }] });
      pins = [{ num: "1", net: by.A, fn: "A" }, { num: "2", net: by.W, fn: "W" }, { num: "3", net: by.B, fn: "B" }];
    } else {
      symbol = defineSymbol(spec.two(`${p.kind}2`, { resistor: "R", capacitor: "C", inductor: "L", switch: "SW" }[p.kind] ?? "X", "1", "2"));
      pins = [{ num: "1", net: by["1"] }, { num: "2", net: by["2"] }];
    }
    if (r.warning) warnings.push(`${p.ref}: ${r.warning}`);
    items.push({ ref: p.ref, symbol, value: choice?.mpn || p.value || p.details || "", footprint: r.footprint, source: r.fromBom ? "BOM" : "default", mpn: choice?.mpn ?? "", kind: p.kind, pins });
    used[p.kind] = (used[p.kind] ?? 0) + 1;
  }

  // Op-amps, gates and 555s are packed into the chosen ICs, channel by channel, in reference order.
  const packages = [];
  const counters = new Map();
  const refTaken = new Set(items.map((i) => i.ref).concat(netlist.parts.map((p) => p.ref)));
  const newRef = (prefix) => { let r, k = counters.get(prefix) ?? 0; do { r = `${prefix}${++k}`; } while (refTaken.has(r)); counters.set(prefix, k); refTaken.add(r); return r; };
  const byIc = {};
  for (const p of icParts) (byIc[icOf[p.ref]] ??= []).push(p);
  for (const [id, list] of Object.entries(byIc)) {
    const ic = ICS[id];
    for (let i = 0; i < list.length; i += ic.units.length) {
      const chunk = list.slice(i, i + ic.units.length);
      const nets = new Map(), fns = new Map();
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
          for (const [nm, num] of Object.entries(unit)) { nets.set(num, by[nm] ?? null); fns.set(num, nm); }
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
      const pinList = [...pp.left, ...pp.right].map((p) => ({ num: p.num, net: nets.get(p.num) ?? null, fn: fns.get(p.num) }));
      const choice = choices[chunk[0].ref];
      const fp = icFootprint(ic, choice, mounting);
      const ref = `U${chunk[0].ref.replace(/^\D+/, "")}`;
      const mpn = choice && icFromChoice(chunk[0], choice) === id ? choice.mpn : "";
      items.push({ ref, symbol: id, value: mpn || id, footprint: fp.footprint, source: fp.fromBom ? "BOM" : "default", mpn, kind: ic.kind, pins: pinList });
      packages.push({ ic: id, ref, channels: chunk.map((c) => c.ref), unused: ic.units.length - chunk.length });
      if (ic.units.length - chunk.length) {
        warnings.push(`${id} ${ref}: ${ic.units.length - chunk.length} spare channel(s) are ${ic.kind === "gate" ? "tied low with open outputs" : "wired as parked followers"}.`);
      }
      if (opts.decouple !== false && pos && neg) {
        const cref = newRef("C_DEC");
        items.push({ ref: cref, symbol: defineSymbol(spec.two("capacitor2", "C", "1", "2")), value: "100nF", footprint: resolve("capacitor", undefined, fp.mounting).footprint,
          source: "default", mpn: "", kind: "capacitor", pins: [{ num: "1", net: pos }, { num: "2", net: neg }], anchor: { ref, num: ic.power.pos } });
      }
    }
  }

  // One power connector carries every rail and ground, so the board has a single 5 V input.
  const supplyNets = [...netlist.rails.map((r) => r.net), "GND"].filter((v, i, a) => a.indexOf(v) === i);
  if (pedal) addPedalParts(pedal, { items, defineSymbol, newRef, resolve, mounting, warnings });
  if (!pedal && (supplyNets.length > 1 || netlist.rails.length)) {
    const jId = `J_PWR${supplyNets.length}`;
    defineSymbol({ id: jId, ref: "J", left: [], right: supplyNets.map((nm, i) => ({ num: String(i + 1), name: nm, type: "power_out" })) });
    items.push({
      ref: "J1", kind: "connector", symbol: jId, value: `Power: ${supplyNets.join(" ")}`,
      footprint: `Connector_PinHeader_2.54mm:PinHeader_1x${String(supplyNets.length).padStart(2, "0")}_P2.54mm_Vertical`,
      pins: supplyNets.map((nm, i) => ({ num: String(i + 1), net: nm })),
    });
  }

  // Pedal mode places the board now: the standoff holes it may add need schematic symbols too.
  let pedalPlan = null;
  if (pedal) {
    const lacking = missingFootprints(items);
    if (lacking.length) return { ok: false, errors: [`Pedal mode needs the board file, and there is no built-in geometry for: ${lacking.map((m) => m.split(":").pop()).join(", ")}. Pick another part for it in the BOM or turn pedal mode off (IN-02).`] };
    pedalPlan = placePedal(pedal, items, placeParts, { gap: opts.gap });
    if (pedalPlan.errors.length) return { ok: false, errors: pedalPlan.errors, questions: pedal.questions };
    for (const h of pedalPlan.extraItems ?? []) { h.symbol = defineSymbol({ id: "hole", ref: "H", left: [], right: [] }); items.push(h); }
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
    it.symUuid = uuid();            // the PCB footprint points back at this symbol
    out.push(`  (symbol (lib_id ${q(`CJS:${def.id}`)}) (at ${n(x)} ${n(y)} 0) (unit 1)
    (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no) (uuid ${q(it.symUuid)})${props}
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
    parts: items.map((i) => ({ ref: i.ref, value: i.value, footprint: i.footprint, source: i.source, mpn: i.mpn, ...(i.added ? { added: i.added } : {}) })),
    packages, supplyNets,
    rails: netlist.rails,
    nets: netlist.nets.length,
  };
  const files = { [`${name}.kicad_sch`]: sch, [`${name}.kicad_pro`]: pro };

  // Placed (not routed) board. Needs real footprint geometry for every part; otherwise the user
  // starts the board from the schematic in KiCad as before and the preview uses a rough layout.
  let pcb = null, layout = null, routing = null, drc = null, classes = new Map();
  const missing = pedal ? [] : missingFootprints(items);
  if (missing.length) {
    warnings.push(`No .kicad_pcb was written because footprint geometry is not built in for: ${missing.map((m) => m.split(":").pop()).join(", ")}. Use Update PCB from Schematic (F8) in KiCad.`);
  } else {
    layout = pedalPlan ? pedalPlan.layout : placeParts(items, { gap: opts.gap });
    const hasGnd = items.some((i) => i.pins.some((p) => p.net === "GND"));
    const pour = hasGnd ? "GND" : null;
    classes = classifyNets(layout.parts.map((r) => r.it), netlist.rails);
    if (opts.route !== false) {
      // Placement packs parts tightly; when that leaves nets unrouted, place again with more room between courtyards and keep the best board.
      const gaps = opts.gap != null ? [opts.gap] : GAP_STEPS;
      const budget = opts.maxMs ?? 20000, started = Date.now();
      let best = null;
      for (let k = 0; k < gaps.length; k++) {
        const lay = k === 0 ? layout : (pedalPlan ? placePedal(pedal, items, placeParts, { gap: gaps[k] }).layout : placeParts(items, { gap: gaps[k] }));
        if (!lay) break;
        let rt = null, dc = null, err = null;
        try {
          rt = route(lay, { classes, pour, maxMs: opts.maxMs, noiseAware: opts.noiseAware });
          dc = checkBoard(lay, rt, { classes, pour });
        } catch (e) { err = e; }
        const score = err ? Infinity : dc.unrouted.length * 1000 + dc.errors.length;
        if (!best || score < best.score) best = { layout: lay, routing: rt, drc: dc, err, score, gap: gaps[k] };
        if (score === 0 || Date.now() - started > budget / 2) break;
      }
      layout = best.layout; routing = best.routing; drc = best.drc;
      if (best.err) {
        warnings.push(`Routing failed (${best.err.message}); the board has placement and connections only.`);
      } else {
        if (best.gap !== undefined && best.gap !== gaps[0]) warnings.push(`Parts were placed ${best.gap} mm apart (instead of the default) so the router had room for the traces.`);
        if (drc.unrouted.length) warnings.push(`${drc.unrouted.length} net(s) could not be routed (${drc.unrouted.map((u) => u.net).join(", ")}). They stay as connections to finish in KiCad.`);
        if (drc.errors.length) warnings.push(`The built-in checker found ${drc.errors.length} problem(s) in the routing; see report.md.`);
      }
    }
    warnings.push(...layout.warnings);
    if (pedal) {
      const sk = pedalSilk(pedal, pedalPlan, layout, { name, rev: opts.rev ?? "A", date: opts.date ?? null });
      layout.texts = sk.texts;
      if (sk.dropped.length) warnings.push(`No free place on the board for the silkscreen label(s): ${sk.dropped.join(", ")}.`);
    }
    const w = writePcb({ name, layout, uuid, sheetFile: `${name}.kicad_sch`, routing, pour });
    files[`${name}.kicad_pcb`] = w.text;
    pcb = previewBoard(layout, routing, drc?.unrouted ?? []);
    summary.board = { width: layout.w, height: layout.l, nets: w.nets };
    if (routing) {
      summary.routing = { ...routing.stats, errors: drc?.errors.length ?? 0, unrouted: drc?.unrouted ?? [], pour };
      files[`${name}.kicad_dru`] = druText(opts.fabMinClear);
      files[`${name}.kicad_pro`] = JSON.stringify({ meta: { filename: `${name}.kicad_pro`, version: 3 }, schematic: { drawing: { default_line_thickness: 6 } }, net_settings: netSettings(classes) }, null, 2) + "\n";
    }
    files[`${name}.dsn`] = dsnText({ name, layout, classes, pour });
    let extra = opts.reportExtra;
    if (pedal) {
      const po = pedalOutputs({ st: pedal, plan: pedalPlan, items, layout, routing, drc, classes, pour, name, warnings });
      Object.assign(files, po.files);
      extra = po.extra;
      summary.pedal = po.summary;
    }
    files["report.md"] = reportMd({ summary, layout, routing, drc, classes, mounting, warnings, extra });
  }
  return { ok: true, files, summary, warnings, labels, pcb, layout, routing, drc, classes };
}
