/*
 * The three-equation New Keynesian model.
 *
 * Gali (2015), "Monetary Policy, Inflation, and the Business Cycle",
 * chapter 3: a Phillips curve, a dynamic IS curve and an interest-rate
 * rule, with a demand disturbance (the natural rate of interest) and a
 * monetary policy disturbance. Variables are percent deviations from a
 * zero-inflation steady state, at quarterly rates.
 *
 * The model has a unique stable solution exactly when
 *     kappa * (phi_pi - 1) + (1 - beta) * phi_x > 0,
 * the Taylor principle. Lower phi_pi below one to see it fail.
 *
 * Written for the DSGE workbench. Copyright (C) 2026 Mico Mrkaic.
 * GPL-3.0-or-later.
 */

var x       (long_name='output gap')
    pi      (long_name='inflation')
    i       (long_name='nominal interest rate')
    r       (long_name='real interest rate')
    rn      (long_name='natural rate of interest')
    v       (long_name='monetary policy disturbance');
varexo en   (long_name='demand shock')
       ev   (long_name='monetary policy shock');

parameters beta     (long_name='discount factor')
           sigma    (long_name='inverse elasticity of intertemporal substitution')
           kappa    (long_name='slope of the Phillips curve')
           phi_pi   (long_name='policy response to inflation')
           phi_x    (long_name='policy response to the output gap')
           rho_n    (long_name='persistence of demand disturbances')
           rho_v    (long_name='persistence of policy disturbances');

beta   = 0.99;
sigma  = 1;
kappa  = 0.1275;
phi_pi = 1.5;
phi_x  = 0.125;
rho_n  = 0.9;
rho_v  = 0.5;

model(linear);
[name='Phillips curve']
pi = beta * pi(+1) + kappa * x;
[name='IS curve']
x = x(+1) - (1 / sigma) * (i - pi(+1) - rn);
[name='interest-rate rule']
i = phi_pi * pi + phi_x * x + v;
[name='real rate']
r = i - pi(+1);
[name='natural rate']
rn = rho_n * rn(-1) + en;
[name='policy disturbance']
v = rho_v * v(-1) + ev;
end;

shocks;
var en; stderr 0.25;
var ev; stderr 0.25;
end;

stoch_simul(order = 1, irf = 20);
