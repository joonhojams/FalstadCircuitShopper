import test from "node:test";
import assert from "node:assert/strict";
import { extractNetlist } from "../src/netlist.js";
import { buildProject } from "../src/kicad.js";
import { FOOTPRINT_DATA } from "../src/footprint-data.js";
import { parseSexp, kids, kid } from "../scripts/sexp.mjs";

// A typical overdrive stage: input cap, op-amp gain stage biased from a 4.5 V (half-supply) source, a volume pot, a 9 V rail.
const rail9 = "R 700 100 700 80 0 0 40 9 0 0 0.5";
const stage = (extra = [rail9]) => [
  "v 64 300 64 252 0 1 40 0.1 0 0 0.5", "g 64 300 64 320 0", "207 64 252 64 236 0 IN",
  "c 64 252 112 252 0 1e-7 0", "w 112 252 112 316 0", "w 112 316 200 316 0", "w 200 316 400 316 0",
  "r 200 316 200 332 0 1000000", "R 200 332 200 352 0 0 40 4.5 0 0 0.5",
  "a 400 300 500 300 0 15 -15 100 0.5 0 100000",
  "w 400 284 400 252 0", "r 400 252 500 252 0 100000", "w 500 252 500 300 0",
  "w 400 284 360 284 0", "r 360 284 360 344 0 4700", "R 360 344 360 364 0 0 40 4.5 0 0 0.5",
  "c 500 300 560 300 0 4.7e-6 0",
  "174 560 300 560 364 0 100000 0.5 Volume", "g 560 364 560 384 0", "207 576 332 576 348 0 OUT",
  ...extra,
].join("\n");
const OD = stage();
// The same stage plus eight RC low-pass sections: crowded enough that the first placement leaves nets unrouted and parts are placed again with more room.
const DENSE = [OD, ...Array.from({ length: 8 }, (_, i) => { const x = 900 + 70 * i; return [`r ${x} 600 ${x + 70} 600 0 10000`, `c ${x + 70} 600 ${x + 70} 660 0 1e-8 0`, `g ${x + 70} 660 ${x + 70} 680 0`].join("\n"); }), "R 900 600 900 580 0 0 40 9 0 0 0.5"].join("\n");

const det = () => { let k = 0; return () => `00000000-0000-4000-8000-${String(++k).padStart(12, "0")}`; };
const build = (o = {}, text = OD) => buildProject(extractNetlist(text), { name: "od", mounting: "tht", ics: { U1: "TL072" }, uuid: det(), pedal: { type: "analog_overdrive", enclosure: "1590B" }, ...o });
const json = (r, f) => JSON.parse(r.files[f]);
const checkRow = (r, id) => r.files["report.md"].split("\n").find((l) => l.startsWith(`| ${id} |`));

test("pedal mode builds a routed, checked board for both mounting styles", () => {
  for (const mounting of ["tht", "smd"]) {
    const r = build({ mounting });
    assert.ok(r.ok, `${mounting}: ${r.errors?.join()}`);
    assert.deepEqual(r.routing.unrouted, [], `${mounting}: every net routes`);
    assert.ok(r.drc.ok, `${mounting}: built-in DRC clean`);
    for (const f of ["od.kicad_sch", "od.kicad_pcb", "od.kicad_pro", "od.kicad_dru", "od.dsn", "drill_plan.json", "drill_plan.svg", "mechanical_overlay.svg", "wiring_guide.md", "report.md", "netlist.json", "placement.json", "fp-lib-table", "pedal.pretty/TP_THT_D2.0mm.kicad_mod", "pedal.pretty/WirePads_3PDT_3x3.kicad_mod"]) {
      assert.ok(r.files[f], `${mounting}: ${f} is in the project`);
    }
    for (const id of ["E1", "D1", "A1", "M1", "M2", "M3", "M5", "CP-04"]) assert.match(checkRow(r, id), /\| PASS/, `${mounting}: ${id}`);
  }
});

test("audio is kept away from power copper (A1)", () => {
  // The IN trace used to run 23 mm beside +9V on this board; the router now routes around power and LED copper.
  const r = build();
  const m = /PASS \(([\d.]+) mm run\)/.exec(checkRow(r, "A1"));
  assert.ok(m && Number(m[1]) <= 5, checkRow(r, "A1"));
});

