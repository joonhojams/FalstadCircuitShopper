// A small two-layer grid router for the placed board (src/pcb.js).
//
// Method: A* over a 0.635 mm lattice (spec grid_route) on F.Cu and B.Cu. Every net is grown as a
// tree (Prim style): the cheapest path from what is already routed to the nearest unrouted pad.
// Tracks run horizontally, vertically or at 45 degrees; turns are limited to 45 degrees so no 90
// degree or acute corners appear (spec RT-02). A pad that is off the lattice (SMD pads) is joined by
// a short two-leg stub that is itself axis + 45 degree.
//
// Net classes set the track width and clearance (src/netclass.js). The router keeps an extra 0.02 mm
// beyond the clearance and the result is re-checked independently by src/drc.js; anything the
// router could not complete stays unrouted and is reported, never faked.
//
// This is an autorouter: the spec (RT-12) wants its output reviewed in KiCad before it is built.

import { PARAMS, VIA, NET_CLASSES, classOf } from "./netclass.js";
import { distPtRect, distPtSeg } from "./geom.js";

// Audio copper is kept away from power and LED copper (spec A1: no power trace within noise_parallel_sep of audio over
// noise_parallel_len). It is a soft cost, so a net that has no other way still gets routed; the check reports what is left.
const NOISY = new Set(["POWER", "LED_CTRL"]);
const NOISE_COST = 3;               // extra cost per mm travelled inside the noisy zone, as a multiple of the step length

const G = PARAMS.grid_route;
const EPS = 0.02;
const DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const DIAG = Math.SQRT2 - 1;
const turnOK = (a, b) => a === 8 || b === 8 || ((b - a + 8) % 8) <= 1 || ((a - b + 8) % 8) <= 1;
const dirIndex = (sx, sy) => DIRS.findIndex(([x, y]) => x === sx && y === sy);
const R4 = (v) => Math.round(v * 10000) / 10000;
const sgn = (v) => (Math.abs(v) < 1e-9 ? 0 : v > 0 ? 1 : -1);
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** Copper already on the board, bucketed in 2 mm cells for neighbour queries. */
export class Copper {
  constructor() { this.cell = 2; this.layers = [new Map(), new Map()]; }
  add(layer, o) {
    const m = this.layers[layer], c = this.cell;
    const x0 = o.k === 1 ? o.x - o.r : Math.min(o.x0, o.x1 ?? o.x0) - (o.hw ?? 0), x1 = o.k === 1 ? o.x + o.r : Math.max(o.x0, o.x1 ?? o.x0) + (o.hw ?? 0);
    const y0 = o.k === 1 ? o.y - o.r : Math.min(o.y0, o.y1 ?? o.y0) - (o.hw ?? 0), y1 = o.k === 1 ? o.y + o.r : Math.max(o.y0, o.y1 ?? o.y0) + (o.hw ?? 0);
    for (let ix = Math.floor(x0 / c); ix <= Math.floor(x1 / c); ix++) for (let iy = Math.floor(y0 / c); iy <= Math.floor(y1 / c); iy++) {
      const k = ix * 8192 + iy;
      (m.get(k) ?? m.set(k, []).get(k)).push(o);
    }
  }
  near(layer, x, y, r, fn) {
    const m = this.layers[layer], c = this.cell;
    for (let ix = Math.floor((x - r) / c); ix <= Math.floor((x + r) / c); ix++) for (let iy = Math.floor((y - r) / c); iy <= Math.floor((y + r) / c); iy++) {
      const l = m.get(ix * 8192 + iy);
      if (l) for (const o of l) fn(o);
    }
  }
}

const gapTo = (o, x, y) => (o.k === 0 ? distPtRect(x, y, o) : o.k === 1 ? Math.hypot(x - o.x, y - o.y) - o.r : distPtSeg(x, y, o.x0, o.y0, o.x1, o.y1) - o.hw);

const padRect = (p) => ({ x0: p.x - p.w / 2, y0: p.y - p.h / 2, x1: p.x + p.w / 2, y1: p.y + p.h / 2 });
const padLayers = (p) => {
  const l = p.l ?? [];
  const f = l.includes("F.Cu") || l.includes("*.Cu"), b = l.includes("B.Cu") || l.includes("*.Cu");
  return [f, b];
};

