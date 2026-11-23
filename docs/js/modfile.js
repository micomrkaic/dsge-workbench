/* modfile.js — read a model written in Dynare's .mod language.
 *
 * parseMod(text) understands the part of the language that describes a
 * stochastic model: declarations (var, varexo, parameters,
 * predetermined_variables), parameter values, the model block (equation
 * tags, model-local variables, leads and lags of any length,
 * steady_state()), initval, steady_state_model, the shocks block
 * (stderr, variances, covariances, correlations) and the @#define / @#if
 * family of macro directives. Commands that ask Dynare to compute
 * something (stoch_simul, estimation, ...) and MATLAB statements are read
 * past and reported as notes; anything that would change the model's
 * meaning and is not supported is an error, with its line.
 *
 * The result is a plain description of the model: names, expressions as
 * syntax trees, and the shocks' covariance. Nothing is solved here; see
 * solve.js, which hands the model to Cozy.
 *
 * Part of dsge-workbench. Copyright (C) 2026 Mico Mrkaic.
 * GPL-3.0-or-later; see LICENSE. */

export class ModError extends Error {
  constructor(message, line) { super(message); this.line = line || 0; }
}

/* Functions a model may call, and how many arguments each takes. */
const FUNCS = {
  exp: 1, log: 1, ln: 1, log10: 1, sqrt: 1, cbrt: 1, abs: 1, sign: 1,
  sin: 1, cos: 1, tan: 1, asin: 1, acos: 1, atan: 1, sinh: 1, cosh: 1, tanh: 1,
  asinh: 1, acosh: 1, atanh: 1, erf: 1, erfc: 1, max: 2, min: 2, normcdf: [1, 3], normpdf: [1, 3],
};

/* Blocks that end with "end;" and are read past. */
const SKIPPED_BLOCKS = new Set(["estimated_params", "estimated_params_init", "estimated_params_bounds",
  "estimated_params_remove", "observation_trends", "optim_weights", "homotopy_setup", "irf_calibration",
  "moment_calibration", "shock_groups", "epilogue", "deterministic_trends", "osr_params_bounds",
  "heteroskedastic_shocks", "filter_initial_state", "generate_irfs", "matched_moments", "verbatim",
  "histval", "endval", "mshocks", "svar_identification", "pac_target_info", "occbin_constraints"]);

/* Commands that end with ";" and are read past. */
const SKIPPED_COMMANDS = new Set(["steady", "check", "resid", "stoch_simul", "estimation", "varobs", "varexobs",
  "osr", "osr_params", "dynare_sensitivity", "identification", "model_diagnostics", "model_info",
  "write_latex_dynamic_model", "write_latex_static_model", "write_latex_original_model",
  "write_latex_steady_state_model", "write_latex_definitions", "write_latex_parameter_table",
  "write_latex_prior_table", "collect_latex_files", "datatomfile", "prior_function", "posterior_function",
  "shock_decomposition", "realtime_shock_decomposition", "plot_shock_decomposition",
  "initial_condition_decomposition", "conditional_forecast", "plot_conditional_forecast", "forecast",
  "calib_smoother", "dynasave", "dynatype", "set_dynare_seed", "save_params_and_steady_state",
  "load_params_and_steady_state", "model_comparison", "unit_root_vars", "model_local_variable",
  "smoother2histval", "histval_file", "initval_file", "simul", "perfect_foresight_setup",
  "perfect_foresight_solver", "extended_path", "method_of_moments", "occbin_setup", "occbin_solver",
  "occbin_graph", "occbin_write_regimes", "print_bytecode_dynamic_model", "print_bytecode_static_model",
  "evaluate_planner_objective", "var_model", "trend_component_model", "bvar_density", "bvar_forecast",
  "bvar_irf", "ms_estimation", "ms_simulation", "markov_switching", "discretionary_policy_dummy"]);

/* Statements that change what the model means and are not supported. */
const UNSUPPORTED = {
  varexo_det: "deterministic exogenous variables (varexo_det) are not supported",
  trend_var: "models with explicit trends (trend_var) are not supported; write the model in stationary form",
  log_trend_var: "models with explicit trends (log_trend_var) are not supported; write the model in stationary form",
  change_type: "change_type is not supported",
  ramsey_model: "optimal policy (ramsey_model) is not supported",
  ramsey_policy: "optimal policy (ramsey_policy) is not supported",
  ramsey_constraints: "optimal policy (ramsey_constraints) is not supported",
  discretionary_policy: "optimal policy (discretionary_policy) is not supported",
  planner_objective: "optimal policy (planner_objective) is not supported",
  external_function: "external functions are not supported",
  pac_model: "PAC models are not supported",
  var_expectation_model: "VAR expectation models are not supported",
};

/* Names Cozy reserves; a model may use them, they are renamed on the way in. */
const COZY_RESERVED = new Set(["let", "in", "fn", "if", "then", "else", "elseif", "end", "for", "while", "do",
  "break", "continue", "return", "true", "false", "null", "where"]);

/* ---- macro directives -------------------------------------------------- */
/* @#define, @#if / @#ifdef / @#ifndef / @#elseif / @#else / @#endif. Lines
 * that are switched off, and the directives themselves, become empty lines,
 * so line numbers survive. */
