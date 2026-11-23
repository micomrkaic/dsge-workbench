/*
 * A real business cycle model with a choice of hours.
 *
 * Households choose consumption, saving and hours of work; firms rent
 * capital and labour; technology follows an AR(1). The model is written in
 * levels (technology in logs) and its steady state is found numerically
 * from the starting values in initval.
 *
 * Written for the DSGE workbench. Copyright (C) 2026 Mico Mrkaic.
 * GPL-3.0-or-later.
 */

var y       (long_name='output')
    c       (long_name='consumption')
    i       (long_name='investment')
    n       (long_name='hours worked')
    k       (long_name='capital')
    w       (long_name='real wage')
    r       (long_name='rental rate of capital')
    a       (long_name='log technology');
varexo e    (long_name='technology shock');

parameters alpha    (long_name='capital share')
           beta     (long_name='discount factor')
           delta    (long_name='depreciation rate')
           rho      (long_name='persistence of technology')
           sigma    (long_name='risk aversion')
           phi      (long_name='inverse Frisch elasticity')
           psi      (long_name='weight on the disutility of work');

alpha = 0.33;
beta  = 0.99;
delta = 0.025;
rho   = 0.95;
sigma = 1;
phi   = 1;
psi   = 8;

model;
[name='Euler equation']
c^(-sigma) = beta * c(+1)^(-sigma) * (r(+1) + 1 - delta);
[name='labour supply']
psi * n^phi * c^sigma = w;
[name='production function']
y = exp(a) * k(-1)^alpha * n^(1 - alpha);
[name='labour demand']
w = (1 - alpha) * y / n;
[name='capital demand']
r = alpha * y / k(-1);
[name='capital accumulation']
k = (1 - delta) * k(-1) + i;
[name='resource constraint']
y = c + i;
[name='technology']
a = rho * a(-1) + e;
end;

initval;
y = 1;
c = 0.75;
i = 0.25;
n = 0.33;
k = 10;
w = 2;
r = 0.035;
a = 0;
end;

shocks;
var e; stderr 0.007;
end;

stoch_simul(order = 1, irf = 40);
