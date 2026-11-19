// Design rules from the guitar-pedal PCB spec (pedal_pcb_spec_for_model.md, params block), the net
// classes derived from them, and the KiCad project/rule files that carry them.
//
// Every number tagged [V] in the spec is "typical, not authoritative". They are used as defaults and
// listed in the report's assumptions. Nothing here was checked against a KiCad install; the
// .kicad_pro keys and .kicad_dru syntax follow KiCad 9 as best known and are listed as unverified.

export const PARAMS = Object.freeze({
  board_thickness: 1.6, copper_oz: 1,
  grid_place_tht: 2.54, grid_place_fine: 1.27, grid_route: 0.635,
  encl_edge_clear_min: 1.0, corner_post_keepout_dia: 8, board_corner_radius_min: 1.0,
  copper_to_edge_min: 0.3, comp_to_edge_smt: 1.5, comp_to_edge_tht: 2.0, height_margin: 0.5,
  track_audio: 0.35, clear_audio: 0.30, track_highz: 0.25, clear_highz: 0.40,
  track_power: 0.6, clear_power: 0.30, track_gnd: 0.5, clear_gnd: 0.25,
  track_vref: 0.30, clear_vref: 0.30, track_led: 0.30, clear_led: 0.25,
  via_pref: [0.8, 0.4], via_min: [0.6, 0.3], annular_min: 0.30,
  hole_to_hole_min: 0.5, drill_to_trace_min: 0.25, pour_clear: 0.30, pour_finger_min: 1.0,
  stitch_via_pitch: [10, 15], audio_via_max_per_net: 2, thermal_spoke: 0.4, thermal_gap: 0.3,
  mask_expansion: 0.05, silk_line_min: 0.15, silk_text_h_min: 1.0,
  io_separation_min: 15, noise_parallel_sep: 3, noise_parallel_len: 5, chargepump_sep_from_input: 20,
});

/** Grid used for routing when the spec's 0.635 mm grid does not fit the pads of a surface-mount board. */
export const SMD_ROUTE_GRID = 0.25;

const CLASS_DEFS = {
  AUDIO_SIG: ["track_audio", "clear_audio"],
  HIGH_Z: ["track_highz", "clear_highz"],
  POWER: ["track_power", "clear_power"],
  GND: ["track_gnd", "clear_gnd"],
  BIAS_VREF: ["track_vref", "clear_vref"],
  LED_CTRL: ["track_led", "clear_led"],
};

/**
 * @param {{mounting: "smd"|"tht", fab?: {house?: string, minTrace?: number, minClear?: number}}} o
 * @returns the effective rules plus the assumptions and deviations that produced them
 */
export function buildRules({ mounting, fab } = {}) {
  const assumptions = [], deviations = [];
  const f = { house: fab?.house || "unspecified", minTrace: fab?.minTrace, minClear: fab?.minClear };
  if (!(f.minTrace > 0) || !(f.minClear > 0)) {
    f.minTrace = 0.2; f.minClear = 0.2;
    assumptions.push("Fab limits not given: assuming 0.2 mm minimum trace and clearance [V]. Enter your fab's real minimums; values below are intersected with them.");
  }
  const classes = {};
  for (const [name, [t, c]] of Object.entries(CLASS_DEFS)) {
    classes[name] = { track: Math.max(PARAMS[t], f.minTrace), clear: Math.max(PARAMS[c], f.minClear) };
    if (classes[name].track > PARAMS[t]) deviations.push(`${name} track widened from ${PARAMS[t]} to ${classes[name].track} mm to meet the fab minimum.`);
    if (classes[name].clear > PARAMS[c]) deviations.push(`${name} clearance widened from ${PARAMS[c]} to ${classes[name].clear} mm to meet the fab minimum.`);
  }
  classes.Default = { ...classes.AUDIO_SIG };

  // The spec's preferred via (0.8 / 0.4) leaves a 0.20 mm annular ring, below its own annular_min of 0.30,
  // so the constraint wins and the pad grows.
  const drill = PARAMS.via_pref[1];
  const pad = Math.max(PARAMS.via_pref[0], drill + 2 * PARAMS.annular_min);
  const via = { pad: Math.round(pad * 1000) / 1000, drill };
  if (via.pad !== PARAMS.via_pref[0]) {
    deviations.push(`Via pad ${via.pad} mm (drill ${drill}) instead of via_pref ${PARAMS.via_pref[0]}/${drill}: that pair gives a ${((PARAMS.via_pref[0] - drill) / 2).toFixed(2)} mm annular ring, below annular_min ${PARAMS.annular_min} mm (the spec contradicts itself; the constraint wins).`);
  }
  const grid = {
    place: mounting === "tht" ? PARAMS.grid_place_tht : 0.5,
    fine: mounting === "tht" ? PARAMS.grid_place_fine : 0.5,
    route: mounting === "tht" ? PARAMS.grid_route : SMD_ROUTE_GRID,
  };
  if (mounting !== "tht") deviations.push(`Routing grid ${SMD_ROUTE_GRID} mm on a surface-mount board (spec grid_route ${PARAMS.grid_route}): SMD pads do not sit on a 0.635 mm grid. Placement grid 0.5 mm.`);
  return { params: PARAMS, classes, via, grid, fab: f, mounting, assumptions, deviations };
}

