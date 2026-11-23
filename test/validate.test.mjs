// validate.test.mjs — the workbench against Dynare.
//
// Each bundled model is read by the workbench's own reader, solved by Cozy
// in the same WebAssembly the browser runs, and compared number by number
// with what Dynare 6.0 computed for the same file (test/reference/*.json,
// written by tools/dynare_reference.py).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { compareWithDynare, compareSecondOrder } from "./compare.mjs";
import { startEngine } from "./engine-node.mjs";

const here = new URL(".", import.meta.url);
const examples = JSON.parse(fs.readFileSync(new URL("../docs/examples/index.json", here), "utf8"));
const engine = await startEngine();

for (const ex of examples) {
  const name = ex.file.replace(/\.mod$/, "");
  test(`${name}: matches Dynare`, async () => {
    const { variables, shocks, report } = await compareWithDynare(engine, ex);
    const worst = Math.max(...Object.values(report));
    console.log(`  ${name}: ${variables} variables, ${shocks} shocks; largest relative difference ${worst.toExponential(1)} (` +
      Object.entries(report).map(([key, v]) => `${key} ${v.toExponential(0)}`).join(", ") + ")");
    for (const [key, v] of Object.entries(report)) assert.ok(v < 1e-6, `${key} differs from Dynare by ${v.toExponential(2)}`);
  });
}

// ... and to second order, against stoch_simul(order=2): the second-order
// terms of the decision rule, the means, and a pruned simulation.
for (const ex of examples) {
  const name = ex.file.replace(/\.mod$/, "");
  test(`${name}: matches Dynare to second order`, async () => {
    const { linear, states, report } = await compareSecondOrder(engine, ex);
    if (linear) { console.log(`  ${name}: a linear model, no second-order terms in either program`); return; }
    const worst = Math.max(...Object.values(report));
    console.log(`  ${name}: ${states} states; largest relative difference ${worst.toExponential(1)} (` +
      Object.entries(report).map(([key, v]) => `${key} ${v.toExponential(0)}`).join(", ") + ")");
    for (const [key, v] of Object.entries(report)) assert.ok(v < 1e-6, `${key} differs from Dynare by ${v.toExponential(2)}`);
  });
}