test("the spec's net names are used and the half-supply source becomes a VREF divider", () => {
  const r = build();
  const nl = json(r, "netlist.json");
  for (const n of ["IN", "OUT", "SW_IN", "SW_OUT", "VREF", "DC_IN", "+9V", "LED_K", "BYP", "GND"]) assert.ok(nl.nets[n], `net ${n}`);
  assert.equal(nl.nets["+4.5V"], undefined, "the 4.5 V source is not a net of its own");
  assert.deepEqual(nl.renames, { "+4.5V": "VREF", IN: "SW_IN", OUT: "SW_OUT" });
  const vref = nl.nets.VREF.map((p) => p.split(".")[0]);
  assert.ok(vref.filter((x) => x.startsWith("R")).length >= 4, "the two circuit resistors plus the divider's two");
  assert.ok(vref.some((x) => x.startsWith("C")), "a VREF decoupling capacitor");
  assert.ok(vref.some((x) => x.startsWith("TP")), "a VREF test point");
  assert.deepEqual(r.summary.rails.map((x) => x.volts), [9], "only the supply stays a rail");
  // jacks and switch carry the in/out nets
  assert.ok(nl.nets.IN.some((p) => p.startsWith("J1.")) && nl.nets.OUT.some((p) => p.startsWith("J2.")));
});

test("without a bypass switch the input and output keep their own names and no footswitch is added", () => {
  const r = build({ pedal: { type: "analog_overdrive", enclosure: "1590B", bypass: "none" } });
  assert.ok(r.ok, r.errors?.join());
  const nl = json(r, "netlist.json");
  assert.equal(nl.nets.SW_IN, undefined);
  assert.ok(!r.summary.parts.some((p) => p.ref.startsWith("SW")));
  assert.ok(nl.nets.IN.some((p) => p.startsWith("J1.")));
});

test("the outline is the enclosure interior less the edge clearance, with a notch at each lid-screw post", () => {
  const r = build();
  assert.deepEqual([r.summary.board.width, r.summary.board.height], [51, 103], "1590B: 106 x 54 interior less 1.5 mm each side");
  const pcb = parseSexp(r.files["od.kicad_pcb"]);
  const edge = [...kids(pcb, "gr_line"), ...kids(pcb, "gr_arc")].filter((e) => kid(e, "layer")[1] === "Edge.Cuts");
  assert.equal(kids(pcb, "gr_arc").filter((e) => kid(e, "layer")[1] === "Edge.Cuts").length, 4, "one post notch per corner");
  // closed: every end point is shared by exactly two edge pieces
  const count = new Map();
  for (const e of edge) for (const k of ["start", "end"]) { const key = kid(e, k).slice(1).map((v) => Number(v).toFixed(3)).join(","); count.set(key, (count.get(key) ?? 0) + 1); }
  assert.ok([...count.values()].every((c) => c === 2), "the outline is a closed loop");
});

test("panel hardware is locked, on the centre line and mirrored, and the drill plan keeps its distances", () => {
  const r = build();
  const place = json(r, "placement.json").placements;
  for (const ref of ["J1", "J2", "J3", "SW1", "RV1", "LED1"]) assert.equal(place.find((p) => p.ref === ref)?.locked, true, `${ref} is locked`);
  const plan = json(r, "drill_plan.json");
  const by = (face) => plan.holes.filter((h) => h.face === face);
  assert.equal(by("side_left").length, 1);
  assert.equal(by("side_right").length, 1);
  assert.equal(by("side_left")[0].x, by("side_right")[0].x, "in/out jacks at the same distance from the top end (DP-04)");
  assert.equal(by("end_top")[0].x, plan.interior_mm.W / 2, "DC jack centred on the top end");
  assert.equal(by("top").filter((h) => h.ref === "RV1").length, 1);
  assert.ok(plan.holes.every((h) => h.dia >= 3), "no panel hole under 3 mm (DP-10)");
  assert.match(checkRow(r, "M5"), /PASS/);
  assert.match(checkRow(r, "M3"), /PASS/);
});

