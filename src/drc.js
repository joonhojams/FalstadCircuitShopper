// Independent checker for a routed board: it re-measures everything from the final geometry and does
// not trust the router. Used by the download report, the preview and the tests.
//
// Checks: copper clearance between different nets (net class clearance, 0.15 mm for pad to pad as
// the generated .kicad_dru says), track width, via size and annular ring, via hole spacing, copper
// to board edge, track angles (45 degree multiples, no 90 degree or acute corners), and
// connectivity of every net (copper overlap on a layer, vias and through-hole pads link layers).

import { PARAMS, VIA, NET_CLASSES, classOf } from "./netclass.js";
import { Copper } from "./router.js";
import { distPtRect, distPtSeg, distSegSeg, distSegRect, distRectRect } from "./geom.js";

const TOL = 1e-3;
const R3 = (v) => Math.round(v * 1000) / 1000;

const shapeDist = (a, b) => {
  if (a.k > b.k) [a, b] = [b, a];                 // order: 0 rect, 1 circle, 2 segment
  if (a.k === 0 && b.k === 0) return distRectRect(a, b);
  if (a.k === 0 && b.k === 1) return distPtRect(b.x, b.y, a) - b.r;
  if (a.k === 0) return distSegRect(b, a) - b.hw;
  if (a.k === 1 && b.k === 1) return Math.hypot(a.x - b.x, a.y - b.y) - a.r - b.r;
  if (a.k === 1) return distPtSeg(a.x, a.y, b.x0, b.y0, b.x1, b.y1) - a.r - b.hw;
  return distSegSeg(a, b) - a.hw - b.hw;
};

const padShape = (p, net, clr) => (p.s === "circle"
  ? { k: 1, x: p.x, y: p.y, r: Math.max(p.w, p.h) / 2, net, clr, pad: true }
  : { k: 0, x0: p.x - p.w / 2, y0: p.y - p.h / 2, x1: p.x + p.w / 2, y1: p.y + p.h / 2, net, clr, pad: true });

/**
 * @param {{w: number, l: number, parts: object[], keepouts?: object[]}} layout
 * @param {{tracks: object[], vias: object[]}} routing
 * @param {{classes: Map<string, string>, via?: object}} opts
 */
