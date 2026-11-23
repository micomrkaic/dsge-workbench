/*
 * The baseline New Keynesian model of Jesús Fernández-Villaverde and Juan
 * F. Rubio-Ramírez (2006): "A Baseline DSGE Model", at the parameter
 * values estimated in Jesús Fernández-Villaverde (2010): "The econometrics
 * of DSGE models", SERIEs, Vol. 1, pp. 3-49: 28 variables and 5 shocks,
 * sticky prices and wages with indexation, habits, investment adjustment
 * costs, variable capital utilisation and trend growth, written in its
 * nonlinear, detrended form.
 *
 * The declarations and the model block are those of Dynare's example file
 * NK_baseline.mod, written by Benjamin Born and Johannes Pfeifer. That
 * file takes four parameters and the steady state from a separate MATLAB
 * file, NK_baseline_steadystate.m. For the DSGE workbench the two were
 * made into one file that needs nothing else (modified 2026 by
 * Mico Mrkaic):
 *
 *   - the four parameters (LambdaYd, Lambdax, gammma1, Rbar) are defined
 *     from the others, below the calibration;
 *   - the steady state is an initval block that repeats the formulas of
 *     the steady-state file. The one equation that file solves numerically,
 *     for labour, has a closed form when the fixed cost Phi is zero, as it
 *     is here; with another Phi the block is a starting point and the
 *     steady state is found from it by Newton's method.
 *
 * The model is written in the beginning of period stock notation. To make the model
 * conform with Dynare's end of period stock notation, it uses the
 * predetermined_variables-command.
 *
 * The model has been implemented in detrended form, i.e. the \mu_{i,t} are actually
 * the the growth rates of the original \mu_{i,t}^{orig} in the paper, i.e.
 *  log(\mu_{i,t})=log(\mu_{i,t}^{orig}/\mu_{i,t-1}^{orig})
 *
 * Please note that the following copyright notice only applies to this Dynare
 * implementation of the model.
 */

/*
 * Copyright © 2013-2023 Dynare Team
 *
 * This file is part of Dynare.
 *
 * Dynare is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * Dynare is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with Dynare.  If not, see <https://www.gnu.org/licenses/>.
 */

var d       (long_name='preference shock')
    c       (long_name='consumption')
    mu_z    (long_name='trend growth rate of the economy (from neutral and investment specific technology)')
    mu_I    (long_name='growth rate of investment-specific technology growth')
    mu_A    (long_name='growth rate of neutral technology')
    lambda  (long_name='Lagrange multiplier')
    R       (long_name='Nominal Interest rate')
    PI      (long_name='Inflation')
    r       (long_name='rental rate of capital')
    x       (long_name='investment')
    u       (long_name='capacity utilization')
    q       (long_name='Tobin marginal q')
    f       (long_name='variable for recursive formulation of wage setting')
    ld      (long_name='aggregate labor demand')
    w       (long_name='real wage')
    wstar   (long_name='optimal real wage')
    PIstarw (long_name='optimal wage inflation')
    PIstar  (long_name='optimal price inflation')
    g1      (long_name='variable 1 for recursive formulation of price setting')
    g2      (long_name='variable 2 for recursive formulation of price setting')
    yd      (long_name='aggregate output')
    mc      (long_name='marginal costs')
    k       (long_name='capital')
    vp      (long_name='price dispersion term')
    vw      (long_name='wage dispersion term')
    l       (long_name='aggregate labor bundle')
    phi     (long_name='labor disutility shock')
    F       (long_name='firm profits')
    ;

varexo epsd (long_name='Innovation preference shock')
    epsphi  (long_name='Innovation labor disutility shock')
    epsmu_I (long_name='Innovation investment-specific technology')
    epsA    (long_name='Innovation neutral technology')
    epsm    (long_name='Innovation monetary policy shock')
    ;

predetermined_variables k;

parameters h            (long_name='consumption habits')
           betta        (long_name='discount factor')
           gammma1      (long_name='capital utilization, linear term')
           gammma2      (long_name='capital utilization, quadratic term')
           delta        (long_name='depreciation rate')
           kappa        (long_name='capital adjustment costs parameter')
           eta          (long_name='elasticity of substitution between labor varieties')
           epsilon      (long_name='elasticity of substitution between goods varieties')
           varpsi       (long_name='labor disutility parameter')
           gammma       (long_name='inverse Frisch elasticity')
           chiw         (long_name='wage indexation parameter')
           chi          (long_name='price indexation')
           thetap       (long_name='Calvo parameter prices')
           thetaw       (long_name='Calvo parameter wages')
           alppha       (long_name='capital share')
           Rbar         (long_name='steady state interest rate')
           PIbar        (long_name='steady state inflation')
           gammmaR      (long_name='interest smoothing coefficient Taylor rule')
           gammmaPI     (long_name='feedback coefficient to inflation monetary policy rule')
           gammmay      (long_name='feedback coefficient to output growth deviation in monetary policy rule')
           Phi          (long_name='firms fixed costs')
           rhod         (long_name='autocorrelation preference shock')
           rhophi       (long_name='autocorrelation labor disutility shock')
           Lambdamu  	(long_name='steady state growth rate of investmentment-specific technology')
           LambdaA      (long_name='steady state neutral technology growth')
           Lambdax      (long_name='steady state growth rate of investment')
           LambdaYd     (long_name='steady state growth rate of output')
           sigma_d      (long_name='standard deviation preference shock')
           sigma_phi    (long_name='standard deviation labor disutility shock')
           sigma_mu     (long_name='standard deviation investment-specific technology')
           sigma_A      (long_name='standard deviation neutral technology')
           sigma_m      (long_name='standard deviation monetary policy shock')
            ;

