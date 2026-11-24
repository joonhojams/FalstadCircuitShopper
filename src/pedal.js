// Guitar-pedal mode (spec: pedal_pcb_spec_for_model.md). Optional: the normal export is unchanged when it is off.
//
// What it adds to the PCB export:
//   * the board outline from the enclosure interior, with the lid-screw posts cut out of the corners (BO-01, BO-02)
//   * panel hardware (pots, in/out jacks, DC jack, footswitch pads, LED) placed where the drill plan needs it and locked
//   * the parts a CircuitJS file omits: DC jack chain with reverse protection and a bulk cap, status LED, test points,
//     a Vcc/2 divider when the circuit used a half-supply source, bypass wiring (see circuitjs_omissions)
//   * net names from the spec (IN, OUT, SW_IN, SW_OUT, LED_K, VREF)
// Drill plan, overlay and wiring guide come from src/pedal-docs.js once the board is placed and routed.
//
// Every number tagged [V] in the spec (enclosure walls, hole diameters, jack geometry) is a typical value, not a datasheet
// value. Where this file had to infer something from a footprint it says so, and the report repeats it.

import { FOOTPRINT_DATA } from "./footprint-data.js";
import { readFootprint } from "./fpread.js";
import { parseSexp } from "./sexp.js";
import { oriented, rotPt } from "./pcb.js";
import { distPtRect } from "./geom.js";

const R4 = (v) => Math.round(v * 10000) / 10000;
const q = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

// ---- enclosures and limits ----

/** Outer L x W x H in mm, spec <mech_rules> ENCLOSURE_REF [V]. Always prefer the maker's drawing. */
export const ENCLOSURES = { "1590A": [92, 38, 31], "1590B": [112, 60, 31], "125B": [122, 66, 39], "1590BB": [119.5, 94, 34], "1590DD": [188, 119.5, 38] };
export const TYPES = ["analog_overdrive", "fuzz", "modulation", "preamp", "buffer", "utility"];
export const BLOCKED = {
  delay_digital: "Digital delay circuits need a 4-layer board with split analog/digital ground (spec layers=4). This app only makes 2-layer boards, so pedal mode is blocked for this circuit type.",
  modulation_bbd_with_mcu: "BBD modulation with an MCU needs a 4-layer board (spec layers=4). This app only makes 2-layer boards, so pedal mode is blocked for this circuit type.",
};
export const PEDAL = {
  wall: 3.0,               // [V] interior wall thickness, spec says ~2.5-3.0; the thicker value is the safe one
  edge_clear: 1.5,         // BO-01: board edge to the interior wall (spec min 1.0, prefers 1.5)
  post_dia: 8,             // [V] corner_post_keepout_dia
  post_keep: 4.5,          // post radius + 0.5 so copper keeps its edge clearance from the notch
  corner_radius: 1.0,      // BO-02
  pot_pitch: 22,           // [V] spec default when the knob diameter is unknown
  fs_from_bottom: 0.30,    // DP-02: footswitch about 30 % of the length from the stomp end
  side_jack_y: 12,         // distance of the jack axis from the top end, mm; DP-04 wants >= 8 from the corner posts
  gap: 0.5,                // clearance between mechanical courtyards
  hole: { pot: 7.5, jack: 10, dc: 12, sw: 12, led: 6 }, // [V] drill_conventions HOLE_DIA, snapped per DP-10
  standoff_drill: 3.2, standoff_keep: 6.0,
};

// ---- footprints this module adds (project library "Pedal") ----

const ring = (x0, y0, x1, y1, l, w = 0.12) => [[x0, y0, x1, y0], [x1, y0, x1, y1], [x1, y1, x0, y1], [x0, y1, x0, y0]].map((a) => ({ k: "l", a, l, w }));
const tpad = (n, x, y, d, drill) => ({ n: String(n), t: "thru_hole", s: "circle", x, y, w: d, h: d, d: drill, l: ["*.Cu", "*.Mask"] });
const wire = [];
for (let p = 0; p < 3; p++) for (let j = 0; j < 3; j++) wire.push(tpad(3 * p + j + 1, (p - 1) * 5.08, (j - 1) * 2.54, 2, 1));
export const PEDAL_FOOTPRINTS = {
  "Pedal:TP_THT_D2.0mm": { attr: "through_hole", pads: [tpad(1, 0, 0, 2, 1)], g: [...ring(-1.5, -1.5, 1.5, 1.5, "F.CrtYd", 0.05), { k: "c", a: [0, 0, 1.2, 0], l: "F.SilkS", w: 0.12 }], cy: [-1.5, -1.5, 1.5, 1.5] },
  // 3PDT footswitch as nine labelled wire pads. Origin = switch centre. Pole p is a column, lug j a row:
  // pad 3p+1 = bypass lug, 3p+2 = common, 3p+3 = effect lug (see wiring_guide.md).
  "Pedal:WirePads_3PDT_3x3": { attr: "through_hole", pads: wire, g: [...ring(-9, -9, 9, 9, "F.SilkS"), ...ring(-9, -9, 9, 9, "F.Fab"), ...ring(-9.5, -9.5, 9.5, 9.5, "F.CrtYd", 0.05)], cy: [-9.5, -9.5, 9.5, 9.5] },
};
Object.assign(FOOTPRINT_DATA, PEDAL_FOOTPRINTS);

