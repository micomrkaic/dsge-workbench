/* solve.js — from a parsed model to results, by way of Cozy.
 *
 * modfile.js gives a description of the model; this file writes the Cozy
 * source that hands it to the dsge package, runs it on an engine (the
 * worker in the browser, the same WebAssembly in node for the tests), and
 * turns what comes back into named results.
 *
 *     const wb = new Workbench(engine);       // engine: {exec({src, read})}
 *     await wb.load(model);                   // compile the model (once)
 *     const r = await wb.solve({alpha: 0.4}); // solve at these values
 *
 * Part of dsge-workbench. Copyright (C) 2026 Mico Mrkaic.
 * GPL-3.0-or-later; see LICENSE. */
import { evalAst, printAst, walkAst } from "./modfile.js";
import { PRELUDE } from "./prelude.js";

/* A number as Cozy source: always a float, at full precision. */
export function cozyNum(v) {
  if (Number.isNaN(v)) return "(0.0 / 0.0)";
  if (!Number.isFinite(v)) return v > 0 ? "inf" : "(-inf)";
  let s = Number.isInteger(v) && Math.abs(v) < 1e15 ? v.toFixed(1) : String(v);
  if (!/[.e]/.test(s)) s += ".0";
  return v < 0 ? `(${s})` : s;
}

/* How a model's names appear in the Cozy source. */
function namer(model) {
  const c = name => model.cozy.get(name) || name;
  return {
    c,
    equation: n => (n.t === "var" ? c(n.name) + (n.shift > 0 ? "(+1)" : n.shift < 0 ? "(-1)" : "") : c(n.name)),
    value: n => c(n.name),
  };
}

/* Starting values for the steady-state search, from initval. */
function startingValues(model, values) {
  const init = new Map();
  const env = name => (init.has(name) ? init.get(name) : values.has(name) ? values.get(name) : 0);
  for (const a of model.init) init.set(a.name, evalAst(a.expr, env));
  for (const v of model.endo) {
    if (!v.aux) continue;
    const src = v.def.t === "var" ? v.def.name : null;       /* an auxiliary variable starts where its source does */
    if (src === null) init.set(v.name, 0);
    else if (init.has(src)) init.set(v.name, init.get(src));
  }
  return init;
}

/* Is the model satisfied with every variable at zero? (True of a linear
 * model without constants; then zero is its steady state.) */
function zeroSteadyState(model, values) {
  const env = (name, node) => (node.t === "var" ? 0 : values.has(name) ? values.get(name) : 0);
  return model.equations.every(q => Math.abs(evalAst(q.expr, env)) < 1e-10);
}

/* The Cozy source that defines the model (wb_m) and the map from the base
 * parameters to all of them (wb_par). */
export function modelSource(model, opt = {}) {
  const nm = namer(model), c = nm.c;
  const values = new Map(model.params.map(p => [p.name, p.value]));
  for (const [name, v] of Object.entries(opt.values || {})) values.set(name, v);      /* a standalone script fixes the values */
  for (const q of model.equations) walkAst(q.expr, n => {
    if (n.t === "bin" && ["<", ">", "<=", ">=", "==", "!="].includes(n.op))
      throw new Error(`equation at line ${q.line}: comparisons (${n.op}) inside a model equation are not supported`);
  });
  const pnames = model.params.map(p => p.name).concat(model.ssParams.map(s => s.name));
  const init = startingValues(model, values);
  const paramRec = pnames.map(name => `${c(name)} = ${cozyNum(values.has(name) ? values.get(name) : init.get(model.ssParams.find(s => s.name === name).of) || 0)}`);

  const fields = [
    `vars = "${model.endo.map(v => c(v.name)).join(" ")}"`,
    `shocks = "${model.exo.map(s => c(s.name)).join(" ")}"`,
    `params = {${paramRec.join(", ")}}`,
  ];
  const lets = pnames.map(name => `let ${c(name)} = p__.${c(name)};`).join(" ");
  let steadyKind = "search";
  if (model.steady) {
    const assigned = new Set(model.steady.lines.map(a => a.name));
    const body = model.steady.lines.map(a => `let ${c(a.name)} = ${printAst(a.expr, nm.value)};`).join(" ");
    const out = model.endo.map(v => {
      if (!v.aux) return `${c(v.name)} = ${assigned.has(v.name) ? c(v.name) : "0.0"}`;
      /* follow a chain of auxiliary variables back to the variable it shifts (none for a shock) */
      let root = v.def.t === "var" ? v.def.name : null;
      while (root && model.endo.find(u => u.name === root).aux) { const d = model.endo.find(u => u.name === root).def; root = d.t === "var" ? d.name : null; }
      return `${c(v.name)} = ${root && assigned.has(root) ? c(root) : "0.0"}`;
    });
    fields.push(`steady = fn p__ -> (${lets} ${body} {${out.join(", ")}})`);
    steadyKind = "formula";
  } else if (model.linear && zeroSteadyState(model, values)) {
    fields.push(`steady = fn p__ -> {${model.endo.map(v => `${c(v.name)} = 0.0`).join(", ")}}`);
    steadyKind = "zero";
  } else {
    /* the search starts from initval; a variable without one starts at zero, as in Dynare */
    fields.push(`init = {${model.endo.map(v => `${c(v.name)} = ${cozyNum(init.has(v.name) ? init.get(v.name) : 0)}`).join(", ")}}`);
  }
  fields.push(`model = [${model.equations.map(q => `"${printAst(q.expr, nm.equation)}"`).join(";\n    ")}]`);

  /* base parameters come in; the others follow from them, in the order they were written */
  const ordered = model.params.map(p => (p.base ? `let ${c(p.name)} = b__.${c(p.name)};` : `let ${c(p.name)} = ${printAst(p.expr, nm.value)};`));
  const wbPar = `let wb_par = fn b__ -> (${ordered.join(" ")} {${model.params.map(p => `${c(p.name)} = ${c(p.name)}`).join(", ")}});`;

  /* steady_state(x): keep the hidden parameter equal to the steady state of x */
  let wbSs = "let wb_ss = fn m, p -> p;";
  if (model.ssParams.length) {
    const idx = name => model.endo.findIndex(v => v.name === name) + 1;
    const sets = model.ssParams.map(s => `q = setfield(q, "${c(s.name)}", y[${idx(s.of)}]);`).join(" ");
    const gap = model.ssParams.map(s => `abs(q.${c(s.name)} - p.${c(s.name)})`).join("; ");
    wbSs = `let wb_ss = fn m, p -> (let moving = true; let it = 0;
  while moving && (it < 50) do (let y = dg_ss(m, p); let q = p; ${sets}
    moving = max([${gap}]) > 1e-13; p = q; it = it + 1) end;
  p);`;
  }
  if (opt.sd) fields.splice(3, 0, `sd = {${model.exo.map((s, j) => `${c(s.name)} = ${cozyNum(opt.sd[j])}`).join(", ")}}`);
  const spec = `{\n  ${fields.join(",\n  ")}}`;
  const src = `let wb_m = dsge.model(${spec});\n${wbPar}\n${wbSs}\n`;
  return { src, spec, pnames, steadyKind };
}