/** Heap of [f, g, state, goal?] entries. */
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(e) {
    const a = this.a; a.push(e);
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
}

/**
 * @param {{w: number, l: number, parts: {it: {ref: string, footprint: string}, pads: object[], body: number[]}[], keepouts?: {x: number, y: number, r: number}[]}} layout
 * @param {{classes: Map<string, string>, maxMs?: number, via?: {size: number, drill: number}, attempts?: number, skipNets?: Set<string>, noViaRects?: number[][]}} opts
 */
export function route(layout, opts) {
  const t0 = now();
  const maxMs = opts.maxMs ?? 20000;
  const via = opts.via ?? VIA;
  const W = layout.w, L = layout.l;
  const edge = PARAMS.copper_to_edge_pref;
  const classes = opts.classes;
  const cls = (net) => classOf(classes, net);

  // ---- net ids and pads ----
  const netId = new Map();
  const idOf = (n) => (netId.has(n) ? netId.get(n) : (netId.set(n, netId.size + 1), netId.size));
  const byNet = new Map();
  let anon = -1;
  const store = new Copper();
  const noVia = [...(opts.noViaRects ?? [])];
  for (const part of layout.parts) {
    const tht = part.pads.some((p) => p.t === "thru_hole");
    if (tht && part.body) noVia.push(part.body);
    for (const p of part.pads) {
      const net = p.net ?? null;
      const id = net ? idOf(net) : anon--;
      const clr = net ? cls(net).clearance : NET_CLASSES.AUDIO_SIG.clearance;
      const [f, b] = padLayers(p);
      const o = p.s === "circle" ? { k: 1, x: p.x, y: p.y, r: Math.max(p.w, p.h) / 2, net: id, clr, pad: true } : { k: 0, ...padRect(p), net: id, clr, pad: true };
      if (f) store.add(0, o);
      if (b) store.add(1, o);
      if (net) (byNet.get(net) ?? byNet.set(net, []).get(net)).push({ ...p, ref: part.it.ref, id });
    }
  }
  for (const k of layout.keepouts ?? []) { const o = { k: 1, x: k.x, y: k.y, r: k.r, net: -1e9, clr: 0 }; store.add(0, o); store.add(1, o); }

  // ---- lattice ----
  const nx = Math.floor(W / G) + 1, ny = Math.floor(L / G) + 1, plane = nx * ny, N = 2 * plane;
  const gs = new Float32Array(N * 9), stamp = new Int32Array(N * 9), prev = new Int32Array(N * 9);
  const freeC = new Int8Array(N), viaC = new Int8Array(plane);
  let gen = 0;
  const nodeIdx = (l, i, j) => l * plane + j * nx + i;
  const decode = (n) => { const l = n >= plane ? 1 : 0, r = n - l * plane; return [r % nx, Math.floor(r / nx), l]; };

  // ---- per-net context while a net is being routed ----
  let ctx = null;
  const clearPt = (layer, x, y, hw, clr, id, strictPads = false) => {
    if (x < edge + hw || y < edge + hw || x > W - edge - hw || y > L - edge - hw) return false;
    let ok = true;
    store.near(layer, x, y, hw + clr + 0.9, (o) => {
      if (!ok || (o.net === id && !(strictPads && o.pad))) return;       // a via never sits in a pad, even one of its own net
      if (gapTo(o, x, y) < Math.max(clr, o.clr) + hw + EPS) ok = false;
    });
    return ok;
  };
  const nodeFree = (l, i, j) => {
    const n = nodeIdx(l, i, j);
    if (freeC[n]) return freeC[n] === 1;
    const ok = clearPt(l, i * G, j * G, ctx.hw, ctx.clr, ctx.id);
    freeC[n] = ok ? 1 : 2;
    return ok;
  };
  const edgeFree = (l, i, j, ni, nj) => {
    for (const t of [0.25, 0.5, 0.75]) if (!clearPt(l, (i + (ni - i) * t) * G, (j + (nj - j) * t) * G, ctx.hw, ctx.clr, ctx.id)) return false;
    return true;
  };
  const viaFree = (i, j) => {
    const n = j * nx + i;
    if (viaC[n]) return viaC[n] === 1;
    const x = i * G, y = j * G, r = via.size / 2;
    let ok = !noVia.some((b) => x > b[0] - 0.2 && x < b[2] + 0.2 && y > b[1] - 0.2 && y < b[3] + 0.2);
    for (const l of [0, 1]) ok = ok && clearPt(l, x, y, r, ctx.clr, ctx.id, true);
    if (ok) store.near(0, x, y, via.drill + PARAMS.hole_to_hole_min + 1, (o) => {
      // same-net copper may touch, but two drilled holes still need hole_to_hole_min between them
      if (o.via && Math.hypot(o.x - x, o.y - y) - o.drill / 2 - via.drill / 2 < PARAMS.hole_to_hole_min + EPS) ok = false;
    });
    viaC[n] = ok ? 1 : 2;
    return ok;
  };

  /** Stubs joining a pad centre to nearby lattice nodes: at most one axis leg and one 45 degree leg. */
  function accessFor(p, l) {
    const [f, b] = padLayers(p);
    if (!(l === 0 ? f : b)) return [];
    const out = [];
    const ci = Math.round(p.x / G), cj = Math.round(p.y / G);
    for (let i = ci - 3; i <= ci + 3; i++) for (let j = cj - 3; j <= cj + 3; j++) {
      if (i < 0 || j < 0 || i >= nx || j >= ny || !nodeFree(l, i, j)) continue;
      const lx = i * G, ly = j * G, dx = lx - p.x, dy = ly - p.y;
      if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) { out.push({ i, j, l, pts: [[p.x, p.y]], cost: 0, endDir: 8, pad: p }); continue; }
      const adx = Math.abs(dx), ady = Math.abs(dy), sx = sgn(dx), sy = sgn(dy), d = Math.min(adx, ady);
      const remx = adx - d, remy = ady - d;
      const len = d * Math.SQRT2 + remx + remy;
      const variants = [
        [[p.x + sx * d, p.y + sy * d]],                  // 45 degree leg first
        [[p.x + sx * remx, p.y + sy * remy]],            // axis leg first
      ];
      const seen = new Set();
      for (const [c] of variants) {
        const key = `${R4(c[0])},${R4(c[1])}`;
        if (seen.has(key)) continue; seen.add(key);
        const pts = [[p.x, p.y], ...(Math.hypot(c[0] - p.x, c[1] - p.y) > 1e-6 && Math.hypot(lx - c[0], ly - c[1]) > 1e-6 ? [c] : []), [lx, ly]];
        let ok = true;
        for (let k = 0; k + 1 < pts.length && ok; k++) {
          const [ax, ay] = pts[k], [bx, by] = pts[k + 1], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 0.1));
          for (let s = 0; s <= n && ok; s++) ok = clearPt(l, ax + ((bx - ax) * s) / n, ay + ((by - ay) * s) / n, ctx.hw, ctx.clr, ctx.id);
        }
        if (!ok) continue;
        const [lax, lay] = pts[pts.length - 2], endDir = dirIndex(sgn(lx - lax), sgn(ly - lay));
        out.push({ i, j, l, pts, cost: len, endDir: endDir < 0 ? 8 : endDir, pad: p });
      }
    }
    return out.sort((a, b) => a.cost - b.cost).slice(0, 12);
  }

  const copperOut = { tracks: [], vias: [] };
  const noisySegs = [];                                     // routed power / LED tracks: { layer, x0, y0, x1, y1 }
  const viaCount = new Map();
  const addTrack = (net, layer, pts) => {
    const w = cls(net).track, id = idOf(net);
    const clr = cls(net).clearance;
    for (let k = 0; k + 1 < pts.length; k++) {
      store.add(layer, { k: 2, x0: pts[k][0], y0: pts[k][1], x1: pts[k + 1][0], y1: pts[k + 1][1], hw: w / 2, net: id, clr, fromRoute: true });
    }
    copperOut.tracks.push({ net, layer: layer === 0 ? "F.Cu" : "B.Cu", w, pts: pts.map(([x, y]) => [R4(x), R4(y)]) });
    if (NOISY.has(classes.get(net))) for (let k = 0; k + 1 < pts.length; k++) noisySegs.push({ layer, x0: pts[k][0], y0: pts[k][1], x1: pts[k + 1][0], y1: pts[k + 1][1] });
  };

  /** Lattice nodes (both layers) within the A1 separation of routed power / LED copper on the same layer. */
  function noiseMap() {
    if (!noisySegs.length || opts.noiseAware === false) return null;
    const sep = PARAMS.noise_parallel_sep, m = new Uint8Array(N);
    for (const sg of noisySegs) {
      const i0 = Math.max(0, Math.floor((Math.min(sg.x0, sg.x1) - sep) / G)), i1 = Math.min(nx - 1, Math.ceil((Math.max(sg.x0, sg.x1) + sep) / G));
      const j0 = Math.max(0, Math.floor((Math.min(sg.y0, sg.y1) - sep) / G)), j1 = Math.min(ny - 1, Math.ceil((Math.max(sg.y0, sg.y1) + sep) / G));
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) if (distPtSeg(i * G, j * G, sg.x0, sg.y0, sg.x1, sg.y1) < sep) m[nodeIdx(sg.layer, i, j)] = 1;
    }
    return m;
  }
  const addVia = (net, x, y) => {
    const o = { k: 1, x, y, r: via.size / 2, net: idOf(net), clr: cls(net).clearance, fromRoute: true, via: true, drill: via.drill };
    store.add(0, o); store.add(1, o);
    viaC.fill(0);                                           // cached via sites near this one are no longer free
    copperOut.vias.push({ net, x: R4(x), y: R4(y), size: via.size, drill: via.drill });
    viaCount.set(net, (viaCount.get(net) ?? 0) + 1);
  };

  const simplify = (pts) => {
    const out = [];
    for (const p of pts) {
      if (out.length && Math.hypot(p[0] - out[out.length - 1][0], p[1] - out[out.length - 1][1]) < 1e-6) continue;
      out.push(p);
      while (out.length >= 3) {
        const [a, b, c] = out.slice(-3);
        const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
        const dot = (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]);
        if (Math.abs(cr) < 1e-6 && dot > 0) out.splice(out.length - 2, 1); else break;
      }
    }
    return out;
  };

  /** One A* from the net's copper to the nearest of `targets` (pads not yet connected). */
  function connect(net, sources, targetPads, { toVia = false } = {}) {
    gen++; freeC.fill(0);
    const goals = new Map();                       // node -> accesses
    const tpts = [];
    for (const p of targetPads) {
      tpts.push([p.x, p.y]);
      for (const l of [0, 1]) for (const a of accessFor(p, l)) { const k = nodeIdx(l, a.i, a.j); (goals.get(k) ?? goals.set(k, []).get(k)).push(a); }
    }
    if (!goals.size && !toVia) return null;
    const heap = new Heap(), srcStub = new Map();
    const hOf = (i, j) => {
      if (toVia) return 0;
      let best = Infinity;
      const x = i * G, y = j * G;
      for (const [px, py] of tpts) { const dx = Math.abs(x - px), dy = Math.abs(y - py); best = Math.min(best, Math.max(dx, dy) + DIAG * Math.min(dx, dy)); }
      return best;
    };
    const seed = (n, d, g, stub) => {
      const s = n * 9 + d;
      if (stamp[s] === gen && gs[s] <= g) return;
      stamp[s] = gen; gs[s] = g; prev[s] = -1;
      if (stub) srcStub.set(s, stub); else srcStub.delete(s);
      const [i, j] = decode(n);
      heap.push([g + hOf(i, j), g, s, null]);
    };
    for (const sr of sources) seed(sr.n, sr.d, sr.cost, sr.stub);

    const bFactor = (l) => (ctx.isGnd ? (l === 0 ? 1.25 : 1) : (l === 0 ? 1 : 1.3));
    const viaCost = ctx.audio ? 10 : 6;
    let expanded = 0;
    while (heap.size) {
      const [, g, s, goal] = heap.pop();
      if (goal) return { stateEnd: s, acc: goal, srcStub };
      if (g > gs[s] + 1e-6) continue;
      if (++expanded > 400000 || (expanded % 2048 === 0 && now() - t0 > maxMs)) return null;
      const n = Math.floor(s / 9), d = s - n * 9;
      const [i, j, l] = decode(n);
      if (toVia && l === 0 && viaFree(i, j) && nodeFree(1, i, j)) return { stateEnd: s, acc: null, srcStub, endVia: true };
      const ga = goals.get(n);
      if (ga) for (const a of ga) {
        if (a.endDir === 8 || turnOK(d, (a.endDir + 4) % 8)) heap.push([g + a.cost, g + a.cost, s, a]);
      }
      for (let k = 0; k < 8; k++) {
        if (!turnOK(d, k)) continue;
        const ni = i + DIRS[k][0], nj = j + DIRS[k][1];
        if (ni < 0 || nj < 0 || ni >= nx || nj >= ny || !nodeFree(l, ni, nj)) continue;
        const step = Math.hypot(DIRS[k][0], DIRS[k][1]) * G;
        const ng = g + step * bFactor(l) + (d !== 8 && d !== k ? 0.15 : 0) + (ctx.noise && ctx.noise[nodeIdx(l, ni, nj)] ? step * NOISE_COST : 0);
        const ns = nodeIdx(l, ni, nj) * 9 + k;
        if (stamp[ns] === gen && gs[ns] <= ng) continue;
        if (!edgeFree(l, i, j, ni, nj)) continue;
        stamp[ns] = gen; gs[ns] = ng; prev[ns] = s;
        heap.push([ng + hOf(ni, nj), ng, ns, null]);
      }
      if (viaFree(i, j)) {
        const ol = 1 - l, no = nodeIdx(ol, i, j);
        if (nodeFree(ol, i, j)) {
          const ng = g + viaCost, ns = no * 9 + 8;
          if (!(stamp[ns] === gen && gs[ns] <= ng)) {
            stamp[ns] = gen; gs[ns] = ng; prev[ns] = s;
            heap.push([ng + hOf(i, j), ng, ns, null]);
          }
        }
      }
    }
    return null;
  }

  function emit(net, found) {
    const chain = [];
    for (let s = found.stateEnd; s !== -1; s = prev[s]) chain.push(s);
    chain.reverse();
    const nodes = chain.map((s) => { const n = Math.floor(s / 9); const [i, j, l] = decode(n); return { i, j, l, n }; });
    const stub = found.srcStub.get(chain[0]);
    let layer = nodes[0].l;
    let pts = [];
    if (stub) pts.push(...stub.pts);
    else pts.push([nodes[0].i * G, nodes[0].j * G]);
    const flush = () => { const sp = simplify(pts); if (sp.length > 1) addTrack(net, layer, sp); };
    for (let k = 0; k < nodes.length; k++) {
      const nd = nodes[k], x = nd.i * G, y = nd.j * G;
      if (k > 0 && nd.l !== nodes[k - 1].l) { flush(); addVia(net, x, y); layer = nd.l; pts = [[x, y]]; continue; }
      if (k > 0 || !stub) pts.push([x, y]);
      else if (pts.length === 0) pts.push([x, y]);
    }
    if (found.acc) for (const q of [...found.acc.pts].reverse()) pts.push(q);
    flush();
    if (found.endVia) { const last = nodes[nodes.length - 1]; addVia(net, last.i * G, last.j * G); }
    return nodes;
  }

  // ---- a net carried by a ground pour: SMD pads get a short track to a via into the pour ----
  function routePour(net, pads) {
    const c = cls(net);
    ctx = { hw: c.track / 2, clr: c.clearance, id: idOf(net), isGnd: true, audio: false };
    viaC.fill(0);
    const failed = [];
    for (const p of pads) {
      if (p.t === "thru_hole") continue;                    // reaches the pour through its hole
      freeC.fill(0);
      const src = accessFor(p, 0).map((a) => ({ n: nodeIdx(0, a.i, a.j), d: a.endDir, cost: a.cost, stub: a }));
      const found = src.length ? connect(net, src, [], { toVia: true }) : null;
      if (found) emit(net, found); else failed.push(p);
    }
    return failed;
  }

  // ---- route one net ----
  function routeNet(net, pads) {
    const c = cls(net);
    ctx = { hw: c.track / 2, clr: c.clearance, id: idOf(net), isGnd: classes.get(net) === "GND", audio: classes.get(net) === "AUDIO_SIG" || classes.get(net) === "HIGH_Z" };
    if (ctx.audio) ctx.noise = noiseMap();
    viaC.fill(0);
    const tree = new Set();                             // lattice nodes of this net's copper
    const connected = [];
    const order = [...pads].sort((a, b) => a.x - b.x || a.y - b.y);
    // start from the pad nearest the centroid of the others, which keeps the tree compact
    let first = order[0];
    const cx = order.reduce((s, p) => s + p.x, 0) / order.length, cy = order.reduce((s, p) => s + p.y, 0) / order.length;
    first = order.reduce((b, p) => (Math.hypot(p.x - cx, p.y - cy) < Math.hypot(b.x - cx, b.y - cy) ? p : b), first);
    connected.push(first);
    let remaining = order.filter((p) => p !== first);
    const failed = [];
    const padSources = (p) => {
      freeC.fill(0);
      const src = [];
      for (const l of [0, 1]) for (const a of accessFor(p, l)) src.push({ n: nodeIdx(l, a.i, a.j), d: a.endDir === 8 ? 8 : a.endDir, cost: a.cost, stub: a });
      return src;
    };
    let seeded = false;
    while (remaining.length) {
      let sources = [];
      for (const n of tree) sources.push({ n, d: 8, cost: 0, stub: null });
      if (!tree.size) { sources = padSources(first); seeded = true; }
      if (!sources.length) { failed.push(...remaining.map((p) => p)); break; }
      const found = connect(net, sources, remaining);
      if (!found) { failed.push(...remaining); break; }      // the search covered the whole board: none of them can be reached
      const nodes = emit(net, found);
      for (const nd of nodes) tree.add(nd.n);
      const tp = found.acc.pad;
      for (const l of [0, 1]) if (tp.t === "thru_hole" && found.acc.cost === 0) tree.add(nodeIdx(l, found.acc.i, found.acc.j));
      if (seeded) {
        const s0 = nodes[0];
        if (first.t === "thru_hole") for (const l of [0, 1]) { const a = nodeIdx(l, s0.i, s0.j); if (Math.abs(s0.i * G - first.x) < 1e-6 && Math.abs(s0.j * G - first.y) < 1e-6) tree.add(a); }
        seeded = false;
      }
      connected.push(tp);
      remaining = remaining.filter((p) => p !== tp);
    }
    return failed;
  }

  const dropRouted = () => { for (const m of store.layers) for (const list of m.values()) for (let k = list.length - 1; k >= 0; k--) if (list[k].fromRoute) list.splice(k, 1); };

  // ---- order and attempts ----
  const nets = [...byNet.entries()].filter(([n, ps]) => ps.length > 1 && !(opts.skipNets?.has(n)));
  const hpwl = (ps) => { const xs = ps.map((p) => p.x), ys = ps.map((p) => p.y); return Math.max(...xs) - Math.min(...xs) + Math.max(...ys) - Math.min(...ys); };
  const rank = (n) => (NOISY.has(classes.get(n)) ? 0 : classes.get(n) === "GND" ? 2 : 1);
  let order = nets.map(([n]) => n).sort((a, b) => rank(a) - rank(b) || hpwl(byNet.get(a)) - hpwl(byNet.get(b)) || a.localeCompare(b));
  let best = null;
  const attempts = opts.attempts ?? 4;
  let attemptsRun = 0;
  for (let a = 0; a < attempts; a++) {
    attemptsRun++;
    // fresh copper: pads and keepouts only
    copperOut.tracks.length = 0; copperOut.vias.length = 0; viaCount.clear(); noisySegs.length = 0;
    dropRouted();
    const unrouted = [];
    for (const net of order) {
      const failed = opts.pour && net === opts.pour ? routePour(net, byNet.get(net)) : routeNet(net, byNet.get(net));
      if (failed.length) unrouted.push({ net, pads: failed.map((p) => `${p.ref}.${p.n}`), x: failed[0].x, y: failed[0].y });
      if (now() - t0 > maxMs) break;
    }
    // Two pads of one net can end on the same via node; keep a single via there.
    const seenVia = new Set(), uniqVias = [];
    for (const v of copperOut.vias) { const k = `${v.net}@${v.x},${v.y}`; if (!seenVia.has(k)) { seenVia.add(k); uniqVias.push(v); } }
    const snap = { tracks: [...copperOut.tracks], vias: uniqVias, unrouted, via: new Map(viaCount) };
    if (!best || unrouted.length < best.unrouted.length) best = snap;
    if (!unrouted.length || now() - t0 > maxMs) break;
    const bad = new Set(unrouted.map((u) => u.net));
    order = [...order.filter((n) => bad.has(n)), ...order.filter((n) => !bad.has(n))];
  }

  // ---- stitching vias for the ground pours (spec PG-07) ----
  const stitch = [];
  if (netId.has("GND") && opts.stitch !== false) {
    ctx = { hw: 0, clr: cls("GND").clearance, id: -5 };      // -5 matches no net: ground copper counts as an obstacle too
    // rebuild the store with the best attempt's copper so the vias are checked against what is really there
    dropRouted();
    for (const t of best.tracks) { const l = t.layer === "F.Cu" ? 0 : 1; for (let k = 0; k + 1 < t.pts.length; k++) store.add(l, { k: 2, x0: t.pts[k][0], y0: t.pts[k][1], x1: t.pts[k + 1][0], y1: t.pts[k + 1][1], hw: t.w / 2, net: idOf(t.net), clr: cls(t.net).clearance }); }
    for (const v of best.vias) { const o = { k: 1, x: v.x, y: v.y, r: v.size / 2, net: idOf(v.net), clr: cls(v.net).clearance, via: true, drill: v.drill }; store.add(0, o); store.add(1, o); }
    const inset = 1.5, px = [], pitch = PARAMS.stitch_via_pitch;
    const pts = [[inset, inset], [W - inset, inset], [W - inset, L - inset], [inset, L - inset]];
    for (let k = 0; k < 4; k++) {
      const [ax, ay] = pts[k], [bx, by] = pts[(k + 1) % 4], len = Math.hypot(bx - ax, by - ay), n = Math.max(1, Math.round(len / pitch));
      for (let s = 0; s < n; s++) px.push([ax + ((bx - ax) * s) / n, ay + ((by - ay) * s) / n]);
    }
    const placedV = [];
    for (const [x, y] of px) {
      // the closest free lattice node within 2 mm
      let bestN = null;
      for (let i = Math.round(x / G) - 3; i <= Math.round(x / G) + 3; i++) for (let j = Math.round(y / G) - 3; j <= Math.round(y / G) + 3; j++) {
        if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
        const vx = i * G, vy = j * G, dd = Math.hypot(vx - x, vy - y);
        if (bestN && dd >= bestN.dd) continue;
        if (noVia.some((b) => vx > b[0] - 0.2 && vx < b[2] + 0.2 && vy > b[1] - 0.2 && vy < b[3] + 0.2)) continue;
        if (placedV.some((q) => Math.hypot(q[0] - vx, q[1] - vy) < via.size + 0.6)) continue;
        if ([0, 1].every((l) => clearPt(l, vx, vy, via.size / 2, ctx.clr, ctx.id))) bestN = { vx, vy, dd };
      }
      if (bestN) { placedV.push([bestN.vx, bestN.vy]); stitch.push({ net: "GND", x: R4(bestN.vx), y: R4(bestN.vy), size: via.size, drill: via.drill, stitch: true }); }
    }
  }

  const lengthMm = best.tracks.reduce((s, t) => s + t.pts.slice(1).reduce((a, p, k) => a + Math.hypot(p[0] - t.pts[k][0], p[1] - t.pts[k][1]), 0), 0);
  return {
    tracks: best.tracks, vias: [...best.vias, ...stitch], unrouted: best.unrouted,
    viaCounts: Object.fromEntries(best.via),
    stats: { nets: nets.length, failedNets: best.unrouted.length, length: R4(lengthMm), vias: best.vias.length, stitchVias: stitch.length, ms: Math.round(now() - t0), attempts: attemptsRun, lattice: `${nx}x${ny}` },
  };
}
