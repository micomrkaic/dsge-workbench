/* engine-worker.js — Cozy in a web worker, so a slow solve never freezes
 * the page. The page posts {id, job}; the worker answers {id, result}. See
 * engine-core.js for what a job is.
 *
 * Part of dsge-workbench. Copyright (C) 2026 Mico Mrkaic.
 * GPL-3.0-or-later; see LICENSE. */
importScripts("../vendor/cozy-engine.js", "engine-core.js");

let engine = null;
CozyEngine({ print: function () {}, printErr: function () {} }).then(function (Module) {
  engine = makeEngine(Module);
  postMessage({ ready: true, version: engine.version });
}).catch(function (e) {
  postMessage({ ready: false, error: String(e && e.message || e) });
});

onmessage = function (e) {
  var result;
  try { result = engine.exec(e.data.job); }
  catch (err) { result = { ok: false, output: "error: the engine stopped (" + (err && err.message || err) + ")", values: {}, crashed: true }; }
  postMessage({ id: e.data.id, result: result });
};
