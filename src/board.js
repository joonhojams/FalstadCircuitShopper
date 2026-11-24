// Approximate 3D board preview: a body size for each KiCad footprint name, packed onto a board
// outline. This is an illustration to sanity-check size and part mix, not the real layout. Place and
// route in KiCad (Update PCB from Schematic).
//
// Sizes are millimetres: w = x extent, l = y extent, h = height above the board. shape "cyl" is a
// vertical cylinder (w is the diameter).

const SMALL = { w: 2, l: 1.25, h: 0.6 };

/** Body size for a footprint name such as "Resistor_SMD:R_0805_2012Metric". */
export function bodyFor(footprint, ref = "") {
  const fp = String(footprint);
  const name = fp.split(":").pop();
  let m;

  if ((m = /_(\d{2})(\d{2})Metric/.exec(name))) {
    const l = Number(m[1]) / 10, w = Number(m[2]) / 10;
    const kind = /^LED_/.test(fp) ? "led" : /^Capacitor_/.test(fp) ? "cap" : /^Inductor_/.test(fp) ? "ind" : "res";
    return { w: l, l: w, h: Math.max(0.35, w * 0.45), kind, smd: true };
  }
  if (/^Resistor_THT/.test(fp)) return { w: Number(/_L([\d.]+)mm/.exec(name)?.[1] ?? 6.3), l: Number(/_D([\d.]+)mm/.exec(name)?.[1] ?? 2.5), h: 2.5, kind: "res", pitch: Number(/_P([\d.]+)mm/.exec(name)?.[1] ?? 10.16) };
  if (/^Inductor_THT/.test(fp)) return { w: 5.3, l: 2.2, h: 2.4, kind: "ind", pitch: 10.16 };
  if (/^Capacitor_THT:CP_Radial/.test(fp)) { const d = Number(/_D([\d.]+)mm/.exec(name)?.[1] ?? 5); return { w: d, l: d, h: d * 2.2, shape: "cyl", kind: "elec", pitch: Number(/_P([\d.]+)mm/.exec(name)?.[1] ?? 2) }; }
  if (/^Capacitor_THT:C_Rect/.test(fp)) return { w: 7.2, l: 2.5, h: 6, kind: "film", pitch: 5 };
  if (/^Capacitor_THT/.test(fp)) return { w: 5, l: 2.5, h: 5, kind: "cap", pitch: 5 };
  if (/^LED_THT/.test(fp)) { const d = Number(/_D([\d.]+)mm/.exec(name)?.[1] ?? 5); return { w: d, l: d, h: d + 3.6, shape: "cyl", kind: "led", pitch: 2.54 }; }

  if (/SOD-323/.test(name)) return { w: 1.7, l: 1.25, h: 0.9, kind: "diode", smd: true };
  if (/SOD-123/.test(name)) return { w: 2.7, l: 1.6, h: 1.1, kind: "diode", smd: true };
  if (/D_SMA/.test(name)) return { w: 4.3, l: 2.6, h: 2.1, kind: "diode", smd: true };
  if (/D_SMB/.test(name)) return { w: 4.6, l: 3.6, h: 2.1, kind: "diode", smd: true };
  if (/DO-41/.test(name)) return { w: 5.2, l: 2.7, h: 2.7, kind: "diode", pitch: 10.16 };
  if (/DO-35/.test(name)) return { w: 3.4, l: 1.7, h: 1.7, kind: "diode", pitch: 7.62 };

  if (/SOT-223/.test(name)) return { w: 6.5, l: 3.5, h: 1.7, kind: "tr", smd: true };
  if (/SOT-23/.test(name)) return { w: 2.9, l: 1.3, h: 1.1, kind: "tr", smd: true };
  if (/TO-252/.test(name)) return { w: 6.6, l: 6.1, h: 2.3, kind: "tr", smd: true };
  if (/TO-92/.test(name)) return { w: 4.8, l: 3.8, h: 4.6, kind: "tr", pitch: 2.54 };
  if (/TO-220/.test(name)) return { w: 10, l: 4.5, h: 15, kind: "tr", pitch: 2.54 };

  if ((m = /(?:^|[_-])(?:DIP|PDIP)-?(\d+)/.exec(name))) { const n = Number(m[1]); return { w: n * 1.27 + 1.3, l: 6.35, h: 4.6, kind: "ic" }; }
  if ((m = /SOIC-(\d+)/.exec(name))) { const n = Number(m[1]); return { w: n * 0.635 + 0.8, l: 3.9, h: 1.75, kind: "ic", smd: true }; }
  if ((m = /TSSOP-(\d+)_(\d\.?\d*)x(\d\.?\d*)mm/.exec(name))) return { w: Number(m[3]), l: Number(m[2]), h: 1.1, kind: "ic", smd: true };
  if ((m = /MSOP-(\d+)_(\d\.?\d*)x(\d\.?\d*)mm/.exec(name))) return { w: Number(m[3]), l: Number(m[2]), h: 1.1, kind: "ic", smd: true };

  if (/SW_PUSH_6mm/.test(name)) return { w: 6.2, l: 6.2, h: 5, kind: "sw" };
  if (/^Connector_PinHeader/.test(fp) && (m = /1x(\d+)/.exec(name))) {
    const n = Number(m[1]);
    return /^J/.test(ref) ? { w: 2.54, l: 2.54 * n, h: 8.5, kind: "conn" } : { w: 2.54 * n, l: 2.54, h: 8.5, kind: "pot" };
  }
  if (/TerminalBlock/.test(name)) return { w: 15.24, l: 7.3, h: 10, kind: "conn" };
  if (/Potentiometer_Bourns_TC33X/.test(name)) return { w: 3.8, l: 3.6, h: 2.2, kind: "pot", smd: true };
  if (/Potentiometer_Bourns_3296/.test(name)) return { w: 9.5, l: 4.8, h: 10, kind: "pot" };
  if (/Potentiometer_Alps_RK09K/.test(name)) return { w: 12, l: 10, h: 15, kind: "pot" };
  // Pedal hardware and power-entry capacitors. Heights are typical values (spec tag [V]), not datasheet numbers.
  if (/^Connector_Audio/.test(fp)) return { w: 20.6, l: 18.2, h: 11, kind: "conn" };
  if (/^Connector_BarrelJack/.test(fp)) return { w: 14.5, l: 9, h: 11, kind: "conn" };
  if (/Potentiometer_Alpha_RD901F/.test(name)) return { w: 11.35, l: 9.5, h: 10, kind: "pot" };
  if (/^MountingHole/.test(fp)) return { w: 3.2, l: 3.2, h: 0.1, kind: "other" };
  if (/^Pedal:WirePads/.test(fp)) return { w: 18, l: 18, h: 0.5, kind: "conn" };       // the switch itself hangs from the lid; only wires reach the board
  if (/^Pedal:TP_/.test(fp)) return { w: 2, l: 2, h: 0.5, kind: "other" };
  if ((m = /^CP_Elec_([\d.]+)x([\d.]+)/.exec(name))) return { w: Number(m[1]) + 0.3, l: Number(m[1]) + 0.3, h: Number(m[2]), kind: "elec", smd: true };
  return { ...SMALL, kind: "other", smd: true };
}

