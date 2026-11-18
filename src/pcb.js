// Places the board's footprints and writes a KiCad 9 .kicad_pcb with footprints (pads, silkscreen,
// courtyard, 3D model reference), net assignments on every pad, a board outline and a ratsnest-ready
// netlist. Traces are NOT routed: open the board in KiCad and route (or autoroute) it there.
//
// Footprint geometry comes from src/footprint-data.js (see scripts/gen-footprints.mjs). If a
// footprint is missing from that table, no PCB is written and the preview falls back to the rough
// layout in board.js.
//
// Not validated against a real KiCad install by the tests here: the tests check structure only.
// Open the board in KiCad, run DRC, then use Update PCB from Schematic (F8) to confirm it matches.

import { FOOTPRINT_DATA } from "./footprint-data.js";
import { bodyFor } from "./board.js";

const STEP = 0.5;          // placement grid, mm
const SEARCH = 1;          // spacing of candidate positions around a target, mm (a multiple of STEP)
const GAP = 0.3;           // minimum space between courtyards, mm
const MARGIN = 3;          // board edge to the nearest courtyard, mm
const R4 = (v) => Math.round(v * 10000) / 10000;
const q = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

// KiCad angles are counter-clockwise on a y-down screen.
const rotPt = (x, y, deg) => {
  switch (((deg % 360) + 360) % 360) {
    case 90: return [y, -x];
    case 180: return [-x, -y];
    case 270: return [-y, x];
    default: return [x, y];
  }
};
const rotBox = (b, deg) => {
  const p = [rotPt(b[0], b[1], deg), rotPt(b[2], b[3], deg)];
  return [Math.min(p[0][0], p[1][0]), Math.min(p[0][1], p[1][1]), Math.max(p[0][0], p[1][0]), Math.max(p[0][1], p[1][1])];
};
const swap = (deg) => ((deg % 180) + 180) % 180 === 90;

/** Footprint names that have no geometry in footprint-data.js. */
export const missingFootprints = (items) => [...new Set(items.map((i) => i.footprint).filter((f) => !FOOTPRINT_DATA[f]))];