function macroPass(text, defines, notes) {
  const lines = text.split("\n");
  const stack = [];                                 /* {active, taken, parentActive} */
  const live = () => stack.every(f => f.active);
  const value = (expr, line) => {
    const toks = expr.match(/\s*(defined\s*\(\s*\w+\s*\)|"[^"]*"|'[^']*'|\d+(?:\.\d+)?|\w+|==|!=|<=|>=|&&|\|\||[!<>()+\-*/])/g);
    if (!toks) throw new ModError("empty condition in a macro directive", line);
    let i = 0;
    const peek = () => (toks[i] || "").trim(), next = () => toks[i++].trim();
    const prim = () => {
      const t = next();
      if (t === "(") { const v = or(); if (next() !== ")") throw new ModError("missing ')' in a macro condition", line); return v; }
      if (t === "!") return prim() ? 0 : 1;
      if (t === "-") return -prim();
      const d = /^defined\s*\(\s*(\w+)\s*\)$/.exec(t);
      if (d) return d[1] in defines ? 1 : 0;
      if (/^["']/.test(t)) return t.slice(1, -1);
      if (/^\d/.test(t)) return Number(t);
      if (t === "true") return 1;
      if (t === "false") return 0;
      if (/^\w+$/.test(t)) {
        if (!(t in defines)) throw new ModError(`macro variable '${t}' is not defined`, line);
        return defines[t];
      }
      throw new ModError(`unexpected '${t}' in a macro condition`, line);
    };
    const mul = () => { let v = prim(); while (peek() === "*" || peek() === "/") v = next() === "*" ? v * prim() : v / prim(); return v; };
    const add = () => { let v = mul(); while (peek() === "+" || peek() === "-") v = next() === "+" ? v + mul() : v - mul(); return v; };
    const cmp = () => {
      let v = add();
      while (["==", "!=", "<", ">", "<=", ">="].includes(peek())) {
        const op = next(), w = add();
        v = (op === "==" ? v === w : op === "!=" ? v !== w : op === "<" ? v < w : op === ">" ? v > w : op === "<=" ? v <= w : v >= w) ? 1 : 0;
      }
      return v;
    };
    const and = () => { let v = cmp(); while (peek() === "&&") { next(); const w = cmp(); v = v && w ? 1 : 0; } return v; };
    const or = () => { let v = and(); while (peek() === "||") { next(); const w = and(); v = v || w ? 1 : 0; } return v; };
    const v = or();
    if (i < toks.length) throw new ModError(`unexpected '${peek()}' in a macro condition`, line);
    return v;
  };
  for (let n = 0; n < lines.length; n++) {
    const m = /^\s*@#\s*(\w+)\s*(.*?)\s*$/.exec(lines[n]);
    if (!m) {
      if (!live()) lines[n] = "";
      else if (/@\{/.test(lines[n])) throw new ModError("macro substitution @{...} is not supported", n + 1);
      continue;
    }
    lines[n] = "";
    const [, word, restRaw] = m, rest = restRaw.replace(/\/\/.*$|%.*$/, "").trim(), line = n + 1;
    if (word === "define") {
      if (!live()) continue;
      const d = /^(\w+)\s*=\s*(.+)$/.exec(rest);
      if (!d) throw new ModError("@#define needs the form NAME = value", line);
      defines[d[1]] = value(d[2], line);
      notes.push({ line, message: `macro: ${d[1]} = ${JSON.stringify(defines[d[1]])}` });
    } else if (word === "if" || word === "ifdef" || word === "ifndef") {
      const parent = live();
      let on = false;
      if (parent) on = word === "if" ? !!value(rest, line) : (rest in defines) === (word === "ifdef");
      stack.push({ active: parent && on, taken: on, parent });
    } else if (word === "elseif") {
      const f = stack[stack.length - 1];
      if (!f) throw new ModError("@#elseif without @#if", line);
      const on = f.parent && !f.taken && !!value(rest, line);
      f.active = on; f.taken = f.taken || on;
    } else if (word === "else") {
      const f = stack[stack.length - 1];
      if (!f) throw new ModError("@#else without @#if", line);
      f.active = f.parent && !f.taken; f.taken = true;
    } else if (word === "endif") {
      if (!stack.pop()) throw new ModError("@#endif without @#if", line);
    } else if (!live()) {
      continue;
    } else {
      throw new ModError(`the macro directive @#${word} is not supported (only @#define and the @#if family are)`, line);
    }
  }
  if (stack.length) throw new ModError("an @#if is never closed by @#endif", lines.length);
  return lines.join("\n");
}

/* ---- tokens ------------------------------------------------------------ */
/* Comments (//, %, block comments) are dropped. A token knows its line and
 * where it starts and ends in the text, so equations can be shown as they
 * were written. */
function tokenize(text) {
  const toks = [];
  let i = 0, line = 1;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === "\n") { line++; i++; continue; }
    if (c === " " || c === "\t" || c === "\r") { i++; continue; }
    if (c === "/" && text[i + 1] === "/") { while (i < n && text[i] !== "\n") i++; continue; }
    if (c === "%") { while (i < n && text[i] !== "\n") i++; continue; }
    if (c === "/" && text[i + 1] === "*") {
      const start = line;
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) { if (text[i] === "\n") line++; i++; }
      if (i >= n) throw new ModError("a /* comment is never closed", start);
      i += 2;
      continue;
    }
    const at = i;
    if (/[A-Za-z_]/.test(c)) {
      while (i < n && /[A-Za-z0-9_]/.test(text[i])) i++;
      toks.push({ k: "id", v: text.slice(at, i), line, at, end: i });
    } else if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(text[i + 1] || ""))) {
      while (i < n && /[0-9]/.test(text[i])) i++;
      if (text[i] === ".") { i++; while (i < n && /[0-9]/.test(text[i])) i++; }
      if (/[eEdD]/.test(text[i] || "") && /[0-9+\-]/.test(text[i + 1] || "") && /[0-9]/.test(text[i + 1] === "+" || text[i + 1] === "-" ? text[i + 2] || "" : text[i + 1])) {
        i += 2;
        while (i < n && /[0-9]/.test(text[i])) i++;
      }
      toks.push({ k: "num", v: text.slice(at, i).replace(/[dD]/, "e"), line, at, end: i });
    } else if (c === "'" || c === '"') {
      i++;
      while (i < n && text[i] !== c && text[i] !== "\n") i++;
      if (text[i] !== c) throw new ModError("a quoted string is never closed", line);
      i++;
      toks.push({ k: "str", v: text.slice(at + 1, i - 1), line, at, end: i });
    } else if (c === "$") {
      i++;
      while (i < n && text[i] !== "$") { if (text[i] === "\n") line++; i++; }
      if (i >= n) throw new ModError("a $...$ name is never closed", line);
      i++;
      toks.push({ k: "tex", v: text.slice(at + 1, i - 1), line, at, end: i });
    } else {
      const two = text.slice(i, i + 2);
      const op = ["==", "!=", "<=", ">=", "**"].includes(two) ? two : c;
      i += op.length;
      toks.push({ k: "op", v: op === "**" ? "^" : op, line, at, end: i });
    }
  }
  return toks;
}

