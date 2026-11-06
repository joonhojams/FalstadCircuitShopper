// Turns a BOM row into a DigiKey keyword search.
//
// The BOM only knows what the simulator knows (a resistance, a capacitance, a
// diode model...). It has no package, tolerance, voltage rating or part number,
// so these searches are heuristics: they pick sensible hobby-build defaults and
// flag the ones that involve a guess. Users can edit any search in the UI.

const PREFIX = { T: 1e12, G: 1e9, M: 1e6, k: 1e3, "": 1, m: 1e-3, "µ": 1e-6, "μ": 1e-6, u: 1e-6, n: 1e-9, p: 1e-12 };

/** "4.7 kΩ" -> 4700, "100 nF" -> 1e-7. Returns null when it doesn't parse. */
export function parseValue(str) {
  const m = /^\s*(-?\d+(?:\.\d+)?(?:e[-+]?\d+)?)\s*([TGMkmµμunp]?)(Ω|F|H|A|V)/.exec(String(str ?? ""));
  return m ? Number(m[1]) * PREFIX[m[2]] : null;
}

const trim = (n) => String(Number(n.toPrecision(6)));
const ohms = (n) => (n >= 1e6 ? `${trim(n / 1e6)}M` : n >= 1e3 ? `${trim(n / 1e3)}K` : trim(n));
const farads = (n) => (n < 1e-8 ? `${trim(n * 1e12)}PF` : `${trim(n * 1e6)}UF`);
const henries = (n) => (n >= 1 ? `${trim(n)}H` : n >= 1e-3 ? `${trim(n * 1e3)}MH` : `${trim(n * 1e6)}UH`);

// Looks like a real part number (has a digit, no spaces), not "default" or a word.
const partNumber = (s) => {
  const t = String(s ?? "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9-]{2,}$/.test(t) && /\d/.test(t) && !/^default/i.test(t) ? t : null;
};

// Simulation-only elements: nothing to buy.
const NO_BUY = {
  "Voltage Source": "Simulation source, not a part",
  "Voltage Rail": "Supply rail, not a part",
  "Current Source": "Simulation source, not a part",
  "Logic Input": "Simulation I/O, not a part",
  "Logic Output": "Simulation I/O, not a part",
};

/**
 * @param {{component: string, value?: string, details?: string}} row
 * @param {"tht"|"smd"|"any"} pkg  preferred mounting style
 * @returns {{skip: string} | {query: string|null, assumed?: boolean, note?: string}}
 */
export function buildQuery(row, pkg = "tht") {
  const { component, value = "", details = "" } = row;
  if (NO_BUY[component]) return { skip: NO_BUY[component] };

  const tht = pkg === "tht";
  const smd = pkg === "smd";
  const n = parseValue(value);
  const none = { query: null, note: "No automatic search for this part. Type a search in the box and press Enter." };
  const guess = (query, note) => ({ query, assumed: true, note });

  switch (component) {
    case "Resistor":
      return n === null ? none : { query: `RES ${ohms(n)} OHM${tht ? " 1/4W AXIAL" : smd ? " 1/8W 0805" : ""}` };

    case "Potentiometer":
      return n === null ? none : { query: `POTENTIOMETER ${ohms(n)} OHM` };

    case "Capacitor": {
      if (n === null) return none;
      const f = farads(n);
      const note = "Voltage rating and type assumed (ceramic below 1 µF, electrolytic above; check polarity). Edit the search to change.";
      if (smd) return guess(n <= 10e-6 ? `CAP CER ${f} 25V 0805` : `CAP ALUM ${f} 25V SMD`, note);
      if (tht) return guess(n < 1e-6 ? `CAP CER ${f} 50V RADIAL` : `CAP ALUM ${f} 25V RADIAL`, note);
      return { query: n < 1e-6 ? `CAP CER ${f}` : `CAP ${f}` };
    }

    case "Inductor":
      return n === null ? none : { query: `FIXED IND ${henries(n)}` };

    case "Diode": {
      const model = partNumber(value);
      return model ? { query: model } : guess("1N4148", "The circuit uses a generic diode; assumed 1N4148.");
    }
    case "Zener Diode":
      return n === null ? none : { query: `DIODE ZENER ${trim(n)}V 500MW` };

    case "LED":
      return guess(`LED ${tht ? "5MM THROUGH HOLE" : smd ? "0805" : ""}`.trim(), "Colour isn't specified in the circuit.");

    case "BJT Transistor": {
      const model = partNumber(details);
      if (model) return { query: model };
      return guess(value === "PNP" ? "2N3906" : "2N3904", `Generic ${value || "NPN"} transistor; assumed ${value === "PNP" ? "2N3906" : "2N3904"}.`);
    }
    case "MOSFET": {
      const p = /^P/i.test(value);
      const q = p ? (smd ? "BSS84" : "BS250") : smd ? "2N7002" : "2N7000";
      return guess(q, `Generic ${p ? "P" : "N"}-channel MOSFET; assumed ${q}.`);
    }
    case "JFET": {
      const model = partNumber(value);
      return model ? { query: model } : guess("2N5457", "Generic JFET; assumed 2N5457.");
    }
    case "Op-Amp":
      return guess(`LM358${tht ? " 8-DIP" : smd ? " 8-SOIC" : ""}`, "Generic op-amp; assumed LM358.");
    case "555 Timer":
      return guess(`NE555${tht ? " 8-DIP" : smd ? " 8-SOIC" : ""}`, "Assumed a standard 555 timer.");

    case "Switch (SPST)":
      return { query: /momentary/i.test(details) ? "SWITCH TACTILE SPST-NO" : "SWITCH TOGGLE SPST" };
    case "Switch (SPDT)":
      return { query: "SWITCH TOGGLE SPDT" };

    default:
      return none;
  }
}
