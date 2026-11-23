/* prelude.js — the workbench's own Cozy code, run once when the engine starts.
 *
 * The dsge package does the steady state, the linearisation and the
 * solution. These few functions sit on top of it: they return a verdict
 * instead of raising an error when a model has no unique stable solution,
 * and they compute moments in a way that copes with unit roots (a price
 * level, say), reporting those variables as having no variance instead of
 * refusing the whole model. To second order the package gives the terms of
 * the decision rule (its internal dg_second, which takes the shocks'
 * covariance, so correlated shocks are covered) and the pruned path for a
 * given run of shocks (dg_path2); the means, the responses and the simulated
 * paths built on those are here.
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

% ---- second order -----------------------------------------------------------
% A second-order solution here is the record s2 = {model, ybar, P, Q, Gxx,
% Gxu, Guu, s2} that the package's dg_path2 reads, with the rule
%   y = ybar + P y(-1) + Q e + 1/2 [Gxx (x (x) x) + 2 Gxu (x (x) e) + Guu (e (x) e) + s2]
% and x the state variables (positions st) as they were last period. Ce is
% the k by k matrix that turns unit, uncorrelated innovations into the
% model's shocks (e = Ce u; its columns are the orthogonalised
% one-standard-deviation innovations), and C = Q Ce.

% wb_mean2(P, C, S, st, Gxx, Guu, s2): the unconditional means to second
% order, as deviations from the steady state. The rule's curvature turns the
% variance of the states and of the shocks (covariance S) into a constant,
% and the constant accumulates through P: the sum of P^j times it, taken by
% doubling. nan where there is no mean: a variable with a unit root, one
% whose curvature loads on a state with a unit root, and one in which the
% constant accumulates without bound.
let wb_mean2 = fn P, C, S, st, Gxx, Guu, s2 -> (
  let n = size(P)[1]; let nx = numel(st); let k = size(S)[1];
  let v = wb_cov(P, C);
  let ux = pick(v.unit[st, 1], 1.0, 0.0);
  let mask = reshape(1.0 - (1.0 - ux) * (1.0 - ux)', nx * nx, 1);    % pairs of states with a unit root in them
  let w = pick(mask > 0.5, 0.0, reshape(v.S[st, st], nx * nx, 1));
  let dep = (abs(Gxx) * mask) > 0.0;
  let mu = 0.5 * (Gxx * w + Guu * reshape(S, k * k, 1) + s2);
  let M = P; let it = 0; let moving = true;
  let share = zeros(n, 1);
  while moving && (it < 34) do (
    let d = M * mu;
    let now = abs(d) ./ max(abs(mu + d), 1e-300);
    moving = (it < 2) || (max(abs(now - share)) > 1e-13);
    share = now;
    mu = mu + d;
    M = M * M;
    it = it + 1
  ) end;
  let bad = pick(v.unit, 1.0, 0.0) + pick(dep, 1.0, 0.0) + pick(share > 1e-9, 1.0, 0.0);
  pick(bad > 0.5, 0.0 / 0.0, mu)
)

% wb_irf2(s2, Ce, T, z): the responses to second order of every variable to
% each innovation, z standard deviations of it at period 0 and no shocks
% after, stacked as wb_irf stacks them. A response is the path with the
% shock less the path without it; both start at the steady state and are
% pruned. To first order the response would be z times wb_irf's.
let wb_irf2 = fn s2, Ce, T, z -> (
  let n = s2.model.n; let k = size(Ce)[2]; let ke = size(Ce)[1];
  let Y = zeros(k * T, n);
  let base = dg_path2(s2, zeros(T, ke)).Y2;
  for j = 1 : k do (
    let E = zeros(T, ke);
    E[1, :] = (z * Ce[:, j])';
    let a = dg_path2(s2, E);
    Y[(j - 1) * T + 1 : j * T, :] = a.Y1 + a.Y2 - base
  ) end;
  Y
)

% wb_simulate2(s2, Ce, T, seed): a pruned simulated path to second order,
% from the steady state, for the same draws wb_simulate makes with that
% seed. T by 2n: the first-order part of the path, then the second-order
% correction; the path is their sum (deviations from the steady state).
let wb_simulate2 = fn s2, Ce, T, seed -> (
  rng(seed);
  let k = size(Ce)[2];
  let E = zeros(T, size(Ce)[1]);
  for t = 1 : T do ( E[t, :] = (Ce * randn(k, 1))' ) end;
  let r = dg_path2(s2, E);
  [r.Y1, r.Y2]
)
`;
