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
    const x = evalAst(v.def, env);                           /* an auxiliary variable starts at what it stands for */
    init.set(v.name, Number.isFinite(x) ? x : 0);
  }
  return init;
}

/* The auxiliary variables at a steady state, as Cozy lets: each is what it
 * stands for with the dates dropped and the shocks at zero. They come in an
 * order in which each uses only those before it. */
function auxValues(model, nm) {
  const still = n => (n.t === "exo" ? "0.0" : nm.c(n.name));
  return model.endo.filter(v => v.aux).map(v => `let ${nm.c(v.name)} = ${printAst(v.def, still)};`).join(" ");
}

/* An initval block written as formulas in the parameters, as a Cozy
 * function of the parameters (wb_init), so that the starting values follow
 * a parameter that is moved, as they do when Dynare runs the file again.
 * Empty if the block holds only numbers. Mirrors startingValues. */
function initFunction(model, nm, lets) {
  const c = nm.c, params = new Set(model.params.map(p => p.name)), assigned = new Set(), other = new Set();
  let follows = false;
  for (const a of model.init) {
    walkAst(a.expr, n => {
      if (!n.name) return;
      if (params.has(n.name)) follows = true;
      else if (!assigned.has(n.name)) other.add(n.name);      /* not given a value yet: zero, as in startingValues */
    });
    assigned.add(a.name);
  }
  if (!follows) return "";
  for (const v of model.endo) if (!v.aux && !assigned.has(v.name)) other.add(v.name);
  const zeros = [...other].map(name => `let ${c(name)} = 0.0;`).join(" ");
  const body = model.init.map(a => `let ${c(a.name)} = ${printAst(a.expr, nm.value)};`).join(" ");
  return `let wb_init = fn p__ -> (${lets} ${zeros} ${body} ${auxValues(model, nm)} [${model.endo.map(v => `1.0 * ${c(v.name)}`).join("; ")}]);\n`;
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
  let steadyKind = "search", wbInit = "";
  if (model.steady) {
    const assigned = new Set(model.steady.lines.map(a => a.name));
    const body = model.steady.lines.map(a => `let ${c(a.name)} = ${printAst(a.expr, nm.value)};`).join(" ");
    const unset = model.endo.filter(v => !v.aux && !assigned.has(v.name)).map(v => `let ${c(v.name)} = 0.0;`).join(" ");
    fields.push(`steady = fn p__ -> (${lets} ${body} ${unset} ${auxValues(model, nm)} {${model.endo.map(v => `${c(v.name)} = ${c(v.name)}`).join(", ")}})`);
    steadyKind = "formula";
  } else if (model.linear && zeroSteadyState(model, values)) {
    fields.push(`steady = fn p__ -> {${model.endo.map(v => `${c(v.name)} = 0.0`).join(", ")}}`);
    steadyKind = "zero";
  } else {
    /* the search starts from initval; a variable without one starts at zero, as in Dynare */
    fields.push(`init = {${model.endo.map(v => `${c(v.name)} = ${cozyNum(init.has(v.name) ? init.get(v.name) : 0)}`).join(", ")}}`);
    wbInit = initFunction(model, nm, lets);
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
  const src = `let wb_m = dsge.model(${spec});\n${wbPar}\n${wbSs}\n${wbInit}`;
  return { src, spec, pnames, steadyKind, initFollows: wbInit !== "" };
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
    this.lastSteady = false;
    this.pnames = m.pnames;
    this.steadyKind = m.steadyKind;
    this.initFollows = m.initFollows;
    this.source = m.src;
    return m;
  }

  /* The source for one solve: base values in, the decision rule out. */
  solveSource(values, shocks, fromFormulas = this.initFollows) {
    const model = this.model, c = name => model.cozy.get(name) || name;
    const base = model.params.filter(p => p.base).map(p => `${c(p.name)} = ${cozyNum(Object.hasOwn(values, p.name) ? values[p.name] : p.value)}`);
    const sd = shocks ? shocks.sd : model.shocks.sd, corr = shocks ? shocks.corr : model.shocks.corr;
    /* where the steady-state search starts: initval's formulas at these parameter values if it
     * has any (and they give real, finite numbers), otherwise the last steady state found */
    const start = fromFormulas
      ? `let wb_i = wb_init(dg_params(wb_m, wb_par(wb_b)));
if all(isfinite(real(wb_i))) && (sum(abs(imag(wb_i))) == 0.0) then (wb_m = setfield(wb_m, "init", real(wb_i))) end;\n`
      : "";
    return `let wb_b = {${base.join(", ")}};
${start}let wb_p = wb_ss(wb_m, dg_params(wb_m, wb_par(wb_b)));
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
    const order = options.order === 2 ? 2 : 1, size = Number.isFinite(options.size) && options.size !== 0 ? options.size : 1;
    const t0 = Date.now();
    const read = ["wb_code", "wb_y", "wb_roots", "wb_counts", "wb_pv"];
    let first = await this.engine.exec({ src: this.solveSource(values, options.shocks), read });
    if (!first.ok && this.initFollows && this.lastSteady) {
      /* the formulas were no good here: try from the last steady state found, as for any other model */
      const again = await this.engine.exec({ src: `let wb_m = setfield(wb_m, "init", wb_last);\n` + this.solveSource(values, options.shocks, false), read });
      if (again.ok) first = again;
    }
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
      horizon, lags, order,
    };
    if (code !== 0) { out.ms = Date.now() - t0; return out; }
    /* remember the steady state as the next search's starting point */
    const warm = this.steadyKind === "search" ? `let wb_m = setfield(wb_m, "init", wb_y); let wb_last = wb_y;` : "";
    if (warm) this.lastSteady = true;
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
    this.second = false;
    if (order === 2) {
      const s2 = await this.secondOrder(out, size);
      if (s2.error) return { ok: false, error: s2.error, ms: Date.now() - t0 };
      out.second = s2;
    }
    out.ms = Date.now() - t0;
    return out;
  }

  /* The second-order terms at the first-order solution just computed (first
   * is its result). Returns {states, Gxx, Gxu, Guu, s2, mean, irf, size,
   * linear}: the names of the state variables x; the terms of
   *   y = ybar + P y(-1) + Q e + 1/2 [Gxx (x ⊗ x) + 2 Gxu (x ⊗ e) + Guu (e ⊗ e) + s2]
   * as matrices with one row per variable; the means to second order as
   * deviations from the steady state (NaN where there is none); and the
   * responses to innovations of `size` standard deviations, shaped like the
   * first-order irf. A model declared linear has no second-order terms: they
   * are zero without being computed. */
  async secondOrder(first, size) {
    const model = this.model, n = model.endo.length, k = model.exo.length, horizon = first.horizon;
    const matrix = m => Array.from({ length: m.rows }, (_, i) => m.data.slice(i * m.cols, (i + 1) * m.cols));
    const lagged = new Set();
    for (const q of model.equations) walkAst(q.expr, node => { if (node.t === "var" && node.shift < 0) lagged.add(node.name); });
    const states = first.names.filter(name => lagged.has(name));
    if (model.linear) {
      const nx = states.length, zeros = cols => Array.from({ length: n }, () => new Array(cols).fill(0));
      return { linear: true, states, size, Gxx: zeros(nx * nx), Gxu: zeros(nx * k), Guu: zeros(k * k), s2: new Array(n).fill(0),
        mean: first.sd.map(s => (Number.isNaN(s) ? NaN : 0)), irf: first.irf.map(byT => byT.map(row => row.map(x => size * x))) };
    }
    const r = await this.engine.exec({
      src: `let wb_S = (wb_sd * wb_sd') .* wb_R;
let wb_g = dg_second(wb_m, wb_p, wb_y, wb_P, wb_Q, wb_S);
let wb_s2 = {model = wb_m, ybar = wb_y, P = wb_P, Q = wb_Q, Gxx = wb_g.Gxx, Gxu = wb_g.Gxu, Guu = wb_g.Guu, s2 = wb_g.s2};
let wb_Ce = (wb_sd * ones(1, ${k})) .* chol(wb_R);
let wb_Gxx = wb_g.Gxx; let wb_Gxu = wb_g.Gxu; let wb_Guu = wb_g.Guu; let wb_gs2 = wb_g.s2; let wb_st = wb_g.st;
let wb_mu2 = wb_mean2(wb_P, wb_C, wb_S, wb_g.st, wb_g.Gxx, wb_g.Guu, wb_g.s2);
let wb_I2 = wb_irf2(wb_s2, wb_Ce, ${horizon}, ${cozyNum(size)});
`,
      read: ["wb_Gxx", "wb_Gxu", "wb_Guu", "wb_gs2", "wb_st", "wb_mu2", "wb_I2"],
    });
    if (!r.ok) return { error: cozyMessage(r.output) };
    const w = r.values;
    for (const [name, value] of Object.entries(w)) if (!value) return { error: `Cozy returned no numbers for ${name}` };
    this.second = true;
    const all = matrix(w.wb_I2);
    return {
      linear: false, size,
      states: Array.from(w.wb_st.data, i => first.names[i - 1]),
      Gxx: matrix(w.wb_Gxx), Gxu: matrix(w.wb_Gxu), Guu: matrix(w.wb_Guu), s2: Array.from(w.wb_gs2.data),
      mean: Array.from(w.wb_mu2.data),
      irf: model.exo.map((_, j) => all.slice(j * horizon, (j + 1) * horizon)),
    };
  }

  /* The pruned second-order path for a given run of shocks (one row per
   * period, in the shocks' own units), as deviations from the steady state:
   * {first, second}, the first-order path and the correction to add to it.
   * Needs a solve at order 2 of a model that is not linear. */
  async path2(shocks) {
    if (!this.second) throw new Error("path2 needs a second-order solution");
    const r = await this.engine.exec({
      src: `let wb_E = [${shocks.map(row => row.map(cozyNum).join(", ")).join("; ")}];
let wb_pt = dg_path2(wb_s2, wb_E); let wb_Y1 = wb_pt.Y1; let wb_Y2 = wb_pt.Y2;`,
      read: ["wb_Y1", "wb_Y2"],
    });
    if (!r.ok) throw new Error(cozyMessage(r.output));
    const rows = m => Array.from({ length: m.rows }, (_, i) => Array.from(m.data.slice(i * m.cols, (i + 1) * m.cols)));
    return { first: rows(r.values.wb_Y1), second: rows(r.values.wb_Y2) };
  }

  /* A simulated path of T periods (deviations from the steady state). After
   * a solve at order 2 of a model that is not linear, pass second = true for
   * the pruned second-order path of the same draws: the result is then
   * {first, second}, the first-order path and the correction to add to it. */
  async simulate(T, seed, second = false) {
    if (second && this.second) {
      const r = await this.engine.exec({ src: `let wb_sim2 = wb_simulate2(wb_s2, wb_Ce, ${T | 0}, ${seed | 0});`, read: ["wb_sim2"] });
      if (!r.ok) throw new Error(cozyMessage(r.output));
      const m = r.values.wb_sim2, n = m.cols / 2;
      const rows = from => Array.from({ length: m.rows }, (_, i) => m.data.slice(i * m.cols + from, i * m.cols + from + n));
      return { first: rows(0), second: rows(n) };
    }
    const r = await this.engine.exec({ src: `let wb_sim = wb_simulate(wb_P, wb_C, ${T | 0}, ${seed | 0});`, read: ["wb_sim"] });
    if (!r.ok) throw new Error(cozyMessage(r.output));
    const m = r.values.wb_sim;
    const first = Array.from({ length: m.rows }, (_, i) => m.data.slice(i * m.cols, (i + 1) * m.cols));
    return second ? { first, second: first.map(row => row.map(() => 0)) } : first;
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
  const s2 = result.determinate && result.second && !result.second.linear ? result.second : null;
  if (s2) {
    const z = s2.size;
    lines.push(`let s = dsge.solve2(m);             % steady state, the rule y = P y(-1) + Q e, and its second-order terms`, `s.ss`);
    if (first) lines.push(`dsge.irf2(s, "${c(first.name)}", ${Math.min(result.horizon, 20)}, ${cozyNum(z)})   % responses to second order to ${z} standard deviation${Math.abs(z) === 1 ? "" : "s"} of ${first.name}`);
    if (correlated) {
      const S = corr.map((row, i) => row.map((r, j) => cozyNum(r * sd[i] * sd[j])).join(", ")).join("; ");
      lines.push(`% The shocks are correlated here, and dsge.solve2 takes them as independent. The curvature`,
        `% terms above (s.Gxx, s.Gxu, s.Guu) do not depend on that; the correction for risk does. With`,
        `% the shocks' covariance, as the workbench computes it:`,
        `let S = [${S}];`,
        `let g = dg_second(m, s.params, s.ybar, s.P, s.Q, S);`,
        `g.s2'                               % half of this is the constant that risk adds to each variable`);
      if (!unit) lines.push(`dg_mean2({model = m, ybar = s.ybar, P = s.P, Q = s.Q, Gxx = g.Gxx, Gxu = g.Gxu, Guu = g.Guu, s2 = g.s2}, S)'   % the means to second order`);
    } else if (!unit) lines.push(`dsge.mean2(s)                       % the means to second order`);
    lines.push(`% the moments below are those of the first-order solution`);
  } else if (result.determinate) {
    lines.push(`let s = dsge.solve(m);              % steady state and decision rule y = P y(-1) + Q e`, `s.ss`);
    if (first) lines.push(`dsge.irf(s, "${c(first.name)}", ${Math.min(result.horizon, 20)})     % responses to one standard deviation of ${first.name}`);
  }
  if (result.determinate) {
    if (correlated) lines.push(`% The shocks are correlated here. The workbench orthogonalises them (Cholesky, in the order`, `% declared); dsge.irf and dsge.moments below treat them as independent.`);
    if (unit) lines.push(`% Some variables have a unit root, so the model has no unconditional moments:`, `% dsge.moments(s) and dsge.vardecomp(s) would say so.`);
    else lines.push(`dsge.moments(s).sd'`, model.exo.length > 1 ? `dsge.vardecomp(s)` : ``);
  }
  return lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n") + "\n";
}
