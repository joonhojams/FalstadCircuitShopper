// Pedal-mode outputs derived from the placed (and routed) board: drill plan, mechanical overlay, wiring guide, machine-readable
// netlist and placement, the project footprint library, silkscreen labels, and the spec's checks (M1-M5, E3-E6, A1, CP-04, D3).
// Spec: pedal_pcb_spec_for_model.md (deliverables D-1, D-3, D-4, D-5, D-6, D-7 and <checks>).
//
// Coordinates: the PCB file is y down from the board's top-left. The drill plan, placement.json and the overlay use the spec's
// convention (CS-01): origin at the lower-left corner, +x right, +y up. In the plan the origin is the lower-left INSIDE corner of the
// enclosure; the PCB sits one board-edge clearance (PEDAL.edge_clear) in from it on every side (the single PCB <-> enclosure offset, PL-01).

import { PEDAL, PEDAL_FOOTPRINTS, HW_STACK as HS, modText } from "./pedal.js";
import { FOOTPRINT_DATA } from "./footprint-data.js";
import { bodyFor } from "./board.js";
import { PARAMS, NET_CLASSES } from "./netclass.js";
import { rotPt } from "./pcb.js";
import { distPtRect } from "./geom.js";

const R2 = (v) => Math.round(v * 100) / 100;
const R4 = (v) => Math.round(v * 10000) / 10000;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const DP = { wall: 3, hole: 3, hole_big: 5, boss: 3, corner_center: 8 };   // spec <params>: hole_edge_to_wall_min, hole_edge_to_hole_edge_min, hole_edge_to_boss_min, DP-04
const POST_CENTER = (Wi, Li) => [[0, 0], [Wi, 0], [0, Li], [Wi, Li]];
const table = (head, rows) => [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map((c) => String(c).replace(/\|/g, "/")).join(" | ")} |`)].join("\n");

// ---------------- silkscreen labels (spec S8, SS-01..SS-05) ----------------

const textBox = (text, size, x, y) => { const w = text.length * size * 0.8 + 0.4, h = size * 1.4; return [x - w / 2, y - h / 2, x + w / 2, y + h / 2]; };
const overlap = (a, b, g = 0.2) => a[0] < b[2] + g && a[2] > b[0] - g && a[1] < b[3] + g && a[3] > b[1] - g;

/**
 * Silkscreen text for the board. Every label goes in free space (clear of every courtyard and of the other labels), so no silk
 * lands on a pad (D2). A label that finds no room is dropped and listed in `dropped`.
 */
export function pedalSilk(st, plan, layout, { name = "circuit", rev = "A", date = null } = {}) {
  const size = 1.0;                                             // silk_text_h_min
  const keep = layout.parts.map((r) => r.box);
  const texts = [], dropped = [];
  const inside = (b) => b[0] >= 0.5 && b[1] >= 0.5 && b[2] <= layout.w - 0.5 && b[3] <= layout.l - 0.5;
  const free = (b) => inside(b) && !keep.some((k) => overlap(b, k, 0.15)) && !texts.some((t) => overlap(b, t.box, 0.15)) && !layout.keepouts?.some((k) => distPtRect(k.x, k.y, { x0: b[0], y0: b[1], x1: b[2], y1: b[3] }) < k.r);
  const put = (text, x, y, layer = "F.SilkS") => { const box = textBox(text, size, x, y); texts.push({ text, x: R2(x), y: R2(y), size, thickness: 0.15, layer, box }); };
  const near = (text, box, prefer = ["below", "above", "right", "left"]) => {
    const w = text.length * size * 0.8 + 0.4, h = size * 1.4;
    const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
    // Close to the part first; a part with a large courtyard (a jack) may need the label a few mm further out.
    for (const g of [0.4, 2, 4, 6]) {
      const at = { below: [cx, box[3] + g + h / 2], above: [cx, box[1] - g - h / 2], right: [box[2] + g + w / 2, cy], left: [box[0] - g - w / 2, cy] };
      for (const side of prefer) for (let s = 0; s <= 12; s++) {
        const [x, y] = at[side], slide = (s % 2 ? 1 : -1) * Math.ceil(s / 2) * 1.5;
        const dx = side === "below" || side === "above" ? slide : 0, dy = side === "left" || side === "right" ? slide : 0;
        if (free(textBox(text, size, x + dx, y + dy))) { put(text, x + dx, y + dy); return true; }
      }
    }
    dropped.push(text); return false;
  };
  const roleOf = (role) => st.mech.find((m) => m.role === role);
  const partBox = (it) => layout.parts.find((r) => r.it === it)?.box;

  // 3PDT lug labels go inside its (empty) courtyard: pole headings above the columns, lug names left of the rows.
  const sw = roleOf("switch");
  if (sw && sw.at) {
    const o = [sw.at.x, sw.at.y];
    for (const [i, t] of ["P1", "P2", "P3"].entries()) texts.push({ text: t, x: R2(o[0] + (i - 1) * 5.08), y: R2(o[1] - 6.2), size, thickness: 0.15, layer: "F.SilkS", box: textBox(t, size, o[0] + (i - 1) * 5.08, o[1] - 6.2) });
    for (const [j, t] of ["BYP", "COM", "FX"].entries()) texts.push({ text: t, x: R2(o[0] - 7.9), y: R2(o[1] + (j - 1) * 2.54), size, thickness: 0.15, layer: "F.SilkS", box: textBox(t, size, o[0] - 7.9, o[1] + (j - 1) * 2.54) });
  }
  const dc = roleOf("dc_jack");
  if (dc && partBox(dc.it)) near(`${st.input.supplyV ?? 9}V CENTER NEG`, partBox(dc.it), ["below", "right", "left"]);
  for (const [role, label] of [["jack_in", "IN"], ["jack_out", "OUT"]]) { const m = roleOf(role); if (m && partBox(m.it)) near(label, partBox(m.it), ["below", "above", "right", "left"]); }
  const tapers = st.input.tapers ?? {};
  for (const m of st.mech.filter((x) => x.role === "pot")) if (partBox(m.it)) near(String(tapers[m.it.ref] ?? st.input.taper ?? "B"), partBox(m.it), ["below", "above", "right", "left"]);
  // Test point names (SS-03: IN/OUT/GND wire pads)
  for (const r of layout.parts.filter((x) => x.it.kind === "testpoint")) near(String(r.it.value), r.box, ["below", "above", "right", "left"]);
  // Info block (SS-04). It goes on the front if there is a free strip, else on the back.
  const info = [`${name} REV ${rev}`, ...(date ? [date] : [])];
  for (const line of info) {
    let done = false;
    for (const layer of ["F.SilkS", "B.SilkS"]) {
      for (let y = layout.l - 1.5; y > 1 && !done; y -= 1.5) for (let x = 1 + (line.length * size * 0.8) / 2; x < layout.w - 1 && !done; x += 2) {
        const b = textBox(line, size, x, y);
        const clear = inside(b) && !texts.some((t) => t.layer === layer && overlap(b, t.box, 0.15)) && (layer === "B.SilkS" || free(b));
        if (clear) { put(line, x, y, layer); done = true; }
      }
      if (done) break;
    }
    if (!done) dropped.push(line);
  }
  return { texts: texts.map(({ box, ...t }) => t), dropped };
}

// ---------------- parts of the output ----------------

const pad2 = (n) => String(n).padStart(2, "0");
const sampleArc = (a, n = 8) => {
  const [x1, y1, x2, y2, x3, y3] = a, d = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2));
  if (Math.abs(d) < 1e-9) return [[x3, y3]];
  const ux = ((x1 * x1 + y1 * y1) * (y2 - y3) + (x2 * x2 + y2 * y2) * (y3 - y1) + (x3 * x3 + y3 * y3) * (y1 - y2)) / d;
  const uy = ((x1 * x1 + y1 * y1) * (x3 - x2) + (x2 * x2 + y2 * y2) * (x1 - x3) + (x3 * x3 + y3 * y3) * (x2 - x1)) / d;
  const r = Math.hypot(x1 - ux, y1 - uy);
  let a1 = Math.atan2(y1 - uy, x1 - ux), a2 = Math.atan2(y2 - uy, x2 - ux), a3 = Math.atan2(y3 - uy, x3 - ux);
  const cross = (x2 - x1) * (y3 - y2) - (y2 - y1) * (x3 - x2);          // which way the arc turns
  if (cross >= 0) { while (a2 < a1) a2 += 2 * Math.PI; while (a3 < a2) a3 += 2 * Math.PI; }
  else { while (a2 > a1) a2 -= 2 * Math.PI; while (a3 > a2) a3 -= 2 * Math.PI; }
  const out = [];
  for (let i = 1; i <= n; i++) { const t = a1 + ((a3 - a1) * i) / n; out.push([ux + r * Math.cos(t), uy + r * Math.sin(t)]); }
  return out;
};
const outlinePoly = (outline) => {
  const pts = [];
  for (const e of outline) { if (e.k === "l") { if (!pts.length) pts.push([e.a[0], e.a[1]]); pts.push([e.a[2], e.a[3]]); } else { if (!pts.length) pts.push([e.a[0], e.a[1]]); pts.push(...sampleArc(e.a)); } }
  return pts.map(([x, y]) => [R4(x), R4(y)]);
};
const arcPath = (a) => {                                       // SVG arc through three points
  const [x1, y1, x2, y2, x3, y3] = a, d = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2));
  if (Math.abs(d) < 1e-9) return `L ${R4(x3)} ${R4(y3)}`;
  const ux = ((x1 * x1 + y1 * y1) * (y2 - y3) + (x2 * x2 + y2 * y2) * (y3 - y1) + (x3 * x3 + y3 * y3) * (y1 - y2)) / d;
  const uy = ((x1 * x1 + y1 * y1) * (x3 - x2) + (x2 * x2 + y2 * y2) * (x1 - x3) + (x3 * x3 + y3 * y3) * (x2 - x1)) / d;
  const r = Math.hypot(x1 - ux, y1 - uy), cross = (x2 - x1) * (y3 - y2) - (y2 - y1) * (x3 - x2);
  return `A ${R4(r)} ${R4(r)} 0 0 ${cross > 0 ? 1 : 0} ${R4(x3)} ${R4(y3)}`;
};

const parseValue = (s) => {                                    // "100k", "4.7k", "10M", "470", "1R5" -> ohms; null if unreadable
  const m = /^\s*([\d.]+)\s*([kKmMrR]?)\s*(\d*)\s*(?:ohm|Ω)?\s*$/.exec(String(s));
  if (!m) return null;
  const mult = { "": 1, r: 1, R: 1, k: 1e3, K: 1e3, m: 1e6, M: 1e6 }[m[2]];
  return Number(m[3] ? `${m[1]}.${m[3]}` : m[1]) * mult;
};

/** Segments of the routed copper on one layer, with the net they belong to. */
const segmentsOf = (routing) => {
  const out = [];
  for (const t of routing?.tracks ?? []) for (let i = 0; i + 1 < t.pts.length; i++) out.push({ net: t.net, layer: t.layer, a: t.pts[i], b: t.pts[i + 1] });
  return out;
};
/** Length over which two nets run side by side closer than `sep`, in mm (check A1). */
export function parallelRun(segsA, segsB, sep) {
  let total = 0;
  for (const s of segsA) for (const t of segsB) {
    if (s.layer !== t.layer) continue;
    const ux = s.b[0] - s.a[0], uy = s.b[1] - s.a[1], ul = Math.hypot(ux, uy);
    const vx = t.b[0] - t.a[0], vy = t.b[1] - t.a[1], vl = Math.hypot(vx, vy);
    if (ul < 1e-6 || vl < 1e-6) continue;
    if (Math.abs(ux * vy - uy * vx) / (ul * vl) > Math.sin((15 * Math.PI) / 180)) continue;     // more than 15 degrees apart: crossing, not running along
    const ex = ux / ul, ey = uy / ul;
    const t0 = (t.a[0] - s.a[0]) * ex + (t.a[1] - s.a[1]) * ey, t1 = (t.b[0] - s.a[0]) * ex + (t.b[1] - s.a[1]) * ey;
    const lo = Math.max(0, Math.min(t0, t1)), hi = Math.min(ul, Math.max(t0, t1));
    if (hi <= lo) continue;
    const mid = (lo + hi) / 2, px = s.a[0] + ex * mid, py = s.a[1] + ey * mid;
    const tt = Math.max(0, Math.min(1, ((px - t.a[0]) * vx + (py - t.a[1]) * vy) / (vl * vl)));
    const d = Math.hypot(px - (t.a[0] + vx * tt), py - (t.a[1] + vy * tt));
    if (d < sep) total += hi - lo;
  }
  return total;
};


// ---------------- ground return (check A4) ----------------

/**
 * Spec A4 asks for a ground-return table. For every ground pad: how it reaches the ground copper. A through-hole pad sits in the pour
 * on both layers; an SMD pad needs a ground track or a via to it. `via` is the distance to the nearest ground via, which is the length
 * of the return path the current takes through the pour.
 */
export function groundReturn(layout, routing, pour) {
  if (!pour || !routing) return { rows: [], loose: [] };
  const vias = routing.vias.filter((v) => v.net === pour);
  const tracks = routing.tracks.filter((t) => t.net === pour);
  const rows = [], loose = [];
  for (const r of layout.parts) for (const p of r.pads) {
    if (p.net !== pour) continue;
    const tht = p.t === "thru_hole" || p.t === "np_thru_hole";
    const onTrack = tracks.some((t) => t.pts.some(([x, y]) => Math.hypot(x - p.x, y - p.y) < 0.05));
    let near = Infinity;
    for (const v of vias) near = Math.min(near, Math.hypot(v.x - p.x, v.y - p.y));
    const how = tht ? "through-hole pad in the pour, both layers" : onTrack ? "ground track" : near < 2.5 ? "via to the other layer's pour" : "pour only";
    const row = { ref: r.it.ref, pad: p.n, how, via: near === Infinity ? null : R2(near) };
    rows.push(row);
    if (!tht && !onTrack && near >= 2.5) loose.push(`${r.it.ref}.${p.n}`);
  }
  return { rows, loose };
}

// ---------------- main entry ----------------

/**
 * @returns {{files: Record<string,string>, extra: object, summary: object}}
 *   extra is passed to reportMd (inputs, questions, assumptions, deviations, checks, unresolved, drillChanges, risks).
 */
export function pedalOutputs({ st, plan, items, layout, routing, drc, classes, pour, name, warnings = [], date = null }) {
  const { input } = st, fr = plan.frame, c = fr.c;
  const Wi = input.Wi, Li = input.Li, Hu = input.Hu;
  const encX = (x) => R2(x + c), encY = (y) => R2(layout.l - y + c);
  const files = {};
  const ofRole = (role) => st.mech.filter((m) => m.role === role);

  // ---- holes (DP-*): positions come from the placed footprints ----
  const holes = [], roleOf = new Map();
  for (const m of st.mech) {
    if (!m.hole) continue;
    const id = `D${holes.length + 1}`, h = m.hole;
    let face, x, y;
    if (h.face === "top") { face = "top"; x = encX(h.at[0]); y = encY(h.at[1]); }
    else if (h.face === "end_top") { face = "end_top"; x = encX(h.along); y = R2(Hu / 2); }
    else { face = h.face; x = R2(Li - (h.along + c)); y = R2(Hu / 2); }
    holes.push({ id, ref: m.it.ref, what: m.hw.what ?? m.role, face, x, y, dia: m.dia });
    roleOf.set(id, m.role);
  }
  (st.standoffs ?? []).forEach(([bx, by], i) => holes.push({ id: `D${holes.length + 1}`, ref: `H${i + 1}`, what: "M3 standoff screw", face: "base", x: encX(bx), y: encY(by), dia: PEDAL.standoff_drill }));

  const faces = {
    top: { size: [Wi, Li], note: "lid, seen from outside; x from the left inside wall, y from the bottom (stomp) end" },
    base: { size: [Wi, Li], note: "base, seen from inside; same x, y as the lid" },
    side_left: { size: [Li, Hu], note: "left side wall; x along the length from the bottom (stomp) end, y up from the base" },
    side_right: { size: [Li, Hu], note: "right side wall; x along the length from the bottom (stomp) end, y up from the base" },
    end_top: { size: [Wi, Hu], note: "top (DC jack) end wall; x from the left side wall, y up from the base" },
    end_bottom: { size: [Wi, Hu], note: "bottom (footswitch) end wall; x from the left side wall, y up from the base" },
  };
  const plans = {
    enclosure: input.enclosure, origin: "lower-left inside corner of the enclosure; +x right, +y up (CS-01); the PCB origin is offset by the board-edge clearance on both axes", y_axis: "up", units: "mm",
    interior_mm: { L: Li, W: Wi, H_usable: Hu }, pcb_offset_mm: { x: c, y: c }, mounting: input.mounting, faces,
    holes: holes.map(({ what, ...h }) => ({ ...h, name: what })), changes_from_template: [],
  };
  files["drill_plan.json"] = JSON.stringify(plans, null, 2) + "\n";

  // ---- checks ----
  const checks = [], deviations = [...(plan.deviations ?? [])], risks = [], unresolved = [], sections = [];

  // M5 (DP-06): hole edges against walls, other holes and corner posts
  const m5 = [];
  for (const h of holes) {
    const [fw, fh] = faces[h.face].size, r = h.dia / 2;
    const edge = Math.min(h.x - r, fw - h.x - r, h.y - r, fh - h.y - r);
    if (edge < DP.wall - 1e-6) m5.push(`${h.id} ${h.ref}: ${R2(edge)} mm from the wall (needs ${DP.wall})`);
    if (h.face === "top" || h.face === "base") for (const [px, py] of POST_CENTER(Wi, Li)) {
      const g = Math.hypot(h.x - px, h.y - py) - r - PEDAL.post_dia / 2;
      if (g < DP.boss - 1e-6) m5.push(`${h.id} ${h.ref}: ${R2(g)} mm from a corner post (needs ${DP.boss})`);
    }
    if (h.face.startsWith("side") && (h.x < DP.corner_center || Li - h.x < DP.corner_center)) m5.push(`${h.id} ${h.ref}: axis ${R2(Math.min(h.x, Li - h.x))} mm from a corner post (DP-04 wants ${DP.corner_center})`);
  }
  holes.forEach((a, i) => holes.slice(i + 1).forEach((b) => {
    if (a.face !== b.face) return;
    const need = a.dia >= 10 || b.dia >= 10 ? DP.hole_big : DP.hole, g = Math.hypot(a.x - b.x, a.y - b.y) - a.dia / 2 - b.dia / 2;
    if (g < need - 1e-6) m5.push(`${a.id} ${a.ref} and ${b.id} ${b.ref}: ${R2(g)} mm between hole edges (needs ${need})`);
  }));
  checks.push(["M5", "drill plan hole spacing (DP-06)", m5.length ? `FAIL: ${m5.join("; ")}` : `PASS (${holes.length} holes)`]);
  for (const f of m5) deviations.push(`DP-06: ${f}.`);

  // M3 (DP-09): the drill hole against the PCB part's own hole point; pot rows collinear
  const m3 = [];
  for (const m of st.mech) {
    if (!m.at || !m.hole) continue;
    const ho = rotPt(...m.hw.holeUsed, m.at.rot), pt = [m.at.x + ho[0], m.at.y + ho[1]];
    const want = m.hole.at ?? m.hole.wallPoint, d = Math.hypot(pt[0] - want[0], pt[1] - want[1]);
    if (d > 0.2) m3.push(`${m.it.ref}: ${R2(d)} mm`);
  }
  const potPts = ofRole("pot").map((m) => m.hole.at);
  let rowSpread = 0;
  for (const p of potPts) for (const q of potPts) if (Math.abs(p[1] - q[1]) < 3) rowSpread = Math.max(rowSpread, Math.abs(p[1] - q[1]));
  if (rowSpread > 0.1) m3.push(`pot row off by ${R2(rowSpread)} mm`);
  checks.push(["M3", "panel alignment (DP-09: part centre vs hole <= 0.2 mm, pot rows <= 0.1 mm)", m3.length ? `FAIL: ${m3.join("; ")}` : "PASS"]);

  // M1: board inside the interior minus the edge clearance, posts cut out, nothing of the copper in a post
  const outsideOk = fr.w + 2 * c <= Wi + 1e-6 && fr.l + 2 * c <= Li + 1e-6 && c >= 1.0 - 1e-6;
  const inPost = layout.parts.filter((r) => fr.keepouts.some((k) => distPtRect(k.x, k.y, { x0: r.box[0], y0: r.box[1], x1: r.box[2], y1: r.box[3] }) < k.r));
  checks.push(["M1", "mechanical overlay: outline inside interior minus clearance, post notches, no part in a post (BO-01, BO-02)", outsideOk && !inPost.length ? "PASS (see mechanical_overlay.svg)" : `FAIL: ${!outsideOk ? "outline does not fit; " : ""}${inPost.map((r) => r.it.ref).join(", ")}`]);

  // D3: every part inside the outline except the panel-edge parts
  const edgeRoles = new Set(["jack_in", "jack_out", "dc_jack"]);
  const outPart = layout.parts.filter((r) => !edgeRoles.has(r.role) && (r.box[0] < -1e-6 || r.box[1] < -1e-6 || r.box[2] > layout.w + 1e-6 || r.box[3] > layout.l + 1e-6));
  checks.push(["D3", "all parts inside the outline except jacks", outPart.length ? `FAIL: ${outPart.map((r) => r.it.ref).join(", ")}` : "PASS"]);

  // M2 (BO-06): height. Heights are typical values for the footprint family [V], not datasheet numbers.
  const tall = [];
  let tallest = { h: 0, ref: "" };
  for (const r of layout.parts) {
    const b = bodyFor(r.it.footprint, r.it.ref);
    if (b.h > tallest.h) tallest = { h: b.h, ref: r.it.ref };
    if (b.h + PARAMS.board_thickness + 0.5 > Hu + 1e-6) tall.push(`${r.it.ref} ${R2(b.h)} mm`);
  }
  checks.push(["M2", `height: part + ${PARAMS.board_thickness} board + 0.5 margin <= ${R2(Hu)} mm usable (BO-06)`, tall.length ? `FAIL: ${tall.join(", ")}. Options: relocate to a lower zone, or pick a lower part.` : `PASS (tallest ${tallest.ref} ${R2(tallest.h)} mm, typical [V])`]);
  unresolved.push("Part heights are typical values for each footprint family, not datasheet numbers (spec: missing Height_mm -> ASSUME [V]). Put your parts' real heights in the BOM.");

  // M4 / BO-03: nuts, washers and the pot shoulder. Hardware sizes are typical values [V] (HW_STACK in pedal.js), not your parts' numbers.
  const stackOf = (id) => ({ pot: HS.pot, jack_in: HS.jack, jack_out: HS.jack, dc_jack: HS.dc, switch: HS.sw })[roleOf.get(id)];
  const m4 = [];
  for (const h of holes) {
    const hw = stackOf(h.id);
    if (!hw) continue;
    const panel = h.face === "top" ? HS.lid_t : PEDAL.wall, need = R2(panel + hw.washer_t + hw.nut_t + HS.thread_margin);
    if (need > hw.bushing_len + 1e-6) m4.push(`${h.id} ${h.ref}: panel ${panel} + washer ${hw.washer_t} + nut ${hw.nut_t} + ${HS.thread_margin} thread = ${need} mm but the bushing is ${hw.bushing_len} mm`);
  }
  holes.forEach((a, i) => holes.slice(i + 1).forEach((b) => {
    const na = stackOf(a.id), nb = stackOf(b.id);
    if (a.face !== b.face || !na || !nb) return;
    const g = Math.hypot(a.x - b.x, a.y - b.y) - na.nut_d / 2 - nb.nut_d / 2;
    if (g < HS.nut_gap - 1e-6) m4.push(`${a.id} ${a.ref} and ${b.id} ${b.ref}: nuts ${R2(g)} mm apart (need ${HS.nut_gap})`);
  }));
  checks.push(["M4", "hardware stack-up: bushing long enough for panel + washer + nut, neighbouring nuts clear (typical hardware [V])", m4.length ? `FAIL: ${m4.join("; ")}` : `PASS (typical [V] hardware; measure yours)`]);
  for (const f of m4) deviations.push(`M4: ${f}.`);
  if (input.mounting === "sandwich") {
    // BO-03: the board hangs from the pot shoulders, so the gap from the board's top face to the lid is the shoulder height.
    const gap = HS.pot.shoulder_h, mech = new Set([...st.mech.map((m) => m.role), "standoff"]), over = [];
    for (const r of layout.parts) {
      if (mech.has(r.role)) continue;
      const h = bodyFor(r.it.footprint, r.it.ref).h;
      if (h + HS.margin > gap + 1e-6) over.push(`${r.it.ref} ${R2(h)} mm`);
    }
    checks.push(["BO-03", `sandwich: parts under the lid fit the ${gap} mm pot-shoulder gap (+ ${HS.margin} margin) [V]`, over.length ? `FAIL: ${over.join(", ")} too tall` : `PASS (gap ${gap} mm = pot shoulder height, typical [V])`]);
    if (over.length) deviations.push(`BO-03: ${over.join(", ")} stand taller than the ${gap} mm gap between the board and the lid (typical pot shoulder [V]). Options in order: lay the part down or move it where the lid gap is larger, use a lower part, or switch to standoff mounting. A taller pot shoulder also fixes it: measure yours.`);
  }

  // E6 / E2: every pin lands on a pad of its footprint with the right net
  const e6 = [];
  const pinMap = [];
  for (const r of layout.parts) for (const p of r.it.pins) {
    const pad = r.pads.find((q) => q.n === String(p.num));
    if (!pad) e6.push(`${r.it.ref}.${p.num}: no such pad on ${r.it.footprint.split(":").pop()}`);
    else if ((pad.net ?? null) !== (p.net ?? null)) e6.push(`${r.it.ref}.${p.num}: pad net ${pad.net} but the schematic says ${p.net}`);
    if (p.fn) pinMap.push({ ref: r.it.ref, circuitjs_fn: p.fn, user_fn: p.fn, pin: String(p.num) });
  }
  checks.push(["E6", "every pin_map row satisfied on the board", e6.length ? `FAIL: ${e6.join("; ")}` : `PASS (${pinMap.length} mapped pins)`]);

  // E3 (CP-03): polarized parts all face the same way
  const polar = layout.parts.filter((r) => ["diode", "zener", "led"].includes(r.it.kind) || /CP_/.test(r.it.footprint));
  const rots = new Set(polar.map((r) => r.rot));
  checks.push(["E3", "polarized parts oriented alike (CP-03)", rots.size <= 1 ? `PASS (${polar.length} parts at ${[...rots][0] ?? 0} deg)` : `FAIL: rotations ${[...rots].join(", ")}`]);

  // E4: supply never on the ground net; VREF is half the supply
  const netsOf = new Map();
  for (const r of layout.parts) for (const p of r.pads) if (p.net) (netsOf.get(p.net) ?? netsOf.set(p.net, []).get(p.net)).push(`${r.it.ref}.${p.n}`);
  const shorts = (drc?.errors ?? []).filter((e) => e.type === "clearance" && /(\+|VREF|GND)/.test(e.msg ?? "") && /short|overlap|same/i.test(e.msg ?? ""));
  let vrefNote = "no VREF divider";
  if (st.vref) {
    const top = items.find((i) => /VREF divider, upper/.test(i.added ?? "")), bot = items.find((i) => /VREF divider, lower/.test(i.added ?? ""));
    const a = top && parseValue(top.value), b = bot && parseValue(bot.value);
    if (a && b) { const v = (st.input.supplyV * b) / (a + b), err = Math.abs(v - st.input.supplyV / 2) / (st.input.supplyV / 2); vrefNote = `VREF ${R2(v)} V unloaded (${R2(err * 100)} % from Vcc/2)${err > 0.02 ? ", outside the 2 % limit" : ""}`; if (err > 0.02) shorts.push({ msg: vrefNote }); }
    else vrefNote = "VREF divider values could not be read; check them";
  }
  checks.push(["E4", "supply not shorted to GND; VREF within 2 % of Vcc/2", shorts.length ? `FAIL: ${shorts.map((s) => s.msg).join("; ")}` : `PASS (${st.input.supplyNet} and GND are separate nets; ${vrefNote})`]);

  // E5: bypass wiring is structural: IN/OUT only on the jack, the switch common and a test point
  if (st.bypass) {
    const only = (net, allowed) => (netsOf.get(net) ?? []).filter((p) => !allowed.some((a) => a.test(p)));
    const ref = (role) => ofRole(role)[0]?.it.ref;
    const swr = ref("switch"), jin = ref("jack_in"), jout = ref("jack_out"), led = ref("led");
    const bad = [
      ...only("IN", [new RegExp(`^${jin}\\.`), new RegExp(`^${swr}\\.2$`), /^TP\d+\./]).map((p) => `IN also touches ${p}`),
      ...only("OUT", [new RegExp(`^${jout}\\.`), new RegExp(`^${swr}\\.5$`), /^TP\d+\./]).map((p) => `OUT also touches ${p}`),
      ...only("BYP", [new RegExp(`^${swr}\\.(1|4)$`)]).map((p) => `BYP also touches ${p}`),
      ...only("LED_K", [new RegExp(`^${swr}\\.8$`), new RegExp(`^${led}\\.`)]).map((p) => `LED_K also touches ${p}`),
    ];
    checks.push(["E5", "bypass path has no effect loading; LED path separate", bad.length ? `FAIL: ${bad.join("; ")}` : "PASS (in bypass IN -> BYP -> OUT only meets the jacks, switch and test points)"]);
  } else checks.push(["E5", "bypass path", "n/a: bypass is none"]);

  // CP-04: input/output separation
  const ji = ofRole("jack_in")[0], jo = ofRole("jack_out")[0];
  if (ji?.at && jo?.at) {
    const pi = layout.parts.find((r) => r.it === ji.it)?.pads, po = layout.parts.find((r) => r.it === jo.it)?.pads;
    let sep = Infinity;
    for (const a of pi ?? []) for (const b of po ?? []) sep = Math.min(sep, Math.hypot(a.x - b.x, a.y - b.y));
    checks.push(["CP-04", `input/output separation >= ${PARAMS.io_separation_min ?? 15} mm`, sep >= 15 ? `PASS (${R2(sep)} mm between the jacks' pads)` : `FAIL: ${R2(sep)} mm`]);
    if (sep < 15) deviations.push(`CP-04: the input and output jacks are only ${R2(sep)} mm apart in this enclosure.`);
  }

  // A1: no power/LED trace running along an audio trace
  if (routing) {
    const seg = segmentsOf(routing), by = (cl) => seg.filter((s) => cl.includes(classes.get(s.net)));
    const audio = by(["AUDIO_SIG", "HIGH_Z"]), noisy = by(["POWER", "LED_CTRL"]);
    const run = parallelRun(audio, noisy, PARAMS.noise_parallel_sep);
    checks.push(["A1", `no power trace within ${PARAMS.noise_parallel_sep} mm of audio over > ${PARAMS.noise_parallel_len} mm`, run > PARAMS.noise_parallel_len ? `FAIL: ${R2(run)} mm run side by side. Adjust it in KiCad.` : `PASS (${R2(run)} mm run)`]);
    if (run > PARAMS.noise_parallel_len) deviations.push(`A1: power or LED copper runs ${R2(run)} mm alongside audio copper within ${PARAMS.noise_parallel_sep} mm.`);
  } else checks.push(["A1", "power/audio parallel runs", "not run (no routing)"]);
  // A4: where each ground pad returns to
  const gr = groundReturn(layout, routing, pour);
  if (routing && pour) {
    checks.push(["A4", "ground-return table (every ground pad reaches the pour)", gr.loose.length ? `FAIL: no track or nearby via on ${gr.loose.join(", ")}` : `PASS (${gr.rows.length} ground pads, table below)`]);
    if (gr.loose.length) deviations.push(`A4: SMD ground pad(s) ${gr.loose.join(", ")} touch the pour only through a thermal relief with no via within 2.5 mm.`);
    sections.push("### Ground return (A4)", "", table(["Ref", "Pad", "Reaches ground by", "Nearest ground via (mm)"], gr.rows.map((g) => [g.ref, g.pad, g.how, g.via ?? "none"])), "");
  } else checks.push(["A4", "ground-return table", "not run (no routing)"]);
  checks.push(["A3", "switcher / charge pump separation", "PASS: pedal mode adds no regulator, switcher or charge pump (supply rails other than Vcc and Vcc/2 are refused)"]);

  // ---- report pieces ----
  const inputs = [
    `- Pedal mode: ${input.type}, enclosure ${input.enclosure} (interior ${R2(Li)} x ${R2(Wi)} x ${R2(Hu)} mm), mounting ${input.mounting}, bypass ${input.bypass}`,
    `- Supply: ${input.supplyV} V on net ${input.supplyNet}${st.vref ? `, Vcc/2 on net VREF (${st.halfVolts} V source in the circuit)` : ""}`,
    `- Board: ${layout.w} x ${layout.l} mm, one edge clearance of ${c} mm inside the interior; plan origin = lower-left inside corner, y up`,
    `- TOP side = lid / control side; every part is on F.Cu (CS-02)`,
  ];
  for (const n of st.notes) inputs.push(`- ${n}`);
  const risk = [
    "B6 built-in pot, jack, DC jack and LED footprints are the KiCad library parts named in wiring_guide.md [V]: check them against the parts you actually buy, or upload your own footprint.",
    ...(["fuzz", "analog_overdrive"].includes(input.type) ? [`B6 ${input.type} circuits are sensitive to layout: review the input network, the high-Z nodes and the ground return in KiCad before ordering.`] : []),
    "Footprint pad data is from the KiCad libraries mirrored on GitHub (2020).",
  ];
  unresolved.push(
    `Enclosure interior ${R2(Li)} x ${R2(Wi)} x ${R2(Hu)} mm is ${ENCL_NOTE(input)}; wall ${PEDAL.wall} mm and post diameter ${PEDAL.post_dia} mm are typical [V]. Use the maker's drawing.`,
    "Panel hole diameters (pot 7.5, jack 10, DC jack 12, switch 12, LED 6 mm) are typical [V]; confirm against your hardware.",
    "Side-wall holes are at half the usable height (DP-04). With sandwich mounting the jack axis must sit at the PCB's height; check with the lid on.",
    "Jack and DC jack hole positions in the footprint (where the barrel meets the wall) were read from the KiCad footprint's pads [V].",
  );
  if (input.mounting === "sandwich") unresolved.push(`BO-03 sandwich mounting: the gap to the lid is taken as the pot shoulder height (${HS.pot.shoulder_h} mm above the board, typical [V]). Measure it from your pots.`);
  unresolved.push(`M4 hardware stack-up uses typical values [V]: lid ${HS.lid_t} mm, wall ${PEDAL.wall} mm, pot bushing ${HS.pot.bushing_len} mm with a ${HS.pot.nut_t} mm nut and ${HS.pot.washer_t} mm washer, jack bushing ${HS.jack.bushing_len} mm. Replace them with your hardware's numbers.`);

  // ---- placement.json (K5) ----
  const flipY = (y) => R4(layout.l - y);
  const placement = {
    y_axis: "up", board: { outline: outlinePoly(fr.outline).map(([x, y]) => [x, flipY(y)]), thickness_mm: PARAMS.board_thickness, origin: "lower_left" },
    keepouts: fr.keepouts.map((k, i) => ({ type: "circle", center: [k.x, flipY(k.y)], dia_mm: R4(k.r * 2), name: `post${i + 1}` })),
    placements: layout.parts.map((r) => ({ ref: r.it.ref, footprint: r.it.footprint, x: r.x, y: flipY(r.y), rot: r.rot, side: "F", locked: Boolean(r.locked) })),
    net_classes: Object.fromEntries(Object.entries(NET_CLASSES).map(([k, v]) => [k, { track_mm: v.track, clearance_mm: v.clearance }])),
    zones: pour ? ["F.Cu", "B.Cu"].map((layer) => ({ net: pour, layer, clearance_mm: PARAMS.pour_clear, thermal_relief: true })) : [],
    holes: [...layout.parts.flatMap((r) => r.pads.filter((p) => p.t === "np_thru_hole").map((p) => ({ type: "NPTH", x: p.x, y: flipY(p.y), dia_mm: Array.isArray(p.d) ? p.d[0] : p.d, ref: r.it.ref })))],
  };
  files["placement.json"] = JSON.stringify(placement, null, 2) + "\n";

  // ---- netlist.json (D-6) ----
  const nets = {};
  for (const [net, pads] of netsOf) nets[net] = pads;
  files["netlist.json"] = JSON.stringify({
    nets,
    parts: items.map((i) => ({ ref: i.ref, from_circuitjs: i.added ? null : i.ref, value: i.value, bom_line: i.mpn || null, added: Boolean(i.added), added_reason: i.added ?? null })),
    pin_map: pinMap,
    unresolved: [],
    excluded: st.netlist.sources.map((s) => ({ element: s.ref, reason: s.dc ? "simulation supply source: the DC jack and its protection chain replace it" : "simulation signal source: the input jack replaces it" })),
    renames: st.renames,
  }, null, 2) + "\n";

  // ---- project library (D-1, K4) ----
  const used = [...new Set(items.map((i) => i.footprint).filter((f) => f.startsWith("Pedal:")))];
  for (const k of used) {
    const fname = k.split(":")[1];
    if (PEDAL_FOOTPRINTS[k]) files[`pedal.pretty/${fname}.kicad_mod`] = modText(fname, PEDAL_FOOTPRINTS[k]);
  }
  Object.assign(files, st.files);
  files["fp-lib-table"] = `(fp_lib_table\n  (version 7)\n  (lib (name "Pedal")(type "KiCad")(uri "\${KIPRJMOD}/pedal.pretty")(options "")(descr "Parts added by pedal mode"))\n)\n`;

  // ---- drawings ----
  files["drill_plan.svg"] = drillSvg({ st, plans, holes, faces, name, Wi, Li, Hu });
  files["mechanical_overlay.svg"] = overlaySvg({ st, fr, layout, holes, Wi, Li, c });
  files["wiring_guide.md"] = wiringGuide({ st, items, holes, layout });

  return {
    files,
    extra: { inputs, questions: st.questions, assumptions: st.assumptions, deviations, checks, unresolved, sections, drillChanges: [], risks: [...risk, ...warnings.filter((w) => /fuzz|charge pump/i.test(w))] },
    summary: { assumptions: st.assumptions, notes: st.notes, enclosure: input.enclosure, interior: [Li, Wi, Hu], mounting: input.mounting, holes: holes.length, checks: Object.fromEntries(checks.map((k) => [k[0], String(k[2]).split(/[:( ]/)[0]])) },
  };
}