/** .kicad_mod text for a footprint in our compact form (used for the project's pedal.pretty library). */
export function modText(name, fp) {
  const gfx = fp.g.map((e) => {
    const st = `(stroke (width ${e.w}) (type solid)) (layer ${q(e.l)})`;
    if (e.k === "l") return `  (fp_line (start ${e.a[0]} ${e.a[1]}) (end ${e.a[2]} ${e.a[3]}) ${st})`;
    if (e.k === "c") return `  (fp_circle (center ${e.a[0]} ${e.a[1]}) (end ${e.a[2]} ${e.a[3]}) ${st} (fill no))`;
    return `  (fp_arc (start ${e.a[0]} ${e.a[1]}) (mid ${e.a[2]} ${e.a[3]}) (end ${e.a[4]} ${e.a[5]}) ${st})`;
  });
  const pads = fp.pads.map((p) => {
    const drill = p.d === undefined ? "" : Array.isArray(p.d) ? ` (drill oval ${p.d[0]} ${p.d[1]})` : ` (drill ${p.d})`;
    return `  (pad ${q(p.n)} ${p.t} ${p.s} (at ${p.x} ${p.y}${p.r ? ` ${p.r}` : ""}) (size ${p.w} ${p.h})${drill} (layers ${p.l.map(q).join(" ")}))`;
  });
  return `(footprint ${q(name)}
  (version 20241229)
  (generator "circuitjs-bom")
  (layer "F.Cu")
  (attr ${fp.attr})
  (property "Reference" "REF**" (at 0 ${R4(fp.cy[1] - 1)}) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))
  (property "Value" ${q(name)} (at 0 ${R4(fp.cy[3] + 1)}) (layer "F.Fab") (effects (font (size 1 1) (thickness 0.15))))
${gfx.join("\n")}
${pads.join("\n")}
)
`;
}

// ---- hardware table ----
// hole = where the panel hole's axis crosses the footprint, in footprint coordinates (mm, y down). For side-mounted jacks it is the point
// on the wall plane; facing = which way the opening faces at rotation 0. All values below were read off the KiCad footprint's pad and Fab
// layout, not from a datasheet: they are [V]. The user can override any of them with their own footprint (see `custom`).
export const HW = {
  pot:  { fp: "Potentiometer_THT:Potentiometer_Alpha_RD901F-40-00D_Single_Vertical", pins: { A: "1", W: "2", B: "3" }, dia: PEDAL.hole.pot, face: "top", what: "pot" },
  jack: { fp: "Connector_Audio:Jack_6.35mm_Neutrik_NMJ6HCD2_Horizontal", pins: { tip: "T", sleeve: "S" }, hole: [-3.91, 8.115], facing: "-x", dia: PEDAL.hole.jack, what: "1/4 in jack" },
  dc:   { fp: "Connector_BarrelJack:BarrelJack_Horizontal", pins: { tip: "1", sleeve: "2" }, hole: [-13.7, 0], facing: "-x", dia: PEDAL.hole.dc, what: "DC jack" },
  sw:   { fp: "Pedal:WirePads_3PDT_3x3", hole: [0, 0], dia: PEDAL.hole.sw, face: "top", what: "3PDT footswitch" },
  led:  { fp: "LED_THT:LED_D3.0mm", pins: { A: "2", K: "1" }, hole: [1.27, 0], dia: PEDAL.hole.led, face: "top", what: "LED" },
};
const FACING = { "-x": [-1, 0], "+x": [1, 0], "-y": [0, -1], "+y": [0, 1] };
// For a part whose hole is not given: the middle of its unnumbered mounting pads, else the centre of its pads.
export function holeOf(fpName, given) {
  if (given) return given;
  const fp = FOOTPRINT_DATA[fpName];
  const tabs = fp.pads.filter((p) => p.n === "");
  const use = tabs.length ? tabs : fp.pads;
  return [R4(use.reduce((s, p) => s + p.x, 0) / use.length), R4(use.reduce((s, p) => s + p.y, 0) / use.length)];
}
const rotFor = (facing, want) => [0, 90, 180, 270].find((r) => { const v = rotPt(...FACING[facing], r); return v[0] === want[0] && v[1] === want[1]; }) ?? 0;

// ---- input ----

export const DEFAULTS = {
  type: "analog_overdrive", enclosure: "1590B", mounting: "sandwich", bypass: "true_bypass_3PDT", knobDia: null, taper: "B",
  maxCurrentMa: 100,
  parts: { reverse: "1N5817", bulk: "100uF 16V", led: "LED 3mm", ledResistor: "4.7k", vrefTop: "100k", vrefBottom: "100k", vrefCap: "10uF", testPoints: true },
};

