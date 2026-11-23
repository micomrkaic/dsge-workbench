/*
 * A growth model with irreversible investment.
 *
 * Investment cannot fall below a fraction phi of its steady-state level.
 * While the constraint is slack its Lagrange multiplier is zero; while it
 * binds, investment sits at the floor and the multiplier is positive. A run
 * of bad technology shocks takes investment to the floor, and consumption
 * has to give where investment cannot.
 *
 * The model block is the one in Dynare's example file Occbin_example.mod,
 * which follows an example by Luca Guerrieri and Matteo Iacoviello
 * (https://www.matteoiacoviello.com/research_files/occbin_20140630.zip).
 * That file has a second constraint as well (adjustment costs when
 * investment is below its steady state). For the DSGE workbench, which
 * simulates one occasionally binding constraint, only the irreversibility
 * constraint was kept, the three log variables were dropped with it, and
 * the surprise shocks were chosen for this model (modified 2026 by
 * Mico Mrkaic).
 *
 * Please note that the following copyright notice only applies to this Dynare
 * implementation of the model.
 */

/*
 * Copyright © 2021 Dynare Team
 *
 * This is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * It is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * For A copy of the GNU General Public License,
 * see <https://www.gnu.org/licenses/>.
 */

var A           $A$         (long_name='TFP')
    C           $C$         (long_name='consumption')
    Invest      $I$         (long_name='investment')
    K           $K$         (long_name='capital')
    Lambda      $\lambda$   (long_name='Lagrange multiplier')
    ;

varexo epsilon $\varepsilon$        (long_name='TFP shock');

parameters alpha    $\alpha$        (long_name='capital share')
        delta       $\delta$        (long_name='depreciation')
        beta        $\beta$         (long_name='discount factor')
        sigma       $\sigma$        (long_name='risk aversion')
        rho         $\rho$          (long_name='autocorrelation TFP')
        phi         $\phi$          (long_name='irreversibility fraction of steady state investment')
        ;

beta=0.96;
alpha=0.33;
delta=0.10;
sigma=2;
rho = 0.9;
phi = 0.975;

model;
[name='Euler']
-C^(-sigma) + beta*C(+1)^(-sigma)*(1-delta+alpha*exp(A(+1))*K^(alpha-1))= -Lambda+beta*(1-delta)*Lambda(+1);

[name='Budget constraint']
C+K-(1-delta)*K(-1)=exp(A)*K(-1)^(alpha);

[name='LOM capital']
Invest = K-(1-delta)*K(-1);

[name='investment',relax='IRR']
Lambda=0;
[name='investment',bind='IRR']
log(Invest) - log(phi*steady_state(Invest)) = 0;

[name='LOM TFP']
A = rho*A(-1)+epsilon;
end;

occbin_constraints;
name 'IRR'; bind log(Invest)-log(steady_state(Invest))<log(phi); relax Lambda<0;
end;

steady_state_model;
K = ((1/beta-1+delta)/alpha)^(1/(alpha-1));
C = -delta*K +K^alpha;
Invest = delta*K;
Lambda = 0;
A=0;
end;

shocks;
  var epsilon; stderr 0.015;
end;

steady;

shocks(surprise);
var epsilon;
periods 1:5, 10, 30, 31:36;
values -0.01, -0.02, 0.02, -0.015;
end;

occbin_setup;
occbin_solver(simul_periods=60,simul_check_ahead_periods=200);