/* ---- expressions ------------------------------------------------------- */
/* Precedence as in Dynare: comparisons, then + and -, then * and /, then
 * unary minus, then ^ (which does not chain: a^b^c is an error there too).
 * `symbols` says what a name is: "endo", "exo", "par" or "loc". */
function parseExpr(cur, symbols) {
  const peek = () => cur.toks[cur.i], isOp = v => { const t = peek(); return t && t.k === "op" && t.v === v; };
  const lineHere = () => (peek() || cur.toks[cur.i - 1] || { line: 0 }).line;

  function primary() {
    const t = peek();
    if (!t) throw new ModError("the expression ends too soon", lineHere());
    if (t.k === "num") { cur.i++; return { t: "num", v: Number(t.v), text: t.v }; }
    if (t.k === "op" && t.v === "(") {
      cur.i++;
      const e = comparison();
      if (!isOp(")")) throw new ModError("a '(' is never closed", t.line);
      cur.i++;
      return e;
    }
    if (t.k !== "id") throw new ModError(`unexpected '${t.v}' in an expression`, t.line);
    cur.i++;
    const kind = symbols(t.v), call = isOp("(");
    if (t.v === "steady_state" && call && !kind) {
      cur.i++;
      const a = peek();
      if (!a || a.k !== "id" || symbols(a.v) !== "endo") throw new ModError("steady_state(...) takes the name of an endogenous variable", t.line);
      cur.i++;
      if (!isOp(")")) throw new ModError("steady_state(...) takes one name", t.line);
      cur.i++;
      return { t: "ss", name: a.v, line: t.line };
    }
    if (kind === "endo" || kind === "exo") {
      let shift = 0;
      if (call) {
        cur.i++;
        let sign = 1;
        if (isOp("+")) cur.i++; else if (isOp("-")) { sign = -1; cur.i++; }
        const s = peek();
        if (!s || s.k !== "num" || !/^\d+$/.test(s.v)) throw new ModError(`'${t.v}(' must be followed by a time shift such as ${t.v}(-1) or ${t.v}(+1); use * to multiply`, t.line);
        cur.i++;
        if (!isOp(")")) throw new ModError(`the time shift of '${t.v}' is never closed`, t.line);
        cur.i++;
        shift = sign * Number(s.v);
      }
      return { t: kind === "endo" ? "var" : "exo", name: t.v, shift, line: t.line };
    }
    if (kind === "par" || kind === "loc") {
      if (call) throw new ModError(`'${t.v}' is a ${kind === "par" ? "parameter" : "model-local variable"}, not a function; use * to multiply`, t.line);
      return { t: kind, name: t.v, line: t.line };
    }
    if (call && Object.hasOwn(FUNCS, t.v)) {
      cur.i++;
      const args = [];
      if (!isOp(")")) for (;;) { args.push(comparison()); if (isOp(",")) { cur.i++; continue; } break; }
      if (!isOp(")")) throw new ModError(`the call to ${t.v}(...) is never closed`, t.line);
      cur.i++;
      const want = FUNCS[t.v];
      if (Array.isArray(want) ? !want.includes(args.length) : args.length !== want)
        throw new ModError(`${t.v}() takes ${Array.isArray(want) ? want.join(" or ") : want} argument${want === 1 ? "" : "s"}, not ${args.length}`, t.line);
      return callNode(t.v, args);
    }
    if (call) throw new ModError(`'${t.v}' is not a function a model may use`, t.line);
    throw new ModError(`'${t.v}' is not declared (as a variable, a shock or a parameter)`, t.line);
  }
  function power() {
    const base = primary();
    if (!isOp("^")) return base;
    const at = peek().line;
    cur.i++;
    const exponent = isOp("-") || isOp("+") ? unary() : primary();
    if (isOp("^")) throw new ModError("a^b^c is ambiguous; write (a^b)^c or a^(b^c)", at);
    return { t: "bin", op: "^", a: base, b: exponent };
  }
  function unary() {
    if (isOp("-")) { cur.i++; return { t: "neg", a: unary() }; }
    if (isOp("+")) { cur.i++; return unary(); }
    return power();
  }
  function product() {
    let e = unary();
    while (isOp("*") || isOp("/")) { const op = peek().v; cur.i++; e = { t: "bin", op, a: e, b: unary() }; }
    return e;
  }
  function sum() {
    let e = product();
    while (isOp("+") || isOp("-")) { const op = peek().v; cur.i++; e = { t: "bin", op, a: e, b: product() }; }
    return e;
  }
  function comparison() {
    let e = sum();
    while (["<", ">", "<=", ">=", "==", "!="].some(isOp)) { const op = peek().v; cur.i++; e = { t: "bin", op, a: e, b: sum() }; }
    return e;
  }
  return comparison();
}

/* normcdf and normpdf are written out with erfc and exp, which Cozy
 * differentiates; ln is log. */
function callNode(fn, args) {
  const num = v => ({ t: "num", v, text: String(v) });
  const bin = (op, a, b) => ({ t: "bin", op, a, b });
  if (fn === "ln") return { t: "call", fn: "log", args };
  if (fn === "normcdf" || fn === "normpdf") {
    const z = args.length === 3 ? bin("/", bin("-", args[0], args[1]), args[2]) : args[0];
    if (fn === "normcdf") return bin("*", num(0.5), { t: "call", fn: "erfc", args: [bin("/", { t: "neg", a: z }, { t: "call", fn: "sqrt", args: [num(2)] })] });
    const pdf = bin("/", { t: "call", fn: "exp", args: [bin("/", { t: "neg", a: bin("^", z, num(2)) }, num(2))] }, { t: "call", fn: "sqrt", args: [bin("*", num(2), num(Math.PI))] });
    return args.length === 3 ? bin("/", pdf, args[2]) : pdf;
  }
  return { t: "call", fn, args };
}

