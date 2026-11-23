// modfile.test.mjs — the model reader, and what the solver does with
// models that are not well behaved.
import test from "node:test";
import assert from "node:assert/strict";
import { parseMod, evalAst, printAst } from "../docs/js/modfile.js";
import { Workbench, modelSource, cozyNum } from "../docs/js/solve.js";
import { startEngine } from "./engine-node.mjs";

const engine = await startEngine();
const good = text => { const r = parseMod(text); assert.deepEqual(r.errors, []); return r; };
const bad = text => { const r = parseMod(text); assert.equal(r.ok, false); return r.errors; };
const solve = async (text, values, options) => { const wb = new Workbench(engine); await wb.load(good(text).model); return wb.solve(values, options); };

const AR1 = `var x; varexo e; parameters rho; rho = 0.9;
model; x = rho * x(-1) + e; end;
shocks; var e; stderr 2; end;`;

const NK = `var x pi i rn v; varexo en ev;
parameters beta sigma kappa phi_pi phi_x rho_n rho_v;
beta = 0.99; sigma = 1; kappa = 0.1275; phi_pi = 1.5; phi_x = 0.125; rho_n = 0.9; rho_v = 0.5;
model(linear);
pi = beta * pi(+1) + kappa * x;
x = x(+1) - (1 / sigma) * (i - pi(+1) - rn);
i = phi_pi * pi + phi_x * x + v;
rn = rho_n * rn(-1) + en;
v = rho_v * v(-1) + ev;
end;
shocks; var en; stderr 0.25; var ev; stderr 0.25; end;`;

test("declarations: lists with commas, TeX names and long names", () => {
  const m = good(`var y $y_t$ (long_name='output'), c
      k (long_name='capital stock');
    varexo e; parameters a b; a = 1; b = 2;
    model; y = a * e; c = b * y; k = c(-1); end;`).model;
  assert.deepEqual(m.endo.map(v => v.name), ["y", "c", "k"]);
  assert.equal(m.endo[0].longName, "output");
  assert.equal(m.endo[0].tex, "y_t");
  assert.equal(m.endo[2].longName, "capital stock");
});

test("comments of all three kinds are ignored, and line numbers survive them", () => {
  const errors = bad(`// one
% two
/* three
   four */
var x; varexo e;
parameters rho; rho = 0.5;
model;
x = rho * x(-1) + e + nosuch;
end;`);
  assert.equal(errors[0].line, 8);
  assert.match(errors[0].message, /'nosuch' is not declared/);
});

test("parameters: base values, derived values and helper scalars", () => {
  const m = good(`var x; varexo e; parameters a b c;
    a = 3/4; step = 0.1; b = a + step; c = log(1.011);
    model; x = b * x(-1) + c + e; end;
    shocks; var e; stderr step * 2; end;`).model;
  const byName = Object.fromEntries(m.params.map(p => [p.name, p]));
  assert.equal(byName.a.base, true);
  assert.equal(byName.a.value, 0.75);
  assert.equal(byName.b.base, false);
  assert.ok(Math.abs(byName.b.value - 0.85) < 1e-15);
  assert.equal(byName.c.base, true);
  assert.equal(byName.step.declared, false);
  assert.ok(Math.abs(m.shocks.sd[0] - 0.2) < 1e-15);
});

test("a derived parameter follows its base parameter when that is moved", async () => {
  const text = `var x; varexo e; parameters a b; a = 0.5; b = a + 0.25;
    model; x = b * x(-1) + e; end; shocks; var e; stderr 1; end;`;
  const r1 = await solve(text), r2 = await solve(text, { a: 0.25 });
  assert.equal(r1.P[0][0], 0.75);
  assert.equal(r2.P[0][0], 0.5);
  assert.equal(r2.params.b, 0.5);
});

test("model-local variables: parameter-only ones become derived parameters, others are written in", async () => {
  const text = `var y z; varexo e; parameters a; a = 0.5;
    model; # twice = 2 * a; # ylag = y(-1) * 1;
    y = twice * 0.4 * ylag + e; z = ylag; end;
    shocks; var e; stderr 1; end;`;
  const m = good(text).model;
  assert.ok(m.params.find(p => p.name === "twice" && p.local && p.value === 1));
  assert.ok(!m.params.find(p => p.name === "ylag"));
  const r = await solve(text);
  assert.ok(Math.abs(r.P[0][0] - 0.4) < 1e-14 && Math.abs(r.P[1][0] - 1) < 1e-14);
});

