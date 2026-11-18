// Builds src/footprint-data.js: pad geometry, silkscreen/fab/courtyard graphics and 3D model
// references for every KiCad footprint this app can put on a board.
//
// Usage:  node scripts/gen-footprints.mjs <footprints-dir> [out-file]
//   <footprints-dir> holds the *.pretty folders, e.g. /usr/share/kicad/footprints (Linux) or
//   /Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints (macOS).
// Re-run it against your own KiCad 9 install to refresh the data; both the old (module ...) and
// the current (footprint ...) file formats are read.
//
// Footprints come from the KiCad libraries (CC-BY-SA 4.0 with an exception that lets them be
// embedded in a design without the design taking the license): https://www.kicad.org/libraries/license/

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSexp, kid, kids } from "./sexp.mjs";

const CHIP = ["0201_0603Metric", "0402_1005Metric", "0603_1608Metric", "0805_2012Metric", "1206_3216Metric", "1210_3225Metric", "1812_4532Metric", "2010_5025Metric", "2512_6332Metric"];
export const WANTED = [
  ...CHIP.flatMap((c) => [`Resistor_SMD:R_${c}`, `Capacitor_SMD:C_${c}`, `Inductor_SMD:L_${c}`, `LED_SMD:LED_${c}`]),
  ...Array.from({ length: 11 }, (_, i) => `Connector_PinHeader_2.54mm:PinHeader_1x${String(i + 2).padStart(2, "0")}_P2.54mm_Vertical`),
  "Button_Switch_THT:SW_PUSH_6mm",
  "Capacitor_THT:CP_Radial_D5.0mm_P2.00mm", "Capacitor_THT:C_Disc_D5.0mm_W2.5mm_P5.00mm", "Capacitor_THT:C_Rect_L7.2mm_W2.5mm_P5.00mm_FKS2_FKP2_MKS2_MKP2",
  "Diode_SMD:D_SMA", "Diode_SMD:D_SMB", "Diode_SMD:D_SOD-123", "Diode_SMD:D_SOD-323",
  "Diode_THT:D_DO-35_SOD27_P7.62mm_Horizontal", "Diode_THT:D_DO-41_SOD81_P10.16mm_Horizontal",
  "Inductor_THT:L_Axial_L5.3mm_D2.2mm_P10.16mm_Horizontal_Vishay_IM-1",
  "LED_THT:LED_D3.0mm", "LED_THT:LED_D5.0mm",
  "Package_DIP:DIP-14_W7.62mm", "Package_DIP:DIP-8_W7.62mm",
  "Package_SO:MSOP-8_3x3mm_P0.65mm", "Package_SO:SOIC-14_3.9x8.7mm_P1.27mm", "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm",
  "Package_SO:TSSOP-14_4.4x5mm_P0.65mm", "Package_SO:TSSOP-8_4.4x3mm_P0.65mm",
  "Package_TO_SOT_SMD:SOT-223-3_TabPin2", "Package_TO_SOT_SMD:SOT-23", "Package_TO_SOT_SMD:TO-252-2",
  "Package_TO_SOT_THT:TO-220-3_Vertical", "Package_TO_SOT_THT:TO-92_Inline",
  "Potentiometer_SMD:Potentiometer_Bourns_TC33X_Vertical", "Potentiometer_THT:Potentiometer_Alps_RK09K_Single_Vertical",
  "Potentiometer_THT:Potentiometer_Bourns_3296P_Horizontal", "Potentiometer_THT:Potentiometer_Bourns_3296W_Vertical",
  "Potentiometer_THT:Potentiometer_Bourns_3296Y_Vertical", "Potentiometer_THT:Potentiometer_Bourns_3386P_Vertical",
  "Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal",
  "TerminalBlock:TerminalBlock_bornier-3_P5.08mm",
];

const KEEP = new Set(["F.SilkS", "F.Fab", "F.CrtYd"]);
const num = (v) => Math.round(Number(v) * 10000) / 10000;
const xy = (n) => [num(n[1]), num(n[2])];
const rot = (p, c, deg) => {
  const a = (deg * Math.PI) / 180, dx = p[0] - c[0], dy = p[1] - c[1];
  return [num(c[0] + dx * Math.cos(a) - dy * Math.sin(a)), num(c[1] + dx * Math.sin(a) + dy * Math.cos(a))];
};
const widthOf = (n) => num(kid(n, "width")?.[1] ?? kid(kid(n, "stroke") ?? [], "width")?.[1] ?? 0.12);