// ---------- net classification ----------

const isGround = (n) => /^(A|D)?GND$/i.test(n);
const KIND = { resistor: "R", capacitor: "C", decoupling: "C", inductor: "L", diode: "D", zener: "D", led: "led", bjt: "Q", mosfet: "Q", pot: "pot", switch: "switch", opamp: "U", gate: "U", timer: "U", header: "J" };
const refKind = (it) => KIND[it.kind] ?? (/^RV/.test(it.ref) ? "pot" : /^SW/.test(it.ref) ? "switch" : /^LED/.test(it.ref) ? "led" : /^([A-Z]+)/.exec(it.ref)?.[1] ?? "?");

/**
 * Which net class each net belongs to.
 * Precedence: GND, POWER, BIAS_VREF, LED_CTRL, HIGH_Z, then AUDIO_SIG for everything else.
 * @param {{ref: string, pins: {num: string, net: string|null, fn?: string}[]}[]} items
 * @param {string[]} rails names of the supply nets
 * @returns {{byNet: Map<string, string>, why: Map<string, string>, assumptions: string[]}}
 */
export function classifyNets(items, rails) {
  const railSet = new Set(rails);
  const nets = new Map();                                          // net -> [{ref, kind, fn, other}]
  for (const it of items) {
    const kind = refKind(it);
    for (const p of it.pins) if (p.net) (nets.get(p.net) ?? nets.set(p.net, []).get(p.net)).push({ ref: it.ref, kind, fn: p.fn, num: p.num, item: it });
  }
  const otherEnd = (m) => (m.item.pins.length === 2 ? m.item.pins.find((p) => p.num !== m.num)?.net : null);
  const byNet = new Map(), why = new Map();
  const set = (net, cls, reason) => { byNet.set(net, cls); why.set(net, reason); };
  for (const [net, pins] of nets) {
    if (isGround(net)) { set(net, "GND", "ground"); continue; }
    if (railSet.has(net)) { set(net, "POWER", "supply rail"); continue; }
    // A divider midpoint with a capacitor to ground, away from any transistor base/gate, is a bias reference.
    const res = pins.filter((m) => m.kind === "R"), caps = pins.filter((m) => m.kind === "C");
    const divider = res.some((m) => railSet.has(otherEnd(m))) && res.some((m) => isGround(otherEnd(m) ?? "")) && caps.some((m) => isGround(otherEnd(m) ?? ""));
    if (/^VREF/i.test(net) || (divider && !pins.some((m) => m.fn === "B" || m.fn === "G"))) { set(net, "BIAS_VREF", /^VREF/i.test(net) ? "named VREF" : "divider midpoint with a capacitor to ground"); continue; }
    if (pins.some((m) => m.kind === "led")) { set(net, "LED_CTRL", "LED pin"); continue; }
    if (pins.some((m) => (m.kind === "U" && m.fn === "+") || (m.kind === "Q" && (m.fn === "B" || m.fn === "G")))) { set(net, "HIGH_Z", "op-amp + input, transistor base or gate"); continue; }
    set(net, "AUDIO_SIG", "signal");
  }
  return { byNet, why, assumptions: [
    "Net classes are guessed from connectivity: supply rails and GND by name, a resistor divider with a capacitor to ground as BIAS_VREF, LED pins as LED_CTRL, op-amp + inputs and transistor bases/gates as HIGH_Z, everything else as AUDIO_SIG. Check the class table in the report.",
  ] };
}