const ENCL_NOTE = (input) => (Object.hasOwn({ "1590A": 1, "1590B": 1, "125B": 1, "1590BB": 1, "1590DD": 1 }, input.enclosure) ? `the typical outer size of a ${input.enclosure} less a wall on each side` : "the size you gave");

// ---------------- drawings ----------------

function drillSvg({ st, plans, holes, faces, name, Wi, Li, Hu }) {
  const M = 14, G = 22;
  const view = [];                                              // placed faces: { face, x0, y0, w, h }
  const col2 = M + Wi + G;
  view.push({ face: "top", x0: M, y0: M + 12, w: Wi, h: Li });
  let y = M + 12;
  for (const f of ["side_left", "side_right", "end_top", "end_bottom"]) { const [w, h] = faces[f].size; view.push({ face: f, x0: col2, y0: y, w, h }); y += h + G; }
  if (holes.some((h) => h.face === "base")) { view.push({ face: "base", x0: M, y0: M + 12 + Li + G, w: Wi, h: Li }); }
  const colBottom = Math.max(...view.map((v) => v.y0 + v.h)) + G;
  const W = Math.ceil(Math.max(col2 + Math.max(Li, Wi), M + Wi) + M), tableY = colBottom;
  const H = Math.ceil(tableY + (holes.length + 3) * 5 + M);
  const o = [];
  o.push(`<text x="${M}" y="${M + 2}" font-size="5" font-weight="bold">${esc(name)} drill plan, enclosure ${esc(plans.enclosure)}</text>`);
  o.push(`<text x="${M}" y="${M + 8}" font-size="3">1:1 (units mm). Print at 100 % and check the 50 mm bar. Origin: lower-left inside corner; x right, y up (CS-01).</text>`);
  o.push(`<line x1="${W - M - 50}" y1="${M + 2}" x2="${W - M}" y2="${M + 2}" stroke="#000" stroke-width="0.4"/><text x="${W - M - 50}" y="${M + 6}" font-size="3">50 mm</text>`);
  for (const v of view) {
    const label = v.face.replace("_", " ");
    o.push(`<text x="${v.x0}" y="${v.y0 - 2}" font-size="3.2" font-weight="bold">${esc(label)} (${faces[v.face].size[0]} x ${faces[v.face].size[1]})</text>`);
    o.push(`<rect x="${v.x0}" y="${v.y0}" width="${v.w}" height="${v.h}" fill="none" stroke="#000" stroke-width="0.3"/>`);
    if (v.face === "top" || v.face === "base") for (const [px, py] of POST_CENTER(Wi, Li)) o.push(`<circle cx="${v.x0 + px}" cy="${v.y0 + (Li - py)}" r="${PEDAL.post_dia / 2}" fill="#eee" stroke="#888" stroke-width="0.2" stroke-dasharray="1 1"/>`);
    for (const h of holes.filter((x) => x.face === v.face)) {
      const cx = v.x0 + h.x, cy = v.y0 + (v.h - h.y), r = h.dia / 2;
      o.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#c00" stroke-width="0.3"/>`);
      o.push(`<line x1="${cx - r - 2}" y1="${cy}" x2="${cx + r + 2}" y2="${cy}" stroke="#c00" stroke-width="0.2"/><line x1="${cx}" y1="${cy - r - 2}" x2="${cx}" y2="${cy + r + 2}" stroke="#c00" stroke-width="0.2"/>`);
      // dimensions from the two reference edges (left edge and bottom edge of the face)
      o.push(`<line x1="${v.x0}" y1="${cy}" x2="${cx - r - 2}" y2="${cy}" stroke="#06c" stroke-width="0.15" stroke-dasharray="1 0.8"/><text x="${v.x0 + 1}" y="${cy - 0.8}" font-size="2.2" fill="#06c">${h.x}</text>`);
      o.push(`<line x1="${cx}" y1="${v.y0 + v.h}" x2="${cx}" y2="${cy + r + 2}" stroke="#06c" stroke-width="0.15" stroke-dasharray="1 0.8"/><text x="${cx + 0.8}" y="${v.y0 + v.h - 1}" font-size="2.2" fill="#06c">${h.y}</text>`);
      o.push(`<text x="${cx + r + 1}" y="${cy - r - 0.5}" font-size="2.6" font-weight="bold">${esc(h.id)}</text>`);
    }
  }
  o.push(`<text x="${M}" y="${tableY}" font-size="3.2" font-weight="bold">Hole table (id, ref, x, y, dia, face)</text>`);
  holes.forEach((h, i) => o.push(`<text x="${M}" y="${tableY + 5 + i * 5}" font-size="2.8" font-family="monospace">${esc(`${h.id.padEnd(4)} ${h.ref.padEnd(5)} x ${String(h.x).padStart(7)}  y ${String(h.y).padStart(7)}  dia ${String(h.dia).padStart(5)}  ${h.face}  ${h.what}`)}</text>`));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}" font-family="sans-serif"><rect width="${W}" height="${H}" fill="#fff"/>${o.join("")}</svg>\n`;
}

