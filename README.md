# CircuitJS BOM Generator

A small Python script that reads a [Falstad CircuitJS1](https://www.falstad.com/circuit/) text export and produces a bill of materials (parts list) as CSV or TSV, ready to import into a database or paste into Google Sheets.

## Requirements

- Python 3.6+
- No third-party packages

## Getting the input

In CircuitJS, choose **File > Export As Text**, copy the text, and save it to a `.txt` file. A CircuitJS share URL also works as input.

## Usage

```
python circuitjs_bom.py circuit.txt                 # summary BOM -> circuit_bom.csv
python circuitjs_bom.py circuit.txt --detail        # one row per part -> circuit_parts.csv
python circuitjs_bom.py circuit.txt --tsv           # tab-separated output
python circuitjs_bom.py circuit.txt -o parts.csv    # choose the output file
python circuitjs_bom.py -                           # read stdin, write stdout
```

| Option | Description |
| --- | --- |
| `input` | Export file, or `-` for stdin |
| `-o`, `--output` | Output path (default: `<input>_bom.csv`, or `<input>_parts.csv` with `--detail`) |
| `--detail` | One row per component instead of a grouped summary |
| `--tsv` | Tab-separated output instead of CSV |

## Output

**Summary mode** (default) groups identical parts:

```
Component,Value,Details,Quantity
Capacitor,1 µF,,2
Resistor,1 kΩ,,2
Resistor,4.7 kΩ,,1
Voltage Source,5 V amplitude,"AC (sine), 60 Hz",1
```

**Detail mode** lists each part with a reference designator and its position in the simulator:

```
Ref,Component,Value,Details,Type Code,x1,y1,x2,y2
R1,Resistor,1 kΩ,,r,176,80,304,80
C1,Capacitor,1 µF,,c,304,80,304,176
```

## Using the output

- **Google Sheets:** run with `--tsv`, copy the file contents, and paste into a sheet. Or use **File > Import** with the CSV.
- **Database:** import the CSV with your tool's bulk loader (e.g. `.import --csv` in SQLite, `COPY` in PostgreSQL, `LOAD DATA` in MySQL).

## Supported components

| Category | Parts |
| --- | --- |
| Passives | Resistor, potentiometer, capacitor, inductor, transformer |
| Diodes | Diode, Zener diode, LED |
| Sources | Voltage source (DC and waveforms), voltage rail, current source |
| Transistors | BJT (NPN/PNP), MOSFET (N/P-channel), JFET |
| ICs | Op-amp |
| Switches | SPST, SPDT |
| Logic | Inverter, AND, NAND, OR, NOR, XOR, logic input/output |

Wires, grounds, scopes, labels, and other non-purchasable elements are skipped. Unrecognized element types appear in the output as `Unknown (type N)` and a warning is printed, so nothing is dropped silently.

Values are formatted with SI prefixes (e.g. `4.7 kΩ`, `1 µF`, `10 mH`).

## Adding components

Add an entry to the `COMPONENTS` table in `circuitjs_bom.py`, keyed by the CircuitJS element type code (the first token on each line of the export). Each entry is a name plus a function that returns `(value, details)`:

```python
"r": ("Resistor", lambda flags, params: (eng(num(params, 0), "Ω"), "")),
```

To give a new part a reference designator prefix in detail mode, add it to `REF_PREFIX`. Parts without one get `U`.

## Limitations

- Parts are identified from the export's element codes. Component values come from the circuit as simulated, so real-world details like package, tolerance, or part number are not included.
- Only the common element types above are mapped so far.
