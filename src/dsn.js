// Specctra .dsn export of the placed board, for Freerouting (File > Open > Specctra DSN, route, then
// File > Export Specctra Session and import the .ses in KiCad: File > Import > Specctra Session).
//
// Units are micrometres. Specctra's y axis points up and KiCad's down, so y is negated. Each part is
// its own image with the board rotation already applied to its pads (placed at rotation 0).
//
// Written from the Specctra format as KiCad writes it. It has been checked for balanced structure in
// the tests but not loaded into Freerouting here (no Java runtime / download access).

import { NET_CLASSES, VIA } from "./netclass.js";

const um = (mm) => Math.round(mm * 10000) / 10;               // mm -> um, 0.1 um precision
const f = (v) => String(um(v));
const nm = (s) => `"${String(s).replace(/"/g, "'")}"`;

export function dsnText({ name, layout, classes, pour = null }) {
  const padstacks = new Map();                                // key -> definition text
  const psName = (p) => {
    const l = p.l ?? [];
    const top = l.includes("F.Cu") || l.includes("*.Cu"), bot = l.includes("B.Cu") || l.includes("*.Cu");
    const layers = [top && "F.Cu", bot && "B.Cu"].filter(Boolean);
    const w = Math.max(p.w, 0.01), h = Math.max(p.h, 0.01);
    const kind = p.s === "circle" || (p.s === "oval" && Math.abs(w - h) < 1e-6) ? "Round" : p.s === "oval" ? "Oval" : "Rect";
    const key = `${kind}${p.t === "thru_hole" ? "TH" : "SMD"}_${layers.join("")}_${um(w)}x${um(h)}`;
    if (!padstacks.has(key)) {
      const shape = (ly) => kind === "Round" ? `(shape (circle ${ly} ${f(w)}))`
        : kind === "Oval" ? (w >= h
          ? `(shape (path ${ly} ${f(h)} ${f(-(w - h) / 2)} 0 ${f((w - h) / 2)} 0))`
          : `(shape (path ${ly} ${f(w)} 0 ${f(-(h - w) / 2)} 0 ${f((h - w) / 2)}))`)
        : `(shape (rect ${ly} ${f(-w / 2)} ${f(-h / 2)} ${f(w / 2)} ${f(h / 2)}))`;
      padstacks.set(key, `    (padstack ${nm(key)}\n${layers.map((ly) => `      ${shape(ly)}`).join("\n")}\n      (attach off)\n    )`);
    }
    return key;
  };

  const images = [], places = [];
  for (const part of layout.parts) {
    const ref = part.it.ref;
    const pins = part.pads.map((p) => `      (pin ${nm(psName(p))} ${nm(p.n)} ${f(p.x - part.x)} ${f(-(p.y - part.y))})`);
    images.push(`    (image ${nm(ref)}\n${pins.join("\n")}\n    )`);
    places.push(`    (component ${nm(ref)}\n      (place ${nm(ref)} ${f(part.x)} ${f(-part.y)} front 0)\n    )`);
  }

  const viaName = `Via[0-1]_${um(VIA.size)}:${um(VIA.drill)}_um`;
  const byNet = new Map();
  for (const part of layout.parts) for (const p of part.pads) if (p.net) (byNet.get(p.net) ?? byNet.set(p.net, []).get(p.net)).push(`${part.it.ref}-${p.n}`);
  const nets = [...byNet].filter(([, pins]) => pins.length > 1);
  const byClass = new Map();
  for (const [n] of nets) (byClass.get(classes.get(n) ?? "AUDIO_SIG") ?? byClass.set(classes.get(n) ?? "AUDIO_SIG", []).get(classes.get(n) ?? "AUDIO_SIG")).push(n);

  const W = layout.w, L = layout.l;
  const keepouts = (layout.keepouts ?? []).flatMap((k, i) => ["F.Cu", "B.Cu"].map((ly) => `    (keepout ${nm(`post${i + 1}`)} (circle ${ly} ${f(k.r * 2)} ${f(k.x)} ${f(-k.y)}))`));

  return `(pcb ${nm(`${name}.dsn`)}
  (parser
    (string_quote ")
    (space_in_quoted_tokens on)
    (host_cad "circuitjs-bom")
    (host_version "1.0")
  )
  (resolution um 10)
  (unit um)
  (structure
    (layer F.Cu (type signal) (property (index 0)))
    (layer B.Cu (type signal) (property (index 1)))
    (boundary (path pcb 0 0 0 ${f(W)} 0 ${f(W)} ${f(-L)} 0 ${f(-L)} 0 0))
${keepouts.join("\n")}
    (via ${nm(viaName)})
    (rule (width ${f(NET_CLASSES.AUDIO_SIG.track)}) (clearance ${f(NET_CLASSES.AUDIO_SIG.clearance)}))
  )
  (placement
${places.join("\n")}
  )
  (library
${images.join("\n")}
${[...padstacks.values()].join("\n")}
    (padstack ${nm(viaName)}
      (shape (circle F.Cu ${f(VIA.size)}))
      (shape (circle B.Cu ${f(VIA.size)}))
      (attach off)
    )
  )
  (network
${nets.map(([n, pins]) => `    (net ${nm(`/${n}`)}\n      (pins ${pins.map(nm).join(" ")})\n    )`).join("\n")}
${[...byClass].map(([c, list]) => `    (class ${c} ${list.map((n) => nm(`/${n}`)).join(" ")}
      (circuit (use_via ${nm(viaName)}))
      (rule (width ${f(NET_CLASSES[c].track)}) (clearance ${f(NET_CLASSES[c].clearance)}))
    )`).join("\n")}
  )
  (wiring)
)
`;
}