/** Check and complete the pedal form. Missing physical inputs are ASK (a numbered question and a block); the rest are ASSUME. */
export function normalizeInput(raw = {}) {
  const errors = [], questions = [], assumptions = [], deviations = [];
  const ask = (text) => { questions.push(text); errors.push(text); };
  const input = { ...DEFAULTS, ...Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined && v !== null && v !== "")) };
  input.parts = { ...DEFAULTS.parts, ...(raw.parts ?? {}) };

  if (BLOCKED[input.type]) errors.push(BLOCKED[input.type]);
  else if (!TYPES.includes(input.type)) { assumptions.push(`circuit_type "${input.type}" is not one of ${TYPES.join(", ")}: assumed analog_overdrive.`); input.type = "analog_overdrive"; }
  else if (!raw.type) assumptions.push("circuit_type was not given: assumed analog_overdrive.");

  if (!["sandwich", "standoffs"].includes(input.mounting)) input.mounting = "sandwich";
  if (!raw.mounting) assumptions.push("BO-03 mounting scheme: sandwich (board held by pot bushings and jack nuts). Switch to standoffs in the form if you use M3 standoffs.");
  if (!["true_bypass_3PDT", "none"].includes(input.bypass)) { assumptions.push(`bypass "${input.bypass}" is not supported here: used true_bypass_3PDT.`); input.bypass = "true_bypass_3PDT"; }

  const model = String(input.enclosure);
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
  let Li = num(raw.interior?.L), Wi = num(raw.interior?.W), Hu = num(raw.interior?.H);
  if (ENCLOSURES[model]) {
    const [L, W, H] = ENCLOSURES[model];
    if (!Li || !Wi || !Hu) assumptions.push(`${model} interior is outer ${L} x ${W} x ${H} mm minus a ${PEDAL.wall} mm wall on every side [V]. Replace it with the numbers from the maker's drawing.`);
    Li ??= L - 2 * PEDAL.wall; Wi ??= W - 2 * PEDAL.wall; Hu ??= H - 2 * PEDAL.wall;
    input.outer = [R4(Li + 2 * PEDAL.wall), R4(Wi + 2 * PEDAL.wall), R4(Hu + 2 * PEDAL.wall)];
  } else if (!Li || !Wi || !Hu) {
    ask(`Enclosure "${model}" is not a known model: give its interior length, width and usable height in mm (enclosure.interior_mm L, W, H_usable).`);
  } else input.outer = [R4(Li + 2 * PEDAL.wall), R4(Wi + 2 * PEDAL.wall), R4(Hu + 2 * PEDAL.wall)];
  if (Li && Wi && (Li < 30 || Wi < 20 || Li > 400 || Wi > 400)) ask(`Interior ${Li} x ${Wi} mm looks wrong (expected 20 to 400 mm). Check the enclosure numbers.`);
  Object.assign(input, { Li, Wi, Hu });

  if (!raw.knobDia) assumptions.push(`DP-01 knob diameter unknown: pot pitch ${PEDAL.pot_pitch} mm [V] (knob + 3 mm when you give the diameter).`);
  input.pitch = input.knobDia ? Number(input.knobDia) + 3 : PEDAL.pot_pitch;
  if (!raw.taper) assumptions.push("Pot taper letters were not given: B assumed for every control (silkscreen only). Set them in the form.");
  if (!raw.maxCurrentMa) assumptions.push(`Supply current not given: ${DEFAULTS.maxCurrentMa} mA assumed [V]; sizes nothing here except the report. POWER traces use the spec default width.`);
  return { ok: !errors.length, errors, questions, assumptions, deviations, input };
}

// ---- netlist: which net is the input / output, what the supply and half-supply rails are ----

const num = (ref) => Number(String(ref).replace(/\D/g, "")) || 0;
function guessIo(nl) {
  const names = nl.nets.map((n) => n.name);
  let inn = names.find((n) => /^(in|input|audio_?in|guitar)$/i.test(n));
  const ac = nl.sources.filter((s) => !s.dc).map((s) => s.nets[s.nets.length - 1]).filter((n) => n && n !== "GND");
  inn ??= ac[0] ?? null;
  let out = names.find((n) => /^(out|output|audio_?out)$/i.test(n));
  if (!out) {
    const op = nl.parts.filter((p) => p.kind === "opamp").sort((a, b) => num(b.ref) - num(a.ref));
    out = op.map((p) => p.pins.find((x) => x.name === "OUT")?.net).find((n) => n && n !== inn) ?? null;
  }
  return { in: inn, out };
}
/** What the form needs from the circuit: candidate nets for the output, the pots, the rails. */
export function inspectPedal(nl) {
  const rails = new Set(nl.rails.map((r) => r.net));
  const g = guessIo(nl);
  return {
    nets: nl.nets.map((n) => n.name).filter((n) => n !== "GND" && !rails.has(n)),
    in: g.in, out: g.out, rails: nl.rails,
    pots: nl.parts.filter((p) => p.kind === "pot").map((p) => p.ref),
  };
}

/**
 * Validates the pedal request against the circuit and returns the netlist with the spec's net names applied.
 * Registers any user footprints (call `cleanup()` when done) and lists the files for the project library.
 */