// ---------- KiCad files ----------

const n3 = (v) => Math.round(v * 1000) / 1000;

/** .kicad_pro: units, net classes with their widths, pattern-based net assignment, global minimums. */
export function proFile(name, rules, byNet) {
  const c = rules.classes;
  const cls = (nm) => ({
    name: nm, track_width: c[nm].track, clearance: c[nm].clear, via_diameter: rules.via.pad, via_drill: rules.via.drill,
    wire_width: 6, bus_width: 12, line_style: 0, diff_pair_width: 0.2, diff_pair_gap: 0.25, diff_pair_via_gap: 0.25,
    microvia_diameter: 0.3, microvia_drill: 0.1, pcb_color: "rgba(0, 0, 0, 0.000)", schematic_color: "rgba(0, 0, 0, 0.000)", priority: nm === "Default" ? 2147483647 : 0,
  });
  const names = ["Default", ...Object.keys(c).filter((k) => k !== "Default")];
  const widths = [...new Set(Object.values(c).map((x) => x.track))].sort((a, b) => a - b);
  return JSON.stringify({
    board: {
      design_settings: {
        defaults: { board_outline_line_width: 0.05, copper_line_width: 0.2, silk_line_width: PARAMS.silk_line_min, silk_text_size_h: 1.2, silk_text_size_v: 1.2, silk_text_thickness: 0.15, other_line_width: 0.1 },
        rules: {
          min_clearance: rules.fab.minClear, min_track_width: rules.fab.minTrace, min_via_annular_width: PARAMS.annular_min,
          min_via_diameter: PARAMS.via_min[0], min_through_hole_diameter: PARAMS.via_min[1], min_copper_edge_clearance: PARAMS.copper_to_edge_min,
          min_hole_clearance: PARAMS.drill_to_trace_min, min_hole_to_hole: PARAMS.hole_to_hole_min, min_silk_clearance: 0, min_text_height: PARAMS.silk_text_h_min,
          solder_mask_to_copper_clearance: 0,
        },
        track_widths: [0, ...widths],
        via_dimensions: [{ diameter: 0, drill: 0 }, { diameter: rules.via.pad, drill: rules.via.drill }],
      },
    },
    meta: { filename: `${name}.kicad_pro`, version: 3 },
    net_settings: {
      classes: names.map(cls),
      meta: { version: 3 },
      net_colors: null,
      netclass_assignments: null,
      netclass_patterns: [...byNet].filter(([, k]) => k !== "AUDIO_SIG").map(([net, k]) => ({ netclass: k, pattern: `/${net}` })),
    },
    schematic: { drawing: { default_line_thickness: 6 } },
  }, null, 2) + "\n";
}

/** .kicad_dru: custom DRC rules that the net classes alone cannot express. */
export function druFile(rules) {
  const mm = (v) => `${n3(v)}mm`;
  return `(version 1)
(rule "highz_clearance" (condition "A.NetClass == 'HIGH_Z' || B.NetClass == 'HIGH_Z'") (constraint clearance (min ${mm(rules.classes.HIGH_Z.clear)})))
(rule "copper_to_edge" (constraint edge_clearance (min ${mm(PARAMS.copper_to_edge_min)})))
(rule "hole_to_hole" (constraint hole_to_hole (min ${mm(PARAMS.hole_to_hole_min)})))
(rule "drill_to_trace" (constraint hole_clearance (min ${mm(PARAMS.drill_to_trace_min)})))
(rule "via_annular" (condition "A.Type == 'Via'") (constraint annular_width (min ${mm(PARAMS.annular_min)})))
(rule "silk_height" (constraint text_height (min ${mm(PARAMS.silk_text_h_min)})))
`;
}
