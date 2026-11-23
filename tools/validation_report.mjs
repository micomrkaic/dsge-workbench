// validation_report.mjs — write docs/validation.json, the table the app
// shows under "Validated against Dynare": for each bundled model, the
// largest relative difference between the workbench's numbers and Dynare's.
//
//   node tools/validation_report.mjs
import fs from "node:fs";
import { compareWithDynare } from "../test/compare.mjs";
import { startEngine } from "../test/engine-node.mjs";

const root = new URL("..", import.meta.url);
const examples = JSON.parse(fs.readFileSync(new URL("docs/examples/index.json", root), "utf8"));
const engine = await startEngine();
const models = [];
let dynare = "";
for (const ex of examples) {
  const { variables, shocks, report } = await compareWithDynare(engine, ex);
  dynare = JSON.parse(fs.readFileSync(new URL(`test/reference/${ex.file.replace(/\.mod$/, "")}.json`, root), "utf8")).dynare;
  models.push({ file: ex.file, title: ex.title, variables, shocks, worst: Math.max(...Object.values(report)), report });
  console.log(`${ex.title}: ${models.at(-1).worst.toExponential(1)}`);
}
fs.writeFileSync(new URL("docs/validation.json", root), JSON.stringify({ dynare, cozy: engine.version, models }, null, 1) + "\n");
