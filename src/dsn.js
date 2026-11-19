// Specctra DSN export for Freerouting (and any other tool that reads .dsn). KiCad imports the result
// with File > Import > Specctra Session (.ses), so net names here are the ones written to the .kicad_pcb.
//
// Every component gets its own "image" with its pads already turned into board orientation, and is
// placed with rotation 0. That avoids Specctra's rotation conventions entirely. Coordinates are whole
// micrometres with y up (Specctra), so y is negated from the KiCad board.
//
// Not run through Freerouting here (it needs Java and the jar); tests check the structure.

import { FOOTPRINT_DATA } from "./footprint-data.js";

const um = (mm) => Math.round(mm * 1000);
const q = (s) => `"${String(s).replace(/"/g, "'")}"`;

function padstackFor(pad, tht) {
  const w = um(pad.w), h = um(pad.h);
  const layers = tht ? ["F.Cu", "B.Cu"] : ["F.Cu"];
  const round = pad.s === "circle" || (pad.s === "oval" && w === h);
  const name = round ? `Round[${tht ? "A" : "T"}]Pad_${w}_um` : `${pad.s === "oval" ? "Oval" : "Rect"}[${tht ? "A" : "T"}]Pad_${w}x${h}_um`;
  const shapes = layers.map((l) => {
    if (round) return `(shape (circle ${l} ${w}))`;
    if (pad.s === "oval") {                       // a stadium: a thick segment along the long side
      const d = Math.abs(w - h) / 2, t = Math.min(w, h);
      return w > h ? `(shape (path ${l} ${t} ${-d} 0 ${d} 0))` : `(shape (path ${l} ${t} 0 ${-d} 0 ${d}))`;
    }
    return `(shape (rect ${l} ${-Math.round(w / 2)} ${-Math.round(h / 2)} ${Math.round(w / 2)} ${Math.round(h / 2)}))`;
  });
  return { name, text: `(padstack ${q(name)} ${shapes.join(" ")} (attach off))` };
}

/**
 * @param {{name: string, layout: object, rules: object, byNet: Map<string,string>, keepouts?: {x: number, y: number, dia: number, name?: string}[]}} a
 *   keepouts are circles in board millimetres (y down), blocking copper on both layers.
 */
export function writeDsn({ name, layout, rules, byNet, keepouts = [] }) {
  const stacks = new Map(), images = [], places = [], nets = new Map();
  for (const r of layout.parts) {
    const fp = FOOTPRINT_DATA[r.it.footprint];
    const img = `${r.it.ref}_${r.it.footprint.split(":").pop()}`;
    const pins = r.pads.map((p, i) => {
      const src = fp.pads[i];
      const tht = src.t !== "smd";
      if (src.t === "np_thru_hole") return null;                // mounting holes carry no copper
      const ps = padstackFor(p, tht);
      stacks.set(ps.name, ps.text);
      if (p.net) (nets.get(p.net) ?? nets.set(p.net, []).get(p.net)).push(`${r.it.ref}-${p.n}`);
      return `(pin ${q(ps.name)} ${q(p.n)} ${um(p.x - r.x)} ${-um(p.y - r.y)})`;
    }).filter(Boolean);
    images.push(`    (image ${q(img)}\n      ${pins.join("\n      ")}\n    )`);
    places.push(`    (component ${q(img)} (place ${r.it.ref} ${um(r.x)} ${-um(r.y)} front 0))`);
  }

  const via = rules.via, viaName = `Via[0-1]_${um(via.pad)}:${um(via.drill)}_um`;
  const viaStack = `(padstack ${q(viaName)} (shape (circle F.Cu ${um(via.pad)})) (shape (circle B.Cu ${um(via.pad)})) (attach off))`;

  const byClass = new Map();
  for (const [net, pins] of nets) {
    if (pins.length < 2) continue;            // nothing to route
    const k = byNet.get(net) ?? "Default";
    (byClass.get(k) ?? byClass.set(k, []).get(k)).push(net);
  }
  const rule = (c) => `(rule (width ${um(c.track)}) (clearance ${um(c.clear)}))`;
  const classes = [...byClass].map(([k, list]) => `    (class ${q(k)} ${list.map((n) => q(`/${n}`)).join(" ")}\n      (circuit (use_via ${q(viaName)}))\n      ${rule(rules.classes[k] ?? rules.classes.Default)})`);

  const W = um(layout.w), L = um(layout.l);
  const keep = keepouts.map((k) => ["F.Cu", "B.Cu"].map((l) => `    (keepout ${q(k.name ?? "keepout")} (circle ${l} ${um(k.dia)} ${um(k.x)} ${-um(k.y)}))`).join("\n"));
  const netBlock = [...nets].filter(([, pins]) => pins.length > 1).map(([n, pins]) => `    (net ${q(`/${n}`)}\n      (pins ${pins.join(" ")})\n    )`);

  return `(pcb ${q(name)}
  (parser (string_quote ") (space_in_quoted_tokens on) (host_cad "circuitjs-bom") (host_version "1.0"))
  (resolution um 1)
  (unit um)
  (structure
    (layer F.Cu (type signal) (property (index 0)))
    (layer B.Cu (type signal) (property (index 1)))
    (boundary (path pcb 0 0 0 ${W} 0 ${W} ${-L} 0 ${-L} 0 0))
${keep.join("\n")}
    (via ${q(viaName)})
    ${rule(rules.classes.Default)}
  )
  (placement
${places.join("\n")}
  )
  (library
${images.join("\n")}
    ${[...stacks.values(), viaStack].join("\n    ")}
  )
  (network
${netBlock.join("\n")}
${classes.join("\n")}
  )
  (wiring)
)
`;
}