export function preparePedal(netlist, raw, { mounting }) {
  const base = normalizeInput(raw ?? {});
  const st = { ...base, netlist, files: {}, notes: [], registered: [], cleanup() { for (const k of this.registered) delete FOOTPRINT_DATA[k]; this.registered = []; } };
  // Collect every missing input before stopping (spec B5: ask once, as a numbered list).
  const err = (text, asQuestion = true) => { st.errors.push(text); if (asQuestion) st.questions.push(text); };

  const input = st.input;
  // --- supply and half-supply ---
  const pos = netlist.rails.filter((r) => r.volts > 0).sort((a, b) => b.volts - a.volts);
  const main = input.supplyV ? pos.find((r) => Math.abs(r.volts - Number(input.supplyV)) < 0.01) : pos[0];
  if (!main) err(input.supplyV ? `The circuit has no ${input.supplyV} V rail. Which supply voltage does the pedal run from?` : "The circuit has no DC supply rail. Add a rail (a +9 V source to ground) to the CircuitJS file, or tell me the supply voltage.");
  const half = main ? pos.find((r) => r !== main && Math.abs(r.volts - main.volts / 2) <= 0.02 * (main.volts / 2)) : null;
  const odd = netlist.rails.filter((r) => r !== main && r !== half);
  if (odd.length) err(`Rail ${odd.map((r) => `${r.net} (${r.volts} V)`).join(", ")} is neither the supply nor half of it. A pedal supply has one DC jack; this needs a regulator or charge pump, which pedal mode does not add. Remove it or say how it is made.`);
  if (main) { input.supplyV = main.volts; input.supplyNet = main.net; }

  // --- input / output nets ---
  const g = guessIo(netlist), nets = new Set(netlist.nets.map((n) => n.name));
  const inNet = raw?.inNet && nets.has(raw.inNet) ? raw.inNet : g.in;
  const outNet = raw?.outNet && nets.has(raw.outNet) ? raw.outNet : g.out;
  if (!inNet) err("Which net is the audio input? The CircuitJS file has no AC source or a net labelled IN. Pick it in the form.");
  if (!outNet) err("Which net is the audio output? No net is labelled OUT and no op-amp output could be guessed. Pick it in the form.");
  if (inNet && outNet && inNet === outNet) err(`Input and output are the same net (${inNet}). Pick a different output net.`);
  if (inNet && !raw?.inNet && !nets.has("IN")) st.assumptions.push(`The input is net ${inNet} (the AC source), carried to the input jack.`);
  if (outNet && !raw?.outNet) st.assumptions.push(`The output is net ${outNet} (${/^(out|output|audio_?out)$/i.test(outNet) ? "labelled OUT" : "the output of the last op-amp"}). Change it in the form if that is wrong.`);

  // --- pots (panel controls) ---
  st.pots = netlist.parts.filter((p) => p.kind === "pot").map((p) => p.ref);

  // --- custom footprints (user hardware overrides the built-in list; UP-01) ---
  st.hw = JSON.parse(JSON.stringify(HW));
  const safe = (s) => String(s).replace(/[^\w.+-]/g, "_").slice(0, 60) || "part";
  for (const [role, c] of Object.entries(raw?.custom ?? {})) {
    if (!HW[role] || !c?.mod) continue;
    if (role === "sw") { err("A footprint of your own for the footswitch is not supported yet: the board uses nine wire pads and the wiring table. Remove it, or wire the switch to the pads."); continue; }
    try {
      if (String(c.mod).length > 200000) throw new Error("file is larger than 200 kB");
      const root = parseSexp(String(c.mod));
      if (!["footprint", "module"].includes(root[0])) throw new Error("not a .kicad_mod file");
      const key = `Pedal:${safe(root[1])}`;
      FOOTPRINT_DATA[key] = readFootprint(String(c.mod));
      st.registered.push(key);
      st.files[`pedal.pretty/${safe(root[1])}.kicad_mod`] = String(c.mod);
      const pinout = c.pinout ?? {};
      const need = Object.keys(HW[role].pins ?? {});
      const miss = need.filter((k) => !pinout[k]);
      if (miss.length) { err(`Your ${HW[role].what} footprint needs a pinout: which pad is ${miss.join(", ")}? (UP-02)`); continue; }
      const badPad = need.filter((k) => !FOOTPRINT_DATA[key].pads.some((p) => p.n === String(pinout[k])));
      if (badPad.length) { err(`Your ${HW[role].what} footprint has no pad named ${badPad.map((k) => pinout[k]).join(", ")}.`); continue; }
      const facing = FACING[c.facing] ? c.facing : HW[role].facing;
      st.hw[role] = { ...HW[role], fp: key, pins: Object.fromEntries(need.map((k) => [k, String(pinout[k])])), hole: Array.isArray(c.hole) && c.hole.length === 2 ? c.hole.map(Number) : (HW[role].facing ? null : holeOf(key)), facing };
      if (HW[role].facing && !st.hw[role].hole) err(`Your ${HW[role].what} footprint needs the panel hole position (hole x, y in mm from the footprint origin) and which way the opening faces.`);
      st.notes.push(`${HW[role].what}: using your footprint ${root[1]} (P1). Hole position ${st.hw[role].hole ?? "from the footprint"} and pinout are as you gave them.`);
    } catch (e) { err(`Could not read your ${HW[role].what} footprint: ${e.message}.`, true); }
  }
  if (st.errors.length) return st;

  // --- rename nets: VREF, IN/OUT/SW_IN/SW_OUT ---
  const bypass = input.bypass === "true_bypass_3PDT";
  const rn = new Map();
  if (half) rn.set(half.net, "VREF");
  rn.set(inNet, bypass ? "SW_IN" : "IN");
  rn.set(outNet, bypass ? "SW_OUT" : "OUT");
  const fix = (n) => rn.get(n) ?? n;
  const taken = new Set([...nets].filter((n) => !rn.has(n)));
  for (const n of rn.values()) if (taken.has(n)) { st.errors.push(`The circuit already has a different net named ${n}. Rename it in CircuitJS.`); st.questions.push(st.errors[st.errors.length - 1]); }
  if (st.errors.length) return st;
  st.netlist = {
    ...netlist,
    parts: netlist.parts.map((p) => ({ ...p, pins: p.pins.map((x) => ({ ...x, net: fix(x.net) })) })),
    nets: netlist.nets.map((n) => ({ ...n, name: fix(n.name) })),
    rails: netlist.rails.filter((r) => r !== half).map((r) => ({ ...r, net: fix(r.net) })),
  };
  Object.assign(st, { vref: Boolean(half), inNet: fix(inNet), outNet: fix(outNet), bypass, renames: Object.fromEntries(rn), halfVolts: half?.volts ?? null });
  if (half) st.assumptions.push(`The ${half.volts} V source (${half.net}) is half of the ${main.volts} V supply, so it became an on-board Vcc/2 divider on net VREF (PG-03), not a connector rail.`);
  st.assumptions.push(`Nets renamed to the spec's names (CS-04): ${[...rn].map(([a, b]) => `${a} -> ${b}`).join(", ")}.`);
  if (!st.assumptions.some((a) => /\+9V_PROT/.test(a))) st.assumptions.push("The reverse-protection diode's output is the supply net itself (no +9V_PROT net) because no RC or ferrite filter is added (CP-08 optional).");
  return st;
}

// ---- parts the CircuitJS file leaves out (circuitjs_omissions) ----

/**
 * Adds the real-world parts to `items`. ctx: { items, defineSymbol, newRef, resolve, mounting, warnings }.
 * Returns the mechanical list: [{ it, role, hw, dia, face }].
 */
