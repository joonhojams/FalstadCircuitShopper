// Reads one KiCad footprint (.kicad_mod, current "(footprint ...)" or older "(module ...)" format) into the compact form used by
// src/footprint-data.js. Pure JavaScript, so the Worker can parse a footprint a user uploads as well as the build script.
import { parseSexp, kid, kids } from "./sexp.js";

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

