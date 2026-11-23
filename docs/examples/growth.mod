/*
 * The stochastic growth model.
 *
 * One good, one household that consumes and saves, capital that
 * depreciates, technology that follows an AR(1), and no choice of hours:
 * the smallest model with a decision in it. Its steady state has a closed
 * form, given in steady_state_model. It is the model that dsge.rbc()
 * returns in Cozy's dsge package.
 *
 * Written for the DSGE workbench. Copyright (C) 2026 Mico Mrkaic.
 * GPL-3.0-or-later.
 */

var y       (long_name='output')
    c       (long_name='consumption')
    i       (long_name='investment')
    k       (long_name='capital')
    a       (long_name='log technology');
varexo e    (long_name='technology shock');

parameters alpha    (long_name='capital share')
           beta     (long_name='discount factor')
           delta    (long_name='depreciation rate')
           rho      (long_name='persistence of technology')
           sigma    (long_name='risk aversion');

alpha = 0.33;
beta  = 0.99;
delta = 0.025;
rho   = 0.95;
sigma = 1;

model;
[name='Euler equation']
c^(-sigma) = beta * c(+1)^(-sigma) * (alpha * exp(a(+1)) * k^(alpha - 1) + 1 - delta);
[name='production function']
y = exp(a) * k(-1)^alpha;
[name='capital accumulation']
k = (1 - delta) * k(-1) + i;
[name='resource constraint']
y = c + i;
[name='technology']
a = rho * a(-1) + e;
end;

steady_state_model;
a = 0;
k = ((1 / beta - 1 + delta) / alpha)^(1 / (alpha - 1));
y = k^alpha;
i = delta * k;
c = y - i;
end;

shocks;
var e; stderr 0.01;
end;

stoch_simul(order = 1, irf = 40);