test("leads and lags beyond one period go through auxiliary variables", async () => {
  const text = `var x y; varexo e; parameters a b; a = 0.5; b = 0.3;
    model; x = a * x(-1) + b * x(-3) + e; y = x(+2); end;
    shocks; var e; stderr 1; end;`;
  const m = good(text).model;
  assert.deepEqual(m.endo.filter(v => v.aux).map(v => v.name), ["x_LAG1", "x_LAG2", "x_LEAD1"]);
  const r = await solve(text, {}, { horizon: 8 });
  assert.equal(r.verdict, "determinate");
  const x = r.irf[0].map(row => row[0]), y = r.irf[0].map(row => row[1]);
  assert.ok(Math.abs(x[3] - (0.5 * x[2] + 0.3 * x[0])) < 1e-13, "x follows its third lag");
  assert.ok(Math.abs(y[0] - x[2]) < 1e-13 && Math.abs(y[3] - x[5]) < 1e-13, "y is x two periods ahead");
});

test("a lagged shock is allowed; a shock with a lead is not", async () => {
  const r = await solve(`var x; varexo e; model; x = e + 0.5 * e(-1) + 0.25 * e(-2); end; shocks; var e; stderr 1; end;`, {}, { horizon: 5 });
  assert.deepEqual(r.irf[0].map(row => +row[0].toFixed(12)), [1, 0.5, 0.25, 0, 0]);
  assert.match(bad(`var x; varexo e; model; x = e(+1); end;`)[0].message, /appears with a lead/);
});

test("predetermined_variables shifts the timing of a variable", async () => {
  const stock = `var k y; varexo e; predetermined_variables k;
    model; k(+1) = 0.9 * k + e; y = k; end; shocks; var e; stderr 1; end;`;
  const usual = `var k y; varexo e;
    model; k = 0.9 * k(-1) + e; y = k(-1); end; shocks; var e; stderr 1; end;`;
  const a = await solve(stock, {}, { horizon: 6 }), b = await solve(usual, {}, { horizon: 6 });
  assert.deepEqual(a.irf, b.irf);
});

test("the shocks block: stderr, variances, covariances and correlations", () => {
  const m = good(`var x y; varexo e u w; model; x = e + w; y = u; end;
    shocks; var e; stderr 2; var u = 9; var e, u = 3; var w; stderr 1; corr u, w = -0.4; end;`).model;
  assert.deepEqual(m.shocks.sd, [2, 3, 1]);
  assert.equal(m.shocks.corr[0][1], 0.5);
  assert.equal(m.shocks.corr[1][2], -0.4);
  assert.equal(m.shocks.corr[2][1], -0.4);
  assert.match(bad(`var x; varexo e u; model; x = e + u; end; shocks; var e; stderr 1; var u; stderr 1; var e, u = 2; end;`)[0].message, /outside -1\.\.1/);
});

test("correlated shocks are orthogonalised in the order declared", async () => {
  const r = await solve(`var x y; varexo e u; model; x = e; y = u; end;
    shocks; var e; stderr 1; var u; stderr 2; corr e, u = 0.6; end;`, {}, { horizon: 2 });
  // Cholesky of [[1, 1.2], [1.2, 4]] is [[1, 0], [1.2, 1.6]]
  assert.ok(Math.abs(r.C[0][0] - 1) < 1e-14 && Math.abs(r.C[1][0] - 1.2) < 1e-14 && Math.abs(r.C[0][1]) < 1e-14 && Math.abs(r.C[1][1] - 1.6) < 1e-14);
  assert.ok(Math.abs(r.sd[1] - 2) < 1e-13 && Math.abs(r.corr[0][1] - 0.6) < 1e-13);
  assert.ok(Math.abs(r.vardecomp[1][0] - 36) < 1e-10 && Math.abs(r.vardecomp[1][1] - 64) < 1e-10);
});