//Note that the parameter naming in FV(2010) differs from FV(2006)
//Fixed parameters, taken from FV(2010), Table 2, p. 37
delta=0.025;
epsilon=10;
eta= 10;
Phi=0;
gammma2=0.001;

//Estimated parameters, taken from FV(2010), Table 3, p. 38, median estimate parameters

betta =0.998;
h=0.97;
varpsi =8.92;
gammma = 1.17;
kappa =9.51;
alppha =0.21;

thetap =0.82;
chi = 0.63;
thetaw =0.68;
chiw =0.62;
gammmaR =0.77;
gammmay =0.19;

gammmaPI =1.29;
PIbar = 1.01;
rhod  = 0.12;
rhophi = 0.93;
sigma_A =  exp(-3.97);
sigma_d = exp(-1.51);

sigma_phi =exp(-2.36);
sigma_mu =exp(-5.43);
sigma_m  =exp(-5.85);
Lambdamu=3.4e-3;
LambdaA = 2.8e-3;


/*
The following parameters depend on other parameters. Dynare's example sets
them in its steady-state file; here they are defined from the others, so
that they follow when one of those is changed.
*/
LambdaYd = (LambdaA+alppha*Lambdamu)/(1-alppha);
Lambdax = exp(LambdaYd);
gammma1 = exp(LambdaYd)*exp(Lambdamu)/betta-(1-delta);
Rbar = 1+(PIbar*exp(LambdaYd)/betta-1);



/*
The following model equations are the stationary model equations, taken from
FV(2006), p. 20, section 3.2.
*/

model;
[name='FOC consumption']
d*(c-h*c(-1)*mu_z^(-1))^(-1)-h*betta*d(+1)*(c(+1)*mu_z(+1)-h*c)^(-1)=lambda;
[name='Euler equation']
lambda=betta*lambda(+1)*mu_z(+1)^(-1)/PI(+1)*R;
[name='FOC capital utilization']
r=gammma1+gammma2*(u-1);
[name='FOC capital']
q=betta*lambda(+1)/lambda*mu_z(+1)^(-1)*mu_I(+1)^(-1)*((1-delta)*q(+1)+r(+1)*u(+1)-(gammma1*(u(+1)-1)+gammma2/2*(u(+1)-1)^2));
[name='FOC investment']
1=q*(1-(kappa/2*(x/x(-1)*mu_z-Lambdax)^2)-(kappa*(x/x(-1)*mu_z-Lambdax)*x/x(-1)*mu_z))
  +betta*q(+1)*lambda(+1)/lambda*mu_z(+1)^(-1)*kappa*(x(+1)/x*mu_z(+1)-Lambdax)*(x(+1)/x*mu_z(+1))^2;
[name='Wage setting 1']
f=(eta-1)/eta*wstar^(1-eta)*lambda*w^eta*ld+betta*thetaw*(PI^chiw/PI(+1))^(1-eta)*(wstar(+1)/wstar*mu_z(+1))^(eta-1)*f(+1);
[name='Wage setting 2']
f=varpsi*d*phi*PIstarw^(-eta*(1+gammma))*ld^(1+gammma)+betta*thetaw*(PI^chiw/PI(+1))^(-eta*(1+gammma))*(wstar(+1)/wstar*mu_z(+1))^(eta*(1+gammma))*f(+1);

[name='Firm price setting 1']
g1=lambda*mc*yd+betta*thetap*(PI^chi/PI(+1))^(-epsilon)*g1(+1);
[name='Firm price setting 2']
g2=lambda*PIstar*yd+betta*thetap*(PI^chi/PI(+1))^(1-epsilon)*PIstar/PIstar(+1)*g2(+1);
[name='Firm price setting 3']
epsilon*g1=(epsilon-1)*g2;
[name='Optimal capital labor ratio']
u*k/ld=alppha/(1-alppha)*w/r*mu_z*mu_I;
[name='Marginal costs']
mc=(1/(1-alppha))^(1-alppha)*(1/alppha)^alppha*w^(1-alppha)*r^alppha;
[name='law of motion wages']
1=thetaw*(PI(-1)^chiw/PI)^(1-eta)*(w(-1)/w*mu_z^(-1))^(1-eta)+(1-thetaw)*PIstarw^(1-eta);
[name='law of motion prices']
1=thetap*(PI(-1)^chi/PI)^(1-epsilon)+(1-thetap)*PIstar^(1-epsilon);