export function addPedalParts(st, ctx) {
  const { items, defineSymbol, newRef, resolve, mounting, warnings } = ctx;
  const { input, hw } = st;
  const parts = input.parts;
  const mech = [];
  const supply = input.supplyNet;
  const two = (id, ref, l, r) => defineSymbol({ id, ref, left: [{ num: "1", name: l }], right: [{ num: "2", name: r }] });
  const add = (it) => { items.push({ source: "pedal", mpn: "", ...it }); return items[items.length - 1]; };
  const asPolar = !(mounting === "tht");

  // Panel pots: the circuit's pots take the panel pot footprint unless the user's BOM pick is a known PCB-mount family.
  for (const it of items.filter((i) => i.kind === "pot")) {
    const custom = hw.pot.fp !== HW.pot.fp;
    if (it.source !== "BOM" || custom) {
      // Warnings about the footprint the pot had before (generic header row, terminal block, SMD trimmer) no longer apply.
      for (let k = warnings.length - 1; k >= 0; k--) if (warnings[k].startsWith(`${it.ref}: `)) warnings.splice(k, 1);
      it.footprint = hw.pot.fp; it.source = custom ? "your footprint" : "pedal default";
      it.pins = it.pins.map((p) => ({ ...p, num: hw.pot.pins[p.fn] ?? p.num }));
      it.symbol = defineSymbol({ id: `pot_${["A", "W", "B"].map((k) => hw.pot.pins[k]).join("")}`, ref: "RV", left: [{ num: hw.pot.pins.A, name: "A" }], right: [{ num: hw.pot.pins.W, name: "W" }, { num: hw.pot.pins.B, name: "B" }] });
      mech.push({ it, role: "pot", hw: hw.pot, dia: hw.pot.dia, face: "top", label: st.input.taper });
    } else warnings.push(`${it.ref}: the BOM picked a trimmer-style potentiometer; it is placed on the board, not on the panel (CP-09: reach it with the lid off).`);
  }

  // Jacks and DC jack
  const jackSym = (h, ref, tipName) => defineSymbol({ id: `${ref.toLowerCase()}_${h.pins.tip}_${h.pins.sleeve}`, ref, left: [{ num: h.pins.tip, name: tipName }], right: [{ num: h.pins.sleeve, name: "SLEEVE" }] });
  const inJ = add({ ref: newRef("J"), kind: "connector", value: "Input jack", footprint: hw.jack.fp, symbol: jackSym(hw.jack, "J", "TIP"), pins: [{ num: hw.jack.pins.tip, net: st.bypass ? "IN" : st.inNet, fn: "tip" }, { num: hw.jack.pins.sleeve, net: "GND", fn: "sleeve" }] });
  const outJ = add({ ref: newRef("J"), kind: "connector", value: "Output jack", footprint: hw.jack.fp, symbol: jackSym(hw.jack, "J", "TIP"), pins: [{ num: hw.jack.pins.tip, net: st.bypass ? "OUT" : st.outNet, fn: "tip" }, { num: hw.jack.pins.sleeve, net: "GND", fn: "sleeve" }] });
  const dcJ = add({ ref: newRef("J"), kind: "connector", value: "DC jack 2.1 mm, center negative", footprint: hw.dc.fp, symbol: jackSym(hw.dc, "J", "TIP (-)"), pins: [{ num: hw.dc.pins.tip, net: "GND", fn: "tip" }, { num: hw.dc.pins.sleeve, net: "DC_IN", fn: "sleeve" }] });
  mech.push({ it: inJ, role: "jack_in", hw: hw.jack, dia: hw.jack.dia, face: "side_left" }, { it: outJ, role: "jack_out", hw: hw.jack, dia: hw.jack.dia, face: "side_right" }, { it: dcJ, role: "dc_jack", hw: hw.dc, dia: hw.dc.dia, face: "end_top" });

  // Power chain: DC jack -> series Schottky (reverse polarity) -> bulk capacitor -> rails (CP-08)
  const rp = resolve("diode", undefined, mounting);
  add({ ref: newRef("D"), kind: "diode", value: parts.reverse, footprint: mounting === "tht" ? "Diode_THT:D_DO-41_SOD81_P10.16mm_Horizontal" : "Diode_SMD:D_SMA", symbol: defineSymbol({ id: "D2", ref: "D", left: [{ num: "2", name: "A" }], right: [{ num: "1", name: "K" }] }),
    pins: [{ num: "2", net: "DC_IN", fn: "A" }, { num: "1", net: supply, fn: "K" }], added: "reverse-polarity protection (series Schottky)" });
  const elec = (value, net, big) => ({ ref: newRef("C"), kind: "capacitor", value, footprint: mounting === "tht" ? (big ? "Capacitor_THT:CP_Radial_D6.3mm_P2.50mm" : "Capacitor_THT:CP_Radial_D5.0mm_P2.00mm") : (big ? "Capacitor_SMD:CP_Elec_6.3x5.4" : "Capacitor_SMD:CP_Elec_5x5.4"),
    symbol: defineSymbol({ id: "cap_pol", ref: "C", left: [{ num: "1", name: "+" }], right: [{ num: "2", name: "-" }] }), pins: [{ num: "1", net, fn: "+" }, { num: "2", net: "GND", fn: "-" }] });
  add({ ...elec(parts.bulk, supply, true), added: "bulk capacitor at the power entry (CP-02)" });
  if (st.vref) {
    const res = (value, a, b) => ({ ref: newRef("R"), kind: "resistor", value, footprint: resolve("resistor", undefined, mounting).footprint, symbol: two("resistor2", "R", "1", "2"), pins: [{ num: "1", net: a }, { num: "2", net: b }] });
    add({ ...res(parts.vrefTop, supply, "VREF"), added: "VREF divider, upper resistor (PG-03)" });
    add({ ...res(parts.vrefBottom, "VREF", "GND"), added: "VREF divider, lower resistor (PG-03)" });
    add({ ...elec(parts.vrefCap, "VREF", false), pins: [{ num: "1", net: "VREF", fn: "+" }, { num: "2", net: "GND", fn: "-" }], added: "VREF decoupling capacitor (PG-03)" });
  }

  // Status LED: lit by the third pole of the footswitch; with no footswitch it is a plain power LED
  const resFp = resolve("resistor", undefined, mounting).footprint;
  const ledA = "LED_A";
  add({ ref: newRef("R"), kind: "resistor", value: parts.ledResistor, footprint: resFp, symbol: two("resistor2", "R", "1", "2"), pins: [{ num: "1", net: supply }, { num: "2", net: ledA }], added: "status LED resistor (RT-08)" });
  const led = add({ ref: newRef("LED"), kind: "led", value: parts.led, footprint: hw.led.fp, symbol: defineSymbol({ id: "D2", ref: "D", left: [{ num: "2", name: "A" }], right: [{ num: "1", name: "K" }] }),
    pins: [{ num: hw.led.pins.A, net: ledA, fn: "A" }, { num: hw.led.pins.K, net: st.bypass ? "LED_K" : "GND", fn: "K" }], added: "status LED" });
  mech.push({ it: led, role: "led", hw: hw.led, dia: hw.led.dia, face: "top" });

  if (st.bypass) {
    // Pole p (column): pad 3p+1 = bypass lug, 3p+2 = common, 3p+3 = effect lug.
    const lugs = [["P1_BYP", "BYP"], ["P1_COM", "IN"], ["P1_FX", st.inNet], ["P2_BYP", "BYP"], ["P2_COM", "OUT"], ["P2_FX", st.outNet], ["P3_NC", null], ["P3_COM", "LED_K"], ["P3_FX", "GND"]];
    const sw = add({ ref: newRef("SW"), kind: "switch", value: "3PDT footswitch (true bypass)", footprint: hw.sw.fp,
      symbol: defineSymbol({ id: "sw_3pdt", ref: "SW", left: lugs.map(([name], i) => ({ num: String(i + 1), name })), right: [] }),
      pins: lugs.map(([name, net], i) => ({ num: String(i + 1), net, fn: name })), added: "footswitch with true-bypass wiring" });
    mech.push({ it: sw, role: "switch", hw: hw.sw, dia: hw.sw.dia, face: "top", lugs });
  }

  // Test points (IN, OUT, VREF, +V, GND)
  if (parts.testPoints) {
    const tpNets = [...new Set([st.bypass ? "IN" : st.inNet, st.bypass ? "OUT" : st.outNet, st.vref ? "VREF" : null, supply, "GND"].filter(Boolean))];
    for (const net of tpNets) add({ ref: newRef("TP"), kind: "testpoint", value: net, footprint: "Pedal:TP_THT_D2.0mm", symbol: defineSymbol({ id: "tp", ref: "TP", left: [{ num: "1", name: "TP" }], right: [] }), pins: [{ num: "1", net }], added: `test point on ${net}` });
  }
  st.mech = mech;
  return mech;
}