/* The first line of a Cozy error, without the position and the package's
 * own prefix. */
export function cozyMessage(output) {
  const line = (output || "").split("\n").map(s => s.trim()).find(s => s.startsWith("error")) || (output || "").trim().split("\n")[0] || "unknown error";
  return line.replace(/^error at \d+:\d+:\s*/, "").replace(/^dsge:\s*/, "");
}

const VERDICTS = ["determinate", "indeterminate", "explosive", "unsolved"];

export class Workbench {
  constructor(engine) { this.engine = engine; this.started = false; this.model = null; }

  async start() {
    if (this.started) return;
    const r = await this.engine.exec({ src: PRELUDE });
    if (!r.ok) throw new Error("the workbench's Cozy prelude did not load: " + cozyMessage(r.output));
    this.started = true;
  }

  /* Compile a model. Throws with Cozy's message if the dsge package
   * refuses it. */
  async load(model) {
    await this.start();
    const m = modelSource(model);
    const r = await this.engine.exec({ src: m.src });
    if (!r.ok) throw new Error(cozyMessage(r.output));
    this.model = model;
    this.pnames = m.pnames;
    this.steadyKind = m.steadyKind;
    this.source = m.src;
    return m;
  }

  /* The source for one solve: base values in, the decision rule out. */
  solveSource(values, shocks) {
    const model = this.model, c = name => model.cozy.get(name) || name;
    const base = model.params.filter(p => p.base).map(p => `${c(p.name)} = ${cozyNum(Object.hasOwn(values, p.name) ? values[p.name] : p.value)}`);
    const sd = shocks ? shocks.sd : model.shocks.sd, corr = shocks ? shocks.corr : model.shocks.corr;
    return `let wb_b = {${base.join(", ")}};
let wb_p = wb_ss(wb_m, dg_params(wb_m, wb_par(wb_b)));
let wb_r = wb_solve(wb_m, wb_p);
let wb_code = wb_r.code; let wb_y = wb_r.y; let wb_roots = wb_r.roots; let wb_counts = wb_r.counts;
let wb_pv = [${this.pnames.map(n => `wb_p.${c(n)}`).join(", ")}];
let wb_sd = [${sd.map(cozyNum).join("; ")}];
let wb_R = [${corr.map(row => row.map(cozyNum).join(", ")).join("; ")}];
`;
  }

