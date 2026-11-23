// compare.mjs — one bundled model, solved by the workbench and set against
// what Dynare 6.0 computed for the same file (test/reference/*.json, written
// by tools/dynare_reference.py). Used by the tests and by the report that
// the app shows.
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseMod } from "../docs/js/modfile.js";
import { Workbench } from "../docs/js/solve.js";

const here = new URL(".", import.meta.url);

// The largest difference between two sets of numbers, relative to their
// size: |a - b| / (scale + |b|). NaN must meet NaN.
function gap(mine, theirs, scale) {
  let worst = 0;
  const go = (a, b) => {
    if (Array.isArray(b)) { assert.equal(a.length, b.length, "shapes differ"); b.forEach((x, i) => go(a[i], x)); return; }
    const an = a === null || Number.isNaN(a), bn = b === null || Number.isNaN(b);
    if (an || bn) { assert.equal(an, bn, `one is NaN and the other is not (${a} vs ${b})`); return; }
    worst = Math.max(worst, Math.abs(a - b) / (scale + Math.abs(b)));
  };
  go(mine, theirs);
  return worst;
}
const largest = x => Math.max(...x.flat(3).filter(v => v !== null && Number.isFinite(v)).map(Math.abs), 0);

// Returns {variables, shocks, report}: report maps each quantity to the
// largest relative difference from Dynare. Structural disagreements (other
// variables, another verdict, NaN on one side only) throw.
export async function compareWithDynare(engine, ex) {
  const name = ex.file.replace(/\.mod$/, "");
    const ref = JSON.parse(fs.readFileSync(new URL(`reference/${name}.json`, here), "utf8"));
    const parsed = parseMod(fs.readFileSync(new URL(`../docs/examples/${ex.file}`, here), "utf8"));
    assert.deepEqual(parsed.errors, [], "the model file is read without errors");
    const model = parsed.model, wb = new Workbench(engine);
    await wb.load(model);
    const r = await wb.solve({}, { horizon: ref.horizon, lags: 5 });
    assert.ok(r.ok, r.error);
    assert.equal(r.verdict, "determinate");
    assert.equal(r.unstable, r.forward, "as many unstable roots as forward-looking variables");

    // the same variables in the same order (the workbench's auxiliary ones come after)
    const n = ref.endo.length, k = ref.exo.length;
    assert.deepEqual(r.names.slice(0, n), ref.endo);
    assert.deepEqual(r.shocks, ref.exo);
    assert.ok(model.endo.slice(n).every(v => v.aux));

    const report = {};
    report.steady = gap(r.steady.slice(0, n), ref.steady, 1e-3 * largest(ref.steady) + 1e-12);

    // the decision rule: responses to the shocks, and to those states that are the model's own variables
    report.ghu = gap(r.Q.slice(0, n), ref.ghu, 1e-3 * largest(ref.ghu));
    const cols = ref.state_names.map(s => r.names.indexOf(s));
    const shared = cols.map((c, j) => [c, j]).filter(([c]) => c >= 0 && c < n);
    const mineP = r.P.slice(0, n).map(row => shared.map(([c]) => row[c]));
    const theirP = ref.ghx.map(row => shared.map(([, j]) => row[j]));
    report.ghx = shared.length ? gap(mineP, theirP, 1e-3 * largest(theirP)) : 0;

    // impulse responses to one-standard-deviation innovations
    const irf = r.irf.map(byT => byT.map(row => row.slice(0, n)));
    report.irf = gap(irf, ref.irf, 1e-3 * largest(ref.irf));
    // ... which are also the ones Dynare itself reports
    let own = 0;
    for (const [field, series] of Object.entries(ref.irf_dynare)) {
      const j = ref.exo.findIndex(s => field.endsWith("_" + s) && ref.endo.includes(field.slice(0, -s.length - 1)));
      const i = ref.endo.indexOf(field.slice(0, -ref.exo[j].length - 1));
      own = Math.max(own, gap(irf[j].map(row => row[i]), [series].flat(), 1e-3 * largest(ref.irf)));
    }
    report.irf_dynare = own;

    // theoretical moments
    report.sd = gap(r.sd.slice(0, n), ref.sd, 1e-3 * largest(ref.sd));
    report.autocorr = gap(r.acorr.slice(0, n), ref.autocorr, 1e-3);
    const refCorr = ref.var.map((row, i) => row.map((v, j) => (v === null || ref.sd[i] === null || ref.sd[j] === null || ref.sd[i] === 0 || ref.sd[j] === 0 ? null : v / (ref.sd[i] * ref.sd[j]))));
    report.corr = gap(r.corr.slice(0, n).map(row => row.slice(0, n)), refCorr, 1e-3);
    if (k > 1) report.vardecomp = gap(r.vardecomp.slice(0, n), ref.variance_decomposition, 1e-1);

    // eigenvalues: the finite, non-zero ones are the same set (an infinite root comes out of
    // either program as some huge number, so anything beyond 1e4 is taken as infinite)
    const finite = xs => xs.filter(v => v !== null && Number.isFinite(v) && v > 1e-7 && v < 1e4).sort((a, b) => a - b);
    const mineRoots = finite(r.roots), theirRoots = finite(ref.eigenvalue_moduli);
    assert.equal(mineRoots.length, theirRoots.length, "the same number of finite non-zero roots");
    report.roots = gap(mineRoots, theirRoots, 1e-3);

    return { variables: n, shocks: k, report };
}
