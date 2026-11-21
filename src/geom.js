// Small 2D distance helpers shared by the router (src/router.js) and the checker (src/drc.js).
// Shapes: rect {x0,y0,x1,y1} (axis aligned), circle {x,y,r}, segment {x0,y0,x1,y1} (a track centreline).

export const distPtSeg = (px, py, x0, y0, x1, y1) => {
  const dx = x1 - x0, dy = y1 - y0, l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - x0) * dx + (py - y0) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
};

export const distPtRect = (px, py, r) => {
  const dx = Math.max(r.x0 - px, 0, px - r.x1), dy = Math.max(r.y0 - py, 0, py - r.y1);
  return Math.hypot(dx, dy);
};

const orient = (ax, ay, bx, by, cx, cy) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
const onSeg = (ax, ay, bx, by, cx, cy) => Math.min(ax, bx) - 1e-12 <= cx && cx <= Math.max(ax, bx) + 1e-12 && Math.min(ay, by) - 1e-12 <= cy && cy <= Math.max(ay, by) + 1e-12;

export function segsCross(a, b) {
  const d1 = orient(b.x0, b.y0, b.x1, b.y1, a.x0, a.y0), d2 = orient(b.x0, b.y0, b.x1, b.y1, a.x1, a.y1);
  const d3 = orient(a.x0, a.y0, a.x1, a.y1, b.x0, b.y0), d4 = orient(a.x0, a.y0, a.x1, a.y1, b.x1, b.y1);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  if (d1 === 0 && onSeg(b.x0, b.y0, b.x1, b.y1, a.x0, a.y0)) return true;
  if (d2 === 0 && onSeg(b.x0, b.y0, b.x1, b.y1, a.x1, a.y1)) return true;
  if (d3 === 0 && onSeg(a.x0, a.y0, a.x1, a.y1, b.x0, b.y0)) return true;
  if (d4 === 0 && onSeg(a.x0, a.y0, a.x1, a.y1, b.x1, b.y1)) return true;
  return false;
}

export const distSegSeg = (a, b) => {
  if (segsCross(a, b)) return 0;
  return Math.min(
    distPtSeg(a.x0, a.y0, b.x0, b.y0, b.x1, b.y1), distPtSeg(a.x1, a.y1, b.x0, b.y0, b.x1, b.y1),
    distPtSeg(b.x0, b.y0, a.x0, a.y0, a.x1, a.y1), distPtSeg(b.x1, b.y1, a.x0, a.y0, a.x1, a.y1));
};

/** Does the segment pass through the rectangle (Liang-Barsky clipping)? */
export function segHitsRect(s, r) {
  let t0 = 0, t1 = 1;
  const dx = s.x1 - s.x0, dy = s.y1 - s.y0;
  for (const [p, q] of [[-dx, s.x0 - r.x0], [dx, r.x1 - s.x0], [-dy, s.y0 - r.y0], [dy, r.y1 - s.y0]]) {
    if (p === 0) { if (q < 0) return false; continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return true;
}

export const distSegRect = (s, r) => {
  if (segHitsRect(s, r)) return 0;
  return Math.min(
    distPtRect(s.x0, s.y0, r), distPtRect(s.x1, s.y1, r),
    distPtSeg(r.x0, r.y0, s.x0, s.y0, s.x1, s.y1), distPtSeg(r.x1, r.y0, s.x0, s.y0, s.x1, s.y1),
    distPtSeg(r.x1, r.y1, s.x0, s.y0, s.x1, s.y1), distPtSeg(r.x0, r.y1, s.x0, s.y0, s.x1, s.y1));
};

export const distRectRect = (a, b) => Math.hypot(Math.max(a.x0 - b.x1, b.x0 - a.x1, 0), Math.max(a.y0 - b.y1, b.y0 - a.y1, 0));