  /* Solve at the given base parameter values (those not given keep the
   * model's own). Returns {ok, verdict, ...}; a model with no unique
   * stable solution is a result, not an error. */
  async solve(values = {}, options = {}) {
    const model = this.model, horizon = options.horizon || model.hints.irf || 40, lags = options.lags || 5;
    const t0 = Date.now();
    const first = await this.engine.exec({ src: this.solveSource(values, options.shocks), read: ["wb_code", "wb_y", "wb_roots", "wb_counts", "wb_pv"] });
    if (!first.ok) return { ok: false, error: cozyMessage(first.output), ms: Date.now() - t0 };
    const v = first.values, code = v.wb_code.data[0], n = model.endo.length, k = model.exo.length;
    const [forward, backward, stable] = v.wb_counts.data;
    const out = {
      ok: true, verdict: VERDICTS[code], determinate: code === 0,
      forward, backward, unstable: 2 * n - stable - (n - forward),
      roots: v.wb_roots.data,
      steady: v.wb_y.data,
      params: Object.fromEntries(this.pnames.map((name, i) => [name, v.wb_pv.data[i]])),
      names: model.endo.map(u => u.name), shocks: model.exo.map(s => s.name),
      horizon, lags,
    };
    if (code !== 0) { out.ms = Date.now() - t0; return out; }
    /* remember the steady state as the next search's starting point */
    const warm = this.steadyKind === "search" ? `let wb_m = setfield(wb_m, "init", wb_y);` : "";
    const second = await this.engine.exec({
      src: `${warm}
let wb_P = wb_r.P; let wb_Q = wb_r.Q;
let wb_C = wb_shocks(wb_Q, wb_sd, wb_R);
let wb_I = wb_irf(wb_P, wb_C, ${horizon});
let wb_mo = wb_moments(wb_P, wb_C, ${lags});
let wb_s = wb_mo.sd; let wb_co = wb_mo.corr; let wb_ac = wb_mo.acorr;
let wb_vd = wb_vardecomp(wb_P, wb_C);
`,
      read: ["wb_P", "wb_Q", "wb_C", "wb_I", "wb_s", "wb_co", "wb_ac", "wb_vd"],
    });
    if (!second.ok) return { ok: false, error: cozyMessage(second.output), ms: Date.now() - t0 };
    const w = second.values;
    for (const [name, value] of Object.entries(w)) if (!value) return { ok: false, error: `Cozy returned no numbers for ${name}`, ms: Date.now() - t0 };
    const matrix = m => Array.from({ length: m.rows }, (_, i) => m.data.slice(i * m.cols, (i + 1) * m.cols));
    out.P = matrix(w.wb_P);                          /* y = P y(-1) + Q e */
    out.Q = matrix(w.wb_Q);
    out.C = matrix(w.wb_C);                          /* responses on impact to one-s.d. innovations */
    const all = matrix(w.wb_I);
    out.irf = model.exo.map((_, j) => all.slice(j * horizon, (j + 1) * horizon));     /* irf[shock][t][variable] */
    out.sd = w.wb_s.data;
    out.corr = matrix(w.wb_co);
    out.acorr = matrix(w.wb_ac);
    out.vardecomp = k ? matrix(w.wb_vd) : [];
    out.ms = Date.now() - t0;
    return out;
  }

  /* A simulated path of T periods (deviations from the steady state). */
  async simulate(T, seed) {
    const r = await this.engine.exec({ src: `let wb_S = wb_simulate(wb_P, wb_C, ${T | 0}, ${seed | 0});`, read: ["wb_S"] });
    if (!r.ok) throw new Error(cozyMessage(r.output));
    const m = r.values.wb_S;
    return Array.from({ length: m.rows }, (_, i) => m.data.slice(i * m.cols, (i + 1) * m.cols));
  }
}

/* A script that reproduces a result in Cozy itself (the command-line
 * interpreter or its playground), using only the dsge package's public
 * functions, with the parameters fixed at the values of that result. */
export function standaloneScript(model, result, shocks, title) {
  const c = name => model.cozy.get(name) || name;
  const sd = shocks ? shocks.sd : model.shocks.sd, corr = shocks ? shocks.corr : model.shocks.corr;
  const m = modelSource(model, { values: result.params, sd });
  const correlated = corr.some((row, i) => row.some((r, j) => i !== j && r !== 0));
  const unit = result.sd && result.sd.some(Number.isNaN);
  const first = model.exo.find((s, j) => sd[j] > 0) || model.exo[0];
  const lines = [
    `% ${title || "A model"}, as solved in the DSGE workbench.`,
    `% Run it in Cozy (https://github.com/micomrkaic/cozy): cozy this-file.cz`,
    `load("dsge")`,
    ``,
    `let m = dsge.model(${m.spec});`,
    ``,
    `let b = dsge.bk(m);                 % the Blanchard-Kahn check`,
    `b.verdict`,
  ];
  if (result.determinate) {
    lines.push(`let s = dsge.solve(m);              % steady state and decision rule y = P y(-1) + Q e`, `s.ss`);
    if (first) lines.push(`dsge.irf(s, "${c(first.name)}", ${Math.min(result.horizon, 20)})     % responses to one standard deviation of ${first.name}`);
    if (correlated) lines.push(`% The shocks are correlated here. The workbench orthogonalises them (Cholesky, in the order`, `% declared); dsge.irf and dsge.moments below treat them as independent.`);
    if (unit) lines.push(`% Some variables have a unit root, so the model has no unconditional moments:`, `% dsge.moments(s) and dsge.vardecomp(s) would say so.`);
    else lines.push(`dsge.moments(s).sd'`, model.exo.length > 1 ? `dsge.vardecomp(s)` : ``);
  }
  return lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n") + "\n";
}
