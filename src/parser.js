// Parser for Falstad CircuitJS1 text exports -> bill of materials.
// JavaScript port of circuitjs_bom.py. Pure functions, no dependencies.

const SI = [[1e12, "T"], [1e9, "G"], [1e6, "M"], [1e3, "k"], [1, ""],
            [1e-3, "m"], [1e-6, "µ"], [1e-9, "n"], [1e-12, "p"]];

/** Format a number with an SI prefix, e.g. 0.000001 -> "1 µF". */
export function eng(value, unit = "") {
  if (value === null || value === undefined || value === "") return "";
  const v = Number(value);
  if (Number.isNaN(v)) return String(value);
  if (v === 0) return `0 ${unit}`.trim();
  for (const [scale, prefix] of SI) {
    if (Math.abs(v) >= scale * 0.9999999) {
      return `${Number((v / scale).toPrecision(6))} ${prefix}${unit}`.trim();
    }
  }
  return `${v} ${unit}`.trim();
}

const num = (p, i, dflt = null) => {
  const v = parseFloat(p[i]);
  return Number.isFinite(v) ? v : dflt;
};
const isNum = (s) => s !== undefined && s !== "" && Number.isFinite(Number(s));

const WAVEFORMS = { 0: "DC", 1: "AC (sine)", 2: "Square", 3: "Triangle",
                    4: "Sawtooth", 5: "Pulse", 6: "Noise" };

const source = (_f, p) => {
  const wf = Math.trunc(num(p, 0, 0));
  const freq = num(p, 1, 0), amp = num(p, 2, 0), bias = num(p, 3, 0);
  if (wf === 0) return [eng(amp, "V"), "DC"];
  let d = `${WAVEFORMS[wf] ?? `Waveform ${wf}`}, ${eng(freq, "Hz")}`;
  if (bias) d += `, bias ${eng(bias, "V")}`;
  return [`${eng(amp, "V")} amplitude`, d];
};

const diode = (_f, p) => {
  const model = p.find((x) => !isNum(x)) ?? "";
  const vf = isNum(p[0]) ? Number(p[0]) : null;
  return [model, vf !== null ? `Vf ${eng(vf, "V")}` : ""];
};

// type code -> [display name, (flags, params) => [value, details]]
const COMPONENTS = {
  r:   ["Resistor",       (_f, p) => [eng(num(p, 0), "Ω"), ""]],
  174: ["Potentiometer",  (_f, p) => [eng(num(p, 0), "Ω"), ""]],
  c:   ["Capacitor",      (_f, p) => [eng(num(p, 0), "F"), ""]],
  l:   ["Inductor",       (_f, p) => [eng(num(p, 0), "H"), ""]],
  d:   ["Diode",          diode],
  z:   ["Zener Diode",    (_f, p) => [eng(num(p, 1, num(p, 0)), "V"), "Zener"]],
  162: ["LED",            (_f, p) => ["", num(p, 0) ? `Vf ${eng(num(p, 0), "V")}` : ""]],
  v:   ["Voltage Source", source],
  R:   ["Voltage Rail",   source],
  i:   ["Current Source", (_f, p) => [eng(num(p, 0), "A"), ""]],
  t:   ["BJT Transistor", (_f, p) => [num(p, 0, 1) === -1 ? "PNP" : "NPN", ""]],
  f:   ["MOSFET",         (f, _p) => [f & 1 ? "P-channel" : "N-channel", ""]],
  j:   ["JFET",           () => ["", ""]],
  a:   ["Op-Amp",         () => ["", ""]],
  s:   ["Switch (SPST)",  () => ["", ""]],
  S:   ["Switch (SPDT)",  () => ["", ""]],
  T:   ["Transformer",    (_f, p) => ["", p.length > 1 ? `Ratio ${p[1]}` : ""]],
  I:   ["Inverter",       () => ["", ""]],
  150: ["AND Gate",       () => ["", ""]],
  151: ["NAND Gate",      () => ["", ""]],
  152: ["OR Gate",        () => ["", ""]],
  153: ["NOR Gate",       () => ["", ""]],
  154: ["XOR Gate",       () => ["", ""]],
  L:   ["Logic Input",    () => ["", ""]],
  M:   ["Logic Output",   () => ["", ""]],
};

const REF_PREFIX = {
  "Resistor": "R", "Potentiometer": "RV", "Capacitor": "C", "Inductor": "L",
  "Diode": "D", "Zener Diode": "D", "LED": "LED", "Voltage Source": "V",
  "Voltage Rail": "V", "Current Source": "I", "BJT Transistor": "Q",
  "MOSFET": "Q", "JFET": "Q", "Op-Amp": "U", "Switch (SPST)": "SW",
  "Switch (SPDT)": "SW", "Transformer": "T",
};

// Wiring / annotation / measurement elements: not parts you would buy.
const IGNORED = new Set(["w", "g", "o", "O", "x", "h", "p", "370", "B", "%", "?", "$"]);

/** Accept plain export text or a share URL with the circuit percent-encoded after '#'. */
export function loadText(raw) {
  raw = String(raw).trim();
  if (raw.includes("#") && /^https?:/i.test(raw)) raw = raw.split("#").slice(1).join("#");
  if (raw.startsWith("%24") || raw.startsWith("$+") || raw.includes("%0A")) {
    try { raw = decodeURIComponent(raw.replace(/\+/g, " ")); } catch { /* leave as-is */ }
  }
  return raw.replace(/\\n/g, "\n");
}

export function parse(text) {
  const parts = [];
  const unknown = {};
  for (const line of text.split(/\r?\n/)) {
    const tok = line.trim().split(/\s+/);
    const code = tok[0];
    if (!code || "$%?#".includes(code[0]) || IGNORED.has(code)) continue;
    const head = tok.slice(1, 6).map((t) => Math.trunc(Number(t)));
    if (head.length < 5 || head.some(Number.isNaN)) continue;
    const [x1, y1, x2, y2, flags] = head;
    const params = tok.slice(6);
    let name, value, details;
    if (Object.hasOwn(COMPONENTS, code)) {
      const [n, fn] = COMPONENTS[code];
      name = n;
      [value, details] = fn(flags, params);
    } else {
      name = `Unknown (type ${code})`;
      value = "";
      details = params.join(" ").slice(0, 60);
      unknown[code] = (unknown[code] ?? 0) + 1;
    }
    parts.push({ code, name, value, details, x1, y1, x2, y2 });
  }
  return { parts, unknown };
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Parse an export and return { count, summary, parts, unknown }. */
export function bom(raw) {
  const { parts, unknown } = parse(loadText(raw));

  const counters = {};
  const detail = parts.map((p) => {
    const prefix = REF_PREFIX[p.name] ?? "U";
    counters[prefix] = (counters[prefix] ?? 0) + 1;
    return { ref: `${prefix}${counters[prefix]}`, component: p.name, value: p.value,
             details: p.details, type: p.code, x1: p.x1, y1: p.y1, x2: p.x2, y2: p.y2 };
  });

  const groups = new Map();
  for (const p of parts) {
    const k = JSON.stringify([p.name, p.value, p.details]);
    groups.set(k, (groups.get(k) ?? 0) + 1);
  }
  const summary = [...groups]
    .map(([k, quantity]) => {
      const [component, value, details] = JSON.parse(k);
      return { component, value, details, quantity };
    })
    .sort((a, b) => cmp(a.component, b.component) || cmp(a.value, b.value) || cmp(a.details, b.details));

  return { count: parts.length, summary, parts: detail, unknown };
}