export function checkBoard(layout, routing, opts) {
  const errors = [], warnings = [];
  const classes = opts.classes;
  const cls = (n) => (n ? classOf(classes, n) : NET_CLASSES.AUDIO_SIG);
  const ids = new Map();
  let anon = -1;
  const idOf = (n) => (n ? (ids.has(n) ? ids.get(n) : (ids.set(n, ids.size + 1), ids.size)) : anon--);

  // ---- items ----
  const items = [];                               // { o, layers:[bool,bool], kind, net, ref, ... }
  const padItems = [];
  for (const part of layout.parts) for (const p of part.pads) {
    const net = p.net ?? null, id = idOf(net);
    const l = p.l ?? [];
    const layers = [l.includes("F.Cu") || l.includes("*.Cu"), l.includes("B.Cu") || l.includes("*.Cu")];
    if (!layers[0] && !layers[1]) continue;
    const it = { o: padShape(p, id, cls(net).clearance), layers, kind: "pad", net, id, label: `${part.it.ref}.${p.n}`, pad: p, tht: p.t === "thru_hole" };
    items.push(it); padItems.push(it);
  }
  for (const t of routing.tracks) {
    const li = t.layer === "F.Cu" ? 0 : 1, id = idOf(t.net);
    for (let k = 0; k + 1 < t.pts.length; k++) {
      items.push({ o: { k: 2, x0: t.pts[k][0], y0: t.pts[k][1], x1: t.pts[k + 1][0], y1: t.pts[k + 1][1], hw: t.w / 2, net: id, clr: cls(t.net).clearance }, layers: [li === 0, li === 1], kind: "track", net: t.net, id, label: `track ${t.net} ${t.layer}`, track: t, seg: k });
    }
  }
  for (const v of routing.vias) {
    const id = idOf(v.net);
    items.push({ o: { k: 1, x: v.x, y: v.y, r: v.size / 2, net: id, clr: cls(v.net).clearance }, layers: [true, true], kind: "via", net: v.net, id, label: `via ${v.net} @${v.x},${v.y}`, via: v });
  }
  for (const k of layout.keepouts ?? []) items.push({ o: { k: 1, x: k.x, y: k.y, r: k.r, net: -1e9, clr: 0 }, layers: [true, true], kind: "keepout", net: null, id: -1e9, label: "keepout" });

  const store = new Copper();
  items.forEach((it, n) => { it.n = n; for (const l of [0, 1]) if (it.layers[l]) store.add(l, { ...it.o, item: it }); });
  const bbox = (o) => (o.k === 0 ? o : o.k === 1 ? { x0: o.x - o.r, y0: o.y - o.r, x1: o.x + o.r, y1: o.y + o.r } : { x0: Math.min(o.x0, o.x1) - o.hw, y0: Math.min(o.y0, o.y1) - o.hw, x1: Math.max(o.x0, o.x1) + o.hw, y1: Math.max(o.y0, o.y1) + o.hw });

  // ---- clearance + connectivity ----
  const parent = items.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { parent[find(a)] = find(b); };
  const seen = new Set();
  for (const it of items) {
    const bb = bbox(it.o), cx = (bb.x0 + bb.x1) / 2, cy = (bb.y0 + bb.y1) / 2, rad = Math.hypot(bb.x1 - bb.x0, bb.y1 - bb.y0) / 2 + 1.2;
    for (const l of [0, 1]) {
      if (!it.layers[l]) continue;
      store.near(l, cx, cy, rad, (q) => {
        const other = q.item;
        if (other === it || other.n < it.n) return;
        const key = `${it.n}:${other.n}:${l}`;
        if (seen.has(key)) return; seen.add(key);
        const d = shapeDist(it.o, other.o);
        if (it.id === other.id && it.id > 0) { if (d <= TOL) union(it.n, other.n); return; }
        if (it.kind === "keepout" || other.kind === "keepout") { if (d < -TOL) errors.push({ type: "keepout", msg: `${(it.kind === "keepout" ? other : it).label} is inside a keep-out area`, x: cx, y: cy }); return; }
        const need = it.kind === "pad" && other.kind === "pad" ? PARAMS.pad_to_pad_min : Math.max(it.o.clr, other.o.clr);
        if (d < need - TOL) errors.push({ type: "clearance", msg: `${it.label} to ${other.label} on ${l === 0 ? "F.Cu" : "B.Cu"}: ${R3(Math.max(d, 0))} mm, needs ${need} mm`, x: R3(cx), y: R3(cy) });
      });
    }
  }
  // a via links both layers, a through-hole pad too: items that touch it on either layer already share a set through it,
  // because those items were unioned on the layer where they overlap the via / pad itself.

  // ---- connectivity per net ----
  const unrouted = [];
  const padsByNet = new Map();
  for (const it of padItems) if (it.net) (padsByNet.get(it.net) ?? padsByNet.set(it.net, []).get(it.net)).push(it);
  const pourPads = [];                 // pads that rely on the ground pour being filled in KiCad
  const viaRoots = new Set(items.filter((i) => i.kind === "via" && i.net === opts.pour).map((i) => find(i.n)));
  for (const [net, pads] of padsByNet) {
    if (pads.length < 2) continue;
    if (opts.pour && net === opts.pour) {
      // a pour net is complete when every SMD pad has a track to a via into the pour; through-hole pads reach it directly
      const loose = pads.filter((p) => !p.tht && !viaRoots.has(find(p.n)));
      for (const p of pads) if (p.tht) pourPads.push(p.label);
      if (loose.length) unrouted.push({ net, parts: loose.length, pads: loose.map((p) => p.label), pour: true });
      continue;
    }
    const roots = new Set(pads.map((p) => find(p.n)));
    if (roots.size > 1) unrouted.push({ net, parts: roots.size, pads: pads.map((p) => p.label) });
  }

  // ---- tracks ----
  const W = layout.w, L = layout.l, edge = PARAMS.copper_to_edge_min;
  for (const t of routing.tracks) {
    const c = cls(t.net);
    if (t.w < c.track - TOL) errors.push({ type: "width", msg: `${t.net} ${t.layer}: track ${t.w} mm is narrower than the ${c.track} mm of its net class`, x: t.pts[0][0], y: t.pts[0][1] });
    for (const [x, y] of t.pts) {
      if (x - t.w / 2 < edge - TOL || y - t.w / 2 < edge - TOL || x + t.w / 2 > W - edge + TOL || y + t.w / 2 > L - edge + TOL) errors.push({ type: "edge", msg: `${t.net} ${t.layer}: copper within ${edge} mm of the board edge at ${x},${y}`, x, y });
    }
    for (let k = 0; k + 1 < t.pts.length; k++) {
      const dx = t.pts[k + 1][0] - t.pts[k][0], dy = t.pts[k + 1][1] - t.pts[k][1];
      const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
      if (Math.abs(ang / 45 - Math.round(ang / 45)) > 0.01) errors.push({ type: "angle", msg: `${t.net} ${t.layer}: segment at ${R3(ang)} degrees, only 0/45/90 are used`, x: t.pts[k][0], y: t.pts[k][1] });
      if (k > 0) {
        const px = t.pts[k][0] - t.pts[k - 1][0], py = t.pts[k][1] - t.pts[k - 1][1];
        let turn = Math.abs(((Math.atan2(dy, dx) - Math.atan2(py, px)) * 180) / Math.PI);
        if (turn > 180) turn = 360 - turn;
        if (turn > 45 + 0.01) errors.push({ type: "corner", msg: `${t.net} ${t.layer}: ${R3(turn)} degree turn at ${t.pts[k][0]},${t.pts[k][1]} (90 degree and acute corners are not allowed)`, x: t.pts[k][0], y: t.pts[k][1] });
      }
    }
  }
  // ---- vias ----
  const via = opts.via ?? VIA;
  for (const v of routing.vias) {
    if (v.size < VIA.min_size - TOL || v.drill < VIA.min_drill - TOL) errors.push({ type: "via", msg: `via ${v.net} ${v.size}/${v.drill} mm is below the minimum ${VIA.min_size}/${VIA.min_drill}`, x: v.x, y: v.y });
    if ((v.size - v.drill) / 2 < VIA.annular_min - TOL) errors.push({ type: "annular", msg: `via ${v.net} @${v.x},${v.y}: annular ring ${R3((v.size - v.drill) / 2)} mm is below ${VIA.annular_min} mm`, x: v.x, y: v.y });
    if (v.x - v.size / 2 < edge - TOL || v.y - v.size / 2 < edge - TOL || v.x + v.size / 2 > W - edge + TOL || v.y + v.size / 2 > L - edge + TOL) errors.push({ type: "edge", msg: `via ${v.net} @${v.x},${v.y} is within ${edge} mm of the board edge`, x: v.x, y: v.y });
  }
  for (let a = 0; a < routing.vias.length; a++) for (let b = a + 1; b < routing.vias.length; b++) {
    const A = routing.vias[a], B = routing.vias[b];
    const h = Math.hypot(A.x - B.x, A.y - B.y) - A.drill / 2 - B.drill / 2;
    if (h < PARAMS.hole_to_hole_min - TOL) errors.push({ type: "hole", msg: `vias @${A.x},${A.y} and @${B.x},${B.y}: ${R3(h)} mm between holes, needs ${PARAMS.hole_to_hole_min} mm`, x: A.x, y: A.y });
  }
  // ---- audio via count (spec audio_via_max_per_net) ----
  const perNet = new Map();
  for (const v of routing.vias) if (!v.stitch) perNet.set(v.net, (perNet.get(v.net) ?? 0) + 1);
  for (const [n, c] of perNet) if ((classes.get(n) === "AUDIO_SIG" || classes.get(n) === "HIGH_Z") && c > PARAMS.audio_via_max_per_net) warnings.push({ type: "audio-vias", msg: `${n} has ${c} vias, the spec allows ${PARAMS.audio_via_max_per_net} on an audio net` });

  return { ok: errors.length === 0 && unrouted.length === 0, errors, warnings, unrouted, pourPads, stats: { items: items.length, errors: errors.length, unrouted: unrouted.length } };
}
