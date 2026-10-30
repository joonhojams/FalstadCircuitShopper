#!/usr/bin/env python3
"""
circuitjs_bom.py - Build a component list (BOM) from a Falstad CircuitJS1 text export.

Usage:
    python circuitjs_bom.py circuit.txt                 # summary BOM -> circuit_bom.csv
    python circuitjs_bom.py circuit.txt --detail        # one row per component
    python circuitjs_bom.py circuit.txt --tsv           # tab-separated (paste straight into Google Sheets)
    python circuitjs_bom.py circuit.txt -o parts.csv
    python circuitjs_bom.py -                           # read from stdin, print to stdout

Input: the text from CircuitJS "File > Export As Text" (or an export link URL).
Each line is:  <type> x1 y1 x2 y2 flags <extra params...>

Output: CSV/TSV. Summary columns: Component, Value, Details, Quantity
        Detail columns:  Ref, Component, Value, Details, Type Code, x1, y1, x2, y2
"""
import argparse
import csv
import sys
from collections import Counter
from urllib.parse import unquote_plus

# ---------------------------------------------------------------- formatting

_PREFIXES = [(1e12, "T"), (1e9, "G"), (1e6, "M"), (1e3, "k"), (1, ""),
             (1e-3, "m"), (1e-6, "µ"), (1e-9, "n"), (1e-12, "p")]


def eng(value, unit=""):
    """Format a number with an SI prefix, e.g. 0.000001 -> '1 µF'."""
    try:
        v = float(value)
    except (TypeError, ValueError):
        return str(value)
    if v == 0:
        return f"0 {unit}".strip()
    for scale, prefix in _PREFIXES:
        if abs(v) >= scale * 0.9999999:
            return f"{round(v / scale, 6):g} {prefix}{unit}".strip()
    return f"{v:g} {unit}".strip()


def num(params, i, default=None):
    try:
        return float(params[i])
    except (IndexError, ValueError):
        return default


# ---------------------------------------------------------------- component table
# Each handler returns (value, details) given (flags:int, params:list[str]).

WAVEFORMS = {0: "DC", 1: "AC (sine)", 2: "Square", 3: "Triangle",
             4: "Sawtooth", 5: "Pulse", 6: "Noise"}


def _source(flags, p):
    wf = int(num(p, 0, 0))
    freq, amp, bias = num(p, 1, 0), num(p, 2, 0), num(p, 3, 0)
    if wf == 0:
        return eng(amp, "V"), "DC"
    detail = f"{WAVEFORMS.get(wf, 'Waveform ' + str(wf))}, {eng(freq, 'Hz')}"
    if bias:
        detail += f", bias {eng(bias, 'V')}"
    return eng(amp, "V") + " amplitude", detail


def _diode(flags, p):
    model = next((x for x in p if not _is_num(x)), "")
    return model, f"Vf {eng(num(p, 0), 'V')}" if num(p, 0) is not None and not model else ""


def _zener(flags, p):
    vz = num(p, 1, num(p, 0))
    return eng(vz, "V") if vz is not None else "", "Zener"


def _is_num(s):
    try:
        float(s)
        return True
    except ValueError:
        return False


COMPONENTS = {
    "r":   ("Resistor",            lambda f, p: (eng(num(p, 0), "Ω"), "")),
    "174": ("Potentiometer",       lambda f, p: (eng(num(p, 0), "Ω"), "")),
    "c":   ("Capacitor",           lambda f, p: (eng(num(p, 0), "F"), "")),
    "l":   ("Inductor",            lambda f, p: (eng(num(p, 0), "H"), "")),
    "d":   ("Diode",               _diode),
    "z":   ("Zener Diode",         _zener),
    "162": ("LED",                 lambda f, p: ("", f"Vf {eng(num(p, 0), 'V')}" if num(p, 0) else "")),
    "v":   ("Voltage Source",      _source),
    "R":   ("Voltage Rail",        _source),
    "i":   ("Current Source",      lambda f, p: (eng(num(p, 0), "A"), "")),
    "t":   ("BJT Transistor",      lambda f, p: ("PNP" if num(p, 0, 1) == -1 else "NPN", "")),
    "f":   ("MOSFET",              lambda f, p: ("P-channel" if f & 1 else "N-channel", "")),
    "j":   ("JFET",                lambda f, p: ("", "")),
    "a":   ("Op-Amp",              lambda f, p: ("", "")),
    "s":   ("Switch (SPST)",       lambda f, p: ("", "")),
    "S":   ("Switch (SPDT)",       lambda f, p: ("", "")),
    "T":   ("Transformer",         lambda f, p: ("", f"Ratio {p[1]}" if len(p) > 1 else "")),
    "I":   ("Inverter",            lambda f, p: ("", "")),
    "150": ("AND Gate",            lambda f, p: ("", "")),
    "151": ("NAND Gate",           lambda f, p: ("", "")),
    "152": ("OR Gate",             lambda f, p: ("", "")),
    "153": ("NOR Gate",            lambda f, p: ("", "")),
    "154": ("XOR Gate",            lambda f, p: ("", "")),
    "L":   ("Logic Input",         lambda f, p: ("", "")),
    "M":   ("Logic Output",        lambda f, p: ("", "")),
}