[name='Taylor Rule']
R/Rbar=(R(-1)/Rbar)^gammmaR*((PI/PIbar)^gammmaPI*((yd/yd(-1)*mu_z)/exp(LambdaYd))^gammmay)^(1-gammmaR)*exp(sigma_m*epsm);

[name='Resource constraint']
yd=c+x+mu_z^(-1)*mu_I^(-1)*(gammma1*(u-1)+gammma2/2*(u-1)^2)*k;
[name='Aggregate production']
yd=(mu_A*mu_z^(-1)*(u*k)^alppha*ld^(1-alppha)-Phi)/vp;
[name='Aggregate labor market']
l=vw*ld;
[name='LOM Price dispersion term']
vp=thetap*(PI(-1)^chi/PI)^(-epsilon)*vp(-1)+(1-thetap)*PIstar^(-epsilon);
[name='LOM Wage dispersion term']
vw=thetaw*(w(-1)/w*mu_z^(-1)*PI(-1)^chiw/PI)^(-eta)*vw(-1)+(1-thetaw)*(PIstarw)^(-eta);
[name='Law of motion for capital']
k(+1)*mu_z*mu_I-(1-delta)*k-mu_z*mu_I*(1-kappa/2*(x/x(-1)*mu_z-Lambdax)^2)*x=0;
[name='Profits']
F=yd-1/(1-alppha)*w*ld;
[name='definition optimal wage inflation']
PIstarw=wstar/w;

//exogenous processes
[name='Preference Shock']
log(d)=rhod*log(d(-1))+sigma_d*epsd;
[name='Labor disutility Shock']
log(phi)=rhophi*log(phi(-1))+sigma_phi*epsphi;
[name='Investment specific technology']
log(mu_I)=Lambdamu+sigma_mu*epsmu_I;
[name='Neutral technology']
log(mu_A)=LambdaA+sigma_A*epsA;
[name='Defininition composite technology']
mu_z=mu_A^(1/(1-alppha))*mu_I^(alppha/(1-alppha));

end;

/*
The steady state, following FVRR (2006), section 4.1, and the steady-state
file of Dynare's example. Each line may use the lines above it.
*/
initval;
PI=PIbar;
u=1;
q=1;
d=1;
phi=1;
mu_z=exp(LambdaYd);
mu_I=exp(Lambdamu);
mu_A=exp(LambdaA);
r=gammma1;
R=1+(PI*mu_z/betta-1);
PIstar=((1-thetap*PI^(-(1-epsilon)*(1-chi)))/(1-thetap))^(1/(1-epsilon));
PIstarw=((1-thetaw*PI^(-(1-chiw)*(1-eta))*mu_z^(-(1-eta)))/(1-thetaw))^(1/(1-eta));
mc=(epsilon-1)/epsilon*(1-betta*thetap*PI^((1-chi)*epsilon))/(1-betta*thetap*PI^(-(1-epsilon)*(1-chi)))*PIstar;
w=(1-alppha)*(mc*(alppha/r)^alppha)^(1/(1-alppha));
wstar=w*PIstarw;
vp=(1-thetap)/(1-thetap*PI^((1-chi)*epsilon))*PIstar^(-epsilon);
vw=(1-thetaw)/(1-thetaw*PI^((1-chiw)*eta)*mu_z^eta)*PIstarw^(-eta);
// labour: the solution of the steady-state file's equation when Phi=0
ld=((eta-1)/eta*wstar/(varpsi*PIstarw^(-eta*gammma))*((1-h*mu_z^(-1))^(-1)-betta*h*(mu_z-h)^(-1))
    /(mu_A*mu_z^(-1)*vp^(-1)*(alppha/(1-alppha)*w/r*mu_z*mu_I)^alppha-(alppha/(1-alppha)*w/r*mu_z*mu_I)*(1-(1-delta)*(mu_z*mu_I)^(-1)))
    *(1-betta*thetaw*mu_z^(eta*(1+gammma))*PI^(eta*(1-chiw)*(1+gammma)))/(1-betta*thetaw*mu_z^(eta-1)*PI^(-(1-chiw)*(1-eta))))^(1/(1+gammma));
l=vw*ld;
k=alppha/(1-alppha)*w/r*mu_z*mu_I*ld;
x=(1-(1-delta)*(mu_z*mu_I)^(-1))*k;
yd=(mu_A/mu_z*k^alppha*ld^(1-alppha)-Phi)/vp;
c=yd-x;
lambda=(1-h*betta*mu_z^(-1))*(1-h/mu_z)^(-1)/c;
F=yd-1/(1-alppha)*w*ld;
f=(eta-1)/eta*wstar*PIstarw^(-eta)*lambda*ld/(1-betta*thetaw*mu_z^(eta-1)*PI^(-(1-chiw)*(1-eta)));
g1=lambda*mc*yd/(1-betta*thetap*PI^((1-chi)*epsilon));
g2=epsilon/(epsilon-1)*g1;
end;

shocks;
var epsd; stderr 1;
var epsphi; stderr 1;
var epsmu_I; stderr 1;
var epsA; stderr 1;
var epsm; stderr 1;
end;

steady;
check;

stoch_simul(order=1,irf=20) yd c R PI;
