// A small two-layer grid router for the placed board. It routes every net, ground last and mostly on
// the bottom layer (a ground pour is added on top of that, see pcb.js), with the width and clearance
// of the net's class, on 45 degree moves, using vias only where they pay for themselves. All clearance tests are exact (segment to pad / track / via
// distances), the grid only decides where a track may turn.
//
// Layer 0 is F.Cu, layer 1 is B.Cu. Coordinates are board millimetres, origin at the outline's
// top-left corner, y down.
//
// It is deliberately simple: no rip-up of finished nets (a failed net is retried first in a second
// pass), no push-and-shove. Nets it cannot finish stay as ratsnest and are listed.
//
// Ground is not routed as a tree. The bottom layer is a ground pour (pour.js models where it can
// fill); each ground pad that does not already touch the main pour region gets a short stub and a via
// to it.
//
// Effort is bounded by a count of search steps (`budget`), not by time: Cloudflare Workers freeze the
// clock while code runs, so a deadline would never fire there. `deadline` is only honoured where
// Date.now() moves (tests, Node).

import { gap, bbox, Heap } from "./geom.js";
import { buildPour } from "./pour.js";

const CELL = 4;                                   // spatial hash cell, mm
const R4 = (v) => Math.round(v * 10000) / 10000;
const SQ2 = Math.SQRT2;
const DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

/** Copper and holes of a board, indexed for distance queries. */
export class Copper {
  /**
   * @param {{w: number, l: number, r: number, edge: number, via: {pad: number, drill: number}, clearOf: (net: string) => number, holeToHole: number}} o
   */
  constructor(o) {
    Object.assign(this, o);
    this.cells = [new Map(), new Map()];
    this.holes = new Map();
    this.stamp = 0;
    this.maxClear = o.maxClear ?? 0.5;
  }
  key(ix, iy) { return ix * 65536 + iy; }
  eachCell(b, fn) {
    for (let ix = Math.floor(b[0] / CELL); ix <= Math.floor(b[2] / CELL); ix++) for (let iy = Math.floor(b[1] / CELL); iy <= Math.floor(b[3] / CELL); iy++) fn(this.key(ix, iy));
  }
  add(layer, shape) {
    shape.bb = shape.bb ?? bbox(shape);
    this.eachCell(shape.bb, (k) => (this.cells[layer].get(k) ?? this.cells[layer].set(k, []).get(k)).push(shape));
  }
  addHole(x, y, r, net = "") {
    const h = { x, y, r, net };
    this.eachCell([x - r, y - r, x + r, y + r], (k) => (this.holes.get(k) ?? this.holes.set(k, []).get(k)).push(h));
  }
  clr(a, b) { return Math.max(this.clearOf(a), this.clearOf(b)); }

  /** Is the point inside the board, at least `e` from the outline (a rounded rectangle, which is convex)? */
  inside(x, y, e) {
    const { w, l, r } = this;
    const qx = Math.abs(x - w / 2) - (w / 2 - r), qy = Math.abs(y - l / 2) - (l / 2 - r);
    const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
    return -d >= e - 1e-9;
  }

  /** A capsule (a-b, half-width h) of `net` on `layer` keeps its distance from every other net's copper. */
  free(layer, ax, ay, bx, by, h, net) {
    if (!this.inside(ax, ay, this.edge + h) || !this.inside(bx, by, this.edge + h)) return false;
    const reach = h + this.maxClear + 0.01;
    const q = [Math.min(ax, bx) - reach, Math.min(ay, by) - reach, Math.max(ax, bx) + reach, Math.max(ay, by) + reach];
    const st = ++this.stamp;
    let ok = true;
    this.eachCell(q, (k) => {
      if (!ok) return;
      const list = this.cells[layer].get(k);
      if (!list) return;
      for (const s of list) {
        if (s.mark === st || s.net === net) continue;
        s.mark = st;
        const bb = s.bb;                                         // cheap reject before the exact distance
        if (bb[2] < q[0] || bb[0] > q[2] || bb[3] < q[1] || bb[1] > q[3]) continue;
        if (gap(ax, ay, bx, by, h, s) < this.clr(s.net, net) - 1e-9) { ok = false; return; }
      }
    });
    return ok;
  }

