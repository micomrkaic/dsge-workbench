/*
 * The New Keynesian model at the zero lower bound.
 *
 * The three equations of the textbook model, with interest rates in levels
 * (percent per quarter): a Phillips curve, an IS curve, and a central bank
 * that follows a Taylor rule unless the rule would take the policy rate
 * below zero. The natural rate of interest is the only disturbance. When it
 * falls far enough the rule asks for a negative rate, the bank cannot
 * deliver it, and the recession is deeper and longer than the linear model
 * says.
 *
 * The floor is an occasionally binding constraint, written the way Dynare
 * writes them: the two versions of the policy equation are tagged relax
 * (the rule is followed) and bind (the rate is at zero), and the
 * occbin_constraints block says when to move from one to the other. The
 * Constraint tab simulates it by the piecewise-linear method of Guerrieri
 * and Iacoviello (2015).
 *
 * Written for the DSGE workbench. Copyright (C) 2026 Mico Mrkaic.
 * GPL-3.0-or-later.
 */

var x       (long_name='output gap')
    pi      (long_name='inflation')
    i       (long_name='policy rate')
    inot    (long_name='rate the rule asks for')
    rn      (long_name='natural rate of interest');
varexo en   (long_name='natural-rate shock');

parameters beta     (long_name='discount factor')
           sigma    (long_name='risk aversion')
           kappa    (long_name='slope of the Phillips curve')
           phi_pi   (long_name='response to inflation')
           phi_x    (long_name='response to the output gap')
           rho_n    (long_name='persistence of the natural rate')
           rbar     (long_name='steady-state interest rate');

beta   = 0.99;
sigma  = 1;
kappa  = 0.1275;
phi_pi = 1.5;
phi_x  = 0.125;
rho_n  = 0.8;
rbar   = 1;

model(linear);
[name='Phillips curve']
pi = beta * pi(+1) + kappa * x;
[name='IS curve']
x = x(+1) - (1 / sigma) * (i - pi(+1) - rn);
[name='Taylor rule']
inot = rbar + phi_pi * pi + phi_x * x;
[name='policy rate', relax='zlb']
i = inot;
[name='policy rate', bind='zlb']
i = 0;
[name='natural rate']
rn = (1 - rho_n) * rbar + rho_n * rn(-1) + en;
end;

occbin_constraints;
name 'zlb'; bind inot < 0; relax inot > 0;
end;

steady_state_model;
x = 0;
pi = 0;
rn = rbar;
inot = rbar;
i = rbar;
end;

shocks;
var en; stderr 0.5;
end;

// the natural rate falls below zero, a little further the quarter after, and later jumps back up
shocks(surprise);
var en;
periods 1, 2, 14;
values -1.6, -0.4, 1;
end;

occbin_setup;
occbin_solver(simul_periods = 40, simul_check_ahead_periods = 100);
