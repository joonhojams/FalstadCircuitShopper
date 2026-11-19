// A conservative model of where a ground pour can fill on one copper layer, used by the router to
// decide which ground pads still need a connection and by the checker to verify it.
//
// The layer is cut into 0.25 mm cells. A cell can hold copper when its centre keeps the pour
// clearance (plus half a cell diagonal) from every other net's copper and from the board edge. Narrow
// fingers (under pour_finger_min) are removed with an opening, and the remaining cells are grouped
// into connected regions. A ground shape that touches a region is joined to everything else in it.
//
// Conservative on purpose: real fill in KiCad also reaches into the cells this model drops, but
// thermal-relief spokes and zone settings can cut a connection this model assumes, so refill the
// zones (B in the PCB editor) and run KiCad's DRC before trusting it.

export const POUR_CELL = 0.25;
const HALF_DIAG = POUR_CELL * Math.SQRT1_2;

/** Distance from a point to the edge of a copper shape (0 inside it). */
function dPt(s, x, y) {
  if (s.t === "rect") return Math.hypot(Math.max(s.x0 - x, 0, x - s.x1), Math.max(s.y0 - y, 0, y - s.y1));
  if (s.t === "circle") return Math.max(0, Math.hypot(x - s.x, y - s.y) - s.r);
  const dx = s.bx - s.ax, dy = s.by - s.ay, len2 = dx * dx + dy * dy;
  let t = len2 ? ((x - s.ax) * dx + (y - s.ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.max(0, Math.hypot(x - (s.ax + t * dx), y - (s.ay + t * dy)) - s.hw);
}
const box = (s) => (s.t === "rect" ? [s.x0, s.y0, s.x1, s.y1] : s.t === "circle" ? [s.x - s.r, s.y - s.r, s.x + s.r, s.y + s.r]
  : [Math.min(s.ax, s.bx) - s.hw, Math.min(s.ay, s.by) - s.hw, Math.max(s.ax, s.bx) + s.hw, Math.max(s.ay, s.by) + s.hw]);

function chamfer(mask, NX, NY) {                         // distance in cells to the nearest set cell (8-neighbour)
  const d = new Float32Array(NX * NY).fill(1e9);
  for (let i = 0; i < d.length; i++) if (mask[i]) d[i] = 0;
  const S2 = Math.SQRT2;
  for (let y = 0; y < NY; y++) for (let x = 0; x < NX; x++) {
    const i = y * NX + x; let v = d[i];
    if (x > 0) v = Math.min(v, d[i - 1] + 1);
    if (y > 0) { v = Math.min(v, d[i - NX] + 1); if (x > 0) v = Math.min(v, d[i - NX - 1] + S2); if (x < NX - 1) v = Math.min(v, d[i - NX + 1] + S2); }
    d[i] = v;
  }
  for (let y = NY - 1; y >= 0; y--) for (let x = NX - 1; x >= 0; x--) {
    const i = y * NX + x; let v = d[i];
    if (x < NX - 1) v = Math.min(v, d[i + 1] + 1);
    if (y < NY - 1) { v = Math.min(v, d[i + NX] + 1); if (x < NX - 1) v = Math.min(v, d[i + NX + 1] + S2); if (x > 0) v = Math.min(v, d[i + NX - 1] + S2); }
    d[i] = v;
  }
  return d;
}

/** Rounded-rectangle depth: how far inside the outline a point is. */
function depthInside(x, y, w, l, r) {
  const qx = Math.abs(x - w / 2) - (w / 2 - r), qy = Math.abs(y - l / 2) - (l / 2 - r);
  return -(Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r);
}

/**
 * @param {{w: number, l: number, cornerRadius?: number}} board
 * @param {{s: object, net: string}[]} copper everything on this layer, every net
 * @param {{net: string, clearOf: (net: string) => number, pourClear: number, edge: number, finger: number}} o
 */
export function buildPour(board, copper, o) {
  const C = POUR_CELL, NX = Math.ceil(board.w / C), NY = Math.ceil(board.l / C);
  const blocked = new Uint8Array(NX * NY);
  const R = board.cornerRadius ?? 1;
  for (let iy = 0; iy < NY; iy++) for (let ix = 0; ix < NX; ix++) {
    if (depthInside((ix + 0.5) * C, (iy + 0.5) * C, board.w, board.l, R) < o.edge + HALF_DIAG) blocked[iy * NX + ix] = 1;
  }
  for (const { s, net } of copper) {
    if (net === o.net) continue;
    const need = Math.max(o.pourClear, o.clearOf(net)) + HALF_DIAG;
    const b = box(s);
    for (let iy = Math.max(0, Math.floor((b[1] - need) / C)); iy <= Math.min(NY - 1, Math.floor((b[3] + need) / C)); iy++) {
      for (let ix = Math.max(0, Math.floor((b[0] - need) / C)); ix <= Math.min(NX - 1, Math.floor((b[2] + need) / C)); ix++) {
        if (!blocked[iy * NX + ix] && dPt(s, (ix + 0.5) * C, (iy + 0.5) * C) < need) blocked[iy * NX + ix] = 1;
      }
    }
  }
  // Opening: drop fingers narrower than `finger`, keep what is within finger/2 of the wide parts.
  const r = o.finger / 2 / C;
  const dBlocked = chamfer(blocked, NX, NY);
  const core = new Uint8Array(NX * NY);
  for (let i = 0; i < core.length; i++) if (!blocked[i] && dBlocked[i] > r) core[i] = 1;
  const dCore = chamfer(core, NX, NY);
  const open = new Uint8Array(NX * NY);
  for (let i = 0; i < open.length; i++) if (!blocked[i] && dCore[i] <= r + 0.5) open[i] = 1;

  // Connected regions (4-neighbour).
  const comp = new Int32Array(NX * NY).fill(-1), size = [];
  const stack = [];
  for (let i = 0; i < comp.length; i++) {
    if (!open[i] || comp[i] >= 0) continue;
    const id = size.length; let n = 0;
    comp[i] = id; stack.push(i);
    while (stack.length) {
      const c = stack.pop(); n++;
      const x = c % NX, y = (c - x) / NX;
      if (x > 0 && open[c - 1] && comp[c - 1] < 0) { comp[c - 1] = id; stack.push(c - 1); }
      if (x < NX - 1 && open[c + 1] && comp[c + 1] < 0) { comp[c + 1] = id; stack.push(c + 1); }
      if (y > 0 && open[c - NX] && comp[c - NX] < 0) { comp[c - NX] = id; stack.push(c - NX); }
      if (y < NY - 1 && open[c + NX] && comp[c + NX] < 0) { comp[c + NX] = id; stack.push(c + NX); }
    }
    size.push(n);
  }
  return {
    NX, NY, size,
    /** Region id at a point, or -1. */
    at(x, y) { const ix = Math.floor(x / C), iy = Math.floor(y / C); return ix < 0 || iy < 0 || ix >= NX || iy >= NY ? -1 : comp[iy * NX + ix]; },
    /** Regions a copper shape touches (cells within one cell of it). */
    touching(s) {
      const out = new Set(), b = box(s);
      for (let iy = Math.max(0, Math.floor((b[1] - C) / C)); iy <= Math.min(NY - 1, Math.floor((b[3] + C) / C)); iy++) {
        for (let ix = Math.max(0, Math.floor((b[0] - C) / C)); ix <= Math.min(NX - 1, Math.floor((b[2] + C) / C)); ix++) {
          const c = comp[iy * NX + ix];
          if (c >= 0 && dPt(s, (ix + 0.5) * C, (iy + 0.5) * C) <= C) out.add(c);
        }
      }
      return out;
    },
    /** Share of the board area (inside the outline) the pour can cover. */
    coverage() { let n = 0; for (let i = 0; i < comp.length; i++) if (comp[i] >= 0) n++; return n * C * C / (board.w * board.l); },
  };
}
