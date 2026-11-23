// rule_residual.mjs — how well does each decision rule satisfy the model?
//
//   node tools/rule_residual.mjs
//
// A first-order solution y = P y(-1) + Q e must satisfy the linearised
// model A y(+1) + B y + C y(-1) = 0, that is, A P P + B P + C = 0. This
// puts both the workbench's P and Dynare's (test/reference/*.json) into
// that equation, with A, B and C from the workbench's exact derivatives,
// and prints the largest entry of what is left over. It is the way to tell
// which program is nearer the truth where the two differ.
//
// Models for which the two programs do not use the same list of variables
// (auxiliary variables for long leads and lags are named differently) are
// passed over.
//
// Part of dsge-workbench. Copyright (C) 2026 Mico Mrkaic.
// GPL-3.0-or-later; see LICENSE.
import fs from "node:fs";
import { parseMod } from "../docs/js/modfile.js";
import { Workbench, cozyNum } from "../docs/js/solve.js";
import { startEngine } from "../test/engine-node.mjs";

const root = new URL("..", import.meta.url);
const examples = JSON.parse(fs.readFileSync(new URL("docs/examples/index.json", root), "utf8"));
const engine = await startEngine();
const RESIDUAL = P => `max(max(abs(wb_L.A * ${P} * ${P} + wb_L.B * ${P} + wb_L.C)))`;

console.log("model".padEnd(26), "workbench".padStart(10), "Dynare".padStart(10), "  largest difference between the two rules");
for (const ex of examples) {
  const name = ex.file.replace(/\.mod$/, "");
  const ref = JSON.parse(fs.readFileSync(new URL(`test/reference/${name}.json`, root), "utf8"));
  const model = parseMod(fs.readFileSync(new URL(`docs/examples/${ex.file}`, root), "utf8")).model;
  const wb = new Workbench(engine);
  await wb.load(model);
  const r = await wb.solve({});
  const names = model.endo.map(v => v.name), n = names.length;
  const cols = ref.state_names.map(s => names.indexOf(s));
  if (n !== ref.endo.length || cols.some(c => c < 0)) { console.log(name.padEnd(26), "(the two programs use different auxiliary variables)"); continue; }
  // Dynare's rule as an n x n matrix: its columns are the state variables
  const Pd = names.map((_, i) => names.map((_, j) => { const q = cols.indexOf(j); return q < 0 ? 0 : ref.ghx[i][q]; }));
  const out = await engine.exec({
    src: `let wb_L = dg_lin_at(wb_m, wb_p, wb_y);
let wb_Pd = [${Pd.map(row => row.map(cozyNum).join(", ")).join("; ")}];
let wb_res = [${RESIDUAL("wb_P")}, ${RESIDUAL("wb_Pd")}, max(max(abs(wb_P - wb_Pd)))];`,
    read: ["wb_res"],
  });
  if (!out.ok) { console.log(name.padEnd(26), out.output.trim().split("\n")[0]); continue; }
  const [mine, theirs, gap] = out.values.wb_res.data;
  console.log(name.padEnd(26), mine.toExponential(1).padStart(10), theirs.toExponential(1).padStart(10), " ", gap.toExponential(1), r.ok ? "" : "(not solved)");
}
process.exit(0);
