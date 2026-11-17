// Extracts a connectivity netlist from a Falstad CircuitJS export.
//
// Falstad stores only where each element's two end points are; the other pins (transistor
// terminals, op-amp inputs) are computed when it draws. The geometry below is a port of that
// code (CircuitElm.interpPoint2 and the BJT, MOSFET and op-amp setPoints), so pin positions
// match what you see on screen. Elements connect where pin coordinates coincide, wires join
// their two ends, and a labeled node joins every node with the same name.
//
// Anything not understood is reported in `unsupported` so a wrong netlist is never silent.

import { elements, bom } from "./parser.js";

const sign = (n) => (n > 0 ? 1 : n < 0 ? -1 : 0);

/** CircuitElm.interpPoint2: points a fraction f along a-b, offset +/- g perpendicular. */
function interp2(a, b, f, g) {
  let gx = b.y - a.y, gy = a.x - b.x;
  const len = Math.hypot(gx, gy) || 1;
  gx = (g * gx) / len;
  gy = (g * gy) / len;
  const bx = a.x * (1 - f) + b.x * f, by = a.y * (1 - f) + b.y * f;
  return [
    { x: Math.floor(bx + gx + 0.48), y: Math.floor(by + gy + 0.48) },
    { x: Math.floor(bx - gx + 0.48), y: Math.floor(by - gy + 0.48) },
  ];
}

const dsignOf = (e) => (e.y1 === e.y2 ? sign(e.x2 - e.x1) : sign(e.y2 - e.y1));

// Reads a numeric extra field: classic lines keep them after the flags, XML uses named attributes.
const field = (e, idx, names) => {
  if (e.attrs) {
    for (const n of names) if (e.attrs[n] !== undefined && Number.isFinite(Number(e.attrs[n]))) return Number(e.attrs[n]);
    return null;
  }
  const v = Number(e.params?.[idx]);
  return e.params?.[idx] !== undefined && Number.isFinite(v) ? v : null;
};

const P1 = (e) => ({ x: e.x1, y: e.y1 });
const P2 = (e) => ({ x: e.x2, y: e.y2 });

/** Pins of each supported type, in a fixed meaning-order, as [name, point]. */
const PINS = {
  two: (names) => (e) => [[names[0], P1(e)], [names[1], P2(e)]],
  t(e) {
    const pnp = field(e, 0, ["pn"]) === -1 ? -1 : 1;
    let d = dsignOf(e);
    if (e.flags & 1) d = -d;
    const [coll, emit] = interp2(P1(e), P2(e), 1, 16 * d * pnp);
    return [["B", P1(e)], ["C", coll], ["E", emit]];
  },
  f(e) {
    const pnp = e.flags & 1 ? -1 : 1;
    let hs2 = 16 * dsignOf(e);
    if (e.flags & 8) hs2 = -hs2;
    const [a, b] = interp2(P1(e), P2(e), 1, -hs2);
    // Falstad draws src[0] as "S" for an N-channel and as "D" for a P-channel.
    const [S, D] = pnp === 1 ? [a, b] : [b, a];
    return [["G", P1(e)], ["S", S], ["D", D]];
  },
  a(e) {
    const s = e.flags & 2 ? 1 : 2;
    let hs = 8 * s * dsignOf(e);
    if (e.flags & 1) hs = -hs;
    const [in1, in2] = interp2(P1(e), P2(e), 0, hs);
    return [["-", in1], ["+", in2], ["OUT", P2(e)]];
  },
};
const PIN_FN = {
  r: PINS.two(["1", "2"]), c: PINS.two(["1", "2"]), l: PINS.two(["1", "2"]),
  d: PINS.two(["A", "K"]), z: PINS.two(["A", "K"]), 162: PINS.two(["A", "K"]),
  s: PINS.two(["1", "2"]), i: PINS.two(["-", "+"]),
  t: PINS.t, f: PINS.f, a: PINS.a,
};
// Voltage sources: Falstad's point2 is the positive terminal.
const SOURCE = { v: (e) => [["-", P1(e)], ["+", P2(e)]], R: (e) => [["+", P1(e)]] };

const KIND = {
  r: "resistor", c: "capacitor", l: "inductor", d: "diode", z: "zener", 162: "led",
  s: "switch", i: "current-source", t: "bjt", f: "mosfet", a: "opamp",
};

/** Lines/tags that only draw wiring: wires, grounds and labeled nodes. */
function wiring({ text, xml }) {
  const wires = [], grounds = [], labels = [];
  const add = (code, c, rest) => {
    if (c.length < 4 || c.some(Number.isNaN)) return;
    const [x1, y1, x2, y2] = c.map(Math.trunc);
    if (code === "w") wires.push([{ x: x1, y: y1 }, { x: x2, y: y2 }]);
    else if (code === "g") grounds.push({ x: x1, y: y1 });
    else if (code === "207" && rest) labels.push({ at: { x: x1, y: y1 }, name: rest });
  };
  if (xml) {
    for (const m of text.matchAll(/<(w|g|207)\s+([^>]*?)\/?>/g)) {
      const xa = /\bx="([^"]*)"/.exec(m[2]);
      if (xa) add(m[1], xa[1].trim().split(/\s+/).map(Number), null);
    }
  } else {
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim().split(/\s+/);
      if (["w", "g", "207"].includes(t[0])) add(t[0], t.slice(1, 5).map(Number), t[6]);
    }
  }
  return { wires, grounds, labels };
}