// ---- board frame ----

export function makeFrame({ Wi, Li }, { posts = true } = {}) {
  const c = PEDAL.edge_clear, w = R4(Wi - 2 * c), l = R4(Li - 2 * c);
  const Ln = (x1, y1, x2, y2) => ({ k: "l", a: [x1, y1, x2, y2].map(R4) });
  const Ar = (...a) => ({ k: "a", a: a.map(R4) });
  const out = [], keepouts = [];
  if (posts) {
    const r = PEDAL.post_dia / 2, t = Math.sqrt(r * r - c * c) - c, m = r * Math.SQRT1_2 - c;
    out.push(Ln(t, 0, w - t, 0), Ar(w - t, 0, w - m, m, w, t), Ln(w, t, w, l - t), Ar(w, l - t, w - m, l - m, w - t, l), Ln(w - t, l, t, l), Ar(t, l, m, l - m, 0, l - t), Ln(0, l - t, 0, t), Ar(0, t, m, m, t, 0));
    for (const [x, y] of [[-c, -c], [w + c, -c], [-c, l + c], [w + c, l + c]]) keepouts.push({ x: R4(x), y: R4(y), r: PEDAL.post_keep, kind: "post" });
  } else {
    const r = PEDAL.corner_radius, k = r * (1 - Math.SQRT1_2);
    out.push(Ln(r, 0, w - r, 0), Ar(w - r, 0, w - k, k, w, r), Ln(w, r, w, l - r), Ar(w, l - r, w - k, l - k, w - r, l), Ln(w - r, l, r, l), Ar(r, l, k, l - k, 0, l - r), Ln(0, l - r, 0, r), Ar(0, r, k, k, r, 0));
  }
  return { w, l, c, Wi, Li, outline: out, keepouts, posts };
}

// ---- placement of the mechanical parts, then the rest ----

const hit = (a, b, g = 0) => a[0] < b[2] + g && a[2] > b[0] - g && a[1] < b[3] + g && a[3] > b[1] - g;
const cyAt = (fpName, x, y, rot) => { const o = oriented(fpName, rot); return [x + o.cy[0], y + o.cy[1], x + o.cy[2], y + o.cy[3]]; };
const STEP = 1.27;

/**
 * Places the panel hardware (locked) and then everything else inside the frame.
 * @returns {{layout?: object, errors: string[], deviations: string[], plan: object}}
 */