export function readFootprint(text) {
  const root = parseSexp(text);
  const legacy = root[0] === "module";
  const pads = [], g = [];
  for (const n of kids(root, "pad")) {
    const at = kid(n, "at"), size = kid(n, "size"), drill = kid(n, "drill"), layers = kid(n, "layers"), rr = kid(n, "roundrect_rratio");
    const shape = n[3] === "custom" ? "rect" : n[3];
    const p = { n: String(n[1]), t: n[2], s: shape, x: num(at[1]), y: num(at[2]), w: num(size[1]), h: num(size[2]), l: layers ? layers.slice(1) : [] };
    if (at[3] && Number(at[3])) p.r = num(at[3]);
    if (drill) {
      if (drill[1] === "oval") p.d = [num(drill[2]), num(drill[3])];
      else if (drill[1] && !Array.isArray(drill[1])) p.d = num(drill[1]);
    }
    if (rr) p.rr = num(rr[1]);
    pads.push(p);
  }
  for (const n of kids(root, "fp_line")) {
    const l = kid(n, "layer")?.[1];
    if (KEEP.has(l)) g.push({ k: "l", a: [...xy(kid(n, "start")), ...xy(kid(n, "end"))], l, w: widthOf(n) });
  }
  for (const n of kids(root, "fp_circle")) {
    const l = kid(n, "layer")?.[1];
    if (KEEP.has(l)) g.push({ k: "c", a: [...xy(kid(n, "center")), ...xy(kid(n, "end"))], l, w: widthOf(n) });
  }
  for (const n of kids(root, "fp_arc")) {
    const l = kid(n, "layer")?.[1];
    if (!KEEP.has(l)) continue;
    if (kid(n, "mid")) g.push({ k: "a", a: [...xy(kid(n, "start")), ...xy(kid(n, "mid")), ...xy(kid(n, "end"))], l, w: widthOf(n) });
    else {                       // old format: start = centre, end = first point, angle sweeps from there
      const c = xy(kid(n, "start")), s = xy(kid(n, "end")), a = Number(kid(n, "angle")[1]);
      g.push({ k: "a", a: [...s, ...rot(s, c, a / 2), ...rot(s, c, a)], l, w: widthOf(n) });
    }
  }
  // Courtyard box (falls back to the pads plus a margin).
  const pts = [];
  for (const e of g.filter((e) => e.l === "F.CrtYd")) {
    if (e.k === "c") { const r = Math.hypot(e.a[2] - e.a[0], e.a[3] - e.a[1]); pts.push([e.a[0] - r, e.a[1] - r], [e.a[0] + r, e.a[1] + r]); }
    else for (let i = 0; i < e.a.length; i += 2) pts.push([e.a[i], e.a[i + 1]]);
  }
  if (!pts.length) for (const p of pads) pts.push([p.x - p.w / 2 - 0.25, p.y - p.h / 2 - 0.25], [p.x + p.w / 2 + 0.25, p.y + p.h / 2 + 0.25]);
  const cy = [num(Math.min(...pts.map((p) => p[0]))), num(Math.min(...pts.map((p) => p[1]))), num(Math.max(...pts.map((p) => p[0]))), num(Math.max(...pts.map((p) => p[1])))];

  const attr = kid(root, "attr")?.slice(1).includes("smd") ? "smd" : pads.some((p) => p.t === "thru_hole") ? "through_hole" : "smd";
  const out = { attr, pads, g, cy };
  const m = kid(root, "model");
  if (m) {
    const rel = String(m[1]).replace(/^\$\{[^}]+\}\//, "").replace(/\.(wrl|step|stp)$/i, "");
    const off = kid(m, "offset") ?? kid(m, "at"), sc = kid(m, "scale"), ro = kid(m, "rotate");
    const trip = (n, k = 1) => (kid(n ?? [], "xyz") ?? ["xyz", 0, 0, 0]).slice(1, 4).map((v) => num(Number(v) * k));
    out.model = { p: rel, o: trip(off, legacy && !kid(m, "offset") ? 25.4 : 1), s: sc ? trip(sc) : [1, 1, 1], r: trip(ro) };
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) { console.error("usage: node scripts/gen-footprints.mjs <footprints-dir> [out-file]"); process.exit(2); }
  const out = process.argv[3] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "src", "footprint-data.js");
  const data = {}, missing = [];
  for (const id of WANTED) {
    const [lib, name] = id.split(":");
    const file = join(dir, `${lib}.pretty`, `${name}.kicad_mod`);
    if (!existsSync(file)) { missing.push(id); continue; }
    data[id] = readFootprint(readFileSync(file, "utf8"));
  }
  const body = Object.entries(data).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`).join("\n");
  writeFileSync(out, `// Generated by scripts/gen-footprints.mjs from the KiCad footprint libraries. Do not edit by hand.
// Libraries are CC-BY-SA 4.0 with an exception for embedding footprints in a design.
// pad: n number, t type, s shape, x/y centre, r rotation, w/h size, d drill, l layers, rr round-rect ratio.
// g: l = line, c = circle (centre + point on it), a = arc (start, mid, end); cy: courtyard box.
export const FOOTPRINT_DATA = {
${body}
};
`);
  console.log(`${Object.keys(data).length} footprints written to ${out}`);
  if (missing.length) console.log(`Not found (${missing.length}):\n  ${missing.join("\n  ")}`);
}