test("every footprint is linked to its schematic symbol, including standoff holes added during a re-placement", () => {
  // SMD pedal boards need extra room between parts, so placement runs again; the M3 holes must keep their symbols.
  for (const mounting of ["tht", "smd"]) {
    const r = build({ mounting, pedal: { type: "analog_overdrive", enclosure: "1590B", mounting: "standoffs" } }, DENSE);
    assert.ok(r.ok, r.errors?.join());
    assert.ok(r.warnings.some((w) => /mm apart/.test(w)), `${mounting}: this circuit must trigger a re-placement for the test to mean anything`);
    assert.deepEqual(r.routing.unrouted, [], `${mounting}: and the larger gap routes everything`);
    const sch = parseSexp(r.files["od.kicad_sch"]);
    const symbols = new Set(kids(sch, "symbol").map((s) => kid(s, "uuid")[1]));
    const pcb = parseSexp(r.files["od.kicad_pcb"]);
    const holes = kids(pcb, "footprint").filter((f) => String(f[1]).startsWith("MountingHole"));
    assert.ok(holes.length >= 2, `${mounting}: at least two M3 holes`);
    for (const f of kids(pcb, "footprint")) assert.ok(symbols.has(kid(f, "path")[1].slice(1)), `${mounting}: ${kids(f, "property")[0][2]} has a symbol`);
  }
});

test("a pot gets the panel footprint without the old generic-footprint warning; labels all find a place", () => {
  const r = build();
  assert.equal(r.summary.parts.find((p) => p.ref === "RV1").footprint, "Potentiometer_THT:Potentiometer_Alpha_RD901F-40-00D_Single_Vertical");
  assert.ok(!r.warnings.some((w) => w.startsWith("RV1:")), r.warnings.join("\n"));
  assert.ok(!r.warnings.some((w) => /No free place/.test(w)), r.warnings.join("\n"));
});

test("missing or impossible inputs come back as questions and block the build", () => {
  let r = build({ pedal: { type: "analog_overdrive", enclosure: "X99" } });
  assert.equal(r.ok, false);
  assert.match(r.questions[0], /interior length, width and usable height/);

  r = build({ pedal: { type: "delay_digital" } });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /4-layer/);

  r = build({}, stage([]).split("\n").filter((l) => !/^R /.test(l)).join("\n"));
  assert.equal(r.ok, false);
  assert.match(r.questions[0], /no DC supply rail/);

  r = build({}, stage([rail9, "R 800 100 800 80 0 0 40 5 0 0 0.5"]));
  assert.equal(r.ok, false);
  assert.match(r.questions[0], /neither the supply nor half of it/);

  // knob diameter, taper and current were not given: assumed and reported, not asked
  r = build();
  assert.ok(r.ok);
  assert.match(r.files["report.md"], /DP-01 knob diameter unknown/);
});

test("a footprint of your own replaces the built-in pot (P1) and is cleaned up afterwards", () => {
  const mod = `(footprint "MyPot" (version 20241229) (layer "F.Cu") (attr through_hole)
    (fp_line (start -5 -5) (end 5 -5) (stroke (width 0.1) (type solid)) (layer "F.CrtYd"))
    (fp_line (start 5 -5) (end 5 5) (stroke (width 0.1) (type solid)) (layer "F.CrtYd"))
    (fp_line (start 5 5) (end -5 5) (stroke (width 0.1) (type solid)) (layer "F.CrtYd"))
    (fp_line (start -5 5) (end -5 -5) (stroke (width 0.1) (type solid)) (layer "F.CrtYd"))
    (pad "1" thru_hole circle (at -2.5 7) (size 1.8 1.8) (drill 1) (layers "*.Cu" "*.Mask"))
    (pad "2" thru_hole circle (at 0 7) (size 1.8 1.8) (drill 1) (layers "*.Cu" "*.Mask"))
    (pad "3" thru_hole circle (at 2.5 7) (size 1.8 1.8) (drill 1) (layers "*.Cu" "*.Mask")))`;
  const pedal = (c) => ({ type: "analog_overdrive", enclosure: "1590B", custom: { pot: c } });
  let r = build({ pedal: pedal({ mod, pinout: { A: "3", W: "2", B: "1" }, hole: [0, 0] }) });
  assert.ok(r.ok, r.errors?.join());
  assert.equal(r.summary.parts.find((p) => p.ref === "RV1").footprint, "Pedal:MyPot");
  assert.ok(r.files["pedal.pretty/MyPot.kicad_mod"], "the footprint is shipped in the project library");
  assert.equal(FOOTPRINT_DATA["Pedal:MyPot"], undefined, "not left behind in the shared table");
  // pins follow the pinout the user gave: pot end A is pad 3
  const nl = json(r, "netlist.json");
  assert.ok(nl.pin_map.some((m) => m.ref === "RV1" && m.user_fn === "A" && m.pin === "3"));

  r = build({ pedal: pedal({ mod, pinout: { A: "3" } }) });
  assert.equal(r.ok, false);
  assert.match(r.questions.join(" "), /which pad is/);
  assert.equal(FOOTPRINT_DATA["Pedal:MyPot"], undefined, "cleaned up after a refusal too");
});