function overlaySvg({ st, fr, layout, holes, Wi, Li, c }) {
  const M = 8, W = Wi + 2 * M, H = Li + 2 * M + 8;
  const o = [`<rect x="${M}" y="${M}" width="${Wi}" height="${Li}" fill="#fafafa" stroke="#000" stroke-width="0.4"/>`];
  for (const [px, py] of POST_CENTER(Wi, Li)) o.push(`<circle cx="${M + px}" cy="${M + py}" r="${PEDAL.post_dia / 2}" fill="#ddd" stroke="#888" stroke-width="0.2"/>`);
  // board outline
  let d = "";
  fr.outline.forEach((e, i) => { const a = e.a; if (e.k === "l") d += `${i ? "L" : `M ${R4(a[0] + c + M)} ${R4(a[1] + c + M)} L`} ${R4(a[2] + c + M)} ${R4(a[3] + c + M)} `; else d += `${i ? "" : `M ${R4(a[0] + c + M)} ${R4(a[1] + c + M)} `}${arcPath(a.map((v, k) => v + c + M))} `; });
  o.push(`<path d="${d} Z" fill="#cfe8d5" stroke="#1c7c4f" stroke-width="0.4"/>`);
  for (const k of fr.keepouts) o.push(`<circle cx="${R4(k.x + c + M)}" cy="${R4(k.y + c + M)}" r="${k.r}" fill="none" stroke="#c00" stroke-width="0.2" stroke-dasharray="1 1"/>`);
  for (const r of layout.parts) {
    const b = r.box;
    o.push(`<rect x="${R4(b[0] + c + M)}" y="${R4(b[1] + c + M)}" width="${R4(b[2] - b[0])}" height="${R4(b[3] - b[1])}" fill="${r.locked ? "#ffe9a8" : "none"}" stroke="${r.locked ? "#b8860b" : "#667"}" stroke-width="0.2"/>`);
    for (const p of r.pads) o.push(`<rect x="${R4(p.x - p.w / 2 + c + M)}" y="${R4(p.y - p.h / 2 + c + M)}" width="${R4(p.w)}" height="${R4(p.h)}" fill="#c33" opacity=".6"/>`);
    o.push(`<text x="${R4(b[0] + c + M + 0.3)}" y="${R4(b[1] + c + M + 1.8)}" font-size="1.8">${esc(r.it.ref)}</text>`);
  }
  for (const h of holes.filter((x) => x.face === "top" || x.face === "base")) o.push(`<circle cx="${R4(h.x + M)}" cy="${R4(Li - h.y + M)}" r="${h.dia / 2}" fill="none" stroke="#06c" stroke-width="0.3"/><line x1="${R4(h.x + M - 2)}" y1="${R4(Li - h.y + M)}" x2="${R4(h.x + M + 2)}" y2="${R4(Li - h.y + M)}" stroke="#06c" stroke-width="0.15"/><line x1="${R4(h.x + M)}" y1="${R4(Li - h.y + M - 2)}" x2="${R4(h.x + M)}" y2="${R4(Li - h.y + M + 2)}" stroke="#06c" stroke-width="0.15"/>`);
  for (const h of holes.filter((x) => x.face.startsWith("side") || x.face.startsWith("end"))) {      // wall holes: a bar on the wall
    const along = h.face.startsWith("side") ? Li - h.x : null;
    if (h.face === "side_left") o.push(`<rect x="${M - 2}" y="${R4(M + along - h.dia / 2)}" width="2" height="${h.dia}" fill="#06c" opacity=".6"/>`);
    else if (h.face === "side_right") o.push(`<rect x="${M + Wi}" y="${R4(M + along - h.dia / 2)}" width="2" height="${h.dia}" fill="#06c" opacity=".6"/>`);
    else if (h.face === "end_top") o.push(`<rect x="${R4(M + h.x - h.dia / 2)}" y="${M - 2}" width="${h.dia}" height="2" fill="#06c" opacity=".6"/>`);
  }
  o.push(`<text x="${M}" y="${H - 3}" font-size="2.4">Mechanical overlay, 1:1 mm, seen from the lid. Grey: lid posts. Green: board. Yellow: locked panel parts. Blue: panel holes. Red dashed: post keep-out.</text>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}" font-family="sans-serif"><rect width="${W}" height="${H}" fill="#fff"/>${o.join("")}</svg>\n`;
}

function wiringGuide({ st, items, holes, layout }) {
  const { input } = st, L = [];
  L.push(`# Wiring and assembly guide`, "", `Generated by pedal mode (${input.type}, ${input.enclosure}). Values tagged [V] are typical, not datasheet numbers.`, "");
  const sw = st.mech.find((m) => m.role === "switch");
  if (sw) {
    const ref = sw.it.ref;
    L.push(`## ${ref}: 3PDT footswitch (true bypass), wired to nine pads`, "",
      "The pads are a 3 x 3 grid. Each column is one pole of the switch; each row is a lug of that pole. Match the pad names to the lug names in YOUR switch's datasheet (lug numbering differs between makers).", "",
      table(["Pad", "Pole", "Lug", "Net", "Connects to"], sw.lugs.map(([lug, net], i) => [`${ref}.${i + 1}`, `P${Math.floor(i / 3) + 1}`, lug.replace(/^P\d_/, ""), net ?? "(not connected)",
        ({ IN: "input jack tip", OUT: "output jack tip", BYP: "the other BYP pad: wire the two bypass lugs together on the board", SW_IN: "effect input (circuit input)", SW_OUT: "effect output (circuit output)", LED_K: "status LED cathode, through the LED resistor's return", GND: "ground" })[net] ?? ""])),
      "", "Engaged (effect on) means the common lug of poles 1 and 2 joins the effect lug; bypassed joins it to the BYP lug. Pole 3 lights the LED only when the effect is on.", "");
  }
  const jacks = st.mech.filter((m) => ["jack_in", "jack_out", "dc_jack"].includes(m.role));
  L.push("## Jacks and LED", "", table(["Ref", "Part", "Footprint", "Wiring"], [
    ...jacks.map((m) => [m.it.ref, m.it.value, m.it.footprint, m.role === "dc_jack" ? "2.1 mm barrel, centre negative: tip = GND, sleeve = DC in; the diode D (reverse protection) follows it (CP-08)" : "tip = signal, sleeve = ground (the sleeve bonds the enclosure to ground, PG-08)"]),
    ...st.mech.filter((m) => m.role === "led").map((m) => [m.it.ref, m.it.value, m.it.footprint, "anode toward the resistor, cathode toward LED_K; long lead = anode"]),
  ]), "");
  L.push("## Panel hardware and holes", "", table(["Hole", "Part", "Face", "Dia mm"], holes.map((h) => [h.id, `${h.ref} (${h.what})`, h.face, h.dia])), "",
    "Hole positions and diameters are in drill_plan.json / drill_plan.svg. Drill the diameters as listed, then check each against your part (the spec's numbers are typical [V]).", "");
  L.push("## Hardware stack-up [V]", "",
    input.mounting === "sandwich"
      ? `Mounting: sandwich. The board hangs from the pot bushings and the jack nuts; there are no standoffs. The gap between the board and the lid is taken as the pot shoulder height, ${HS.pot.shoulder_h} mm (typical [V], BO-03): measure it on your pots, and set the board height so the side-wall jack holes line up.`
      : "Mounting: M3 standoffs at the marked holes (drill 3.2 mm, keep copper clear of the 6 mm standoff head).",
    `Check M4 uses typical hardware [V]: lid ${HS.lid_t} mm, wall ${PEDAL.wall} mm, pot nut ${HS.pot.nut_t} + washer ${HS.pot.washer_t} on a ${HS.pot.bushing_len} mm bushing, jack nut ${HS.jack.nut_t} + washer ${HS.jack.washer_t} on ${HS.jack.bushing_len} mm. Test-fit with the lid on.`, "");
  L.push("## Orientation notes", "",
    "- All polarized parts (electrolytic capacitors, diodes, LEDs) are placed at the same rotation (CP-03).",
    "- Pin 1 of every IC is marked on the silkscreen by the library footprint.",
    `- ${st.input.supplyV ?? 9} V centre-negative supply: the board says so next to the DC jack.`,
    `- Pot taper letters on the silkscreen are for ${st.input.taper ?? "B"} unless you set them per control.`, "");
  L.push("## Added parts", "", table(["Ref", "Value", "Why"], items.filter((i) => i.added).map((i) => [i.ref, i.value, i.added])), "");
  return L.join("\n");
}