  /** A via of `net` fits at (x, y): clear on both layers, off every pad, and away from other holes. */
  viaFree(x, y, net) {
    const r = this.via.pad / 2;
    for (const layer of [0, 1]) {
      if (!this.free(layer, x, y, x, y, r, net)) return false;
      const st = ++this.stamp;
      let bad = false;
      this.eachCell([x - r - 0.3, y - r - 0.3, x + r + 0.3, y + r + 0.3], (k) => {
        for (const s of this.cells[layer].get(k) ?? []) {
          if (s.mark === st || s.kind !== "pad") continue;
          s.mark = st;
          if (gap(x, y, x, y, r, s) < 0.15) bad = true;       // RT-09: never in a pad
        }
      });
      if (bad) return false;
    }
    const hr = this.via.drill / 2;
    let bad = false;
    const st2 = new Set();
    this.eachCell([x - 2, y - 2, x + 2, y + 2], (k) => {
      for (const h of this.holes.get(k) ?? []) {
        if (st2.has(h)) continue;
        st2.add(h);
        if (Math.hypot(h.x - x, h.y - y) < h.r + hr + this.holeToHole - 1e-9) bad = true;
      }
    });
    return !bad;
  }
}

/** Copper shape and layers of a placed pad. */
export function padShape(p, idx) {
  const net = p.net ?? `~nc${idx}`;
  if (p.t === "np_thru_hole") return null;
  const layers = p.t === "thru_hole" ? [0, 1] : (p.l ?? []).includes("B.Cu") && !(p.l ?? []).includes("F.Cu") ? [1] : [0];
  const shape = p.s === "circle"
    ? { t: "circle", x: p.x, y: p.y, r: Math.min(p.w, p.h) / 2, net, kind: "pad" }
    : { t: "rect", x0: p.x - p.w / 2, y0: p.y - p.h / 2, x1: p.x + p.w / 2, y1: p.y + p.h / 2, net, kind: "pad" };
  return { shape, layers };
}
const drillR = (d) => (Array.isArray(d) ? Math.max(d[0], d[1]) : d) / 2;

/** The static board: pads and drilled holes. */
export function buildCopper(layout, rules, classOf) {
  const clearOf = (net) => rules.classes[classOf.get(net) ?? "Default"]?.clear ?? rules.classes.Default.clear;
  const cu = new Copper({
    w: layout.w, l: layout.l, r: layout.cornerRadius ?? 1, edge: rules.params.copper_to_edge_min, via: rules.via, clearOf,
    holeToHole: rules.params.hole_to_hole_min, maxClear: Math.max(...Object.values(rules.classes).map((c) => c.clear)),
  });
  let idx = 0;
  const pads = [];
  for (const rec of layout.parts) {
    for (const p of rec.pads) {
      const ps = padShape(p, idx++);
      if (p.d) cu.addHole(p.x, p.y, drillR(p.d));
      if (!ps) continue;
      for (const L of ps.layers) cu.add(L, ps.shape);
      pads.push({ ref: rec.it.ref, num: p.n, net: p.net, shape: ps.shape, layers: ps.layers, pad: p });
    }
  }
  return { cu, pads };
}

const CLASS_ORDER = { HIGH_Z: 0, AUDIO_SIG: 1, BIAS_VREF: 2, LED_CTRL: 3, POWER: 4, GND: 5 };
const VIA_COST = { HIGH_Z: 40, AUDIO_SIG: 8, BIAS_VREF: 5, LED_CTRL: 4, POWER: 4, GND: 3 };       // mm of detour a via is worth
const BOTTOM = { HIGH_Z: 1.8, AUDIO_SIG: 1.6, BIAS_VREF: 1.3, LED_CTRL: 1.2, POWER: 1.2, GND: 0.8 };  // RT-01: top layer preferred

/**
 * Routes the placed board.
 * @param {{w: number, l: number, parts: object[]}} layout
 * @param {{rules: object, classOf: Map<string, string>, deadline?: number}} ctx
 * @returns {{tracks: object[], vias: object[], failures: object[], routedNets: number, passes: number}}
 */