export function placePedal(st, items, placeParts, { gap } = {}) {
  const { input } = st;
  const fr = makeFrame(input, { posts: input.posts !== false });
  const errors = [], deviations = [];
  const fixed = [], rects = [];                 // rects: courtyards of the fixed parts, for collision tests
  const byRole = (role) => st.mech.filter((m) => m.role === role);
  const plan = { frame: fr, holes: [] };

  const inside = (box, loose = false) => loose || (box[0] >= 0.3 && box[1] >= 0.3 && box[2] <= fr.w - 0.3 && box[3] <= fr.l - 0.3);
  const clearPosts = (box) => !fr.keepouts.some((k) => distPtRect(k.x, k.y, { x0: box[0], y0: box[1], x1: box[2], y1: box[3] }) < k.r);
  const free = (box, loose = false) => inside(box, loose) && clearPosts(box) && !rects.some((r) => hit(box, r.box, PEDAL.gap));
  const put = (m, x, y, rot) => {
    const box = cyAt(m.it.footprint, x, y, rot);
    fixed.push({ it: m.it, x: R4(x), y: R4(y), rot, role: m.role });
    rects.push({ ref: m.it.ref, box });
    m.at = { x: R4(x), y: R4(y), rot };
    return box;
  };
  const origin = (m, p, rot) => { const h = rotPt(...m.hw.holeUsed, rot); return [p[0] - h[0], p[1] - h[1]]; };
  for (const m of st.mech) m.hw = { ...m.hw, holeUsed: holeOf(m.hw.fp, m.hw.hole) };

  // 1. DC jack at the top end, centred; 2. input/output jacks on the side walls
  const dc = byRole("dc_jack")[0], jin = byRole("jack_in")[0], jout = byRole("jack_out")[0];
  const wallRot = (m, dir) => rotFor(m.hw.facing, dir);
  const wallPut = (m, wallPoint, dir) => {
    const rot = wallRot(m, dir), o = origin(m, wallPoint, rot);
    const box = cyAt(m.it.footprint, o[0], o[1], rot);
    return { rot, o, box };
  };
  const c = fr.c;
  const d = wallPut(dc, [fr.w / 2, -c], [0, -1]);
  put(dc, d.o[0], d.o[1], d.rot);
  dc.hole = { face: "end_top", along: R4(fr.w / 2), wallPoint: [fr.w / 2, -c] };
  // Jacks: same distance from the top end on both walls (DP-04); if the two bodies meet in a narrow box the second is moved down and that is reported.
  const tryJack = (m, x, dir, y) => wallPut(m, [x, y], dir);
  const blocked = (box) => rects.some((r) => hit(box, r.box, PEDAL.gap));
  const lengthwise = (box) => box[1] >= 0.3 && box[3] <= fr.l - 0.3;
  let yj = PEDAL.side_jack_y;
  let a = tryJack(jin, -c, [-1, 0], yj);
  for (let n = 0; n < 200 && blocked(a.box); n++) { yj += STEP; a = tryJack(jin, -c, [-1, 0], yj); }
  put(jin, a.o[0], a.o[1], a.rot); jin.hole = { face: "side_left", along: R4(yj), wallPoint: [-c, yj] };
  // The output jack goes at the same height unless the two bodies meet (a narrow enclosure): then it moves down, and that is reported.
  let yo = yj, b = tryJack(jout, fr.w + c, [1, 0], yo);
  for (let n = 0; n < 200 && blocked(b.box); n++) { yo += STEP; b = tryJack(jout, fr.w + c, [1, 0], yo); }
  put(jout, b.o[0], b.o[1], b.rot); jout.hole = { face: "side_right", along: R4(yo), wallPoint: [fr.w + c, yo] };
  if (!lengthwise(a.box) || !lengthwise(b.box)) errors.push("The input/output jacks do not fit along the side walls of this enclosure (DP-04). Use a longer enclosure or a jack footprint of your own.");
  if (Math.abs(yo - yj) > 0.01) deviations.push(`DP-04: the enclosure is too narrow for both jacks at the same height; the output jack is ${R4(yo - yj)} mm lower than the input jack.`);
  if (yj + c < 8) deviations.push(`DP-04: the jack axis is ${R4(yj + c)} mm from the corner post (spec wants >= 8).`);

  // 3. Footswitch, then the LED above it
  const sw = byRole("switch")[0], led = byRole("led")[0];
  let swBox = null;
  if (sw) {
    const h = sw.hw.holeUsed, swc = [fr.w / 2, fr.l - PEDAL.fs_from_bottom * input.Li];
    const cy0 = FOOTPRINT_DATA[sw.it.footprint].cy;
    let sy = Math.min(swc[1], fr.l - 0.3 - cy0[3] - 2.0);
    let placed = false;
    for (let n = 0; n < 60 && !placed; n++, sy -= STEP) {
      const o = [swc[0] - h[0], sy - h[1]], box = cyAt(sw.it.footprint, o[0], o[1], 0);
      if (free(box)) { swBox = put(sw, o[0], o[1], 0); sw.hole = { face: "top", at: [R4(swc[0]), R4(sy)] }; placed = true; }
    }
    if (!placed) errors.push("The footswitch does not fit in this enclosure (DP-02). Use a longer enclosure.");
    else if (Math.abs(fr.l - sw.hole.at[1] - PEDAL.fs_from_bottom * input.Li) > 0.5) deviations.push(`DP-02: the footswitch is ${R4(fr.l - sw.hole.at[1] + c)} mm from the stomp end instead of about 30 % of the length, to clear other parts.`);
  }
  // LED on the centerline just above the switch (DP-03)
  let ledBox = null;
  if (led) {
    const h = led.hw.holeUsed, cy0 = FOOTPRINT_DATA[led.it.footprint].cy;
    const top = swBox ? swBox[1] : fr.l - 6;
    let ly = top - PEDAL.gap - 1.5 - (cy0[3] - h[1]);
    // DP-06: hole edge to hole edge >= 3 mm, or 5 mm when either hole is 10 mm or wider. Courtyards alone do not guarantee it.
    if (sw?.hole) { const sd = sw.dia ?? sw.hw?.dia ?? 0, ld = led.dia ?? led.hw?.dia ?? 0; ly = Math.min(ly, sw.hole.at[1] - (sd / 2 + ld / 2 + (sd >= 10 || ld >= 10 ? 5 : 3)) - 0.25); }
    let placed = false;
    for (let n = 0; n < 40 && !placed; n++, ly -= STEP) {
      const o = [fr.w / 2 - h[0], ly - h[1]], box = cyAt(led.it.footprint, o[0], o[1], 0);
      if (free(box)) { ledBox = put(led, o[0], o[1], 0); led.hole = { face: "top", at: [R4(fr.w / 2), R4(ly)] }; placed = true; }
    }
    if (!placed) errors.push("The status LED does not fit above the footswitch (DP-03).");
  }

  // 4. Pots in rows from the top, staggered, with the spec's pitch (DP-01)
  const pots = byRole("pot");
  const pitch = input.pitch;
  if (pots.length) {
    const sample = pots[0], hole0 = sample.hw.holeUsed, cy = FOOTPRINT_DATA[sample.it.footprint].cy;
    const left = hole0[0] - cy[0], right = cy[2] - hole0[0], up = hole0[1] - cy[1], down = cy[3] - hole0[1];
    const xmin = 0.3 + left, xmax = fr.w - 0.3 - right;
    const mid = fr.w / 2;
    const nr = Math.max(1, Math.min(3, Math.floor((Math.min(mid - xmin, xmax - mid) * 2) / pitch + 1e-6) + 1));
    const limit = (ledBox ?? swBox)?.[1] ?? fr.l;
    const placedShafts = [];
    let rowStart = 0.3 + up, remaining = pots.slice(), r = 0;
    const rowsNeeded = Math.ceil(pots.length / nr);
    while (remaining.length) {
      const k = Math.min(nr, Math.ceil(remaining.length / (rowsNeeded - r)));
      const row = remaining.splice(0, k);
      const xs = row.map((_, i) => mid + (i - (row.length - 1) / 2) * pitch);
      let y = rowStart, ok = false;
      for (; y + down <= limit - PEDAL.gap; y += STEP) {
        const boxes = xs.map((x) => cyAt(sample.it.footprint, x - hole0[0], y - hole0[1], 0));
        const apart = xs.every((x) => placedShafts.every((p) => Math.hypot(p[0] - x, p[1] - y) >= pitch - 1e-6));
        if (apart && boxes.every((bx) => free(bx))) { ok = true; break; }
      }
      if (!ok) { errors.push(`The ${pots.length} controls do not fit at ${R4(pitch)} mm pitch in this enclosure (DP-01). Use a larger enclosure or a smaller knob diameter.`); break; }
      row.forEach((m, i) => { put(m, xs[i] - hole0[0], y - hole0[1], 0); m.hole = { face: "top", at: [R4(xs[i]), R4(y)] }; placedShafts.push([xs[i], y]); });
      rowStart = y; r++;
    }
  }
  if (errors.length) return { errors, deviations, plan, frame: fr };

  // 5. Standoff holes (BO-03 standoffs): corners first, then along the long edges, wherever nothing else is
  const holes = [];
  if (input.mounting === "standoffs") {
    const hp = "MountingHole:MountingHole_3.2mm_M3";
    const cand = [[9, 9], [fr.w - 9, 9], [9, fr.l - 9], [fr.w - 9, fr.l - 9], [fr.w / 2, 9], [fr.w / 2, fr.l - 9]];
    for (const [x, y] of cand) {
      if (holes.length >= 4) break;
      const box = [x - PEDAL.standoff_keep / 2, y - PEDAL.standoff_keep / 2, x + PEDAL.standoff_keep / 2, y + PEDAL.standoff_keep / 2];
      if (free(box)) { holes.push([x, y]); rects.push({ ref: `H${holes.length}`, box }); }
    }
    if (holes.length < 2) errors.push("Standoff mounting needs at least two free spots for M3 holes (BO-03); there is no room. Use sandwich mounting or a larger enclosure.");
  }
  st.standoffs = holes;
  if (errors.length) return { errors, deviations, plan, frame: fr };

  // Everything else goes around the locked parts
  // Called again with a larger gap when routing needs more room: the hole items from the first call already have schematic symbols, so reuse them.
  const prior = items.filter((i) => i.kind === "hole");
  const hItems = holes.map(([x, y], i) => prior[i] ?? ({ ref: `H${i + 1}`, kind: "hole", value: "M3 standoff", footprint: "MountingHole:MountingHole_3.2mm_M3", symbol: "hole", pins: [], source: "pedal", mpn: "", added: "M3 standoff hole (BO-03)" }));
  const all = [...items.filter((i) => i.kind !== "hole"), ...hItems];
  hItems.forEach((hi, i) => fixed.push({ it: hi, x: holes[i][0], y: holes[i][1], rot: 0, role: "standoff" }));
  const layout = placeParts(all, { gap, fixed, bounds: { w: fr.w, l: fr.l }, keepouts: fr.keepouts, uniformPolar: true });
  layout.outline = fr.outline;
  layout.keepouts = fr.keepouts;
  layout.pedal = { frame: fr, mech: st.mech, holes };
  return { layout, errors: [], deviations, plan, frame: fr, extraItems: hItems.filter((h) => !prior.includes(h)) };
}
