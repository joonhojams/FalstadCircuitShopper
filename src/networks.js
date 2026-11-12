// Suggests replacing a "niche" resistor or capacitor value (one that is not in a common
// E-series) with a series or parallel pair of common values, so fewer unusual parts have
// to be stocked and bought. Pure functions, no dependencies.
//
// This is a suggestion engine, not an automatic rewrite: the BOM itself is never changed.
// A network is two parts instead of one, so it only saves money when the common parts are
// cheaper (or already on the BOM). Ranking therefore prefers networks built from values the
// BOM already uses, then the smallest error.

import { parseValue } from "./queries.js";

export const SERIES = ["E6", "E12", "E24", "E48", "E96"];

// E6/E12/E24 are defined by their published tables. E48 and E96 are the 3-digit
// roundings of 10^(i/N), which matches the published tables.
const TABLES = {
  E6: [1.0, 1.5, 2.2, 3.3, 4.7, 6.8],
  E12: [1.0, 1.2, 1.5, 1.8, 2.2, 2.7, 3.3, 3.9, 4.7, 5.6, 6.8, 8.2],
  E24: [1.0, 1.1, 1.2, 1.3, 1.5, 1.6, 1.8, 2.0, 2.2, 2.4, 2.7, 3.0, 3.3, 3.6, 3.9, 4.3, 4.7, 5.1, 5.6, 6.2, 6.8, 7.5, 8.2, 9.1],
};
const mantissas = (series) => {
  if (TABLES[series]) return TABLES[series];
  const n = series === "E48" ? 48 : 96;
  return Array.from({ length: n }, (_, i) => Number((10 ** (i / n)).toPrecision(3)));
};

/** All values of a series from 10^loDec to 10^hiDec, ascending. */
const cache = new Map();
function seriesValues(series, loDec, hiDec) {
  const key = `${series}|${loDec}|${hiDec}`;
  let out = cache.get(key);
  if (!out) {
    const m = mantissas(series);
    out = [];
    for (let d = loDec; d <= hiDec; d++) for (const x of m) out.push(Number((x * 10 ** d).toPrecision(6)));
    cache.set(key, out);
  }
  return out;
}

// ---------- helpers ----------

const trim = (n) => String(Number(n.toPrecision(4)));
export function format(value, kind) {
  const prefixes = kind === "R"
    ? [[1e9, "G"], [1e6, "M"], [1e3, "k"], [1, ""], [1e-3, "m"]]
    : [[1, ""], [1e-3, "m"], [1e-6, "µ"], [1e-9, "n"], [1e-12, "p"]];
  for (const [scale, p] of prefixes) {
    if (value >= scale * 0.9999999) return `${trim(value / scale)} ${p}${kind === "R" ? "Ω" : "F"}`;
  }
  const [scale, p] = prefixes[prefixes.length - 1];
  return `${trim(value / scale)} ${p}${kind === "R" ? "Ω" : "F"}`;
}

/** Index of the first element >= x in a sorted array. */
function lowerBound(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < x) lo = mid + 1; else hi = mid;
  }
  return lo;
}
/** The (up to) two series values on either side of x. */
const around = (arr, x) => {
  const i = lowerBound(arr, x);
  return [arr[i - 1], arr[i]].filter((v) => v !== undefined);
};

const combine = (topology, kind, a, b) => {
  // Resistors add in series and combine like 1/(1/a+1/b) in parallel; capacitors are the reverse.
  const adds = (topology === "series") === (kind === "R");
  return adds ? a + b : (a * b) / (a + b);
};

/** The series value nearest `v` (by ratio) and its signed error in percent. */
export function nearest(v, series) {
  const d = Math.floor(Math.log10(v));
  const vals = seriesValues(series, d - 1, d + 1);
  let best = vals[0];
  for (const x of vals) if (Math.abs(Math.log(x / v)) < Math.abs(Math.log(best / v))) best = x;
  return { value: best, errPct: ((best - v) / v) * 100 };
}

/** True when v is a value of the series (within 0.5%, to absorb float noise and rounding). */
export const isStandard = (v, series) => Math.abs(nearest(v, series).errPct) < 0.5;

// ---------- the search ----------

/**
 * Two-part series or parallel networks of `series` values that make `target` within `tolPct`.
 * @returns {{topology: string, parts: number[], value: number, errPct: number}[]}
 */
