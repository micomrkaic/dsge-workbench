#!/usr/bin/env python3
"""dynare_reference.py — what Dynare says about each bundled model.

    tools/dynare_reference.py            all models in docs/examples/index.json
    tools/dynare_reference.py rbc nk     only these

For each model this runs Dynare (under Octave) on the model file and writes
test/reference/NAME.json: the steady state, the first-order decision rule,
the eigenvalues, the impulse responses, and the theoretical moments and
variance decomposition. A second run, stoch_simul(order=2), writes
test/reference/NAME.order2.json: the second-order terms of the decision
rule (ghxx, ghxu, ghuu, ghs2), the means to second order, and a pruned
simulation for a fixed path of shocks. For a model with an occasionally
binding constraint ("occbin" in index.json) a third run executes the file
as it is, with its own shocks(surprise) and occbin_solver, and writes
test/reference/NAME.occbin.json: Dynare's piecewise-linear path, the path
that ignores the constraint, and the periods in which it binds. The tests
compare the workbench's numbers with these files; they are committed, so
the tests need neither Dynare nor Octave.

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


DUMP2 = r"""
function dump_order2(outfile, T)
  global M_ oo_ options_
  n = M_.orig_endo_nbr; k = M_.exo_nbr;
  dr = oo_.dr;
  r = struct();
  r.dynare = dynare_version();
  r.endo = M_.endo_names(1:n)';
  r.exo = M_.exo_names';
  r.order = 1 + isfield(dr, 'ghxx');                % 1 if Dynare kept a linear model at first order
  r.steady = dr.ys(1:n)';
  back(dr.order_var) = 1:M_.endo_nbr;
  states = dr.order_var(M_.nstatic + (1:M_.nspred));
  r.state_names = M_.endo_names(states)';
  % Dynare's auxiliary variables: what each stands for
  aux = struct('name', {}, 'type', {}, 'of', {}, 'lag', {});
  for q = 1:numel(M_.aux_vars)
    a = M_.aux_vars(q);
    aux(end + 1).name = M_.endo_names{a.endo_index};
    aux(end).type = a.type;
    if a.type == 1, aux(end).of = M_.endo_names{a.orig_index}; aux(end).lag = a.orig_lead_lag;
    elseif a.type == 3, aux(end).of = M_.exo_names{a.orig_index}; aux(end).lag = a.orig_lead_lag;
    else, aux(end).of = ''; aux(end).lag = 0; end
  end
  r.aux = aux;
  r.sigma_e = M_.Sigma_e;
  if r.order >= 2
    g = dr.ghxx(back, :); r.ghxx = g(1:n, :);
    g = dr.ghxu(back, :); r.ghxu = g(1:n, :);
    g = dr.ghuu(back, :); r.ghuu = g(1:n, :);
    g = dr.ghs2(back);    r.ghs2 = g(1:n)';
    r.mean = oo_.mean(1:n)';
    % a pruned simulation from the steady state for a fixed, reproducible path of shocks
    cs = transpose(chol(M_.Sigma_e + 1e-14 * eye(k)));
    cs(abs(cs) < 1e-10) = 0;
    ex = zeros(T, k);
    for t = 1:T, for j = 1:k, ex(t, :) = ex(t, :) + sin(1.3 * t + j) * cs(:, j)'; end, end
    options_.pruning = true;
    y = simult_(M_, options_, dr.ys, dr, ex, 2);
    r.shock_path = ex;
    r.sim = y(1:n, 2:end)';
  end
  fid = fopen(outfile, 'w');
  fputs(fid, jsonencode(r));
  fclose(fid);
