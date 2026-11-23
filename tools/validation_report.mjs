// validation_report.mjs — write docs/validation.json, the table the app
// shows under "Validated against Dynare": for each bundled model, the
// largest relative difference between the workbench's numbers and Dynare's.
//
//   node tools/validation_report.mjs
import fs from "node:fs";
import { compareWithDynare, compareSecondOrder } from "../test/compare.mjs";
import { startEngine } from "../test/engine-node.mjs";

const root = new URL("..", import.meta.url);
const examples = JSON.parse(fs.readFileSync(new URL("docs/examples/index.json", root), "utf8"));
const engine = await startEngine();
const models = [];
let dynare = "";
for (const ex of examples) {
  const { variables, shocks, report } = await compareWithDynare(engine, ex);
  dynare = JSON.parse(fs.readFileSync(new URL(`test/reference/${ex.file.replace(/\.mod$/, "")}.json`, root), "utf8")).dynare;
  // to second order: null for a model declared linear, which has no second-order terms
  const two = await compareSecondOrder(engine, ex);
  const second = two.linear ? null : Math.max(...Object.values(two.report));
  models.push({ file: ex.file, title: ex.title, variables, shocks, worst: Math.max(...Object.values(report)), report, second, report2: two.report });
  console.log(`${ex.title}: ${models.at(-1).worst.toExponential(1)}; second order ${second === null ? "(linear)" : second.toExponential(1)}`);
}
fs.writeFileSync(new URL("docs/validation.json", root), JSON.stringify({ dynare, cozy: engine.version, models }, null, 1) + "\n");