export function findPairs(target, kind, series, tolPct) {
  const d = Math.floor(Math.log10(target));
  // Series partners lie below the target; parallel partners above it. A ratio over 100 between the
  // two parts is pointless (the small one dominates), so the window stays a few decades wide.
  const vals = seriesValues(series, d - 3, d + 3);
  const found = new Map();
  const add = (topology, a, b) => {
    const [x, y] = a <= b ? [a, b] : [b, a];
    const value = combine(topology, kind, x, y);
    const errPct = ((value - target) / target) * 100;
    if (Math.abs(errPct) > tolPct) return;
    const key = `${topology}|${x}|${y}`;
    if (!found.has(key)) found.set(key, { topology, parts: [x, y], value, errPct });
  };

  // "Adding" topology (series R, parallel C): a + b = target, so b is near target - a.
  // "Reciprocal" topology (parallel R, series C): 1/a + 1/b = 1/target, so b is near ta/(a - t).
  for (const topology of ["series", "parallel"]) {
    const adds = (topology === "series") === (kind === "R");
    for (const a of vals) {
      let ideal;
      if (adds) {
        if (a >= target) break;
        ideal = target - a;
      } else {
        if (a <= target || a > target * 100) continue;
        ideal = (a * target) / (a - target);
      }
      if (ideal > target * 100 || ideal < target / 100) continue;
      for (const b of around(vals, ideal)) add(topology, a, b);
    }
  }
  return [...found.values()];
}

/**
 * @param {number} target   the niche value (ohms or farads)
 * @param {"R"|"C"} kind
 * @param {{series: string, tolerance: number, have?: Set<number>, limit?: number}} opts
 *   have: values already used elsewhere on the BOM (they cost nothing extra to reuse)
 */
export function suggestNetworks(target, kind, { series, tolerance, have = new Set(), limit = 3 }) {
  const pairs = findPairs(target, kind, series, tolerance).map((p) => ({
    ...p,
    newValues: new Set(p.parts.filter((v) => !have.has(v))).size,
  }));
  // Fewest new values to stock, then closest to the target, then a tidy 2x-same-value pair.
  pairs.sort((p, q) =>
    p.newValues - q.newValues || Math.abs(p.errPct) - Math.abs(q.errPct) ||
    (p.parts[0] === p.parts[1] ? 0 : 1) - (q.parts[0] === q.parts[1] ? 0 : 1) ||
    p.topology.localeCompare(q.topology) || p.parts[0] - q.parts[0]);
  return pairs.slice(0, limit);
}

const NOTES = {
  R: {
    series: "The same current flows through both resistors, so the power splits in proportion to their values. Check each against its rating.",
    parallel: "The current splits between the two resistors, so each only needs a fraction of the power rating.",
  },
  C: {
    series: "Series capacitors share the voltage unevenly unless they have matched leakage, so add a balancing resistor across each for high voltages. Their ratings add only when balanced.",
    parallel: "Capacitors in parallel add their capacitance; the voltage rating is that of the lower-rated part. ESR drops and tolerances average out.",
  },
};

const MAX_SEARCHES = 30;
const unitOf = { Resistor: "R", Capacitor: "C" };

/**
 * Analyse the BOM summary rows.
 * @param {{component: string, value: string, details?: string, quantity: number}[]} summary
 * @param {{resistorSeries?: string, capacitorSeries?: string, tolerance?: number}} settings tolerance in percent
 */
export function analyse(summary, settings = {}) {
  const resistorSeries = settings.resistorSeries ?? "E24";
  const capacitorSeries = settings.capacitorSeries ?? "E12";
  const tolerance = settings.tolerance ?? 1;
  const seriesFor = { R: resistorSeries, C: capacitorSeries };

  const rows = [];
  for (const row of summary) {
    const kind = unitOf[row.component];
    const v = kind ? parseValue(row.value) : null;
    if (!kind || v === null || !(v > 0)) continue;
    rows.push({ row, kind, v, standard: isStandard(v, seriesFor[kind]) });
  }

  // Values that stay on the BOM as they are can be reused by the networks at no extra cost.
  const have = { R: new Set(), C: new Set() };
  for (const r of rows) if (r.standard) have[r.kind].add(nearest(r.v, seriesFor[r.kind]).value);

  const items = [];
  let searched = 0;
  for (const r of rows) {
    if (r.standard) continue;
    if (++searched > MAX_SEARCHES) break; // keeps a request within the Worker's CPU budget
    const series = seriesFor[r.kind];
    const near = nearest(r.v, series);
    const options = suggestNetworks(r.v, r.kind, { series, tolerance, have: have[r.kind] }).map((o) => ({
      topology: o.topology,
      parts: o.parts.map((x) => ({ value: x, label: format(x, r.kind), onBom: have[r.kind].has(x) })),
      result: format(o.value, r.kind),
      errPct: Number(o.errPct.toFixed(2)),
      newValues: o.newValues,
      partsPerUnit: 2,
      totalParts: 2 * r.row.quantity,
      note: NOTES[r.kind][o.topology],
    }));
    items.push({
      component: r.row.component,
      value: r.row.value,
      details: r.row.details ?? "",
      quantity: r.row.quantity,
      series,
      nearest: { value: near.value, label: format(near.value, r.kind), errPct: Number(near.errPct.toFixed(2)), withinTolerance: Math.abs(near.errPct) <= tolerance },
      options,
    });
  }
  return {
    settings: { resistorSeries, capacitorSeries, tolerance },
    checked: rows.length,
    standardCount: rows.filter((r) => r.standard).length,
    truncated: rows.filter((r) => !r.standard).length > MAX_SEARCHES,
    items,
  };
}