/** Body outline (from the Fab layer, else the courtyard) used for the 3D preview. */
function bodyBox(fp) {
  const pts = [];
  for (const e of fp.g.filter((e) => e.l === "F.Fab")) {
    if (e.k === "c") { const r = Math.hypot(e.a[2] - e.a[0], e.a[3] - e.a[1]); pts.push([e.a[0] - r, e.a[1] - r], [e.a[0] + r, e.a[1] + r]); }
    else for (let i = 0; i < e.a.length; i += 2) pts.push([e.a[i], e.a[i + 1]]);
  }
  if (pts.length < 2) return fp.cy;
  const b = [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
  const area = (x) => (x[2] - x[0]) * (x[3] - x[1]);
  return area(b) < 0.25 * area(fp.cy) ? fp.cy : b;     // a tiny fab mark is not the body
}

/** Pad centres/sizes and courtyard for a footprint turned by `rot`, relative to its origin. */
function oriented(fpName, rot) {
  const fp = FOOTPRINT_DATA[fpName];
  const pads = fp.pads.map((p) => {
    const [x, y] = rotPt(p.x, p.y, rot);
    return { n: p.n, x, y, w: swap(rot) ? p.h : p.w, h: swap(rot) ? p.w : p.h };
  });
  return { pads, cy: rotBox(fp.cy, rot), body: rotBox(bodyBox(fp), rot) };
}

/**
 * @param {{ref: string, footprint: string, pins: {num: string, net: string|null}[]}[]} items
 * @returns {{parts: object[], w: number, l: number, warnings: string[]}}
 */
export function placeParts(items) {
  const warnings = [];
  const info = new Map();                     // item -> per-pad net, by pad number
  for (const it of items) {
    const fp = FOOTPRINT_DATA[it.footprint];
    const byNum = new Map(it.pins.map((p) => [String(p.num), p.net]));
    for (const num of byNum.keys()) if (!fp.pads.some((p) => p.n === num)) warnings.push(`${it.ref}: pin ${num} has no matching pad on ${it.footprint.split(":").pop()}.`);
    info.set(it, byNum);
  }
  const rotsFor = (it) => (FOOTPRINT_DATA[it.footprint].pads.length <= 3 && it.ref !== "J1" ? [0, 90] : [0]);
  const area = (it) => { const c = FOOTPRINT_DATA[it.footprint].cy; return (c[2] - c[0]) * (c[3] - c[1]); };

  const placed = [];                          // { it, rot, x, y, box, pads: [{n, x, y, w, h, net}] }
  const netPads = new Map();                  // net -> [{x, y}]
  let minX = -Infinity;                       // keeps the power connector on the left edge

  const place = (it, rot, x, y) => {
    const o = oriented(it.footprint, rot);
    const pads = o.pads.map((p) => ({ ...p, x: R4(x + p.x), y: R4(y + p.y), net: info.get(it).get(p.n) ?? null }));
    const rec = { it, rot, x, y, box: [x + o.cy[0], y + o.cy[1], x + o.cy[2], y + o.cy[3]], body: [x + o.body[0], y + o.body[1], x + o.body[2], y + o.body[3]], pads };
    placed.push(rec);
    cellsOf(rec.box, GAP, (k) => (grid.get(k) ?? grid.set(k, []).get(k)).push(rec));
    for (const p of pads) if (p.net) (netPads.get(p.net) ?? netPads.set(p.net, []).get(p.net)).push(p);
    return rec;
  };
  // Placed courtyards are indexed in 4 mm cells so a candidate is only tested against its neighbours.
  const CELL = 4, grid = new Map();
  const cellKey = (ix, iy) => (ix + 2048) * 4096 + (iy + 2048);
  const cellsOf = (b, pad, fn) => {
    for (let ix = Math.floor((b[0] - pad) / CELL); ix <= Math.floor((b[2] + pad) / CELL); ix++)
      for (let iy = Math.floor((b[1] - pad) / CELL); iy <= Math.floor((b[3] + pad) / CELL); iy++) fn(cellKey(ix, iy));
  };
  const free = (box) => {
    if (box[0] < minX) return false;
    let ok = true;
    cellsOf(box, GAP, (k) => {
      if (!ok) return;
      for (const r of grid.get(k) ?? []) {
        if (box[0] < r.box[2] + GAP && box[2] > r.box[0] - GAP && box[1] < r.box[3] + GAP && box[3] > r.box[1] - GAP) { ok = false; return; }
      }
    });
    return ok;
  };
  // How far the part's pads are from the nearest already-placed pad on the same net.
  const cost = (it, o, x, y) => {
    let c = 0;
    for (const p of o.pads) {
      const net = info.get(it).get(p.n);
      const list = net && netPads.get(net);
      if (!list) continue;
      let best = Infinity;
      for (const t of list) best = Math.min(best, Math.abs(t.x - (x + p.x)) + Math.abs(t.y - (y + p.y)));
      c += best;
    }
    return c;
  };
  const score = (it) => it.pins.reduce((s, p) => s + (p.net && netPads.has(p.net) ? 1 : 0), 0);
  const snap = (v) => Math.round(v / STEP) * STEP;

  function put(it) {
    const fp0 = oriented(it.footprint, 0);
    // Aim each pad at the closest placed pad on its net.
    let tx = 0, ty = 0, k = 0;
    for (const p of fp0.pads) {
      const list = info.get(it).get(p.n) && netPads.get(info.get(it).get(p.n));
      if (!list) continue;
      let best = null, bd = Infinity;
      for (const t of list) { const d = Math.abs(t.x - p.x) + Math.abs(t.y - p.y); if (d < bd) { bd = d; best = t; } }
      tx += best.x - p.x; ty += best.y - p.y; k++;
    }
    if (k) { tx /= k; ty /= k; }
    else if (placed.length) {                 // no connection yet: next to the placed group
      tx = Math.max(...placed.map((r) => r.box[2])) - fp0.cy[0] + GAP; ty = placed[0].y;
    }
    tx = snap(tx); ty = snap(ty);
    let bestRec = null;
    for (const rot of rotsFor(it)) {
      const o = oriented(it.footprint, rot);
      let found = 0;
      for (let r = 0; r < 120 && found < 8; r++) {
        for (let dx = -r; dx <= r && found < 8; dx++) {
          const edge = Math.abs(dx) === r;
          for (let dy = -r; dy <= r && found < 8; dy += edge ? 1 : 2 * r || 1) {   // whole column on the ring's sides, two cells otherwise
            if (!edge && Math.abs(dy) !== r) continue;
            const x = tx + dx * SEARCH, y = ty + dy * SEARCH;
            if (!free([x + o.cy[0], y + o.cy[1], x + o.cy[2], y + o.cy[3]])) continue;
            found++;
            const c = cost(it, o, x, y) + rot * 0.001;            // prefer upright on a tie
            if (!bestRec || c < bestRec.c) bestRec = { c, rot, x, y };
          }
        }
      }
    }
    return place(it, bestRec.rot, bestRec.x, bestRec.y);
  }

  const todo = [...items];
  const j1 = todo.find((i) => i.ref === "J1");
  if (j1) { todo.splice(todo.indexOf(j1), 1); const r = place(j1, 0, 0, 0); minX = r.box[2] + 1.5; }
  while (todo.length) {
    // Most-connected next; the largest part first when nothing is connected yet (usually an IC).
    let bi = 0, bs = -1;
    todo.forEach((it, i) => { const s = score(it); if (s > bs || (s === bs && (area(it) > area(todo[bi]) || (area(it) === area(todo[bi]) && it.ref.localeCompare(todo[bi].ref, undefined, { numeric: true }) < 0)))) { bi = i; bs = s; } });
    put(todo.splice(bi, 1)[0]);
  }

  // Move everything so the board starts at (0, 0) with a margin around the courtyards.
  const bx0 = Math.min(...placed.map((r) => r.box[0])), by0 = Math.min(...placed.map((r) => r.box[1]));
  const bx1 = Math.max(...placed.map((r) => r.box[2])), by1 = Math.max(...placed.map((r) => r.box[3]));
  const dx = Math.ceil((MARGIN - bx0) / STEP) * STEP, dy = Math.ceil((MARGIN - by0) / STEP) * STEP;
  const w = Math.ceil(bx1 + dx + MARGIN), l = Math.ceil(by1 + dy + MARGIN);
  for (const r of placed) {
    r.x = R4(r.x + dx); r.y = R4(r.y + dy);
    r.box = r.box.map((v, i) => R4(v + (i % 2 ? dy : dx)));
    r.body = r.body.map((v, i) => R4(v + (i % 2 ? dy : dx)));
    for (const p of r.pads) { p.x = R4(p.x + dx); p.y = R4(p.y + dy); }
  }
  return { parts: placed, w: Math.max(w, 10), l: Math.max(l, 10), warnings };
}

/** Ratsnest: a minimum spanning tree over each net's pads, as [x1, y1, x2, y2]. */
export function airwires(parts) {
  const byNet = new Map();
  for (const r of parts) for (const p of r.pads) if (p.net) (byNet.get(p.net) ?? byNet.set(p.net, []).get(p.net)).push(p);
  const out = [];
  for (const pads of byNet.values()) {
    if (pads.length < 2) continue;
    const inTree = [pads[0]], rest = pads.slice(1);
    while (rest.length) {
      let bi = 0, bj = 0, bd = Infinity;
      rest.forEach((p, i) => inTree.forEach((t, j) => { const d = Math.hypot(p.x - t.x, p.y - t.y); if (d < bd) { bd = d; bi = i; bj = j; } }));
      const p = rest.splice(bi, 1)[0], t = inTree[bj];
      if (bd > 0.01) out.push([R4(t.x), R4(t.y), R4(p.x), R4(p.y)]);
      inTree.push(p);
    }
  }
  return out;
}

/** What the 3D preview draws: the same placement, with bodies sized from the footprints. */
export function previewBoard(layout) {
  return {
    real: true, w: layout.w, l: layout.l, thickness: 1.6,
    parts: layout.parts.map((r) => {
      const b = bodyFor(r.it.footprint, r.it.ref);
      const bw = r.body[2] - r.body[0], bl = r.body[3] - r.body[1];
      return {
        ref: r.it.ref, value: r.it.value ?? "", footprint: r.it.footprint, kind: b.kind, shape: b.shape, h: b.h,
        x: R4((r.body[0] + r.body[2]) / 2), y: R4((r.body[1] + r.body[3]) / 2),
        w: R4(b.shape === "cyl" ? Math.min(bw, bl) : bw), l: R4(b.shape === "cyl" ? Math.min(bw, bl) : bl), rot: r.rot,
        pads: r.pads.map((p) => [p.x, p.y, R4(p.w), R4(p.h)]),
      };
    }),
    air: airwires(layout.parts),
  };
}

// ---- .kicad_pcb writer ----

const LAYERS = `  (layers
    (0 "F.Cu" signal)
    (2 "B.Cu" signal)
    (9 "F.Adhes" user "F.Adhesive")
    (11 "B.Adhes" user "B.Adhesive")
    (13 "F.Paste" user)
    (15 "B.Paste" user)
    (5 "F.SilkS" user "F.Silkscreen")
    (7 "B.SilkS" user "B.Silkscreen")
    (1 "F.Mask" user)
    (3 "B.Mask" user)
    (17 "Dwgs.User" user "User.Drawings")
    (19 "Cmts.User" user "User.Comments")
    (21 "Eco1.User" user "User.Eco1")
    (23 "Eco2.User" user "User.Eco2")
    (25 "Edge.Cuts" user)
    (27 "Margin" user)
    (31 "F.CrtYd" user "F.Courtyard")
    (29 "B.CrtYd" user "B.Courtyard")
    (35 "F.Fab" user)
    (33 "B.Fab" user)
  )`;

const FONT = "(effects (font (size 1 1) (thickness 0.15)))";
const stroke = (w) => `(stroke (width ${R4(w || 0.12)}) (type solid))`;

/**
 * @param {{name: string, items: object[], layout: ReturnType<typeof placeParts>, uuid: () => string, sheetFile: string}} a
 *   items[].symUuid is the schematic symbol's UUID, so Update PCB from Schematic keeps the link.
 */
export function writePcb({ name, layout, uuid, sheetFile }) {
  // Net names follow what KiCad gives a local label on the root sheet: "/NAME".
  const netId = new Map();
  for (const r of layout.parts) for (const p of r.pads) if (p.net && !netId.has(p.net)) netId.set(p.net, netId.size + 1);
  const netName = (n) => `/${n}`;

  const paper = layout.w <= 270 && layout.l <= 190 ? ["A4", 297, 210] : layout.w <= 390 && layout.l <= 270 ? ["A3", 420, 297] : ["A2", 594, 420];
  const ox = Math.round((paper[1] - layout.w) / 2), oy = Math.round((paper[2] - layout.l) / 2);
  const X = (v) => R4(v + ox), Y = (v) => R4(v + oy);

  const fps = layout.parts.map((r) => {
    const it = r.it, fp = FOOTPRINT_DATA[it.footprint];
    const props = (ref, value) => `    (property "Reference" ${q(ref)} (at 0 ${R4(fp.cy[1] - 1)} ${r.rot}) (layer "F.SilkS") (uuid ${q(uuid())})
      ${FONT})
    (property "Value" ${q(value)} (at 0 ${R4(fp.cy[3] + 1)} ${r.rot}) (layer "F.Fab") (uuid ${q(uuid())})
      ${FONT})
    (property "Datasheet" "" (at 0 0 ${r.rot}) (layer "F.Fab") (hide yes) (uuid ${q(uuid())})
      ${FONT})
    (property "Description" "" (at 0 0 ${r.rot}) (layer "F.Fab") (hide yes) (uuid ${q(uuid())})
      ${FONT})`;
    const gfx = fp.g.map((e) => {
      const layer = `(layer ${q(e.l)}) (uuid ${q(uuid())})`;
      if (e.k === "l") return `    (fp_line (start ${e.a[0]} ${e.a[1]}) (end ${e.a[2]} ${e.a[3]}) ${stroke(e.w)} ${layer})`;
      if (e.k === "c") return `    (fp_circle (center ${e.a[0]} ${e.a[1]}) (end ${e.a[2]} ${e.a[3]}) ${stroke(e.w)} (fill no) ${layer})`;
      return `    (fp_arc (start ${e.a[0]} ${e.a[1]}) (mid ${e.a[2]} ${e.a[3]}) (end ${e.a[4]} ${e.a[5]}) ${stroke(e.w)} ${layer})`;
    });
    const nets = new Map(it.pins.map((p) => [String(p.num), p.net]));
    const pads = fp.pads.map((p) => {
      const net = nets.get(p.n);
      const ang = ((p.r ?? 0) + r.rot) % 360;
      const drill = p.d === undefined ? "" : Array.isArray(p.d) ? ` (drill oval ${p.d[0]} ${p.d[1]})` : ` (drill ${p.d})`;
      const rr = p.s === "roundrect" ? ` (roundrect_rratio ${p.rr ?? 0.25})` : "";
      const netTxt = net ? ` (net ${netId.get(net)} ${q(netName(net))})` : "";
      return `    (pad ${q(p.n)} ${p.t} ${p.s} (at ${p.x} ${p.y}${ang ? ` ${ang}` : ""}) (size ${p.w} ${p.h})${drill} (layers ${p.l.map(q).join(" ")})${rr}${netTxt} (uuid ${q(uuid())}))`;
    });
    const model = fp.model
      ? `\n    (model ${q(`\${KICAD9_3DMODEL_DIR}/${fp.model.p}.step`)} (offset (xyz ${fp.model.o.join(" ")})) (scale (xyz ${fp.model.s.join(" ")})) (rotate (xyz ${fp.model.r.join(" ")})))`
      : "";
    return `  (footprint ${q(it.footprint)} (layer "F.Cu") (uuid ${q(uuid())}) (at ${X(r.x)} ${Y(r.y)}${r.rot ? ` ${r.rot}` : ""})
${props(it.ref, it.value ?? "")}
    (path ${q(`/${it.symUuid}`)})
    (sheetname "/")
    (sheetfile ${q(sheetFile)})
    (attr ${fp.attr})
${gfx.join("\n")}
${pads.join("\n")}
    (embedded_fonts no)${model}
  )`;
  });

  const text = `(kicad_pcb
  (version 20241229)
  (generator "circuitjs-bom")
  (generator_version "1.0")
  (general (thickness 1.6) (legacy_teardrops no))
  (paper ${q(paper[0])})
${LAYERS}
  (setup (pad_to_mask_clearance 0))
  (net 0 "")
${[...netId].map(([n, id]) => `  (net ${id} ${q(netName(n))})`).join("\n")}
${fps.join("\n")}
  (gr_rect (start ${X(0)} ${Y(0)}) (end ${X(layout.w)} ${Y(layout.l)}) (stroke (width 0.05) (type default)) (fill no) (layer "Edge.Cuts") (uuid ${q(uuid())}))
  (embedded_fonts no)
)
`;
  return { text, nets: netId.size, origin: [ox, oy], paper: paper[0] };
}