test("pedal output is deterministic and the normal export is untouched when pedal mode is off", () => {
  const a = build(), b = build();
  assert.deepEqual(a.files, b.files);
  const off = buildProject(extractNetlist(OD.replace(/^R 200 332.*$/m, "").replace(/^R 360 344.*$/m, "")), { name: "od", ics: { U1: "TL072" }, uuid: det() });
  assert.ok(off.ok, off.errors?.join());
  assert.ok(!off.files["drill_plan.json"] && !off.files["wiring_guide.md"], "no pedal files without pedal mode");
});

test("A4: the report lists where every ground pad returns to and fails a pad with no way into the pour", async () => {
  const { groundReturn } = await import("../src/pedal-docs.js");
  const part = (ref, pads) => ({ it: { ref }, pads });
  const layout = { parts: [
    part("J1", [{ n: "1", x: 0, y: 0, t: "thru_hole", net: "GND" }, { n: "2", x: 5, y: 0, t: "thru_hole", net: "+9V" }]),
    part("C1", [{ n: "1", x: 10, y: 0, t: "smd", net: "GND" }]),      // has a via 1 mm away
    part("C2", [{ n: "1", x: 30, y: 0, t: "smd", net: "GND" }]),      // alone
    part("C3", [{ n: "1", x: 50, y: 0, t: "smd", net: "GND" }]),      // ground track ends on it
  ] };
  const routing = { vias: [{ net: "GND", x: 11, y: 0 }, { net: "+9V", x: 30, y: 0 }], tracks: [{ net: "GND", layer: "F.Cu", w: 0.5, pts: [[50, 0], [55, 0]] }] };
  const g = groundReturn(layout, routing, "GND");
  assert.deepEqual(g.rows.map((r) => [r.ref, r.how]), [
    ["J1", "through-hole pad in the pour, both layers"], ["C1", "via to the other layer's pour"], ["C2", "pour only"], ["C3", "ground track"]]);
  assert.deepEqual(g.loose, ["C2.1"], "a non-ground via beside C2 does not count");
  assert.equal(g.rows[1].via, 1);
  assert.deepEqual(groundReturn(layout, null, "GND"), { rows: [], loose: [] });
});

test("M4 and BO-03 run with typical [V] hardware: a tall capacitor fails the sandwich gap, standoffs have no such gap, a short bushing fails M4", async () => {
  const { HW_STACK } = await import("../src/pedal.js");
  const sandwichTht = build({ mounting: "tht", pedal: { type: "analog_overdrive", enclosure: "1590B", mounting: "sandwich" } });
  assert.match(checkRow(sandwichTht, "BO-03"), /\| FAIL: .*too tall/);
  assert.match(checkRow(sandwichTht, "M4"), /\| PASS/);
  assert.match(sandwichTht.files["report.md"], /BO-03: .*taller than the 7 mm gap/);
  assert.ok(!/NOT IMPLEMENTED/.test(checkRow(sandwichTht, "M4")));

  const standoffs = build({ mounting: "tht", pedal: { type: "analog_overdrive", enclosure: "1590B", mounting: "standoffs" } });
  assert.equal(checkRow(standoffs, "BO-03"), undefined, "BO-03 is a sandwich-only rule");
  assert.match(checkRow(standoffs, "M4"), /\| PASS/);

  assert.match(checkRow(build({ mounting: "smd" }), "BO-03"), /\| PASS/, "low SMD parts fit under the lid");

  const keep = HW_STACK.pot.bushing_len;
  try {
    HW_STACK.pot.bushing_len = 3;
    const short = build({ mounting: "smd" });
    assert.match(checkRow(short, "M4"), /\| FAIL: .*bushing is 3 mm/);
  } finally { HW_STACK.pot.bushing_len = keep; }
});
