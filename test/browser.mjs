// browser.mjs — the workbench driven in a real browser.
//
//   python3 -m http.server -d docs 8767 &
//   node test/browser.mjs http://localhost:8767/ [screenshot-directory]
//
// Needs Playwright with Chromium (not part of `npm test`, which needs only
// node). Each check prints a line; the exit status is the number that failed.
import fs from "node:fs";
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");       // found wherever it is installed

const [url = "http://localhost:8767/", shots] = process.argv.slice(2);
let failed = 0;
const check = (ok, what, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`); if (!ok) failed++; };

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
const page = await context.newPage();
const errors = [];
page.on("pageerror", e => errors.push(e.message));
page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
const settled = () => page.waitForFunction(() => document.querySelector("#status .badge") && !document.querySelector("#status .badge.busy"), null, { timeout: 30000 });
const status = async () => (await page.textContent("#status")).replace(/\s+/g, " ").trim();
const tab = async name => { await page.click(`#tabs button:text-is("${name}")`); await page.waitForTimeout(250); };
const shot = async name => { if (shots) await page.screenshot({ path: `${shots}/${name}.png` }); };
const setParam = async (name, value) => { await page.fill(`.param:has(.param-name:text-is("${name}")) input[type=number]`, String(value)); await page.waitForTimeout(700); await settled(); };

await page.goto(url);
await settled();
await page.evaluate(() => localStorage.clear());
await page.reload();
await settled();
check(/Unique stable solution/.test(await status()), "the first example solves on arrival", await status());
check(await page.$eval("#example", e => e.value) === "rbc.mod", "the example menu shows what is loaded");

// --- every tab draws something
for (const [name, selector] of [["Summary", ".verdict.good"], ["Impulse responses", ".multiples svg.chart"], ["Moments", "svg.heat"], ["Variance", "table.grid"], ["Simulation", "svg.chart"], ["Decision rule", "table.grid"], ["Cozy script", "pre.source"]]) {
  await tab(name);
  await page.waitForSelector(`#view ${selector}`, { timeout: 5000 }).catch(() => {});
  check(!!(await page.$(`#view ${selector}`)), `the ${name} tab draws`);
}

// --- a parameter moves the results; a baseline can be pinned
await tab("Impulse responses");
const firstPath = () => page.$eval("#view .card svg path.line:last-of-type", p => p.getAttribute("d"));
const before = await firstPath();
await page.click('button:text-is("Pin as baseline")');
await setParam("rho", 0.5);
const after = await firstPath();
check(before !== after, "moving rho changes the impulse responses");
check((await page.$$("#view .card:first-child path.line")).length === 2, "the pinned baseline stays on the chart beside the new response");
check(await page.$eval('.param:has(.param-name:text-is("rho"))', e => e.classList.contains("changed")), "a moved parameter is marked");
await shot("irf-pinned");
// hovering a chart gives a readout for both lines
const card = await page.$("#view .card svg");
const box = await card.boundingBox();
await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
await page.waitForTimeout(150);
const tip = await page.textContent(".tip");
check(/period/.test(tip) && /pinned/.test(tip) && /now/.test(tip), "hovering a chart shows the period and both values", tip.replace(/\s+/g, " ").slice(0, 80));
await shot("irf-hover");
await page.mouse.move(5, 5);
await page.click("#reset");
await page.waitForTimeout(600); await settled();
check(await firstPath() === before, "Reset puts the model's own values back");

// --- the table view and the units switch
await page.click('#view button:text-is("Table")');
check((await page.$$("#view table.grid tbody tr")).length === 40, "the table view lists every period");
await page.click('#view button:text-is("Table")');
await page.click('#view button:text-is("% of steady state")');
check(/% of steady state/.test(await page.textContent("#view .card .sub")), "responses can be shown in percent of the steady state");
await page.click('#view button:text-is("Deviation")');

// --- downloads
const grab = async (trigger, what, test) => {
  const [d] = await Promise.all([page.waitForEvent("download", { timeout: 8000 }), trigger()]);
  const body = fs.readFileSync(await d.path());
  check(test(body, d.suggestedFilename()), what, `${d.suggestedFilename()}, ${body.length} bytes`);
};
await grab(() => page.click('#view button:text-is("CSV")'), "impulse responses download as CSV", (b, n) => n.endsWith(".csv") && b.toString().split("\n").length === 42 && b.toString().startsWith("period,y,c"));
await grab(() => page.click('#view button:text-is("SVG")'), "the figure downloads as SVG with its colours written in", (b, n) => n.endsWith(".svg") && /<svg/.test(b) && !/var\(--/.test(b.toString()) && /stroke: ?(#|rgb)/.test(b.toString()));
await grab(() => page.click('#view button:text-is("PNG")'), "the figure downloads as PNG", b => b.slice(1, 4).toString() === "PNG" && b.length > 5000);
await grab(() => page.click("#save"), "the model saves as a .mod file", (b, n) => n === "rbc.mod" && /model;/.test(b));
await tab("Cozy script");
await grab(() => page.click('#view button:text-is("Download")'), "the Cozy script downloads", (b, n) => n.endsWith(".cz") && /dsge\.model/.test(b));

// --- the Taylor principle
await page.selectOption("#example", "nk.mod");
await page.waitForTimeout(600); await settled();
await tab("Summary");
check(/Unique stable solution/.test(await status()), "the New Keynesian example solves");
await setParam("phi_pi", 0.9);
check(/Indeterminate/.test(await status()) && /1 unstable root for 2 forward-looking/.test(await status()), "phi_pi = 0.9 is reported as indeterminate", await status());
check(!!(await page.$("#view .verdict.bad")), "the summary explains the failed Blanchard–Kahn condition");
await shot("indeterminate");
await tab("Impulse responses");
check(/no unique stable solution/.test(await page.textContent("#view")), "with no solution the other tabs say so instead of showing stale results");
await setParam("phi_pi", 1.5);
check(/Unique stable solution/.test(await status()), "raising phi_pi restores the solution");

// --- errors in the text
await page.click("#text");
await page.keyboard.press("Control+End");
await page.keyboard.type("\nmodel; x = ; end;\n");
await page.waitForTimeout(900);
check(/The model has errors/.test(await status()), "an error in the text is reported", await status());
check((await page.$$("#messages .msg.error")).length >= 1 && (await page.$$("#gutter .err")).length >= 1, "the error is listed with its line and marked in the margin");
await shot("error");
await page.click("#messages .msg.error button.where");
check(await page.evaluate(() => document.activeElement.id === "text" && document.activeElement.selectionEnd > document.activeElement.selectionStart), "clicking the line number selects that line");
for (let i = 0; i < 20; i++) await page.keyboard.press("Control+z");
await page.selectOption("#example", "example1.mod");
await page.waitForTimeout(600); await settled();
check(/Unique stable solution/.test(await status()), "choosing an example replaces the broken text");

// --- a link carries the model and what was moved
await setParam("rho", 0.8);
await page.click("#share");
await page.waitForTimeout(400);
const link = page.url();
check(/#z=/.test(link), "Copy link puts the model in the address", `${link.length} characters`);
const second = await context.newPage();
await second.goto(link);
await second.waitForFunction(() => document.querySelector("#status .badge.good"), null, { timeout: 30000 });
check(await second.inputValue('.param:has(.param-name:text-is("rho")) input[type=number]') === "0.8", "opening the link restores the model and the moved parameter");
await second.close();

// --- second order
await page.selectOption("#example", "growth.mod");
await page.waitForTimeout(600); await settled();
await page.click('#status .order button:text-is("2nd order")');
await page.waitForTimeout(500); await settled();
check(/second order, solved in/.test(await status()) && await page.$eval('#status .order button.on', e => e.textContent) === "2nd order", "the order switch solves the model to second order", await status());
await tab("Summary");
check(/Mean, second order/.test(await page.textContent("#view table.grid thead")), "the summary sets the second-order mean beside the steady state");
const kRow = await page.$$eval("#view table.grid tbody tr", rows => rows.map(r => [...r.cells].map(c => c.textContent)).find(c => c[0] === "k"));
check(kRow && parseFloat(kRow[4]) > 0, "risk raises mean capital", kRow ? kRow.join(" | ") : "");
await tab("Impulse responses");
check(/second order/.test(await page.textContent("#view .legend")) && /first order/.test(await page.textContent("#view .legend")), "responses are drawn to second order against the first-order ones");
const cPath = () => page.$eval('.card[data-name="c"] svg.chart', s => [...s.querySelectorAll("path")].map(p => p.getAttribute("d")).join(" "));
const atOne = await cPath();
await page.fill('input[aria-label="Shock size in standard deviations"]', "-8");
await page.keyboard.press("Tab");
await page.waitForTimeout(600); await settled();
check(await cPath() !== atOne && /innovation of −?-?8 standard deviations/.test(await page.textContent("#view .foot")), "the size and sign of the shock can be chosen", (await page.textContent("#view .foot")).slice(0, 90));
await shot("second-order-irf");
await tab("Moments");
check(/Steady state/.test(await page.textContent("#view table.grid thead")) && /The mean is to second order/.test(await page.textContent("#view")), "the moments report the second-order mean and say what the variances are");
await tab("Simulation");
await page.waitForTimeout(500);
const simPath = () => page.$eval("#view svg.chart", s => [...s.querySelectorAll("path")].map(p => p.getAttribute("d")).join(" "));
const total = await simPath();
await page.click('#view .seg button:text-is("Difference")');
await page.waitForTimeout(500);
check(await simPath() !== total && /second-order path less the first-order path/.test(await page.textContent("#view .foot")), "the simulation shows the pruned path, the first-order path, or their difference");
await page.click('#view .seg button:text-is("Second order")');
await page.waitForTimeout(300);
await tab("Decision rule");
check(/Second-order terms/.test(await page.textContent("#view")) && (await page.$$eval("#view table.grid", t => t.length)) === 2 &&
  /k\(-1\) × a\(-1\)/.test(await page.textContent("#view")) && /Risk/.test(await page.textContent("#view")), "the decision rule lists the second-order terms, each product once");
await grab(() => page.click('#view h3 ~ .bar button:text-is("CSV")'), "the second-order terms download as CSV", (b, n) => n === "growth-decision-rule-second-order.csv" && /e × e/.test(b));
await tab("Cozy script");
check(/dsge\.solve2\(m\)/.test(await page.textContent("#view pre.source")), "the Cozy script solves to second order too");
await page.click("#share");
await page.waitForTimeout(400);
const link2 = page.url();
const third = await context.newPage();
await third.goto(link2);
await third.waitForFunction(() => document.querySelector("#status .badge.good"), null, { timeout: 30000 });
check(await third.$eval('#status .order button.on', e => e.textContent) === "2nd order", "a link carries the order of approximation");
await third.close();
await page.selectOption("#example", "nk.mod");
await page.waitForTimeout(600); await settled();
check(await page.$eval('#status .order button:text-is("2nd order")', e => e.disabled) && !/second order/.test(await status()), "a model declared linear stays at first order, and the switch says why");
await page.selectOption("#example", "NK_baseline.mod");
await page.waitForTimeout(1200); await settled();
check(/Unique stable solution/.test(await status()) && /second order, solved in/.test(await status()), "the 28-variable model solves to second order", await status());
await page.click('#status .order button:text-is("1st order")');
await page.waitForTimeout(500); await settled();
check(!/second order/.test(await status()), "... and back to first");

// --- an occasionally binding constraint
check(!(await page.$$eval("#tabs button", bs => bs.map(b => b.textContent))).includes("Constraint"), "a model without a constraint has no Constraint tab");
await page.selectOption("#example", "zlb.mod");
await page.waitForTimeout(700); await settled();
check((await page.$$eval("#tabs button", bs => bs.map(b => b.textContent))).includes("Constraint") && /Unique stable solution/.test(await status()), "a model that declares one gets the tab, and is solved with the constraint slack");
await tab("Summary");
check(/Constraints/.test(await page.textContent("#view .tiles")), "the summary counts the constraint");
await tab("Constraint");
await page.waitForSelector("#view .multiples svg.chart", { timeout: 15000 }).catch(() => {});
const constraintText = async () => (await page.textContent("#view")).replace(/\s+/g, " ");
check(/Constraint 'zlb' binds when inot < 0 and is released when inot > 0/.test(await constraintText()), "the tab states the constraint's two conditions", (await constraintText()).slice(0, 90));
check(/binds in 5 of 40 periods/.test(await constraintText()) && /Periods 1–5/.test(await constraintText()), "the file's surprise shocks are simulated: the periods in which it binds are named");
check((await page.$$('.card[data-name="i"] svg.chart rect.bind')).length === 1 && (await page.$$('.card[data-name="i"] svg.chart path.line')).length === 2, "each chart shades the binding periods under the two paths");
await shot("constraint");
await page.click('#view .seg button:text-is("One shock")');
await page.waitForTimeout(600);
check(/binds in/.test(await constraintText()) && /innovation of −?-?3 standard deviations in en in period 1/.test(await constraintText()), "one shock of a chosen size can be simulated instead");
await page.fill('#view input[aria-label="Shock size in standard deviations"]', "0.5");
await page.keyboard.press("Tab");
await page.waitForTimeout(600);
check(/The constraint never binds/.test(await constraintText()) && (await page.$$("#view svg.chart rect.bind")).length === 0, "a shock the other way never reaches the floor, and the tab says so");
await page.fill('#view input[aria-label="Shock size in standard deviations"]', "-4");
await page.keyboard.press("Tab");
await page.waitForTimeout(600);
const boundAt = async () => Number(/binds in (\d+) of/.exec(await constraintText())[1]);
const boundBefore = await boundAt();
await setParam("phi_pi", 3);
await page.waitForTimeout(500);
check(await boundAt() < boundBefore, "moving a parameter re-runs the simulation: a rule that reacts more leaves the floor sooner", `${boundBefore} periods, then ${await boundAt()}`);
await page.click('#view .bar button:text-is("Table")');
await page.waitForTimeout(300);
check(/Binds/.test(await page.textContent("#view table.grid thead")) && (await page.$$("#view table.grid tbody tr")).length === 40, "the numbers can be shown as a table");
await grab(() => page.click('#view .bar button:text-is("CSV")'), "the two paths download as CSV", (b, n) => n === "zlb-constraint.csv" && /period,binding,x,x \(ignoring the constraint\)/.test(b));
await page.click('#view .bar button:text-is("Table")');
await tab("Cozy script");
check(/dsge\.occbin\(m, alt,/.test(await page.textContent("#view pre.source")), "the Cozy script reproduces the simulation");
await page.click("#reset");
await page.waitForTimeout(500); await settled();
await page.selectOption("#example", "irreversible.mod");
await page.waitForTimeout(800); await settled();
await tab("Constraint");
await page.waitForSelector("#view .multiples svg.chart", { timeout: 15000 }).catch(() => {});
check(/Constraint 'IRR' binds when log\(Invest\) - log\(steady_state\(Invest\)\) < log\(phi\)/.test(await constraintText()) && /binds in 45 of 60 periods/.test(await constraintText()),
  "a nonlinear model with a multiplier is simulated too, its conditions shown as written", (await constraintText()).slice(0, 110));
await tab("Summary");

// --- a large model, and a file opened from disk
await page.selectOption("#example", "Smets_Wouters_2007.mod");
await page.waitForTimeout(800); await settled();
check(/12 unstable roots for 12 forward-looking/.test(await status()), "Smets and Wouters (2007) solves", await status());
await tab("Variance");
check((await page.$$("#view svg.chart rect.seg")).length > 30, "its variance decomposition is drawn");
await shot("smets-wouters-variance");
await page.selectOption("#example", "NK_baseline.mod");
await page.waitForTimeout(800); await settled();
check(/Unique stable solution/.test(await status()) && (await page.$$(".param")).length === 33, "the 28-variable New Keynesian model solves, with sliders for its 28 free parameters and 5 shocks", await status());
await page.fill('.param:has(.param-name:text-is("betta")) input[type=number]', "0.9");
await page.waitForTimeout(600); await settled();
check(/Unique stable solution/.test(await status()), "... and again after a parameter is typed far from its value: the starting values follow", await status());
await page.selectOption("#example", "growth.mod");
await page.waitForTimeout(600); await settled();
check(/Unique stable solution/.test(await status()), "the growth model solves", await status());
await page.setInputFiles("#file", { name: "mine.mod", mimeType: "text/plain", buffer: Buffer.from("var x; varexo e; parameters rho; rho = 0.7;\nmodel; x = rho * x(-1) + e; end;\nshocks; var e; stderr 1; end;\n") });
await page.waitForTimeout(600); await settled();
check(/Unique stable solution/.test(await status()) && /3 lines|4 lines/.test(await page.textContent("#model-size")), "a .mod file opened from disk is solved");

// --- the theme switch, the about box, a narrow screen
await page.click("#theme");
check(await page.evaluate(() => document.documentElement.dataset.theme) === "dark" && await page.evaluate(() => getComputedStyle(document.body).backgroundColor) === "rgb(13, 13, 13)", "the theme switch turns the page dark");
await page.click("#theme");
await page.click("#about-open");
await page.waitForSelector("#validation tbody tr");
check((await page.$$("#validation tbody tr")).length === 10, "the about box lists the ten models checked against Dynare");
await shot("about");
await page.click("#about form button");
await page.setViewportSize({ width: 390, height: 800 });
await page.selectOption("#example", "nk.mod");
await page.waitForTimeout(600); await settled();
check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "on a phone-width screen nothing overflows sideways");
await shot("narrow");

check(errors.length === 0, "no script errors in the page", errors.join(" | ").slice(0, 300));
await browser.close();
console.log(failed ? `${failed} check(s) failed` : "all browser checks passed");
process.exit(failed);