/* Visit every node of a tree; the callback may return a replacement. */
export function mapAst(e, f) {
  let out;
  if (e.t === "neg") out = { ...e, a: mapAst(e.a, f) };
  else if (e.t === "bin") out = { ...e, a: mapAst(e.a, f), b: mapAst(e.b, f) };
  else if (e.t === "call") out = { ...e, args: e.args.map(a => mapAst(a, f)) };
  else out = e;
  return f(out) || out;
}
export function walkAst(e, f) { mapAst(e, n => { f(n); }); }

const MATH = {
  exp: Math.exp, log: Math.log, log10: Math.log10, sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, sign: Math.sign,
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh, asinh: Math.asinh, acosh: Math.acosh, atanh: Math.atanh,
  max: Math.max, min: Math.min, erf, erfc: x => 1 - erf(x),
};
function erf(x) {                                   /* Abramowitz and Stegun 7.1.26; display only */
  const s = Math.sign(x), a = Math.abs(x), t = 1 / (1 + 0.3275911 * a);
  return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a));
}

/* The value of a tree. `env(name, node)` gives the value of a name; shocks
 * are zero, and a variable has the same value at every lead and lag (so an
 * equation can be checked at a steady state). */
export function evalAst(e, env) {
  switch (e.t) {
    case "num": return e.v;
    case "par": case "loc": case "var": case "ss": return env(e.name, e);
    case "exo": return 0;
    case "neg": return -evalAst(e.a, env);
    case "call": return MATH[e.fn](...e.args.map(a => evalAst(a, env)));
    case "bin": {
      const a = evalAst(e.a, env), b = evalAst(e.b, env);
      switch (e.op) {
        case "+": return a + b;
        case "-": return a - b;
        case "*": return a * b;
        case "/": return a / b;
        case "^": return Math.pow(a, b);
        case "<": return a < b ? 1 : 0;
        case ">": return a > b ? 1 : 0;
        case "<=": return a <= b ? 1 : 0;
        case ">=": return a >= b ? 1 : 0;
        case "==": return a === b ? 1 : 0;
        default: return a !== b ? 1 : 0;
      }
    }
  }
  throw new Error("unknown node " + e.t);
}

/* A tree as source text, fully parenthesised where it matters. `name`
 * renders a leaf (a variable with its shift, a parameter, ...). */
export function printAst(e, name) {
  const prec = { "==": 1, "!=": 1, "<": 1, ">": 1, "<=": 1, ">=": 1, "+": 2, "-": 2, "*": 3, "/": 3, "^": 5 };
  const go = (n, parent, right) => {
    switch (n.t) {
      case "num": return n.v < 0 ? `(${numText(n)})` : numText(n);
      case "neg": { const s = "-" + go(n.a, 6, false); return parent > 0 ? `(${s})` : s; }
      case "call": return `${n.fn}(${n.args.map(a => go(a, 0, false)).join(", ")})`;
      case "bin": {
        const p = prec[n.op];
        const s = n.op === "^" ? `${go(n.a, 6, false)}^${go(n.b, 6, true)}` : `${go(n.a, p, false)} ${n.op} ${go(n.b, p, true)}`;
        return p < parent || (p === parent && right) ? `(${s})` : s;
      }
      default: return name(n);
    }
  };
  return go(e, 0, false);
}
function numText(n) {
  if (n.text && /^[0-9.eE+\-]+$/.test(n.text)) return n.text.startsWith(".") ? "0" + n.text : n.text.endsWith(".") ? n.text + "0" : n.text;
  return Number.isInteger(n.v) && Math.abs(n.v) < 1e15 ? String(n.v) : n.v.toPrecision(17).replace(/\.?0+(e|$)/, "$1");
}

