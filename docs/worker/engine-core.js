/* engine-core.js — a Cozy session behind one function.
 *
 * makeEngine(Module) takes an instantiated Cozy WebAssembly module
 * (vendor/cozy-engine.js) and returns
 *
 *     exec({src, read}) -> {ok, output, values}
 *
 * which runs Cozy source in the session and then reads the named globals
 * back as numbers: values[name] = {rows, cols, data} with data row-major,
 * or null where the global is missing or not numeric. Globals persist from
 * one call to the next, so a model compiled once can be solved many times.
 *
 * A classic script on purpose: the worker loads it with importScripts and
 * the tests load it in node, so both run the same code.
 *
 * Part of dsge-workbench. Copyright (C) 2026 Mico Mrkaic.
 * GPL-3.0-or-later; see LICENSE. */
(function (root) {
  "use strict";

  function makeEngine(Module) {
    var open = Module.cwrap("cozy_open", null, []);
    var evalSrc = Module.cwrap("cozy_eval", "number", ["string"]);
    var ok = Module.cwrap("cozy_ok", "number", []);
    var matrix = Module.cwrap("cozy_matrix", "number", ["string", "number", "number"]);
    var version = Module.cwrap("cozy_version", "string", []);
    var dims = Module._malloc(8);                    /* two ints: rows, cols */

    open();
    var loaded = Module.UTF8ToString(evalSrc('load("dsge");'));
    if (!ok()) throw new Error("the dsge package did not load: " + loaded);

    function readMatrix(name) {
      var p = matrix(name, dims, dims + 4);
      if (!p) return null;
      var rows = Module.getValue(dims, "i32"), cols = Module.getValue(dims + 4, "i32");
      /* copy out at once: the buffer is Cozy's and is reused */
      var data = Array.prototype.slice.call(new Float64Array(Module.HEAPF64.buffer, p, rows * cols));
      return { rows: rows, cols: cols, data: data };
    }

    function exec(job) {
      var output = Module.UTF8ToString(evalSrc(job.src));
      var good = !!ok(), values = {};
      if (good && job.read) for (var i = 0; i < job.read.length; i++) values[job.read[i]] = readMatrix(job.read[i]);
      return { ok: good, output: output, values: values };
    }

    return { exec: exec, version: version() };
  }

  root.makeEngine = makeEngine;
  if (typeof module === "object" && module.exports) module.exports = makeEngine;
})(typeof self !== "undefined" ? self : globalThis);
