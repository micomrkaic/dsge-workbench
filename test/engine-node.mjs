// engine-node.mjs — the Cozy engine in node, for the tests: the same
// WebAssembly file and the same engine-core.js the browser's worker uses.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

export async function startEngine() {
  const CozyEngine = require("../docs/vendor/cozy-engine.js");
  const makeEngine = require("../docs/worker/engine-core.js");
  const Module = await CozyEngine({ print() {}, printErr() {} });
  const engine = makeEngine(Module);
  // the browser client is asynchronous; keep the same shape here
  return { version: engine.version, exec: async job => engine.exec(job) };
}