/* ---- the file ---------------------------------------------------------- */
export function parseMod(source) {
  const errors = [], warnings = [], notes = [];
  const fail = (message, line) => errors.push({ line: line || 0, message });
  const result = { ok: false, errors, warnings, notes, model: null };

  let text, toks;
  try {
    text = macroPass(source.replace(/\r\n?/g, "\n"), {}, notes);
    toks = tokenize(text);
  } catch (e) {
    if (!(e instanceof ModError)) throw e;
    fail(e.message, e.line);
    return result;
  }

  const endo = [], exo = [], params = [];           /* {name, longName, tex, line} */
  const kinds = new Map();                          /* name -> endo | exo | par | loc */
  const assigns = [];                               /* parameter and scalar values, in order */
  const locals = [];                                /* model-local variables, in order */
  const equations = [];
  const predetermined = new Set();
  let linear = false, sawModel = false;
  let initval = null, steadyBlock = null, shockStmts = [];
  const hints = { irf: 40, order: 1 };
  const symbols = name => { const k = kinds.get(name); return k === "scalar" ? undefined : k; };    /* inside the model */
  const symValue = name => { const k = kinds.get(name); return k === "scalar" ? "par" : k; };      /* in values: helper scalars count */

  const cur = { toks, i: 0 };
  const peek = (d = 0) => toks[cur.i + d];
  const isOp = (v, d = 0) => { const t = peek(d); return t && t.k === "op" && t.v === v; };
  const isId = (v, d = 0) => { const t = peek(d); return t && t.k === "id" && (v === undefined || t.v === v); };
  const expectSemi = what => {
    if (!isOp(";")) { const t = peek() || toks[toks.length - 1]; throw new ModError(`expected ';' after ${what}${peek() ? `, found '${peek().v}'` : ""}`, t ? t.line : 0); }
    cur.i++;
  };
  const skipToSemi = () => { while (peek() && !isOp(";")) cur.i++; if (peek()) cur.i++; };
  const skipLine = () => { const line = peek().line; while (peek() && peek().line === line) cur.i++; };
  const skipBlock = (word, line) => {
    while (peek() && !(isId("end") && isOp(";", 1))) cur.i++;
    if (!peek()) throw new ModError(`the ${word} block is never closed by 'end;'`, line);
    cur.i += 2;
  };
  const sourceText = (from, to) => text.slice(toks[from].at, toks[to - 1].end).replace(/\s+/g, " ").trim();

  function declare(list, kind, word) {
    /* name [$tex$] [(long_name = '...', ...)] [,] ... ; */
    if (isOp("(")) { while (peek() && !isOp(")")) cur.i++; cur.i++; }      /* var(options) */
    let any = false;
    while (peek() && !isOp(";")) {
      const t = peek();
      if (t.k === "op" && t.v === ",") { cur.i++; continue; }
      if (t.k !== "id") throw new ModError(`expected a name in the ${word} list, found '${t.v}'`, t.line);
      cur.i++;
      const item = { name: t.v, longName: "", tex: "", line: t.line };
      if (peek() && peek().k === "tex") { item.tex = peek().v; cur.i++; }
      if (isOp("(")) {
        cur.i++;
        while (peek() && !isOp(")")) {
          if (isId("long_name") && isOp("=", 1) && peek(2) && peek(2).k === "str") { item.longName = peek(2).v; cur.i += 3; }
          else cur.i++;
        }
        cur.i++;
      }
      if (kinds.has(t.v)) throw new ModError(`'${t.v}' is declared twice`, t.line);
      kinds.set(t.v, kind);
      list.push(item);
      any = true;
    }
    if (!any) throw new ModError(`the ${word} list is empty`, (peek() || toks[cur.i - 1]).line);
    expectSemi(`the ${word} list`);
  }

  function modelBlock(line) {
    if (sawModel) throw new ModError("a second model block; a file has one", line);
    sawModel = true;
    if (isOp("(")) {
      cur.i++;
      while (peek() && !isOp(")")) {
        if (isId("linear")) linear = true;
        else if (peek().k === "id" && !["use_dll", "block", "bytecode", "cutoff", "mfs", "no_static", "differentiate_forward_vars", "parallel_local_files", "balanced_growth_test_tol", "static_mfs"].includes(peek().v))
          warnings.push({ line, message: `model option '${peek().v}' is ignored` });
        cur.i++;
      }
      cur.i++;
    }
    expectSemi("'model'");
    let tag = "";
    while (peek() && !(isId("end") && isOp(";", 1))) {
      const t = peek();
      if (isOp("[")) {                                /* [name = '...', ...] */
        cur.i++;
        while (peek() && !isOp("]")) {
          if (isId("name") && isOp("=", 1) && peek(2) && peek(2).k === "str") { tag = peek(2).v; cur.i += 3; }
          else cur.i++;
        }
        cur.i++;
        continue;
      }
      if (isOp("#")) {                                /* # name = expression; */
        cur.i++;
        const nm = peek();
        if (!nm || nm.k !== "id" || !isOp("=", 1)) throw new ModError("a model-local variable is written '# name = expression;'", t.line);
        if (kinds.has(nm.v) && kinds.get(nm.v) !== "scalar") throw new ModError(`'${nm.v}' is already declared, so it cannot be a model-local variable`, nm.line);
        cur.i += 2;
        const expr = parseExpr(cur, symbols);
        expectSemi("a model-local variable");
        kinds.set(nm.v, "loc");
        locals.push({ name: nm.v, expr, line: nm.line });
        continue;
      }
      const from = cur.i;
      const lhs = parseExpr(cur, symbols);
      let rhs = null;
      if (isOp("=")) { cur.i++; rhs = parseExpr(cur, symbols); }
      const to = cur.i;
      expectSemi("an equation");
      equations.push({ lhs, rhs, line: t.line, name: tag, text: sourceText(from, to) });
      tag = "";
    }
    if (!peek()) throw new ModError("the model block is never closed by 'end;'", line);
    cur.i += 2;
  }

  function valueBlock(word, line, into, allowed) {
    expectSemi(`'${word}'`);
    while (peek() && !(isId("end") && isOp(";", 1))) {
      const t = peek();
      if (t.k !== "id" || !isOp("=", 1)) throw new ModError(`in ${word}, each line is 'name = expression;' (found '${t.v}')`, t.line);
      cur.i += 2;
      /* names assigned earlier in the block may be used: treat them as known */
      const expr = parseExpr(cur, name => symValue(name) || (into.some(a => a.name === name) ? "par" : undefined));
      expectSemi(`a line of ${word}`);
      if (!allowed(t.v)) { warnings.push({ line: t.line, message: `${word}: '${t.v}' is not a variable of the model; kept as a helper value` }); }
      into.push({ name: t.v, expr, line: t.line });
    }
    if (!peek()) throw new ModError(`the ${word} block is never closed by 'end;'`, line);
    cur.i += 2;
  }

  function shocksBlock(line) {
    if (isOp("(")) { while (peek() && !isOp(")")) cur.i++; cur.i++; }
    expectSemi("'shocks'");
    const known = name => { if (kinds.get(name) !== "exo") throw new ModError(`'${name}' is not a declared shock (varexo)`, (peek() || toks[cur.i - 1]).line); return name; };
    while (peek() && !(isId("end") && isOp(";", 1))) {
      const t = peek();
      if (isId("var")) {
        cur.i++;
        const a = known(peek().v); cur.i++;
        if (isOp(",")) {                             /* var a, b = covariance; */
          cur.i++;
          const b = known(peek().v); cur.i++;
          if (!isOp("=")) throw new ModError("a covariance is written 'var a, b = expression;'", t.line);
          cur.i++;
          shockStmts.push({ kind: "cov", a, b, expr: parseExpr(cur, symValue), line: t.line });
          expectSemi("a covariance");
        } else if (isOp("=")) {                      /* var a = variance; */
          cur.i++;
          shockStmts.push({ kind: "var", a, expr: parseExpr(cur, symValue), line: t.line });
          expectSemi("a variance");
        } else {                                     /* var a; stderr s;   or   var a; periods ...; values ...; */
          expectSemi("'var name'");
          if (isId("stderr")) {
            cur.i++;
            shockStmts.push({ kind: "sd", a, expr: parseExpr(cur, symValue), line: t.line });
            expectSemi("a standard deviation");
          } else if (isId("periods")) {
            skipToSemi();
            if (isId("values")) skipToSemi();
            warnings.push({ line: t.line, message: `a deterministic path for the shock '${a}' is ignored; the workbench solves the stochastic model` });
          } else throw new ModError(`after 'var ${a};' comes 'stderr value;'`, t.line);
        }
      } else if (isId("corr")) {                      /* corr a, b = correlation; */
        cur.i++;
        const a = known(peek().v); cur.i++;
        if (!isOp(",")) throw new ModError("a correlation is written 'corr a, b = expression;'", t.line);
        cur.i++;
        const b = known(peek().v); cur.i++;
        if (!isOp("=")) throw new ModError("a correlation is written 'corr a, b = expression;'", t.line);
        cur.i++;
        shockStmts.push({ kind: "corr", a, b, expr: parseExpr(cur, symValue), line: t.line });
        expectSemi("a correlation");
      } else throw new ModError(`unexpected '${t.v}' in the shocks block`, t.line);
    }
    if (!peek()) throw new ModError("the shocks block is never closed by 'end;'", line);
    cur.i += 2;
  }

  /* -- statements, one at a time; an error skips to the next ';' -- */
  while (cur.i < toks.length) {
    const t = peek(), start = cur.i;
    try {
      if (isOp(";")) { cur.i++; continue; }
      if (t.k !== "id") { notes.push({ line: t.line, message: "a line that is not a Dynare statement was passed over" }); skipLine(); continue; }
      const word = t.v;
      if (word === "var" && !isOp("=", 1)) { cur.i++; declare(endo, "endo", "var"); }
      else if (word === "varexo") { cur.i++; declare(exo, "exo", "varexo"); }
      else if (word === "parameters") { cur.i++; declare(params, "par", "parameters"); }
      else if (word === "predetermined_variables") {
        cur.i++;
        while (peek() && !isOp(";")) {
          if (isOp(",")) { cur.i++; continue; }
          if (kinds.get(peek().v) !== "endo") throw new ModError(`predetermined_variables: '${peek().v}' is not a declared variable`, peek().line);
          predetermined.add(peek().v); cur.i++;
        }
        expectSemi("predetermined_variables");
      }
      else if (word === "model" && (isOp(";", 1) || isOp("(", 1))) { cur.i++; modelBlock(t.line); }
      else if (word === "initval" && (isOp(";", 1) || isOp("(", 1))) {
        cur.i++;
        if (isOp("(")) { while (peek() && !isOp(")")) cur.i++; cur.i++; }
        initval = [];
        valueBlock("initval", t.line, initval, name => kinds.get(name) === "endo" || kinds.get(name) === "exo");
      }
      else if (word === "steady_state_model" && isOp(";", 1)) {
        cur.i++;
        steadyBlock = [];
        valueBlock("steady_state_model", t.line, steadyBlock, () => true);
      }
      else if (word === "shocks" && (isOp(";", 1) || isOp("(", 1))) { cur.i++; shocksBlock(t.line); }
      else if (Object.hasOwn(UNSUPPORTED, word)) throw new ModError(UNSUPPORTED[word], t.line);
      else if (SKIPPED_BLOCKS.has(word) && (isOp(";", 1) || isOp("(", 1))) {
        cur.i++;
        skipBlock(word, t.line);
        notes.push({ line: t.line, message: `the ${word} block is not used by the workbench` });
      }
      else if (SKIPPED_COMMANDS.has(word)) {
        if (word === "stoch_simul") {
          for (let j = cur.i; toks[j] && !(toks[j].k === "op" && toks[j].v === ";"); j++) {
            const o = toks[j], eq = toks[j + 1], val = toks[j + 2];
            if (o.k !== "id" || !eq || eq.v !== "=" || !val) continue;
            if (o.v === "irf" && val.k === "num" && Number(val.v) > 0) hints.irf = Math.min(400, Number(val.v));
            if (o.v === "order" && val.k === "num" && Number(val.v) > 1) warnings.push({ line: o.line, message: `stoch_simul asks for order ${val.v}; the workbench solves to first order` });
            if (o.v === "hp_filter" || o.v === "bandpass_filter" || o.v === "one_sided_hp_filter") warnings.push({ line: o.line, message: `${o.v} is not applied: moments are those of the unfiltered model` });
          }
          for (let j = cur.i; toks[j] && !(toks[j].k === "op" && toks[j].v === ";"); j++)
            if (toks[j].k === "id" && toks[j].v === "loglinear") warnings.push({ line: toks[j].line, message: "loglinear is not applied: results are for the model as written" });
        }
        skipToSemi();
        if (!["steady", "check", "resid"].includes(word)) notes.push({ line: t.line, message: `${word} is a Dynare command; the workbench computes its results from the model alone` });
      }
      else if (isOp("=", 1)) {                        /* name = expression;  a parameter's value, or a helper scalar */
        cur.i += 2;
        let expr;
        try { expr = parseExpr(cur, symValue); expectSemi("a value"); }
        catch (e) {
          if (!(e instanceof ModError) || kinds.get(word) === "par") throw e;
          cur.i = start; skipLine();                 /* not arithmetic: a MATLAB statement */
          notes.push({ line: t.line, message: `'${word} = ...' is not a model statement and was passed over` });
          continue;
        }
        const kind = kinds.get(word);
        if (kind === "endo" || kind === "exo") throw new ModError(`'${word}' is a variable; give it a starting value in an initval block`, t.line);
        if (!kind) kinds.set(word, "scalar");
        assigns.push({ name: word, expr, line: t.line, declared: kind === "par" });
      }
      else { notes.push({ line: t.line, message: `'${word} ...' is not a model statement and was passed over` }); skipLine(); }
    } catch (e) {
      if (!(e instanceof ModError)) throw e;
      fail(e.message, e.line || t.line);
      if (cur.i === start) cur.i++;
      skipToSemi();
    }
  }

  /* -- what the statements add up to -- */
  if (!endo.length) fail("no endogenous variables are declared (var ...;)");
  if (!sawModel && !errors.length) fail("the file has no model block");
  if (errors.length) return result;

  /* Values of parameters and helper scalars, in the order written. A
   * parameter whose expression mentions no other name is a `base` one: a
   * number the user may move. The others follow from them. */
  const values = new Map(), defs = [];
  const lookup = line => name => {
    if (!values.has(name)) throw new ModError(`'${name}' is used before it has a value`, line);
    return values.get(name);
  };
  for (const a of assigns) {
    let base = true;
    walkAst(a.expr, n => { if (n.t === "par" || n.t === "loc") base = false; if (n.t === "var" || n.t === "exo" || n.t === "ss") fail(`the value of '${a.name}' may not depend on a variable`, a.line); });
    if (errors.length) return result;
    try { values.set(a.name, evalAst(a.expr, lookup(a.line))); }
    catch (e) { if (!(e instanceof ModError)) throw e; fail(e.message, e.line); return result; }
    const def = { name: a.name, expr: a.expr, base, value: values.get(a.name), declared: a.declared, line: a.line };
    const old = defs.findIndex(d => d.name === a.name);
    if (old < 0) { defs.push(def); continue; }
    /* a second value: the last one is used throughout */
    warnings.push({ line: a.line, message: `'${a.name}' is given a value more than once; the last one is used` });
    if (base) { defs[old] = def; continue; }
    let usedSince = false;
    for (const d of defs.slice(old + 1)) walkAst(d.expr, n => { if ((n.t === "par" || n.t === "loc") && n.name === a.name) usedSince = true; });
    if (usedSince) { fail(`'${a.name}' is given a new value that depends on other parameters after it was already used; give it one value`, a.line); return result; }
    defs.splice(old, 1);
    defs.push(def);
  }

  /* Model-local variables. One that depends only on parameters is a derived
   * parameter; one that mentions a variable is written into the equations
   * that use it. */
  const inlined = new Map();
  for (const l of locals) {
    let dynamic = false;
    const expr = mapAst(l.expr, n => n.t === "loc" && inlined.has(n.name) ? inlined.get(n.name) : null);
    walkAst(expr, n => { if (n.t === "var" || n.t === "exo" || n.t === "ss") dynamic = true; });
    if (dynamic) { inlined.set(l.name, expr); continue; }
    try { values.set(l.name, evalAst(expr, lookup(l.line))); }
    catch (e) { if (!(e instanceof ModError)) throw e; fail(e.message, e.line); continue; }
    const old = defs.findIndex(d => d.name === l.name);                 /* a helper scalar of the same name gives way */
    if (old >= 0) defs.splice(old, 1);
    defs.push({ name: l.name, expr, base: false, value: values.get(l.name), declared: false, local: true, line: l.line });
  }
  if (errors.length) return result;

  /* Equations: lhs - (rhs), with model-local variables written in and
   * predetermined variables moved back one period. */
  const usedPar = new Set(), usedEndo = new Set(), usedExo = new Set();
  let eqs = equations.map(q => {
    let e = q.rhs ? { t: "bin", op: "-", a: q.lhs, b: q.rhs } : q.lhs;
    e = mapAst(e, n => n.t === "loc" && inlined.has(n.name) ? inlined.get(n.name) : null);
    e = mapAst(e, n => {
      if (n.t === "loc") return { t: "par", name: n.name, line: n.line };
      if (n.t === "var" && predetermined.has(n.name)) return { ...n, shift: n.shift - 1 };
      return null;
    });
    return { ...q, expr: e };
  });

  /* steady_state(x): a hidden parameter that the solver keeps equal to the
   * steady state of x. */
  const ssParams = new Map();
  const taken = name => kinds.has(name) || [...ssParams.values()].includes(name);
  const fresh = stem => { let s = stem, k = 1; while (taken(s) || aux.some(a => a.name === s)) s = `${stem}_${++k}`; return s; };
  const aux = [];                                   /* {name, of, shift, def} auxiliary variables and their equations */
  eqs = eqs.map(q => ({ ...q, expr: mapAst(q.expr, n => {
    if (n.t !== "ss") return null;
    if (!ssParams.has(n.name)) ssParams.set(n.name, fresh(`${n.name}_SS`));
    return { t: "par", name: ssParams.get(n.name), line: n.line };
  }) }));

  /* Leads and lags beyond one period, and lagged shocks, through auxiliary
   * variables (x_LAG1 = x(-1), then x(-2) is x_LAG1(-1), and so on). */
  const auxName = new Map();
  const chain = (name, kind, shift) => {            /* a variable standing for name(shift), |shift| >= 1 (or 0 for a shock) */
    const key = `${kind}:${name}:${shift}`;
    if (auxName.has(key)) return auxName.get(key);
    const dir = shift < 0 ? -1 : 1, steps = Math.abs(shift);
    const nm = fresh(kind === "exo" && shift === 0 ? `${name}_NOW` : `${name}_${dir < 0 ? "LAG" : "LEAD"}${steps}`);
    let def;
    if (kind === "exo" && shift === 0) def = { t: "exo", name, shift: 0 };
    else if (steps === 1 && kind === "endo") def = { t: "var", name, shift: dir };
    else if (kind === "exo" && steps === 1) def = { t: "var", name: chain(name, "exo", 0), shift: dir };
    else def = { t: "var", name: chain(name, kind, shift - dir), shift: dir };
    auxName.set(key, nm);
    aux.push({ name: nm, of: name, shift, def });
    return nm;
  };
  try {
  eqs = eqs.map(q => ({ ...q, expr: mapAst(q.expr, n => {
    if (n.t === "var" && Math.abs(n.shift) > 1) { const d = n.shift < 0 ? -1 : 1; return { t: "var", name: chain(n.name, "endo", n.shift - d), shift: d, line: n.line }; }
    if (n.t === "exo" && n.shift > 0) throw new ModError(`the shock '${n.name}' appears with a lead; shocks are not known in advance`, n.line);
    if (n.t === "exo" && n.shift < 0) {
      const steps = -n.shift;
      return { t: "var", name: steps === 1 ? chain(n.name, "exo", 0) : chain(n.name, "exo", -(steps - 1)), shift: -1, line: n.line };
    }
    return null;
  }) }));
  } catch (e) { if (!(e instanceof ModError)) throw e; fail(e.message, e.line); return result; }
  const nOriginal = eqs.length;
  for (const a of aux) eqs.push({ expr: { t: "bin", op: "-", a: { t: "var", name: a.name, shift: 0 }, b: a.def }, text: "", name: "", line: 0, aux: true });
  for (const q of eqs) walkAst(q.expr, n => {
    if (n.t === "par") usedPar.add(n.name);
    if (n.t === "var") usedEndo.add(n.name);
    if (n.t === "exo") usedExo.add(n.name);
  });

  if (nOriginal !== endo.length)
    fail(`the model has ${nOriginal} equation${nOriginal === 1 ? "" : "s"} for ${endo.length} endogenous variable${endo.length === 1 ? "" : "s"}; the two must be equal`);
  for (const v of endo) if (!usedEndo.has(v.name)) fail(`the variable '${v.name}' appears in no equation`, v.line);
  for (const s of exo) if (!usedExo.has(s.name)) warnings.push({ line: s.line, message: `the shock '${s.name}' appears in no equation` });
  for (const name of usedPar) if (!values.has(name) && ![...ssParams.values()].includes(name)) fail(`the parameter '${name}' is used in the model but never given a value`, (params.find(p => p.name === name) || {}).line);
  for (const p of params) if (!values.has(p.name) && !usedPar.has(p.name)) warnings.push({ line: p.line, message: `the parameter '${p.name}' is declared but has no value and is not used` });
  if (errors.length) return result;

  /* Shocks: standard deviations and a correlation matrix. */
  const k = exo.length, sd = new Array(k).fill(0), corr = exo.map((_, i) => exo.map((_, j) => (i === j ? 1 : 0)));
  const idx = name => exo.findIndex(s => s.name === name);
  const given = new Set();
  const num = st => {
    walkAst(st.expr, n => { if (n.t === "var" || n.t === "exo" || n.t === "ss") throw new ModError("a shock's size may not depend on a variable", st.line); });
    return evalAst(st.expr, lookup(st.line));
  };
  try {
    for (const st of shockStmts) if (st.kind === "sd" || st.kind === "var") {
      const v = num(st);
      if (!(v >= 0)) throw new ModError(`the ${st.kind === "sd" ? "standard deviation" : "variance"} of '${st.a}' must be zero or more`, st.line);
      sd[idx(st.a)] = st.kind === "sd" ? v : Math.sqrt(v);
      given.add(st.a);
    }
    for (const st of shockStmts) if (st.kind === "cov" || st.kind === "corr") {
      const i = idx(st.a), j = idx(st.b), v = num(st);
      const r = st.kind === "corr" ? v : v / (sd[i] * sd[j]);
      if (!(Math.abs(r) <= 1)) throw new ModError(`the ${st.kind === "corr" ? "correlation" : "covariance"} of '${st.a}' and '${st.b}' implies a correlation of ${r.toPrecision(4)}, outside -1..1`, st.line);
      corr[i][j] = corr[j][i] = r;
    }
  } catch (e) { if (!(e instanceof ModError)) throw e; fail(e.message, e.line); return result; }
  for (const s of exo) if (!given.has(s.name)) warnings.push({ line: s.line, message: `the shock '${s.name}' has no standard deviation in a shocks block, so it is zero (as in Dynare)` });

  /* Starting values and the steady state. */
  const endoNames = new Set(endo.map(v => v.name));
  const init = (initval || []).filter(a => endoNames.has(a.name));
  let steady = null;
  if (steadyBlock) {
    const assigned = new Set(steadyBlock.map(a => a.name));
    const missing = endo.filter(v => !assigned.has(v.name)).map(v => v.name);
    if (missing.length && !linear) fail(`steady_state_model gives no value for: ${missing.join(", ")}`);
    for (const a of steadyBlock) if (kinds.get(a.name) === "par") fail(`steady_state_model changes the parameter '${a.name}'; that is not supported`, a.line);
    steady = { lines: steadyBlock, zero: missing };
  }
  if (errors.length) return result;

  /* Names as Cozy will see them. */
  const cozy = new Map(), usedCozy = new Set();
  const allNames = [...endo.map(v => v.name), ...aux.map(a => a.name), ...exo.map(s => s.name), ...defs.map(d => d.name), ...ssParams.values(),
    ...(steadyBlock || []).map(a => a.name)];
  for (const name of allNames) {
    if (cozy.has(name)) continue;
    let c = name.replace(/__+/g, "_");
    if (COZY_RESERVED.has(c)) c += "_";
    while (usedCozy.has(c)) c += "_";
    usedCozy.add(c);
    cozy.set(name, c);
  }

  result.ok = true;
  result.model = {
    linear,
    endo: endo.map(v => ({ ...v, aux: false })).concat(aux.map(a => ({ name: a.name, longName: a.shift === 0 ? `${a.of} (this period)` : `${a.of}(${a.shift > 0 ? "+" : ""}${a.shift})`, tex: "", aux: true, def: a.def }))),
    exo,
    params: defs.map(d => ({ ...d, longName: (params.find(p => p.name === d.name) || {}).longName || "" })),
    equations: eqs.map(q => ({ expr: q.expr, text: q.text, name: q.name, line: q.line, aux: !!q.aux })),
    init, steady, ssParams: [...ssParams].map(([of, name]) => ({ of, name })),
    shocks: { sd, corr },
    hints, cozy,
  };
  return result;
}
