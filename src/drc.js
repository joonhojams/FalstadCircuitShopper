// An independent check of a routed board: copper clearance between nets, copper to the board edge,
// via annular ring and hole to hole spacing, and connectivity (every net's pads end up in one piece).
// It re-derives the copper from the finished output (pads, tracks, vias) and shares no state with the
// router, so a router bug cannot hide itself. It is not KiCad's DRC: run that too.
//
// Ground is connected through the bottom-layer pour, as modelled by pour.js (the same model the router
// plans with, so it is shared code, not an independent check of that model). Everything else is
// checked from the copper alone.

import { gap, bbox } from "./geom.js";
import { buildPour } from "./pour.js";

const EPS = 1e-6;

/** Gap between two copper shapes (negative when they overlap). */
function shapeGap(a, b) {
  if (a.t === "seg") return gap(a.ax, a.ay, a.bx, a.by, a.hw, b);
  if (b.t === "seg") return gap(b.ax, b.ay, b.bx, b.by, b.hw, a);
  if (a.t === "circle" && b.t === "circle") return Math.hypot(a.x - b.x, a.y - b.y) - a.r - b.r;
  if (a.t === "circle") return rectPt(b, a.x, a.y) - a.r;
  if (b.t === "circle") return rectPt(a, b.x, b.y) - b.r;
  const dx = Math.max(b.x0 - a.x1, a.x0 - b.x1, 0), dy = Math.max(b.y0 - a.y1, a.y0 - b.y1, 0);
  return Math.hypot(dx, dy);
}
const rectPt = (r, x, y) => Math.hypot(Math.max(r.x0 - x, 0, x - r.x1), Math.max(r.y0 - y, 0, y - r.y1));

/** Rounded-rectangle outline: how far inside the board a point is (negative outside). */
function depthInside(x, y, w, l, r) {
  const qx = Math.abs(x - w / 2) - (w / 2 - r), qy = Math.abs(y - l / 2) - (l / 2 - r);
  return -(Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r);
}

/**
 * @param {{w: number, l: number, cornerRadius?: number, parts: object[]}} layout placed parts with pads {x,y,w,h,s,t,d,l,net,n}
 * @param {{tracks: object[], vias: object[]}} routed tracks {layer,x1,y1,x2,y2,w,net}, vias {x,y,net}
 * @param {{rules: object, classOf: Map<string,string>}} ctx
 */
