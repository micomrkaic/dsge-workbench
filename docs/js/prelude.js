/* prelude.js — the workbench's own Cozy code, run once when the engine starts.
 *
 * The dsge package does the steady state, the linearisation and the
 * solution. These few functions sit on top of it: they return a verdict
 * instead of raising an error when a model has no unique stable solution,
 * and they compute moments in a way that copes with unit roots (a price
 * level, say), reporting those variables as having no variance instead of
 * refusing the whole model.
 *
 * Part of dsge-workbench. Copyright (C) 2026 Mico Mrkaic.
 * GPL-3.0-or-later; see LICENSE. */
export const PRELUDE = String.raw`
% wb_solve(m, p): linearise the model m at the parameter record p and solve
% it. code is 0 for a unique stable solution, 1 for indeterminacy (too few
% unstable roots), 2 for no stable solution (too many), 3 if the roots are
% right but no decision rule could be computed. P and Q are the rule
% y = P y(-1) + Q e in deviations from the steady state y.
let wb_solve = fn m, p -> (
  let L = dg_lin(m, p);
  let c = dg_core(L.A, L.B, L.C);
  let n = m.n;
  let code = if c.nstable == n then (if c.found then 0 else 3 end) elseif c.nstable > n then 1 else 2 end;
  let Q = if code == 0 then 0.0 - ((L.A * c.P + L.B) \ L.D) else zeros(n, m.k) end;
  % entries that are rounding error (1e-13 of the largest) are set to zero
  let P = pick(abs(c.P) < 1e-13 * max(abs(c.P)), 0.0, c.P);
  Q = pick(abs(Q) < 1e-13 * max(1e-300, max(abs(Q))), 0.0, Q);
  {code = code, y = L.y, P = P, Q = Q, roots = c.roots,
   counts = [sum(m.lead > 0), sum(m.lag > 0), c.nstable, n]}
)

% wb_shocks(Q, sd, R): the responses to one-standard-deviation innovations
% when the shocks have standard deviations sd and correlation matrix R.
% Correlated shocks are orthogonalised in the order they are declared (the
% Cholesky factor of their covariance), as Dynare does.
let wb_shocks = fn Q, sd, R -> Q * ((sd * ones(1, numel(sd))) .* chol(R))

% wb_cov(P, C): the unconditional covariance of y = P y(-1) + C u with
% var(u) = I, by doubling (S = W + P W P' + P^2 W P^2' + ...), and which
% variables have none because they carry a unit root. Each doubling adds
% the variance of twice as many periods. The share of a variable's variance
% that the latest doubling added goes to zero if the variable is
% stationary and to one half if it has a unit root; the loop stops when
% that share has stopped changing for every variable. It never runs past
% 2^34 periods, where rounding in a unit root would start to show, so a
% root within about 1e-9 of one counts as a unit root.
% Returns {S, unit}.
let wb_cov = fn P, C -> (
  let n = size(P)[1];
  let S = C * C'; let M = P; let it = 0; let moving = true;
  let share = zeros(n, 1);
  while moving && (it < 34) do (
    let dS = M * S * M';
    let now = diag(dS) ./ max(diag(S) + diag(dS), 1e-300);
    moving = (it < 2) || (max(abs(now - share)) > 1e-13);
    share = now;
    S = S + dS;
    M = M * M;
    it = it + 1
  ) end;
  {S = (S + S') / 2, unit = share > 1e-9}
)

% wb_moments(P, C, K): standard deviations, correlations and
% autocorrelations at lags 1..K. Variables with a unit root get nan.
let wb_moments = fn P, C, K -> (
  let n = size(P)[1];
  let v = wb_cov(P, C);
  let none = 0.0 / 0.0;
  let d = pick(v.unit, none, diag(v.S));
  let sd = sqrt(max(d, 0.0));                         % nan stays nan (Cozy 0.1.31 and later)
  let still = sd == 0.0;                              % a variable that never moves has no correlations
  let den = pick(still, none, sd) * pick(still, none, sd)';
  let ac = zeros(n, K);
  let G = v.S;
  for j = 1 : K do ( G = P * G; ac[:, j] = diag(G) ./ pick(still, none, d) ) end;
  {sd = sd, corr = v.S ./ den, acorr = ac}
)

% wb_vardecomp(P, C): the share of each variable's variance due to each
% innovation, in percent (rows sum to 100; nan for a unit root or a
% variable that never moves).
let wb_vardecomp = fn P, C -> (
  let n = size(P)[1]; let k = size(C)[2];
  let V = zeros(n, k);
  let bad = zeros(n, 1);                              % counts reasons a row has no decomposition
  for j = 1 : k do (
    let v = wb_cov(P, C[:, j]);
    V[:, j] = diag(v.S);
    bad = bad + pick(v.unit, 1.0, 0.0)
  ) end;
  let total = sum(V, 2);
  bad = bad + pick(total == 0.0, 1.0, 0.0);
  100 * V ./ (pick(bad > 0.0, 0.0 / 0.0, total) * ones(1, k))
)

% wb_irf(P, C, T): the responses of every variable to each innovation, T
% periods each, stacked: rows (j - 1) T + 1 .. j T belong to innovation j.
let wb_irf = fn P, C, T -> (
  let n = size(P)[1]; let k = size(C)[2];
  let Y = zeros(k * T, n);
  for j = 1 : k do (
    let y = C[:, j];
    for t = 1 : T do ( Y[(j - 1) * T + t, :] = y'; y = P * y ) end
  ) end;
  Y
)

% wb_simulate(P, C, T, seed): a simulated path of T periods in deviations
% from the steady state, starting there.
let wb_simulate = fn P, C, T, seed -> (
  rng(seed);
  let n = size(P)[1]; let k = size(C)[2];
  let Y = zeros(T, n);
  let y = zeros(n, 1);
  for t = 1 : T do ( y = P * y + C * randn(k, 1); Y[t, :] = y' ) end;
  Y
)
`;