end
"""
SIM_T = 40


def model_text(entry):
    name = pathlib.Path(entry["file"]).stem
    lines = (EXAMPLES / entry["file"]).read_text(encoding="utf-8").split("\n")
    cut = next((i for i, line in enumerate(lines) if re.search(entry["cut"], line.strip())), None)
    if cut is None:
        raise SystemExit(f"{name}: no line matches the cut pattern {entry['cut']!r}")
    return name, "\n".join(lines[:cut])


def regular(x, rows, cols, name):
    """jsonencode flattens 1 x n and n x 1 matrices: give every matrix its rows back."""
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


def reference2(entry):
    name, head = model_text(entry)
    model = head + "\n\nsteady(tolf=1e-13, tolx=1e-13);\nstoch_simul(order=2, irf=0, ar=1, nograph, noprint);\n"
    with tempfile.TemporaryDirectory() as tmp:
        tmp = pathlib.Path(tmp)
        (tmp / f"{name}.mod").write_text(model, encoding="utf-8")
        (tmp / "dump_order2.m").write_text(DUMP2)
        out = tmp / "out.json"
        cmd = f"dynare {name} nolog; dump_order2('{out}', {SIM_T});"
        run = subprocess.run(["octave", "--no-gui", "--quiet", "--eval", cmd], cwd=tmp, capture_output=True, text=True)
        if run.returncode != 0 or not out.exists():
            sys.stderr.write(run.stdout[-3000:] + run.stderr[-3000:])
            raise SystemExit(f"{name}: Dynare failed at order 2")
        data = json.loads(out.read_text())
    for key in ("exo", "state_names", "steady"):
        if not isinstance(data[key], list):
            data[key] = [data[key]]
    if isinstance(data["aux"], dict):
        data["aux"] = [data["aux"]]
    n, k, nx = len(data["endo"]), len(data["exo"]), len(data["state_names"])
    data["sigma_e"] = regular(data["sigma_e"], k, k, name)
    if data["order"] >= 2:
        data["ghxx"] = regular(data["ghxx"], n, nx * nx, name)
        data["ghxu"] = regular(data["ghxu"], n, nx * k, name)
        data["ghuu"] = regular(data["ghuu"], n, k * k, name)
        data["ghs2"] = regular(data["ghs2"], 1, n, name)[0]
        data["mean"] = regular(data["mean"], 1, n, name)[0]
        data["shock_path"] = regular(data["shock_path"], SIM_T, k, name)
        data["sim"] = regular(data["sim"], SIM_T, n, name)
    data["model"] = entry["file"]
    (OUT / f"{name}.order2.json").write_text(json.dumps(data, separators=(",", ":")) + "\n")
    what = "second order" if data["order"] >= 2 else "linear model: Dynare stays at first order"
    print(f"{name}: order 2 -> test/reference/{name}.order2.json ({what}, {nx} states)")


DUMP_OCCBIN = r"""
function dump_occbin(outfile)
  global M_ oo_
  n = M_.orig_endo_nbr;
  s = oo_.occbin.simul;
  r = struct();
  r.dynare = dynare_version();
  r.endo = M_.endo_names(1:n)';
  r.exo = M_.exo_names';
  r.steady = s.ys(1:n)';
  r.piecewise = s.piecewise(:, 1:n);                % in levels, one row per period
  r.linear = s.linear(:, 1:n);
  % regime_history(t) is the plan made in period t: the regimes expected from t on and
  % when each starts. Period t is in the first of them; past the last period that has a
  % plan (the last one with a shock) the economy follows that last plan.
  T = size(s.piecewise, 1); H = numel(s.regime_history); r.binding = zeros(1, T);
  for t = 1:T
    h = s.regime_history(min(t, H));
    q = find(h.regimestart <= t - min(t, H) + 1, 1, 'last');
    r.binding(t) = double(h.regime(q) ~= 0);
  end
  r.error_flag = s.error_flag;
  r.periods = size(s.piecewise, 1);
  fid = fopen(outfile, 'w');
  fputs(fid, jsonencode(r));
  fclose(fid);
end
"""


def reference_occbin(entry):
    name = pathlib.Path(entry["file"]).stem
    text = (EXAMPLES / entry["file"]).read_text(encoding="utf-8")
    with tempfile.TemporaryDirectory() as tmp:
        tmp = pathlib.Path(tmp)
        (tmp / f"{name}.mod").write_text(text, encoding="utf-8")
        (tmp / "dump_occbin.m").write_text(DUMP_OCCBIN)
        out = tmp / "out.json"
        cmd = f"dynare {name} nolog nograph; dump_occbin('{out}');"
        run = subprocess.run(["octave", "--no-gui", "--quiet", "--eval", cmd], cwd=tmp, capture_output=True, text=True)
        if run.returncode != 0 or not out.exists():
            sys.stderr.write(run.stdout[-3000:] + run.stderr[-3000:])
            raise SystemExit(f"{name}: Dynare's OccBin failed")
        data = json.loads(out.read_text())
    if not isinstance(data["exo"], list):
        data["exo"] = [data["exo"]]
    n, T = len(data["endo"]), data["periods"]
    data["piecewise"] = regular(data["piecewise"], T, n, name)
    data["linear"] = regular(data["linear"], T, n, name)
    data["binding"] = [int(v) for v in regular(data["binding"], 1, T, name)[0]]
    data["steady"] = regular(data["steady"], 1, n, name)[0]
    data["model"] = entry["file"]
    assert data["error_flag"] == 0, (name, "Dynare's OccBin reported an error")
    (OUT / f"{name}.occbin.json").write_text(json.dumps(data, separators=(",", ":")) + "\n")
    print(f"{name}: OccBin -> test/reference/{name}.occbin.json ({T} periods, binding in {sum(data['binding'])})")


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
            reference2(entry)
            if entry.get("occbin"):
                reference_occbin(entry)


if __name__ == "__main__":
    main()
