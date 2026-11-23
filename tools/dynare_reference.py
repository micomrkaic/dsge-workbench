#!/usr/bin/env python3
"""dynare_reference.py — what Dynare says about each bundled model.

    tools/dynare_reference.py            all models in docs/examples/index.json
    tools/dynare_reference.py rbc nk     only these

For each model this runs Dynare (under Octave) on the model file and writes
test/reference/NAME.json: the steady state, the first-order decision rule,
the eigenvalues, the impulse responses, and the theoretical moments and
variance decomposition. The tests compare the workbench's numbers with
these files; they are committed, so the tests need neither Dynare nor
Octave.

The model file is used as it is up to the first computing command (the
"cut" pattern in index.json); from there on it is replaced by a single
stoch_simul(order=1) so that every model is asked for the same things.
A steady command with a tight tolerance comes first: Dynare's default for
a numerical steady state is about 6e-6, which would be the largest
difference in the comparison.

Needs: octave and dynare (Debian/Ubuntu: apt install dynare).

Part of dsge-workbench. Copyright (C) 2026 Mico Mrkaic.
GPL-3.0-or-later; see LICENSE.
"""
import json
import pathlib
import re
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
EXAMPLES = ROOT / "docs" / "examples"
OUT = ROOT / "test" / "reference"
HORIZON = 40

DUMP = r"""
function dump_reference(outfile, horizon)
  global M_ oo_ options_
  n = M_.orig_endo_nbr;
  r = struct();
  r.dynare = dynare_version();
  r.endo = M_.endo_names(1:n)';
  r.exo = M_.exo_names';
  r.steady = oo_.dr.ys(1:n)';                       % the steady state the solution was taken around
  r.eigenvalue_moduli = sort(abs(oo_.dr.eigval))';
  r.sigma_e = M_.Sigma_e;

  % the decision rule, rows in the order the variables were declared
  dr = oo_.dr;
  back(dr.order_var) = 1:M_.endo_nbr;
  ghx = dr.ghx(back, :); ghu = dr.ghu(back, :);
  states = dr.order_var(M_.nstatic + (1:M_.nspred));
  r.state_names = M_.endo_names(states)';
  r.ghx = ghx(1:n, :);
  r.ghu = ghu(1:n, :);

  % impulse responses to one-standard-deviation (Cholesky) innovations,
  % computed from the decision rule so that none is dropped for being small
  cs = transpose(chol(M_.Sigma_e + 1e-14 * eye(M_.exo_nbr)));
  cs(abs(cs) < 1e-10) = 0;
  irf = zeros(M_.exo_nbr, horizon, n);
  A = zeros(M_.endo_nbr); A(:, states) = ghx;
  for j = 1:M_.exo_nbr
    y = ghu * cs(:, j);
    for t = 1:horizon
      irf(j, t, :) = y(1:n);
      y = A * y;
    end
  end
  r.irf = irf;
  % and Dynare's own, where it reports them, as a cross-check of the above
  own = struct();
  f = fieldnames(oo_.irfs);
  for q = 1:numel(f)
    own.(f{q}) = oo_.irfs.(f{q});
  end
  r.irf_dynare = own;

  % theoretical moments
  v = oo_.var(1:n, 1:n);
  r.sd = sqrt(diag(v))';
  r.var = v;
  ac = zeros(n, numel(oo_.autocorr));
  for q = 1:numel(oo_.autocorr)
    d = diag(oo_.autocorr{q});
    ac(:, q) = d(1:n);
  end
  r.autocorr = ac;
  r.variance_decomposition = oo_.variance_decomposition(1:n, :);

  fid = fopen(outfile, 'w');
  fputs(fid, jsonencode(r));
  fclose(fid);
end
"""


def reference(entry):
    name = pathlib.Path(entry["file"]).stem
    text = (EXAMPLES / entry["file"]).read_text(encoding="utf-8")
    lines = text.split("\n")
    cut = next((i for i, line in enumerate(lines) if re.search(entry["cut"], line.strip())), None)
    if cut is None:
        raise SystemExit(f"{name}: no line matches the cut pattern {entry['cut']!r}")
    model = "\n".join(lines[:cut]) + f"\n\nsteady(tolf=1e-13, tolx=1e-13);\nstoch_simul(order=1, irf={HORIZON}, ar=5, nograph, noprint);\n"
    with tempfile.TemporaryDirectory() as tmp:
        tmp = pathlib.Path(tmp)
        (tmp / f"{name}.mod").write_text(model, encoding="utf-8")
        (tmp / "dump_reference.m").write_text(DUMP)
        out = tmp / "out.json"
        cmd = f"dynare {name} nolog; dump_reference('{out}', {HORIZON});"
        run = subprocess.run(["octave", "--no-gui", "--quiet", "--eval", cmd], cwd=tmp, capture_output=True, text=True)
        if run.returncode != 0 or not out.exists():
            sys.stderr.write(run.stdout[-3000:] + run.stderr[-3000:])
            raise SystemExit(f"{name}: Dynare failed")
        data = json.loads(out.read_text())
    # a 1 x n matrix comes back as a flat list and a 1 x 1 as a number: make shapes regular
    n, k = len(data["endo"]), len(data["exo"]) if isinstance(data["exo"], list) else 1
    if not isinstance(data["exo"], list):
        data["exo"] = [data["exo"]]
    if not isinstance(data["state_names"], list):
        data["state_names"] = [data["state_names"]]
    ns = len(data["state_names"])

    def shape(x, rows, cols):
        flat = []
        def walk(v):
            if isinstance(v, list):
                for u in v:
                    walk(u)
            else:
                flat.append(v)
        walk(x)
        assert len(flat) == rows * cols, (name, len(flat), rows, cols)
        return [flat[i * cols:(i + 1) * cols] for i in range(rows)]

    data["ghx"] = shape(data["ghx"], n, ns)
    data["ghu"] = shape(data["ghu"], n, k)
    data["sigma_e"] = shape(data["sigma_e"], k, k)
    data["var"] = shape(data["var"], n, n)
    data["autocorr"] = shape(data["autocorr"], n, 5)
    nvd = len(json.dumps(data["variance_decomposition"]).split(",")) // n
    data["variance_decomposition"] = shape(data["variance_decomposition"], n, nvd)
    irf = shape(data["irf"], k, HORIZON * n)
    data["irf"] = [[row[t * n:(t + 1) * n] for t in range(HORIZON)] for row in irf]
    for key in ("steady", "sd", "eigenvalue_moduli"):
        if not isinstance(data[key], list):
            data[key] = [data[key]]
    data["model"] = entry["file"]
    data["horizon"] = HORIZON
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"{name}.json").write_text(json.dumps(data, separators=(",", ":")) + "\n")
    print(f"{name}: Dynare {data['dynare']}, {n} variables, {k} shocks, {ns} states -> test/reference/{name}.json")


def main():
    entries = json.loads((EXAMPLES / "index.json").read_text())
    want = set(sys.argv[1:])
    for entry in entries:
        if not want or pathlib.Path(entry["file"]).stem in want:
            reference(entry)


if __name__ == "__main__":
    main()