test("macro directives: @#define and the @#if family choose lines", () => {
  const text = flag => `@#define rule = ${flag}
var x; varexo e; parameters a; a = 0.5;
model;
@#if rule == 1
x = a * x(-1) + e;
@#else
x = 0.9 * x(-1) + e;
@#endif
end;`;
  assert.equal(printAst(good(text(1)).model.equations[0].expr, n => n.name), "x - (a * x + e)");
  assert.equal(good(text(0)).model.equations[0].line, 7);
  assert.match(bad(`@#for i in 1:3\nvar x;\n@#endfor`)[0].message, /@#for is not supported/);
  assert.match(bad(`@#if 1\nvar x;`)[0].message, /never closed/);
});

test("commands and MATLAB lines are passed over and reported as notes", () => {
  const r = good(`${AR1}
steady; check;
estimated_params; rho, beta_pdf, 0.5, 0.1; end;
varobs x;
options_.debug = 1;
figure(1)
plot(1:3)
estimation(datafile = d, mh_replic = 2000);
stoch_simul(order = 2, irf = 12, hp_filter = 1600) x;`);
  assert.equal(r.model.hints.irf, 12);
  assert.ok(r.warnings.some(w => /first order/.test(w.message)));
  assert.ok(r.warnings.some(w => /hp_filter is not applied/.test(w.message)));
  assert.ok(r.notes.some(n => /estimated_params block is not used/.test(n.message)));
  assert.ok(r.notes.some(n => /options_/.test(n.message)));
  assert.equal(r.model.equations.length, 1);
});

test("what would change the model's meaning and is not supported is an error", () => {
  assert.match(bad(`var x; varexo_det g; model; x = g; end;`)[0].message, /varexo_det/);
  assert.match(bad(`${AR1}\nramsey_model(planner_discount = 0.99);`)[0].message, /optimal policy/);
  assert.match(bad(`var x; trend_var(growth_factor = g) A;`)[0].message, /explicit trends/);
});

test("errors say what is wrong and where", () => {
  assert.match(bad(`var x y; varexo e; model; x = e; end;`)[0].message, /1 equation for 2 endogenous variables/);
  assert.match(bad(`var x; varexo e; parameters a; model; x = a * e; end;`)[0].message, /'a' is used in the model but never given a value/);
  assert.match(bad(`var x; varexo e; parameters a; a = 2; model; x = a(-1) + e; end;`)[0].message, /'a' is a parameter, not a function/);
  assert.match(bad(`var x; varexo e; model; x = x(-1)^2^3 + e; end;`)[0].message, /ambiguous/);
  assert.match(bad(`var x; varexo e; model; x = foo(x) + e; end;`)[0].message, /'foo' is not a function/);
  assert.match(bad(`var x; varexo e; model; x = (x(-1) + e; end;`)[0].message, /never closed/);
  assert.match(bad(`var x; varexo e; model; x = e;`)[0].message, /never closed by 'end;'/);
  assert.match(bad(`var x x; varexo e; model; x = e; end;`)[0].message, /declared twice/);
  assert.match(bad(`var x y; varexo e; model; x = e; x = 2 * e; end;`)[0].message, /'y' appears in no equation/);
  const two = bad(`var x; varexo e; parameters a;\na = oops + 1;\nmodel; x = e; end;`);
  assert.equal(two[0].line, 2);
});

test("expressions: precedence as in Dynare", () => {
  const value = src => { const m = good(`var x; varexo e; parameters a; a = ${src}; model; x = a + e; end;`).model; return m.params[0].value; };
  assert.equal(value("-2^2"), -4);
  assert.equal(value("2^-1"), 0.5);
  assert.equal(value("2*3^2"), 18);
  assert.equal(value("8/4/2"), 1);
  assert.equal(value("1 - 2 - 3"), -4);
  assert.equal(value("-(1 + 2)*3"), -9);
  assert.equal(value(".5 + 1.e1 + 2d0"), 12.5);
  assert.equal(value("max(2, 3) - min(2, 3)"), 1);
  assert.ok(Math.abs(value("normcdf(0) + normcdf(1.96, 0, 1)") - 1.4750021) < 1e-6);
  assert.equal(evalAst({ t: "num", v: 2 }, () => 0), 2);
});

test("numbers are written for Cozy at full precision", () => {
  assert.equal(cozyNum(1), "1.0");
  assert.equal(cozyNum(-0.5), "(-0.5)");
  assert.equal(cozyNum(1e21), "1e+21");
  assert.equal(Number(cozyNum(0.1 + 0.2)), 0.1 + 0.2);
  assert.equal(cozyNum(NaN), "(0.0 / 0.0)");
});

test("names that Cozy reserves are renamed on the way in and back on the way out", async () => {
  const text = `var in end; varexo do; parameters fn; fn = 0.5;
    model; in = fn * in(-1) + do; end = in; end; shocks; var do; stderr 1; end;`;
  const m = good(text).model;
  assert.equal(m.cozy.get("in"), "in_");
  assert.match(modelSource(m).src, /vars = "in_ end_"/);
  const r = await solve(text);
  assert.deepEqual(r.names, ["in", "end"]);
  assert.equal(r.P[0][0], 0.5);
});

test("the Taylor principle: the verdict is a result, not an error", async () => {
  const fine = await solve(NK), loose = await solve(NK, { phi_pi: 0.9 });
  assert.equal(fine.verdict, "determinate");
  assert.equal(loose.verdict, "indeterminate");
  assert.equal(loose.determinate, false);
  assert.equal(loose.forward, 2);
  assert.equal(loose.unstable, 1);
  assert.equal(loose.irf, undefined);
  const explosive = await solve(AR1, { rho: 1.5 });
  assert.equal(explosive.verdict, "explosive");
});

test("the solution of the three-equation model is Gali's closed form", async () => {
  const r = await solve(NK);
  const lam = 1 / ((1 - 0.99 * 0.5) * (1 * (1 - 0.5) + 0.125) + 0.1275 * (1.5 - 0.5));
  assert.ok(Math.abs(r.Q[0][1] + (1 - 0.99 * 0.5) * lam) < 1e-13);
  assert.ok(Math.abs(r.Q[1][1] + 0.1275 * lam) < 1e-13);
});

test("moments of an AR(1), and their absence for a random walk", async () => {
  const r = await solve(AR1);
  assert.ok(Math.abs(r.sd[0] - 2 / Math.sqrt(1 - 0.81)) < 1e-12);
  assert.ok(Math.abs(r.acorr[0][2] - 0.729) < 1e-12);
  const walk = await solve(`var x dx; varexo e; model; x = x(-1) + e; dx = x - x(-1); end; shocks; var e; stderr 1; end;`);
  assert.equal(walk.verdict, "determinate");
  assert.ok(Number.isNaN(walk.sd[0]), "a random walk has no variance");
  assert.ok(Math.abs(walk.sd[1] - 1) < 1e-13, "its first difference does");
  assert.ok(Number.isNaN(walk.vardecomp[0][0]) && Math.abs(walk.vardecomp[1][0] - 100) < 1e-10);
});

test("steady_state(x) follows the steady state of x", async () => {
  const text = `var y gap; varexo e; parameters ybar rho; ybar = 2; rho = 0.5;
    model; y = (1 - rho) * ybar + rho * y(-1) + e; gap = y - steady_state(y); end;
    initval; y = 1; gap = 0; end; shocks; var e; stderr 1; end;`;
  const r = await solve(text);
  assert.ok(Math.abs(r.steady[0] - 2) < 1e-12 && Math.abs(r.steady[1]) < 1e-12);
  const moved = await solve(text, { ybar: 5 });
  assert.ok(Math.abs(moved.steady[0] - 5) < 1e-12 && Math.abs(moved.steady[1]) < 1e-12);
});

test("steady_state_model gives the steady state by formula; a wrong one is refused", async () => {
  const text = formula => `var k y; varexo e; parameters alpha delta s; alpha = 0.3; delta = 0.1; s = 0.2;
    model; y = exp(e) * k(-1)^alpha; k = (1 - delta) * k(-1) + s * y; end;
    steady_state_model; kk = ${formula}; k = kk; y = k^alpha; end;
    shocks; var e; stderr 0.01; end;`;
  const r = await solve(text("(s / delta)^(1 / (1 - alpha))"));
  assert.ok(Math.abs(r.steady[0] - Math.pow(2, 1 / 0.7)) < 1e-12);
  const wrong = await solve(text("1"));
  assert.equal(wrong.ok, false);
  assert.match(wrong.error, /steady function does not solve the model/);
});

test("a model with no steady state near its starting values reports that", async () => {
  const r = await solve(`var x; varexo e; model; exp(x) = -1 + 0 * x(-1) + e; end; initval; x = 0; end; shocks; var e; stderr 1; end;`);
  assert.equal(r.ok, false);
  assert.match(r.error, /steady state/);
});

test("a simulated path is reproducible and has about the right volatility", async () => {
  const wb = new Workbench(engine);
  await wb.load(good(AR1).model);
  await wb.solve();
  const a = await wb.simulate(4000, 7), b = await wb.simulate(4000, 7), c = await wb.simulate(4000, 8);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  const sd = Math.sqrt(a.reduce((s, row) => s + row[0] * row[0], 0) / a.length);
  assert.ok(Math.abs(sd / (2 / Math.sqrt(0.19)) - 1) < 0.1);
});
