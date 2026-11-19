// 2D distance helpers for the router and the checker. Lengths are mm. Pads are axis-aligned
// rectangles or circles, tracks are segments with a half-width, vias are circles.

export const dPtSeg = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};

const orient = (ax, ay, bx, by, cx, cy) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);

/** True when the two closed segments cross or touch. */
export const segsCross = (ax, ay, bx, by, cx, cy, dx, dy) => {
  const o1 = orient(ax, ay, bx, by, cx, cy), o2 = orient(ax, ay, bx, by, dx, dy);
  const o3 = orient(cx, cy, dx, dy, ax, ay), o4 = orient(cx, cy, dx, dy, bx, by);
  return ((o1 > 0) !== (o2 > 0) && o1 !== 0 && o2 !== 0 && (o3 > 0) !== (o4 > 0) && o3 !== 0 && o4 !== 0)
    || (o1 === 0 && onSeg(ax, ay, bx, by, cx, cy)) || (o2 === 0 && onSeg(ax, ay, bx, by, dx, dy))
    || (o3 === 0 && onSeg(cx, cy, dx, dy, ax, ay)) || (o4 === 0 && onSeg(cx, cy, dx, dy, bx, by));
};
const onSeg = (ax, ay, bx, by, px, py) => px >= Math.min(ax, bx) - 1e-12 && px <= Math.max(ax, bx) + 1e-12 && py >= Math.min(ay, by) - 1e-12 && py <= Math.max(ay, by) + 1e-12;

export const dSegSeg = (ax, ay, bx, by, cx, cy, dx, dy) => {
  if (segsCross(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
  return Math.min(dPtSeg(ax, ay, cx, cy, dx, dy), dPtSeg(bx, by, cx, cy, dx, dy), dPtSeg(cx, cy, ax, ay, bx, by), dPtSeg(dx, dy, ax, ay, bx, by));
};

export const dPtRect = (px, py, r) => Math.hypot(Math.max(r.x0 - px, 0, px - r.x1), Math.max(r.y0 - py, 0, py - r.y1));

/** Does the closed segment touch the axis-aligned rectangle? (Liang-Barsky clipping.) */
function segHitsRect(ax, ay, bx, by, r) {
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dy = by - ay;
  const clip = (p, q) => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
    return true;
  };
  return clip(-dx, ax - r.x0) && clip(dx, r.x1 - ax) && clip(-dy, ay - r.y0) && clip(dy, r.y1 - ay);
}

/** Distance from a segment to a rectangle: 0 if they touch, otherwise the nearest of an end to the rectangle or a corner to the segment. */
export const dSegRect = (ax, ay, bx, by, r) => {
  if (segHitsRect(ax, ay, bx, by, r)) return 0;
  return Math.min(dPtRect(ax, ay, r), dPtRect(bx, by, r),
    dPtSeg(r.x0, r.y0, ax, ay, bx, by), dPtSeg(r.x1, r.y0, ax, ay, bx, by), dPtSeg(r.x1, r.y1, ax, ay, bx, by), dPtSeg(r.x0, r.y1, ax, ay, bx, by));
};

/**
 * Gap between a capsule (segment a-b with half-width h) and a copper shape; negative means overlap.
 * shape: {t: "rect", x0, y0, x1, y1} | {t: "circle", x, y, r} | {t: "seg", ax, ay, bx, by, hw}
 */
export function gap(ax, ay, bx, by, h, s) {
  if (s.t === "rect") return dSegRect(ax, ay, bx, by, s) - h;
  if (s.t === "circle") return dPtSeg(s.x, s.y, ax, ay, bx, by) - s.r - h;
  return dSegSeg(ax, ay, bx, by, s.ax, s.ay, s.bx, s.by) - s.hw - h;
}

/** Bounding box of a shape, grown by `pad`. */
export function bbox(s, pad = 0) {
  if (s.t === "rect") return [s.x0 - pad, s.y0 - pad, s.x1 + pad, s.y1 + pad];
  if (s.t === "circle") return [s.x - s.r - pad, s.y - s.r - pad, s.x + s.r + pad, s.y + s.r + pad];
  return [Math.min(s.ax, s.bx) - s.hw - pad, Math.min(s.ay, s.by) - s.hw - pad, Math.max(s.ax, s.bx) + s.hw + pad, Math.max(s.ay, s.by) + s.hw + pad];
}

/** Binary min-heap on a numeric key (used by the router's open set). */
export class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const { k, v } = this;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop() {
    const { k, v } = this;
    const top = v[0], lk = k.pop(), lv = v.pop();
    const n = k.length;
    if (n) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}
