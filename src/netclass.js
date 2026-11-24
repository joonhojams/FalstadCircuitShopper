// Net classes and routing parameters, taken from the pedal PCB spec (<params> and <net_classes>).
// Values the spec tags as typical rather than authoritative are marked [V] in the report.

export const PARAMS = {
  board_thickness: 1.6,
  grid_place_tht: 2.54, grid_place_fine: 1.27, grid_route: 0.635,
  copper_to_edge_min: 0.3, copper_to_edge_pref: 0.5,
  comp_to_edge_smt: 1.5, comp_to_edge_tht: 2.0,       // spec CP-10: SMT part and THT body to the board edge
  pour_clear: 0.3, thermal_spoke: 0.4, thermal_gap: 0.3,
  stitch_via_pitch: 12.5,
  audio_via_max_per_net: 2,
  hole_to_hole_min: 0.5, drill_to_trace_min: 0.25,
  pad_to_pad_min: 0.15,                // fine-pitch library pads (TSSOP 0.65) are closer than the class clearance
  mask_expansion: 0.05,
  noise_parallel_sep: 3, noise_parallel_len: 5,
};

// The spec's via numbers contradict each other: via_pref 0.8/0.4 mm leaves a 0.2 mm annular ring but
// annular_min is 0.30. The default honours the stricter ring (1.0 / 0.4 = 0.3) and is reported as a deviation.
export const VIA = { size: 1.0, drill: 0.4, min_size: 0.6, min_drill: 0.3, annular_min: 0.3, spec_pref: [0.8, 0.4] };

/** name -> {track, clearance}. Spec <net_classes>. */
export const NET_CLASSES = {
  AUDIO_SIG: { track: 0.35, clearance: 0.30 },
  HIGH_Z:    { track: 0.25, clearance: 0.40 },
  POWER:     { track: 0.60, clearance: 0.30 },
  GND:       { track: 0.50, clearance: 0.25 },
  BIAS_VREF: { track: 0.30, clearance: 0.30 },
  LED_CTRL:  { track: 0.30, clearance: 0.25 },
};

const isPower = (n, rails) => rails.has(n) || /^[+-]\d/.test(n) || /PROT/i.test(n) || /^DC_/i.test(n);

/**
 * Assigns every net to a class.
 * @param {{pins: {num: string, net: string|null, fn?: string}[]}[]} items  board items; pin.fn is the function name where known
 * @param {{net: string}[]} rails
 * @returns {Map<string, string>} net name -> class name
 */
export function classifyNets(items, rails = []) {
  const railSet = new Set(rails.map((r) => r.net));
  const highZ = new Set();
  for (const it of items) for (const p of it.pins) {
    // op-amp non-inverting input, transistor base, MOSFET gate
    if (p.net && ((it.kind === "opamp" && p.fn === "+") || (it.kind === "bjt" && p.fn === "B") || (it.kind === "mosfet" && p.fn === "G"))) highZ.add(p.net);
  }
  const out = new Map();
  for (const it of items) for (const p of it.pins) {
    const n = p.net;
    if (!n || out.has(n)) continue;
    out.set(n,
      n === "GND" || /^AGND|^DGND/.test(n) ? "GND"
      : isPower(n, railSet) ? "POWER"
      : /^LED/i.test(n) ? "LED_CTRL"
      : /^VREF|^VBIAS|^BIAS/i.test(n) ? "BIAS_VREF"
      : highZ.has(n) ? "HIGH_Z"
      : "AUDIO_SIG");
  }
  return out;
}

export const classOf = (classes, net) => NET_CLASSES[classes.get(net)] ?? NET_CLASSES.AUDIO_SIG;