REF_PREFIX = {
    "Resistor": "R", "Potentiometer": "RV", "Capacitor": "C", "Inductor": "L",
    "Diode": "D", "Zener Diode": "D", "LED": "LED", "Voltage Source": "V",
    "Voltage Rail": "V", "Current Source": "I", "BJT Transistor": "Q",
    "MOSFET": "Q", "JFET": "Q", "Op-Amp": "U", "Switch (SPST)": "SW",
    "Switch (SPDT)": "SW", "Transformer": "T",
}

# Elements that are wiring/annotation/measurement only, not parts you'd buy.
IGNORED = {"w", "g", "o", "O", "x", "h", "p", "370", "B", "%", "?", "$"}


# ---------------------------------------------------------------- parsing

def load_text(raw):
    """Accept plain export text or a CircuitJS share URL (percent-encoded)."""
    raw = raw.strip()
    if "#" in raw and raw.lower().startswith("http"):
        raw = raw.split("#", 1)[1]
    if raw.startswith("%24") or raw.startswith("$+") or "%0A" in raw:
        raw = unquote_plus(raw)
    return raw.replace("\\n", "\n")


def parse(text):
    parts = []
    unknown = Counter()
    for line in text.splitlines():
        tok = line.split()
        if not tok or tok[0][0] in "$%?#":
            continue
        code = tok[0]
        if code in IGNORED:
            continue
        try:
            x1, y1, x2, y2, flags = (int(float(t)) for t in tok[1:6])
        except ValueError:
            continue
        params = tok[6:]
        if code in COMPONENTS:
            name, fn = COMPONENTS[code]
            value, details = fn(flags, params)
        else:
            name, value, details = f"Unknown (type {code})", "", " ".join(params)[:60]
            unknown[code] += 1
        parts.append({"code": code, "name": name, "value": value, "details": details,
                      "x1": x1, "y1": y1, "x2": x2, "y2": y2})
    return parts, unknown


# ---------------------------------------------------------------- output

def write_rows(parts, detail, delim, out):
    w = csv.writer(out, delimiter=delim, lineterminator="\n")
    if detail:
        w.writerow(["Ref", "Component", "Value", "Details", "Type Code", "x1", "y1", "x2", "y2"])
        counters = Counter()
        for p in parts:
            prefix = REF_PREFIX.get(p["name"], "U")
            counters[prefix] += 1
            w.writerow([f"{prefix}{counters[prefix]}", p["name"], p["value"], p["details"],
                        p["code"], p["x1"], p["y1"], p["x2"], p["y2"]])
    else:
        w.writerow(["Component", "Value", "Details", "Quantity"])
        counts = Counter((p["name"], p["value"], p["details"]) for p in parts)
        for (name, value, details), qty in sorted(counts.items()):
            w.writerow([name, value, details, qty])


def main():
    ap = argparse.ArgumentParser(description="Create a BOM from a CircuitJS1 text export.")
    ap.add_argument("input", help="CircuitJS export .txt file, or - for stdin")
    ap.add_argument("-o", "--output", help="output file (default: <input>_bom.csv, or stdout for stdin)")
    ap.add_argument("--detail", action="store_true", help="one row per component instead of a summary")
    ap.add_argument("--tsv", action="store_true", help="tab-separated output")
    args = ap.parse_args()

    raw = sys.stdin.read() if args.input == "-" else open(args.input, encoding="utf-8").read()
    parts, unknown = parse(load_text(raw))
    if not parts:
        sys.exit("No components found - is this a CircuitJS text export?")

    delim = "\t" if args.tsv else ","
    ext = ".tsv" if args.tsv else ".csv"
    if args.output:
        out_path = args.output
    elif args.input == "-":
        out_path = None
    else:
        out_path = args.input.rsplit(".", 1)[0] + ("_parts" if args.detail else "_bom") + ext

    if out_path:
        with open(out_path, "w", newline="", encoding="utf-8") as f:
            write_rows(parts, args.detail, delim, f)
        print(f"Wrote {len(parts)} components to {out_path}", file=sys.stderr)
    else:
        write_rows(parts, args.detail, delim, sys.stdout)

    if unknown:
        print("Note: unrecognized element types (listed as 'Unknown'): " +
              ", ".join(f"{k} x{v}" for k, v in unknown.items()), file=sys.stderr)


if __name__ == "__main__":
    main()