class DSU {
  constructor() { this.p = new Map(); }
  find(k) {
    if (!this.p.has(k)) this.p.set(k, k);
    let r = k;
    while (this.p.get(r) !== r) r = this.p.get(r);
    while (this.p.get(k) !== r) { const n = this.p.get(k); this.p.set(k, r); k = n; }
    return r;
  }
  union(a, b) { this.p.set(this.find(a), this.find(b)); }
}
const key = (p) => `${p.x},${p.y}`;

/**
 * @param {string} raw  a CircuitJS export
 * @param {{mergeRails?: boolean}} opts  mergeRails (default true): DC rails of equal voltage share one net
 * @returns {{parts, nets, rails, sources, unsupported, warnings}}
 */
export function extractNetlist(raw, { mergeRails = true } = {}) {
  const parsed = elements(raw);
  const refs = bom(raw).parts.map((p) => p.ref);
  const wire = wiring(parsed);
  const dsu = new DSU();
  const ground = "GND";

  for (const [a, b] of wire.wires) dsu.union(key(a), key(b));
  for (const g of wire.grounds) dsu.union(key(g), "@GND");
  const byName = new Map();
  for (const l of wire.labels) {
    const k = `@L:${l.name}`;
    dsu.union(key(l.at), k);
    byName.set(k, l.name);
  }

  const parts = [], rails = [], sources = [], unsupported = {}, warnings = [];
  parsed.parts.forEach((e, i) => {
    const ref = refs[i];
    const fn = PIN_FN[e.code];
    if (fn) {
      const pins = fn(e);
      pins.forEach(([, pt]) => dsu.find(key(pt)));
      parts.push({ ref, kind: KIND[e.code], code: String(e.code), name: e.name, value: e.value, details: e.details, pins });
    } else if (SOURCE[e.code]) {
      const pins = SOURCE[e.code](e);
      pins.forEach(([, pt]) => dsu.find(key(pt)));
      const wf = field(e, 0, ["wf"]) ?? 0;
      const volts = field(e, 2, ["maxv"]);
      const bias = field(e, 3, ["bi", "bias"]) ?? 0;
      const entry = { ref, code: String(e.code), pins, dc: wf === 0, volts: wf === 0 ? volts : null, bias };
      (e.code === "R" ? rails : sources).push(entry);
    } else {
      unsupported[e.name] = (unsupported[e.name] ?? 0) + 1;
    }
  });

  const railName = (v) => `${v < 0 ? "-" : "+"}${Number(Math.abs(v).toFixed(3))}V`;
  // A rail is a one-pin source: it is the net, at a fixed voltage.
  const railNet = new Map(); // dsu root -> volts
  for (const r of rails) {
    if (!r.dc || r.volts === null) {
      warnings.push(`${r.ref} is not a DC rail (it is a time-varying source), so its net is left as a plain signal net.`);
      continue;
    }
    const root = dsu.find(key(r.pins[0][1]));
    if (mergeRails) dsu.union(root, `@RAIL:${r.volts}`);
    railNet.set(dsu.find(root), r.volts);
  }
  // Voltage sources with the negative terminal on ground are rails too (a battery to ground).
  for (const s of sources) {
    const neg = dsu.find(key(s.pins[0][1])), pos = dsu.find(key(s.pins[1][1]));
    if (s.dc && s.volts !== null && neg === dsu.find("@GND")) {
      if (mergeRails) dsu.union(pos, `@RAIL:${s.volts}`);
      railNet.set(dsu.find(pos), s.volts);
    } else {
      warnings.push(`${s.ref} is a voltage source that is not a DC supply referenced to ground; it is listed but not turned into a rail.`);
    }
  }

  // Name every net.
  const names = new Map();
  const taken = new Set();
  const give = (root, name) => {
    let n = name, i = 2;
    while (taken.has(n)) n = `${name}_${i++}`;
    taken.add(n);
    names.set(root, n);
  };
  give(dsu.find("@GND"), ground);
  for (const [root, v] of [...railNet].sort((a, b) => a[1] - b[1])) {
    if (!names.has(dsu.find(root))) give(dsu.find(root), railName(v));
  }
  for (const [k, n] of byName) if (!names.has(dsu.find(k))) give(dsu.find(k), n.replace(/[^\w+.-]/g, "_"));
  let auto = 0;
  const netOf = (pt) => {
    const root = dsu.find(key(pt));
    if (!names.has(root)) give(root, `N${String(++auto).padStart(3, "0")}`);
    return names.get(root);
  };

  for (const p of parts) p.pins = p.pins.map(([name, pt]) => ({ name, net: netOf(pt) }));
  for (const s of [...rails, ...sources]) s.pins = s.pins.map(([name, pt]) => ({ name, net: netOf(pt) }));

  const nets = new Map();
  for (const p of parts) for (const pin of p.pins) {
    if (!nets.has(pin.net)) nets.set(pin.net, []);
    nets.get(pin.net).push(`${p.ref}.${pin.name}`);
  }
  // Pins that connect to nothing (a net with one pin and no label) are probably an unfinished wire.
  for (const [n, list] of nets) {
    if (list.length === 1 && /^N\d+$/.test(n)) warnings.push(`${list[0]} connects to nothing.`);
  }

  const railList = [...railNet].map(([root, v]) => ({ net: names.get(dsu.find(root)), volts: v }))
    .filter((r, i, a) => a.findIndex((x) => x.net === r.net) === i)
    .sort((a, b) => a.volts - b.volts);
  const unsupportedList = Object.entries(unsupported).map(([name, count]) => ({ name, count }));
  return {
    parts,
    nets: [...nets].map(([name, pins]) => ({ name, pins })),
    rails: railList,
    sources: [...rails, ...sources].map((s) => ({ ref: s.ref, nets: s.pins.map((p) => p.net), volts: s.volts, dc: s.dc })),
    unsupported: unsupportedList,
    warnings,
  };
}