export function routeBoard(layout, { rules, classOf, deadline = Infinity, budget = 1_500_000 }) {
  let ops = 0;
  const g = rules.grid.route;
  const NX = Math.floor(layout.w / g) + 1, NY = Math.floor(layout.l / g) + 1;
  const S = NX * NY * 2 * 8;
  const gCost = new Float64Array(S), parent = new Int32Array(S), seen = new Uint32Array(S);
  let gen = 0;

  // Nets to route: every net with two or more pads.
  const padsByNet = new Map();
  const baseline = buildCopper(layout, rules, classOf);
  for (const p of baseline.pads) if (p.net) (padsByNet.get(p.net) ?? padsByNet.set(p.net, []).get(p.net)).push(p);
  const nets = [...padsByNet].filter(([, ps]) => ps.length >= 2).map(([net, ps]) => ({ net, pads: ps, cls: classOf.get(net) ?? "AUDIO_SIG", len: mstLength(ps) }));
  const rank = (n) => CLASS_ORDER[n.cls] ?? 1;
  nets.sort((a, b) => rank(a) - rank(b) || a.len - b.len);

  const nodeOf = (layer, ix, iy) => (layer * NX + ix) * NY + iy;

  function attempt(order) {
    const { cu, pads } = buildCopper(layout, rules, classOf);
    const tracks = [], vias = [], failures = [], grounds = [], gstate = new Map();
    for (const n of order) {
      const track = rules.classes[n.cls]?.track ?? rules.classes.Default.track, h = track / 2;
      const viaCost = VIA_COST[n.cls] ?? 6, bottom = BOTTOM[n.cls] ?? 1.3;
      const valid = new Map();                                 // node -> point is clear for this net
      const okNode = (layer, ix, iy) => {
        const k = nodeOf(layer, ix, iy);
        let v = valid.get(k);
        if (v === undefined) { v = cu.free(layer, ix * g, iy * g, ix * g, iy * g, h, n.net); valid.set(k, v); }
        return v;
      };
      const viaOk = new Map(), edgeOk = new Map();
      const okVia = (ix, iy) => {
        const k = ix * NY + iy;
        let v = viaOk.get(k);
        if (v === undefined) { v = cu.viaFree(ix * g, iy * g, n.net); viaOk.set(k, v); }
        return v;
      };
      const entry = (p) => {                                   // grid nodes that lie inside the pad
        const s = p.shape, out = [];
        const [x0, y0, x1, y1] = bbox(s);
        for (const layer of p.layers) {
          for (let ix = Math.max(0, Math.ceil(x0 / g - 1e-9)); ix <= Math.min(NX - 1, Math.floor(x1 / g + 1e-9)); ix++) {
            for (let iy = Math.max(0, Math.ceil(y0 / g - 1e-9)); iy <= Math.min(NY - 1, Math.floor(y1 / g + 1e-9)); iy++) {
              if (s.t === "circle" && Math.hypot(ix * g - s.x, iy * g - s.y) > s.r) continue;
              if (okNode(layer, ix, iy)) out.push([layer, ix, iy]);
            }
          }
        }
        return out;
      };

      if (n.cls === "GND") {
        // Ground is a pour on the bottom layer. Pass "fanout" (before the signals) gives every
        // surface-mount ground pad a stub and a via into the pour while there is still room; pass
        // "repair" (after them) reconnects any ground piece the signals cut off from the main region.
        const st = gstate.get(n.net) ?? gstate.set(n.net, { anchors: [], stubbed: new Set() }).get(n.net);
        const pour = buildPour(layout, copperOn(cu, 1), { net: n.net, clearOf: cu.clearOf, pourClear: rules.params.pour_clear, edge: rules.params.copper_to_edge_min + 0.2, finger: rules.params.pour_finger_min });
        const bottomPads = n.pads.filter((p) => p.layers.includes(1));
        const pieces = [...bottomPads.map((p) => ({ shape: p.shape, pad: p })), ...st.anchors];     // things already on the bottom layer
        const votes = new Map();
        for (const pc of pieces) { pc.regions = pour.touching(pc.shape); for (const c of pc.regions) votes.set(c, (votes.get(c) ?? 0) + 1); }
        let main = -1, most = 0;
        for (const [c, v] of votes) if (v > most) { most = v; main = c; }
        if (main < 0) pour.size.forEach((sz, c) => { if (main < 0 || sz > pour.size[main]) main = c; });
        const info = { net: n.net, region: main, regions: pour.size.length, coverage: Math.round(pour.coverage() * 100) / 100 };
        const at = grounds.findIndex((x) => x.net === n.net);
        if (at >= 0) grounds[at] = info; else grounds.push(info);
        const fail = (p, reason) => { if (n.phase === "repair") failures.push({ net: n.net, cls: n.cls, to: `${p.ref}.${p.num}`, reason }); };
        if (main < 0) { for (const p of n.pads) fail(p, "no room for a ground pour"); continue; }
        const target = new Set();
        for (let ix = 0; ix < NX; ix++) for (let iy = 0; iy < NY; iy++) if (pour.at(ix * g, iy * g) === main) target.add(nodeOf(1, ix, iy));
        const commit = (found) => {
          for (const t of found.tracks) { tracks.push({ ...t, w: track, net: n.net, cls: n.cls }); cu.add(t.layer, { t: "seg", ax: t.x1, ay: t.y1, bx: t.x2, by: t.y2, hw: h, net: n.net, kind: "track" }); }
          for (const v of found.vias) { vias.push({ ...v, net: n.net, cls: n.cls }); for (const L of [0, 1]) cu.add(L, { t: "circle", x: v.x, y: v.y, r: rules.via.pad / 2, net: n.net, kind: "via" }); cu.addHole(v.x, v.y, rules.via.drill / 2, n.net); }
          valid.clear(); viaOk.clear(); edgeOk.clear();
        };
        const stub = (p) => {                                   // route pad p into the main region; remember where it lands
          const src = new Set(entry(p).map(([l, x, y]) => nodeOf(l, x, y)));
          if (!src.size) { fail(p, "no clear grid point inside the pad"); return; }
          const found = search(src, target, null);
          if (!found) { fail(p, "no path to the ground pour"); return; }
          commit(found);
          const last = found.nodes[found.nodes.length - 1], iy = last % NY, ix = ((last - iy) / NY) % NX;
          st.anchors.push({ shape: { t: "circle", x: ix * g, y: iy * g, r: h, net: n.net }, node: last, ix, iy });
          st.stubbed.add(p);
        };
        if (n.phase === "fanout") {
          for (const p of n.pads) if (!p.layers.includes(1)) stub(p);
        } else {
          for (const p of n.pads) if (!p.layers.includes(1) && !st.stubbed.has(p)) stub(p);                         // fan-out failed earlier
          for (const pc of pieces) {
            if (pc.regions.has(main)) continue;
            if (pc.pad) { stub(pc.pad); continue; }
            const found = search(new Set([pc.node]), target, null);                                                 // a stub's end that was cut off
            if (found) commit(found); else failures.push({ net: n.net, cls: n.cls, to: `stub at (${pc.ix * g}, ${pc.iy * g})`, reason: "cut off from the ground pour" });
          }
        }
        continue;
      }

      // Grow a tree: start from the first pad and attach the nearest remaining pad each time.
      const inTree = [n.pads[0]], rest = n.pads.slice(1);
      const treeNodes = new Set();
      const myTracks = [], myVias = [];
      for (const [layer, ix, iy] of entry(inTree[0])) treeNodes.add(nodeOf(layer, ix, iy));
      let failed = false;
      while (rest.length) {
        let bi = 0, bd = Infinity;
        rest.forEach((p, i) => inTree.forEach((t) => { const d = Math.abs(p.pad.x - t.pad.x) + Math.abs(p.pad.y - t.pad.y); if (d < bd) { bd = d; bi = i; } }));
        const target = rest.splice(bi, 1)[0];
        const tEntry = entry(target);
        const found = tEntry.length ? search(treeNodes, new Set(tEntry.map(([l, x, y]) => nodeOf(l, x, y))), target) : null;
        if (!found) { failures.push({ net: n.net, cls: n.cls, to: `${target.ref}.${target.num}`, reason: tEntry.length ? "no path" : "no clear grid point inside the pad" }); failed = true; continue; }
        for (const nd of found.nodes) treeNodes.add(nd);
        for (const t of found.tracks) myTracks.push(t);
        for (const v of found.vias) myVias.push(v);
        inTree.push(target);
        for (const [layer, ix, iy] of tEntry) treeNodes.add(nodeOf(layer, ix, iy));
        // new copper becomes an obstacle for the nets routed after this one
        for (const t of found.tracks) cu.add(t.layer, { t: "seg", ax: t.x1, ay: t.y1, bx: t.x2, by: t.y2, hw: h, net: n.net, kind: "track" });
        for (const v of found.vias) { for (const L of [0, 1]) cu.add(L, { t: "circle", x: v.x, y: v.y, r: rules.via.pad / 2, net: n.net, kind: "via" }); cu.addHole(v.x, v.y, rules.via.drill / 2, n.net); }
        valid.clear(); viaOk.clear(); edgeOk.clear();
      }
      void failed;
      tracks.push(...myTracks.map((t) => ({ ...t, w: track, net: n.net, cls: n.cls })));
      vias.push(...myVias.map((v) => ({ ...v, net: n.net, cls: n.cls })));

      /** A* from every tree node to any entry node of the target pad. */
      function search(sources, tset, targetPad) {
        gen++;
        const open = new Heap();
        const tx = targetPad?.pad.x, ty = targetPad?.pad.y;
        const ext = targetPad ? Math.max(targetPad.pad.w, targetPad.pad.h) / 2 : 0;
        const hfn = targetPad ? (ix, iy) => { const dx = Math.abs(ix * g - tx), dy = Math.abs(iy * g - ty); return Math.max(0, (Math.max(dx, dy) + (SQ2 - 1) * Math.min(dx, dy)) - ext); } : () => 0;
        const dec = (s) => { const dir = s % 8, nd = (s - dir) / 8, iy = nd % NY, r = (nd - iy) / NY, ix = r % NX, layer = (r - ix) / NX; return [layer, ix, iy, dir]; };
        for (const nd of sources) {
          const iy = nd % NY, r = (nd - iy) / NY, ix = r % NX, layer = (r - ix) / NX;
          const s = nd * 8 + 0;
          seen[s] = gen; gCost[s] = 0; parent[s] = -1;
          open.push(hfn(ix, iy), s);
        }
        let expanded = 0, goal = -1;
        while (open.size) {
          expanded++;
          if (++ops > budget || expanded > 80000) break;
          if ((expanded & 0x3fff) === 0 && Date.now() > deadline) break;
          const s = open.pop();
          const [layer, ix, iy, dir] = dec(s);
          const gc = gCost[s];
          if (tset.has(nodeOf(layer, ix, iy))) { goal = s; break; }
          const here = hfn(ix, iy);
          void here;
          const x = ix * g, y = iy * g;
          for (let d = 0; d < 8; d++) {
            const nx = ix + DIRS[d][0], ny = iy + DIRS[d][1];
            if (nx < 0 || ny < 0 || nx >= NX || ny >= NY) continue;
            if (!okNode(layer, nx, ny)) continue;
            const ek = (nodeOf(layer, ix, iy) << 3) | d;
            let eok = edgeOk.get(ek);
            if (eok === undefined) { eok = cu.free(layer, x, y, nx * g, ny * g, h, n.net); edgeOk.set(ek, eok); }
            if (!eok) continue;
            const step = (d & 1 ? SQ2 : 1) * g * (layer ? bottom : 1);
            const turn = dir === d || gc === 0 ? 0 : 0.25 * g * (Math.min((d - dir + 8) % 8, (dir - d + 8) % 8));
            const ns = nodeOf(layer, nx, ny) * 8 + d;
            const c = gc + step + turn;
            if (seen[ns] !== gen || c < gCost[ns] - 1e-9) { seen[ns] = gen; gCost[ns] = c; parent[ns] = s; open.push(c + hfn(nx, ny), ns); }
          }
          // switch layer
          if (okVia(ix, iy) && okNode(1 - layer, ix, iy)) {
            const ns = nodeOf(1 - layer, ix, iy) * 8 + dir;
            const c = gc + viaCost;
            if (seen[ns] !== gen || c < gCost[ns] - 1e-9) { seen[ns] = gen; gCost[ns] = c; parent[ns] = s; open.push(c + hfn(ix, iy), ns); }
          }
        }
        if (goal < 0) return null;
        // walk back
        const path = [];
        for (let s = goal; s >= 0; s = parent[s]) path.push(dec(s));
        path.reverse();
        const outTracks = [], outVias = [], outNodes = [];
        let segStart = null, segDir = -1, segLayer = -1, prev = null;
        const flush = (end) => { if (segStart && (segStart[0] !== end[0] || segStart[1] !== end[1])) outTracks.push({ layer: segLayer, x1: R4(segStart[0] * g), y1: R4(segStart[1] * g), x2: R4(end[0] * g), y2: R4(end[1] * g) }); };
        for (const [layer, ix, iy] of path) {
          outNodes.push(nodeOf(layer, ix, iy));
          if (prev) {
            const [pl, px, py] = prev;
            if (pl !== layer) { flush([px, py]); outVias.push({ x: R4(px * g), y: R4(py * g) }); segStart = [ix, iy]; segDir = -1; segLayer = layer; prev = [layer, ix, iy]; continue; }
            const dx = ix - px, dy = iy - py, dd = DIRS.findIndex(([a, b]) => a === dx && b === dy);
            if (dd !== segDir) { flush([px, py]); segStart = [px, py]; segDir = dd; segLayer = layer; }
          } else { segStart = [ix, iy]; segLayer = layer; }
          prev = [layer, ix, iy];
        }
        if (prev) flush([prev[1], prev[2]]);
        return { nodes: outNodes, tracks: outTracks, vias: outVias };
      }
    }
    return { tracks, vias, failures, grounds, cu, pads };
  }

  const gnd = nets.filter((n) => n.cls === "GND"), signals = nets.filter((n) => n.cls !== "GND");
  const plan = (sig) => [...gnd.map((n) => ({ ...n, phase: "fanout" })), ...sig, ...gnd.map((n) => ({ ...n, phase: "repair" }))];
  // Negotiation: nets that fail go earlier in the next pass, up to four passes, keeping the best result.
  const bump = new Map();
  let best = attempt(plan(signals)), passes = 1;
  while (best.failures.length && passes < 4 && Date.now() < deadline && ops < budget * 0.75) {
    for (const f of best.failures) if (f.cls !== "GND") bump.set(f.net, (bump.get(f.net) ?? 0) + 1);
    if (!bump.size) break;                                      // only ground failed: more passes cannot help
    const order = [...signals].sort((a, b) => (bump.get(b.net) ?? 0) - (bump.get(a.net) ?? 0));
    const next = attempt(plan(order));
    passes++;
    if (next.failures.length < best.failures.length) best = next;
  }
  return { tracks: best.tracks, vias: best.vias, failures: best.failures, grounds: best.grounds, ops, routedNets: nets.length - new Set(best.failures.map((f) => f.net)).size, totalNets: nets.length, passes, copper: best.cu, pads: best.pads };
}

/** Every shape on one layer once, with its net. */
function copperOn(cu, layer) {
  const seen = new Set(), out = [];
  for (const list of cu.cells[layer].values()) for (const sh of list) if (!seen.has(sh)) { seen.add(sh); out.push({ s: sh, net: sh.net }); }
  return out;
}

function mstLength(ps) {
  const inT = [ps[0]], rest = ps.slice(1);
  let sum = 0;
  while (rest.length) {
    let bi = 0, bd = Infinity;
    rest.forEach((p, i) => inT.forEach((t) => { const d = Math.hypot(p.pad.x - t.pad.x, p.pad.y - t.pad.y); if (d < bd) { bd = d; bi = i; } }));
    sum += bd; inT.push(rest.splice(bi, 1)[0]);
  }
  return sum;
}