const GAP = 2.5, MARGIN = 3;

/**
 * Packs parts into rows on a rectangular board.
 * @param {{ref: string, value?: string, footprint: string}[]} parts
 */
export function layoutBoard(parts) {
  const bodies = parts.map((p) => ({ ref: p.ref, value: p.value ?? "", footprint: p.footprint, ...bodyFor(p.footprint, p.ref) }));
  // Taller parts first so rows are even; keep J1 (power connector) at the start so it sits on the left edge.
  const order = bodies.map((b, i) => [b, i]).sort(([a, i], [b, j]) => (b.ref === "J1") - (a.ref === "J1") || (b.w * b.l - a.w * a.l) || i - j).map(([b]) => b);
  const area = order.reduce((s, b) => s + (b.w + GAP) * (b.l + GAP), 0);
  const maxW = Math.max(30, Math.sqrt(area * 1.6), ...order.map((b) => b.w + 2 * MARGIN));

  let x = MARGIN, y = MARGIN, rowH = 0, usedW = 0;
  const placed = [];
  for (const b of order) {
    if (x > MARGIN && x + b.w + MARGIN > maxW) { x = MARGIN; y += rowH + GAP; rowH = 0; }
    placed.push({ ...b, x: Math.round((x + b.w / 2) * 100) / 100, y: Math.round((y + b.l / 2) * 100) / 100 });
    x += b.w + GAP; rowH = Math.max(rowH, b.l); usedW = Math.max(usedW, x - GAP);
  }
  const w = Math.max(20, Math.ceil(usedW + MARGIN)), l = Math.max(20, Math.ceil(y + rowH + MARGIN));
  return { w, l, thickness: 1.6, parts: placed };
}