export function checkBoard(layout, routed, { rules, classOf }) {
  const clearOf = (net) => rules.classes[classOf.get(net) ?? "Default"]?.clear ?? rules.classes.Default.clear;
  const clr = (a, b) => Math.max(clearOf(a), clearOf(b));
  const P = rules.params;
  const violations = [];
  const R = layout.cornerRadius ?? 1;

  // ---- copper ----
  const shapes = [];                       // {id, layer, s, net, kind, label}
  let id = 0;
  const holes = [];                        // {x, y, r, label}
  const padsOfNet = new Map();             // net -> [id]
  for (const rec of layout.parts) {
    for (const p of rec.pads) {
      const myId = id++;
      if (p.d) holes.push({ x: p.x, y: p.y, r: (Array.isArray(p.d) ? Math.max(p.d[0], p.d[1]) : p.d) / 2, label: `${rec.it.ref}.${p.n}`, pad: true });
      if (p.t === "np_thru_hole") continue;
      const layers = p.t === "thru_hole" ? [0, 1] : (p.l ?? []).includes("B.Cu") && !(p.l ?? []).includes("F.Cu") ? [1] : [0];
      const s = p.s === "circle" ? { t: "circle", x: p.x, y: p.y, r: Math.min(p.w, p.h) / 2 } : { t: "rect", x0: p.x - p.w / 2, y0: p.y - p.h / 2, x1: p.x + p.w / 2, y1: p.y + p.h / 2 };
      const net = p.net ?? `~nc${myId}`;
      for (const L of layers) shapes.push({ id: myId, layer: L, s, net, kind: "pad", label: `${rec.it.ref}.${p.n}` });
      if (p.net) (padsOfNet.get(p.net) ?? padsOfNet.set(p.net, []).get(p.net)).push(myId);
    }
  }
  for (const t of routed.tracks) {
    const myId = id++;
    shapes.push({ id: myId, layer: t.layer, s: { t: "seg", ax: t.x1, ay: t.y1, bx: t.x2, by: t.y2, hw: t.w / 2 }, net: t.net, kind: "track", label: `track ${t.net} (${t.x1},${t.y1})-(${t.x2},${t.y2}) ${t.layer ? "B" : "F"}.Cu` });
  }
  const vr = rules.via.pad / 2;
  for (const v of routed.vias) {
    const myId = id++;
    for (const L of [0, 1]) shapes.push({ id: myId, layer: L, s: { t: "circle", x: v.x, y: v.y, r: vr }, net: v.net, kind: "via", label: `via ${v.net} (${v.x},${v.y})` });
    holes.push({ x: v.x, y: v.y, r: rules.via.drill / 2, label: `via ${v.net} (${v.x},${v.y})` });
    if ((rules.via.pad - rules.via.drill) / 2 < P.annular_min - EPS) violations.push({ type: "annular", detail: `via at (${v.x}, ${v.y}) has a ${((rules.via.pad - rules.via.drill) / 2).toFixed(3)} mm ring, below ${P.annular_min}` });
  }

  // ---- clearance between different nets, per layer, through a spatial hash ----
  const CELL = 4;
  for (const layer of [0, 1]) {
    const grid = new Map();
    const list = shapes.filter((x) => x.layer === layer);
    list.forEach((sh, i) => {
      const b = bbox(sh.s, 1);
      for (let ix = Math.floor(b[0] / CELL); ix <= Math.floor(b[2] / CELL); ix++) for (let iy = Math.floor(b[1] / CELL); iy <= Math.floor(b[3] / CELL); iy++) {
        const k = ix * 65536 + iy;
        (grid.get(k) ?? grid.set(k, []).get(k)).push(i);
      }
    });
    const done = new Set();
    for (const idxs of grid.values()) {
      for (let a = 0; a < idxs.length; a++) for (let b = a + 1; b < idxs.length; b++) {
        const i = idxs[a], j = idxs[b], key = i < j ? i * 1e6 + j : j * 1e6 + i;
        if (done.has(key)) continue;
        done.add(key);
        const A = list[i], B = list[j];
        if (A.net === B.net || A.id === B.id) continue;
        if (A.kind === "pad" && B.kind === "pad") continue;            // footprint spacing, KiCad's DRC covers it
        const g = shapeGap(A.s, B.s), need = clr(A.net, B.net);
        if (g < need - EPS) violations.push({ type: g <= EPS ? "short" : "clearance", layer: layer ? "B.Cu" : "F.Cu", a: A.label, b: B.label, gap: Math.round(g * 1000) / 1000, need });
      }
    }
  }

  // ---- edge, annular ring, hole to hole ----
  for (const t of routed.tracks) {
    for (const [x, y] of [[t.x1, t.y1], [t.x2, t.y2]]) {
      if (depthInside(x, y, layout.w, layout.l, R) < P.copper_to_edge_min + t.w / 2 - EPS) { violations.push({ type: "edge", detail: `track ${t.net} end (${x}, ${y}) is closer than ${P.copper_to_edge_min} mm to the board edge` }); break; }
    }
  }
  for (const v of routed.vias) if (depthInside(v.x, v.y, layout.w, layout.l, R) < P.copper_to_edge_min + vr - EPS) violations.push({ type: "edge", detail: `via ${v.net} (${v.x}, ${v.y}) is too close to the board edge` });
  for (let i = 0; i < holes.length; i++) for (let j = i + 1; j < holes.length; j++) {
    const a = holes[i], b = holes[j];
    if (Math.abs(a.x - b.x) > 6 || Math.abs(a.y - b.y) > 6) continue;
    const g = Math.hypot(a.x - b.x, a.y - b.y) - a.r - b.r;
    if (g < P.hole_to_hole_min - EPS && !(a.pad && b.pad)) violations.push({ type: "hole-to-hole", detail: `${a.label} and ${b.label}: ${g.toFixed(3)} mm between holes, need ${P.hole_to_hole_min}` });
  }

  // ---- connectivity ----
  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  for (const sh of shapes) parent.set(sh.id, sh.id);
  for (const layer of [0, 1]) {
    const list = shapes.filter((x) => x.layer === layer && !x.net.startsWith("~nc"));
    const byNet = new Map();
    for (const sh of list) (byNet.get(sh.net) ?? byNet.set(sh.net, []).get(sh.net)).push(sh);
    for (const group of byNet.values()) {
      for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
        if (find(group[i].id) === find(group[j].id)) continue;
        if (shapeGap(group[i].s, group[j].s) <= EPS) union(group[i].id, group[j].id);
      }
    }
  }
  // Ground shapes that touch the same region of the bottom pour are one piece.
  for (const net of padsOfNet.keys()) {
    if (classOf.get(net) !== "GND") continue;
    const bottom = shapes.filter((x) => x.layer === 1);
    const pour = buildPour(layout, bottom.map((x) => ({ s: x.s, net: x.net })), { net, clearOf: (n) => clearOf(n), pourClear: P.pour_clear, edge: P.copper_to_edge_min + 0.2, finger: P.pour_finger_min });
    for (const sh of bottom) {
      if (sh.net !== net) continue;
      for (const c of pour.touching(sh.s)) {
        const key = `pour:${net}:${c}`;
        if (!parent.has(key)) parent.set(key, key);
        union(sh.id, key);
      }
    }
  }
  const opens = [];
  for (const [net, ids] of padsOfNet) {
    if (ids.length < 2) continue;
    const comps = new Set(ids.map(find));
    if (comps.size > 1) opens.push({ net, pieces: comps.size });
  }
  return { ok: violations.length === 0 && opens.length === 0, violations, opens, stats: { shapes: shapes.length, tracks: routed.tracks.length, vias: routed.vias.length } };
}

/** Total track length per net in mm, for the report (spec check A2). */
export function trackLengths(tracks) {
  const out = new Map();
  for (const t of tracks) out.set(t.net, (out.get(t.net) ?? 0) + Math.hypot(t.x2 - t.x1, t.y2 - t.y1));
  return new Map([...out].map(([k, v]) => [k, Math.round(v * 10) / 10]));
}

