/* app.js — the DSGE workbench's page.
 *
 * The page keeps one model at a time. When its text changes it is read
 * again (modfile.js) and compiled by Cozy (solve.js, through the worker in
 * engine.js); when a parameter moves it is only solved again. Every solve
 * replaces the results, and the open tab is redrawn from them.
 *
 * Part of dsge-workbench. Copyright (C) 2026 Mico Mrkaic.
 * GPL-3.0-or-later; see LICENSE. */
import { parseMod } from "./modfile.js";
import { Workbench, standaloneScript } from "./solve.js";
import { EngineClient } from "./engine.js";
import { h, svg, fmt, lineChart, rootsChart, stackedBars, heatmap, legend, SERIES, hideTip } from "./charts.js";

const $ = id => document.getElementById(id);
const TABS = ["Summary", "Impulse responses", "Moments", "Variance", "Simulation", "Decision rule", "Cozy script"];
const STORE = "dsge-workbench:";

const state = {
  examples: [], title: "", fileName: "model.mod",
  parsed: null, model: null,            /* the last reading of the text; model is null if it has errors */
  loadError: "",                        /* Cozy refused the model */
  overrides: {}, sd: null,              /* parameter values and shock sizes moved away from the model's own */
  horizon: 40,
  result: null, solving: false,
  tab: "Summary",
  shock: 0, units: "dev", pinned: null,
  vars: null,                           /* names shown in charts and tables */
  relTo: null,                          /* moments: standard deviations relative to this variable */
  sim: { T: 200, seed: 1, path: null, vars: [], slots: {} },
  table: false,
};
const engine = new EngineClient();
let wb = null, wbGeneration = -1, loadedModel = null;

/* ---- small things ------------------------------------------------------ */
function toast(text) {
  const t = document.body.appendChild(h("div", { class: "toast", text }));
  setTimeout(() => t.remove(), 2200);
}
function download(name, data, type) {
  const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type }));
  const a = document.body.appendChild(h("a", { href: url, download: name }));
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const csvCell = v => (typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const csv = rows => rows.map(r => r.map(csvCell).join(",")).join("\n") + "\n";
const stem = () => state.fileName.replace(/\.[^.]*$/, "") || "model";
function store(key, value) { try { localStorage.setItem(STORE + key, value); } catch { /* private window: carry on without */ } }
function recall(key) { try { return localStorage.getItem(STORE + key); } catch { return null; } }

/* ---- the editor: a textarea over a painted copy of its text ------------ */
const text = $("text"), paintEl = $("paint"), gutter = $("gutter");
const KEYWORDS = "var|varexo|parameters|model|end|initval|endval|histval|shocks|steady_state_model|stderr|corr|steady|check|stoch_simul|estimation|estimated_params|varobs|predetermined_variables|linear|steady_state";
const PAINT = new RegExp(`(//[^\\n]*|%[^\\n]*|/\\*[\\s\\S]*?\\*/)|(^[ \\t]*@#[^\\n]*)|(?<![\\w.])(\\d+\\.?\\d*(?:[eE][+-]?\\d+)?|\\.\\d+)|\\b(${KEYWORDS})\\b`, "gm");
const esc = s => s.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
function paint() {
  const src = text.value;
  let out = "", last = 0;
  for (const m of src.matchAll(PAINT)) {
    out += esc(src.slice(last, m.index));
    const cls = m[1] ? "t-c" : m[2] ? "t-m" : m[3] ? "t-n" : "t-k";
    out += `<span class="${cls}">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  paintEl.innerHTML = out + esc(src.slice(last)) + "\n";
  paintGutter();
}
function paintGutter() {
  const n = text.value.split("\n").length;
  const marks = new Map();
  if (state.parsed) {
    for (const w of state.parsed.warnings) if (w.line) marks.set(w.line, "wrn");
    for (const e of state.parsed.errors) if (e.line) marks.set(e.line, "err");
  }
  gutter.replaceChildren(...Array.from({ length: n }, (_, i) => h("div", { class: marks.get(i + 1) || "", text: String(i + 1) })));
  $("model-size").textContent = `${n} lines`;
}
function goToLine(line) {
  const lines = text.value.split("\n");
  const at = lines.slice(0, line - 1).reduce((s, l) => s + l.length + 1, 0);
  text.focus();
  text.setSelectionRange(at, at + (lines[line - 1] || "").length);
  $("editor").scrollTop = Math.max(0, (line - 4) * parseFloat(getComputedStyle(text).lineHeight));
}
let typing = 0;
text.addEventListener("input", () => {
  paint();
  store("text", text.value);
  clearTimeout(typing);
  typing = setTimeout(() => { $("example").value = ""; store("example", ""); textChanged(); }, 350);
});
text.addEventListener("keydown", e => {
  if (e.key !== "Tab" || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
  e.preventDefault();
  text.setRangeText("    ", text.selectionStart, text.selectionEnd, "end");
  text.dispatchEvent(new Event("input"));
});
function setText(value, name) {
  text.value = value;
  if (name) state.fileName = name;
  state.overrides = {}; state.sd = null; state.pinned = null; state.vars = null; state.relTo = null; state.shock = 0;
  state.sim.vars = []; state.sim.slots = {}; state.sim.path = null;
  paint();
  store("text", value);
  store("name", state.fileName);
  $("editor").scrollTop = 0;
  textChanged();
}

/* ---- from text to results ---------------------------------------------- */
let running = false, again = false, textDirty = false;
function textChanged() { textDirty = true; run(); }
async function run() {
  if (running) { again = true; return; }
  running = true;
  do {
    again = false;
    try { await step(); }
    catch (e) { state.result = { ok: false, error: e.message }; state.solving = false; render(); }
  } while (again);
  running = false;
}

async function step() {
  if (textDirty) {
    textDirty = false;
    const before = state.model;
    state.parsed = parseMod(text.value);
    state.model = state.parsed.ok ? state.parsed.model : null;
    state.loadError = "";
    paintGutter();
    if (state.model) carryOver(before, state.model);
    renderMessages();
    renderParams();
    if (!state.model) { state.result = null; loadedModel = null; render(); return; }
  }
  if (!state.model) return;
  await engine.ready;
  if (!wb || wbGeneration !== engine.generation) { wb = new Workbench(engine); wbGeneration = engine.generation; loadedModel = null; }
  if (loadedModel !== state.model) {
    try { await wb.load(state.model); loadedModel = state.model; }
    catch (e) { state.loadError = e.message; state.result = null; loadedModel = null; renderMessages(); render(); return; }
    renderMessages();
  }
  state.solving = true;
  const slow = setTimeout(() => $("view").classList.add("stale"), 180);
  const r = await wb.solve(state.overrides, { horizon: state.horizon, shocks: shocksNow() });
  clearTimeout(slow);
  $("view").classList.remove("stale");
  state.solving = false;
  state.result = r;
  state.sim.path = null;
  if (r.ok && r.determinate && state.tab === "Simulation") await simulate();
  updateDerived();
  render();
}

/* What the user had moved stays moved when the text is edited, unless the
 * text itself changed that value. */
function carryOver(before, model) {
  const keep = {};
  for (const p of model.params) {
    if (!p.base || !(p.name in state.overrides)) continue;
    const old = before && before.params.find(q => q.name === p.name);
    if (old && old.value === p.value) keep[p.name] = state.overrides[p.name];
  }
  state.overrides = keep;
  const same = before && state.sd && before.exo.length === model.exo.length && before.exo.every((s, j) => s.name === model.exo[j].name && before.shocks.sd[j] === model.shocks.sd[j]);
  if (!same) state.sd = null;
  if (state.shock >= model.exo.length) state.shock = 0;
  state.horizon = state.horizon && before ? state.horizon : model.hints.irf;
  const names = model.endo.filter(v => !v.aux).map(v => v.name);
  if (!state.vars || !state.vars.every(n => names.includes(n))) state.vars = names.slice(0, 16);
  if (!names.includes(state.relTo)) state.relTo = names[0];
  state.sim.vars = state.sim.vars.filter(n => names.includes(n));
  if (!state.sim.vars.length) names.slice(0, 3).forEach(simToggle);
  if (state.pinned && state.pinned.names.join() !== model.endo.map(v => v.name).join()) state.pinned = null;
}
function shocksNow() { return { sd: state.sd || state.model.shocks.sd, corr: state.model.shocks.corr }; }

/* ---- messages under the editor ----------------------------------------- */
function renderMessages() {
  const box = $("messages"), p = state.parsed;
  box.replaceChildren();
  if (!p) return;
  const row = (kind, tag, m) => h("div", { class: "msg " + kind },
    m.line ? h("button", { class: "where", type: "button", text: `line ${m.line}`, onclick: () => goToLine(m.line) }) : h("span", { class: "where" }),
    h("span", { class: "tag", text: tag }), h("span", { text: m.message }));
  for (const e of p.errors) box.append(row("error", "Error", e));
  if (state.loadError) box.append(row("error", "Error", { line: 0, message: state.loadError }));
  for (const w of p.warnings) box.append(row("warning", "Warning", w));
  if (p.ok && !p.warnings.length && !state.loadError) {
    const m = p.model, aux = m.endo.filter(v => v.aux).length;
    box.append(h("div", { class: "msg ok" }, h("span", { class: "where" }), h("span", { text: `Read ${m.endo.length - aux} variables, ${m.exo.length} shock${m.exo.length === 1 ? "" : "s"} and ${m.params.filter(q => q.declared).length} parameters.` })));
  }
  if (p.notes.length) {
    box.append(h("details", { class: "notes" }, h("summary", { text: `${p.notes.length} statement${p.notes.length === 1 ? "" : "s"} not used by the workbench` }),
      p.notes.map(n => row("note", "", n))));
  }
}

/* ---- the parameter panel ------------------------------------------------ */
function sliderRange(v) {
  if (v === 0) return [-1, 1];
  if (v > 0 && v < 1) return [0, 1];
  if (v < 0 && v > -1) return [-1, 0];
  const top = Number((Math.abs(v) * 3).toPrecision(1));
  return v > 0 ? [0, Math.max(top, v)] : [Math.min(-top, v), 0];
}
function control(name, long, home, get, set) {
  const [lo, hi] = sliderRange(home);
  const num = h("input", { type: "number", step: "any", value: get(), "aria-label": name });
  const range = h("input", { type: "range", min: lo, max: hi, step: (hi - lo) / 400, value: get(), "aria-label": `${name} slider` });
  const row = h("div", { class: "param", title: long || name },
    h("div", { class: "param-top" }, h("span", { class: "param-name", text: name }), num), range,
    long ? h("div", { class: "param-long", text: long }) : null);
  const apply = (v, from) => {
    if (!Number.isFinite(v)) return;
    if (from !== num) num.value = String(Number(v.toPrecision(6)));
    if (from !== range) { if (v < +range.min) range.min = v; if (v > +range.max) range.max = v; range.value = v; }
    row.classList.toggle("changed", v !== home);
    set(v);
    run();
  };
  num.addEventListener("input", () => apply(parseFloat(num.value), num));
  range.addEventListener("input", () => apply(Number(Number(range.value).toPrecision(6)), range));
  row.classList.toggle("changed", get() !== home);
  return row;
}
function renderParams() {
  const box = $("params"), m = state.model;
  box.replaceChildren();
  if (!m) { box.append(h("p", { class: "empty", text: "Parameters appear here once the model reads without errors." })); return; }
  const base = m.params.filter(p => p.base && p.declared);
  for (const p of base) {
    box.append(control(p.name, p.longName, p.value, () => (p.name in state.overrides ? state.overrides[p.name] : p.value),
      v => { if (v === p.value) delete state.overrides[p.name]; else state.overrides[p.name] = v; }));
  }
  if (m.exo.length) {
    box.append(h("h3", { text: "Shock standard deviations" }));
    m.exo.forEach((s, j) => box.append(control(s.name, s.longName, m.shocks.sd[j], () => (state.sd || m.shocks.sd)[j],
      v => { const sd = (state.sd || m.shocks.sd).slice(); sd[j] = Math.max(0, v); state.sd = sd.every((x, i) => x === m.shocks.sd[i]) ? null : sd; })));
    const pairs = [];
    m.shocks.corr.forEach((row, i) => row.forEach((r, j) => { if (j > i && r !== 0) pairs.push(`corr(${m.exo[i].name}, ${m.exo[j].name}) = ${fmt(r, 3)}`); }));
    if (pairs.length) box.append(h("div", { class: "param param-long", text: pairs.join("; ") + " (set in the model)" }));
  }
  const derived = m.params.filter(p => !(p.base && p.declared));
  if (derived.length) {
    box.append(h("details", { id: "derived" }, h("summary", { text: `Derived values (${derived.length})` }),
      derived.map(p => h("div", { class: "derived", title: p.longName || p.name }, h("span", { text: p.name }), h("span", { "data-derived": p.name, text: fmt(p.value, 6) })))));
  }
}
function updateDerived() {
  const r = state.result;
  if (!r || !r.ok) return;
  for (const el of document.querySelectorAll("[data-derived]")) el.textContent = fmt(r.params[el.dataset.derived], 6);
}
$("reset").addEventListener("click", () => { state.overrides = {}; state.sd = null; renderParams(); run(); });

/* ---- status line and tabs ----------------------------------------------- */
function renderStatus() {
  const box = $("status"), r = state.result;
  box.replaceChildren();
  if (!state.parsed) { box.append(h("span", { class: "badge busy", text: "Starting…" })); return; }
  if (!state.model) { box.append(h("span", { class: "badge bad", text: "The model has errors" }), h("span", { text: "They are listed under the editor." })); return; }
  if (state.loadError) { box.append(h("span", { class: "badge bad", text: "Cozy could not compile the model" }), h("span", { text: state.loadError })); return; }
  if (!r) { box.append(h("span", { class: "badge busy", text: "Solving…" })); return; }
  if (!r.ok) { box.append(h("span", { class: "badge bad", text: "No solution" }), h("span", { text: r.error })); return; }
  const roots = `${r.unstable} unstable root${r.unstable === 1 ? "" : "s"} for ${r.forward} forward-looking variable${r.forward === 1 ? "" : "s"}`;
  if (r.determinate) box.append(h("span", { class: "badge good", text: "✓ Unique stable solution" }), h("span", { text: roots }));
  else if (r.verdict === "indeterminate") box.append(h("span", { class: "badge warn", text: "Indeterminate" }), h("span", { text: `${roots}: many stable paths` }));
  else if (r.verdict === "explosive") box.append(h("span", { class: "badge bad", text: "No stable solution" }), h("span", { text: `${roots}: every path explodes` }));
  else box.append(h("span", { class: "badge bad", text: "Not solved" }), h("span", { text: "the root count is right, but no decision rule could be computed" }));
  box.append(h("span", { class: "dim", text: `solved in ${r.ms} ms by Cozy ${engine.version}` }));
}
function renderTabs() {
  $("tabs").replaceChildren(...TABS.map(t => h("button", { type: "button", role: "tab", "aria-selected": String(t === state.tab), text: t, onclick: () => openTab(t) })));
}
async function openTab(t) {
  state.tab = t;
  store("tab", t);
  if (t === "Simulation" && !state.sim.path && solved()) await simulate();
  render();
}
const solved = () => state.result && state.result.ok && state.result.determinate;

/* ---- what the views share ---------------------------------------------- */
const longOf = name => (state.model.endo.find(v => v.name === name) || {}).longName || "";
const indexOf = name => state.result.names.indexOf(name);
const shown = () => state.vars.filter(n => indexOf(n) >= 0);
function chips(selected, toggle, extra) {
  const names = state.model.endo.filter(v => !v.aux).map(v => v.name);
  if (names.length <= 3 && !extra) return null;
  return h("div", { class: "pickers", role: "group", "aria-label": "Variables shown" },
    names.map(n => h("button", { type: "button", class: "chip", "aria-pressed": String(selected.includes(n)), title: longOf(n) || n, text: n, onclick: () => { toggle(n); render(); } })),
    extra || null);
}
const toggleVar = n => { state.vars = state.vars.includes(n) ? state.vars.filter(x => x !== n) : state.model.endo.map(v => v.name).filter(x => x === n || state.vars.includes(x)); };
const allNone = () => [
  h("button", { type: "button", class: "chip", text: "all", onclick: () => { state.vars = state.model.endo.filter(v => !v.aux).map(v => v.name); render(); } }),
  h("button", { type: "button", class: "chip", text: "none", onclick: () => { state.vars = []; render(); } }),
];
function table(head, rows, opt = {}) {
  const t = h("table", { class: "grid" });
  t.append(h("thead", {}, h("tr", {}, head.map((c, i) => h("th", { class: opt.text && opt.text.includes(i) ? "text" : "", text: c })))));
  t.append(h("tbody", {}, rows.map(r => h("tr", { class: r.sep ? "sep" : "" }, r.cells.map((c, i) => {
    const isNum = typeof c === "number";
    return h("td", { class: (opt.text && opt.text.includes(i) ? "text" : "") + (isNum && Number.isNaN(c) ? " none" : ""), text: isNum ? fmt(c, opt.digits || 5) : c });
  })))));
  return h("div", { class: "scroll" }, t);
}
const exportButtons = (onCsv, charts) => [
  h("button", { type: "button", class: "small", text: "CSV", title: "Download these numbers", onclick: onCsv }),
  charts ? h("button", { type: "button", class: "small", text: "SVG", title: "Download the figure as SVG", onclick: () => exportFigure(charts(), "svg") }) : null,
  charts ? h("button", { type: "button", class: "small", text: "PNG", title: "Download the figure as PNG", onclick: () => exportFigure(charts(), "png") }) : null,
];
const noSolution = () => h("p", { class: "empty", text: !state.model ? "Fix the errors listed under the editor and the results will appear here." :
  !state.result ? "Solving…" : !state.result.ok ? `There is nothing to show: ${state.result.error}.` :
  "There is no unique stable solution at these parameter values, so there are no responses or moments to show. The Summary tab shows the eigenvalues." });

/* ---- Summary ------------------------------------------------------------ */
function viewSummary(view) {
  const r = state.result, m = state.model;
  if (!m || !r || !r.ok) { view.append(noSolution()); return; }
  const n = m.endo.length, aux = m.endo.filter(v => v.aux).length;
  const why = r.determinate
    ? `The model has ${r.forward} forward-looking variable${r.forward === 1 ? "" : "s"} and ${r.unstable} eigenvalue${r.unstable === 1 ? "" : "s"} outside the unit circle. The two are equal, which is the Blanchard–Kahn condition for one stable path.`
    : r.verdict === "indeterminate"
      ? `The model has ${r.forward} forward-looking variable${r.forward === 1 ? "" : "s"} but only ${r.unstable} eigenvalue${r.unstable === 1 ? "" : "s"} outside the unit circle. With too few unstable roots, expectations are not pinned down and many stable paths satisfy the equations.`
      : r.verdict === "explosive"
        ? `The model has ${r.forward} forward-looking variable${r.forward === 1 ? "" : "s"} but ${r.unstable} eigenvalues outside the unit circle. With too many unstable roots no path stays bounded.`
        : "The eigenvalue count satisfies the Blanchard–Kahn condition, but the decision rule could not be computed (the model may be singular).";
  view.append(h("div", { class: "verdict " + (r.determinate ? "good" : "bad") },
    h("strong", { text: r.determinate ? "A unique stable solution" : r.verdict === "indeterminate" ? "Indeterminacy: no unique solution" : r.verdict === "explosive" ? "No stable solution" : "Not solved" }),
    h("span", { text: why })));
  const tile = (k, v, s) => h("div", { class: "tile" }, h("div", { class: "k", text: k }), h("div", { class: "v", text: String(v) }), h("div", { class: "s", text: s || "" }));
  view.append(h("div", { class: "tiles" },
    tile("Variables", n - aux, aux ? `plus ${aux} auxiliary` : m.linear ? "linear model" : ""),
    tile("Shocks", m.exo.length),
    tile("Forward-looking", r.forward, "appear with a lead"),
    tile("State variables", r.backward, "appear with a lag"),
    tile("Unstable roots", r.unstable, r.determinate ? "as many as needed" : `${r.forward} needed`),
    tile("Solved in", `${r.ms} ms`, `Cozy ${engine.version}`)));
  view.append(h("h3", { text: "Eigenvalues" }), h("div", { class: "wide" }, rootsChart(r.roots)),
    h("p", { class: "foot", text: "Moduli of the model's generalised eigenvalues, on a log scale. Roots at zero and at infinity sit at the edges. Hover a dot for its value." }));
  const how = wb.steadyKind === "formula" ? "given by the model's steady_state_model block and checked against the equations"
    : wb.steadyKind === "zero" ? "zero: the model is linear and has no constant terms" : "found by Newton's method with exact derivatives, starting from initval";
  const rows = m.endo.filter(v => !v.aux).map(v => ({ cells: [v.name, v.longName, r.steady[indexOf(v.name)]] }));
  view.append(h("h3", { text: "Steady state" }),
    h("div", { class: "bar" }, h("span", { class: "dim", text: `The steady state is ${how}.` }), h("span", { class: "spacer" }),
      exportButtons(() => download(`${stem()}-steady-state.csv`, csv([["variable", "description", "steady state"], ...rows.map(x => x.cells)]), "text/csv"))),
    table(["Variable", "Description", "Steady state"], rows, { text: [1], digits: 8 }));
}

/* ---- Impulse responses --------------------------------------------------- */
function irfSeries(name) {
  const r = state.result, i = indexOf(name), ss = r.steady[i];
  const pct = state.units === "pct" && Math.abs(ss) > 1e-9;
  const scale = v => (pct ? (100 * v) / Math.abs(ss) : v);
  const out = [{ name: "now", color: SERIES[0], values: r.irf[state.shock].map(row => scale(row[i])) }];
  const p = state.pinned;
  if (p && p.irf[state.shock]) out.unshift({ name: "pinned", color: "var(--muted)", dashed: true, values: p.irf[state.shock].map(row => (pct ? (100 * row[i]) / Math.abs(p.steady[i]) : row[i])) });
  return { series: out, pct };
}
function viewIrf(view) {
  if (!solved()) { view.append(noSolution()); return; }
  const r = state.result, m = state.model, sd = shocksNow().sd;
  const shockSel = h("select", { "aria-label": "Shock", onchange: e => { state.shock = +e.target.value; render(); } },
    m.exo.map((s, j) => h("option", { value: j, selected: j === state.shock, text: `${s.name}${s.longName ? " — " + s.longName : ""}${sd[j] === 0 ? " (size 0)" : ""}` })));
  const anyLevel = r.steady.some(v => Math.abs(v) > 1e-9);
  const names = shown();
  const cards = () => [...view.querySelectorAll(".card")].map(c => ({ title: c.dataset.name, sub: c.dataset.sub, chart: c.querySelector("svg") }));
  view.append(h("div", { class: "bar" },
    h("label", {}, "Shock", shockSel),
    h("label", {}, "Horizon", h("input", { type: "number", min: 4, max: 400, step: 1, value: state.horizon, onchange: e => { state.horizon = Math.max(4, Math.min(400, Math.round(+e.target.value) || 40)); state.pinned = null; run(); } })),
    anyLevel ? h("div", { class: "seg", role: "group", "aria-label": "Units" },
      h("button", { type: "button", class: state.units === "dev" ? "on" : "", text: "Deviation", onclick: () => { state.units = "dev"; render(); } }),
      h("button", { type: "button", class: state.units === "pct" ? "on" : "", text: "% of steady state", onclick: () => { state.units = "pct"; render(); } })) : null,
    h("button", { type: "button", text: state.pinned ? "Re-pin" : "Pin as baseline", title: "Keep these responses on the charts while you change parameters", onclick: () => { state.pinned = { irf: r.irf, steady: r.steady, names: r.names.slice() }; render(); } }),
    state.pinned ? h("button", { type: "button", text: "Unpin", onclick: () => { state.pinned = null; render(); } }) : null,
    h("span", { class: "spacer" }),
    h("button", { type: "button", class: "small" + (state.table ? " on" : ""), text: "Table", title: "Show the numbers instead of the charts", onclick: () => { state.table = !state.table; render(); } }),
    exportButtons(() => download(`${stem()}-irf-${m.exo[state.shock].name}.csv`, csv([["period", ...names], ...r.irf[state.shock].map((row, t) => [t, ...names.map(nm => irfSeries(nm).series.at(-1).values[t])])]), "text/csv"), state.table ? null : cards)));
  if (state.pinned) view.append(legend([{ name: "these settings", color: SERIES[0] }, { name: "pinned baseline", color: "var(--muted)", dashed: true }]));
  const picker = chips(state.vars, toggleVar, allNone());
  if (picker) view.append(picker);
  if (!names.length) { view.append(h("p", { class: "empty", text: "Choose variables above." })); return; }
  if (state.table) {
    view.append(table(["Period", ...names], r.irf[state.shock].map((row, t) => ({ cells: [String(t), ...names.map(nm => irfSeries(nm).series.at(-1).values[t])] }))));
  } else {
    const group = { charts: [] };
    view.append(h("div", { class: "multiples" }, names.map(nm => {
      const s = irfSeries(nm), sub = (longOf(nm) || "") + (s.pct ? (longOf(nm) ? ", " : "") + "% of steady state" : "");
      return h("div", { class: "card", "data-name": nm, "data-sub": sub }, h("h4", { text: nm }), h("div", { class: "sub", text: sub }),
        lineChart(s.series, { group, title: nm, period: "period", label: `response of ${nm}` }));
    })));
  }
  const size = sd[state.shock];
  view.append(h("p", { class: "foot", text: `Responses to a one-standard-deviation innovation in ${m.exo[state.shock].name} (${fmt(size, 4)}) at period 0, as deviations from the steady state${state.units === "pct" && anyLevel ? ", in percent of it where it is not zero" : ""}.` +
    (m.shocks.corr.some((row, i) => row.some((c, j) => i !== j && c !== 0)) ? " The shocks are correlated; they are orthogonalised in the order declared, as in Dynare." : "") }));
}

/* ---- Moments ------------------------------------------------------------- */
function viewMoments(view) {
  if (!solved()) { view.append(noSolution()); return; }
  const r = state.result, m = state.model, names = m.endo.filter(v => !v.aux).map(v => v.name);
  const ref = r.sd[indexOf(state.relTo)];
  const rows = names.map(nm => { const i = indexOf(nm); return { cells: [nm, r.steady[i], r.sd[i], r.sd[i] / ref, ...r.acorr[i]] }; });
  const head = ["Variable", "Mean", "Std. dev.", `Relative to ${state.relTo}`, ...r.acorr[0].map((_, j) => `AC(${j + 1})`)];
  const pick = shown();
  const corr = pick.map(a => pick.map(b => r.corr[indexOf(a)][indexOf(b)]));
  view.append(h("div", { class: "bar" },
    h("label", {}, "Standard deviations relative to", h("select", { onchange: e => { state.relTo = e.target.value; render(); } }, names.map(nm => h("option", { value: nm, selected: nm === state.relTo, text: nm })))),
    h("span", { class: "spacer" }),
    exportButtons(() => download(`${stem()}-moments.csv`, csv([head.map(x => x.replace(/^Relative to .*/, `sd relative to ${state.relTo}`)), ...rows.map(x => x.cells)]), "text/csv"))),
    table(head, rows));
  if (r.sd.some(Number.isNaN)) view.append(h("p", { class: "foot", text: "A dash marks a variable with a unit root: it has no unconditional variance, so no standard deviation or correlation." }));
  view.append(h("h3", { text: "Correlations" }));
  const picker = chips(state.vars, toggleVar, allNone());
  if (picker) view.append(picker);
  if (pick.length < 2) { view.append(h("p", { class: "empty", text: "Choose two or more variables." })); return; }
  const left = Math.min(150, 14 + 7.2 * Math.max(...pick.map(s => s.length)));
  view.append(h("div", { class: "bar" }, h("span", { class: "spacer" }),
    exportButtons(() => download(`${stem()}-correlations.csv`, csv([["", ...pick], ...pick.map((a, i) => [a, ...corr[i]])]), "text/csv"),
      () => [{ title: "Correlations", sub: "", chart: view.querySelector("svg.heat") }])),
    h("div", { class: "wide" }, heatmap(pick, corr, { left }),
      h("div", { class: "scale" }, h("span", { text: "−1" }), h("i"), h("span", { text: "+1" }), h("span", { class: "dim", text: "hover a cell for its value" }))));
}

/* ---- Variance decomposition ----------------------------------------------- */
function viewVardecomp(view) {
  if (!solved()) { view.append(noSolution()); return; }
  const r = state.result, m = state.model, k = m.exo.length;
  if (!k) { view.append(h("p", { class: "empty", text: "The model has no shocks." })); return; }
  /* at most eight colours: beyond seven shocks, the rest are shown together */
  const fold = k > 8, shockNames = fold ? [...m.exo.slice(0, 7).map(s => s.name), "other shocks"] : m.exo.map(s => s.name);
  const share = row => (fold ? [...row.slice(0, 7), row.slice(7).reduce((a, b) => a + b, 0)] : row);
  const names = shown();
  const left = Math.min(170, 16 + 7.2 * Math.max(0, ...names.map(s => s.length)));
  const all = m.endo.filter(v => !v.aux).map(v => v.name);
  const csvRows = [["variable", ...m.exo.map(s => s.name)], ...all.map(nm => [nm, ...r.vardecomp[indexOf(nm)]])];
  view.append(h("div", { class: "bar" },
    h("span", { class: "dim", text: "Share of each variable's unconditional variance due to each shock, in percent." }), h("span", { class: "spacer" }),
    exportButtons(() => download(`${stem()}-variance-decomposition.csv`, csv(csvRows), "text/csv"), () => [{ title: "Variance decomposition, percent", sub: shockNames.join(" · "), chart: view.querySelector("svg.chart") }])));
  view.append(legend(shockNames.map((nm, j) => ({ name: nm, color: SERIES[j] })), "box"));
  const picker = chips(state.vars, toggleVar, allNone());
  if (picker) view.append(picker);
  if (names.length) view.append(h("div", { class: "wide" }, stackedBars(names.map(nm => ({ name: nm, shares: share(r.vardecomp[indexOf(nm)]), why: Number.isNaN(r.sd[indexOf(nm)]) ? "unit root: no variance to decompose" : "never moves" })), shockNames, { left })));
  view.append(h("h3", { text: "The numbers" }), table(["Variable", ...m.exo.map(s => s.name)], all.map(nm => ({ cells: [nm, ...r.vardecomp[indexOf(nm)]] })), { digits: 4 }));
  if (m.shocks.corr.some((row, i) => row.some((c, j) => i !== j && c !== 0))) view.append(h("p", { class: "foot", text: "The shocks are correlated; the decomposition is for the orthogonalised innovations, in the order declared." }));
}

/* ---- Simulation ----------------------------------------------------------- */
async function simulate() {
  if (!solved()) return;
  try { state.sim.path = await wb.simulate(state.sim.T, state.sim.seed); }
  catch (e) { state.sim.path = null; toast(e.message); }
}
function simToggle(n) {
  const s = state.sim;
  if (s.vars.includes(n)) { s.vars = s.vars.filter(x => x !== n); delete s.slots[n]; return; }
  if (s.vars.length >= 4) { const drop = s.vars.shift(); delete s.slots[drop]; }
  s.vars.push(n);
  s.slots[n] = [0, 1, 2, 3].find(i => !Object.values(s.slots).includes(i));      /* a colour stays with its variable */
}
function viewSimulation(view) {
  if (!solved()) { view.append(noSolution()); return; }
  const r = state.result, s = state.sim;
  const redo = async () => { await simulate(); render(); };
  const all = state.model.endo.filter(v => !v.aux).map(v => v.name);
  view.append(h("div", { class: "bar" },
    h("label", {}, "Periods", h("input", { type: "number", min: 20, max: 5000, step: 10, value: s.T, onchange: e => { s.T = Math.max(20, Math.min(5000, Math.round(+e.target.value) || 200)); redo(); } })),
    h("label", {}, "Seed", h("input", { type: "number", min: 0, step: 1, value: s.seed, onchange: e => { s.seed = Math.max(0, Math.round(+e.target.value) || 0); redo(); } })),
    h("button", { type: "button", text: "New draw", onclick: () => { s.seed++; redo(); } }),
    h("span", { class: "spacer" }),
    exportButtons(() => s.path && download(`${stem()}-simulation.csv`, csv([["period", ...all], ...s.path.map((row, t) => [t + 1, ...all.map(nm => row[indexOf(nm)] + r.steady[indexOf(nm)])])]), "text/csv"),
      () => [{ title: "Simulated path, deviations from the steady state", sub: s.vars.join(" · "), chart: view.querySelector("svg.chart") }])));
  view.append(h("div", { class: "pickers", role: "group", "aria-label": "Variables drawn (up to four)" },
    all.map(n => h("button", { type: "button", class: "chip", "aria-pressed": String(s.vars.includes(n)), title: longOf(n) || n, text: n, onclick: () => { simToggle(n); render(); } }))));
  if (!s.path) { view.append(h("p", { class: "empty", text: "Drawing…" })); return; }
  if (!s.vars.length) { view.append(h("p", { class: "empty", text: "Choose up to four variables above." })); return; }
  const series = s.vars.slice().sort((a, b) => s.slots[a] - s.slots[b]).map(nm => ({ name: nm + (longOf(nm) ? ` — ${longOf(nm)}` : ""), color: SERIES[s.slots[nm]], values: s.path.map(row => row[indexOf(nm)]) }));
  if (series.length > 1) view.append(legend(series));
  const width = Math.max(480, Math.min(1400, view.clientWidth - 58));
  view.append(h("div", { class: "wide" }, lineChart(series, { width, height: Math.round(Math.max(260, Math.min(380, width * 0.4))), x0: 1, xLabel: "period", period: "period", label: "simulated path", thin: s.T > 120 })),
    h("p", { class: "foot", text: `One random path of ${s.T} periods from the steady state, as deviations from it${series.length === 1 ? ` (${series[0].name})` : ""}. The CSV holds every variable, in levels. The same seed gives the same path.` }));
}

/* ---- Decision rule --------------------------------------------------------- */
function viewRule(view) {
  if (!solved()) { view.append(noSolution()); return; }
  const r = state.result, m = state.model;
  const cols = m.endo.filter(v => !v.aux).map(v => v.name), ci = cols.map(indexOf);
  const states = r.names.map((nm, j) => ({ nm, j })).filter(({ j }) => r.P.some(row => row[j] !== 0));
  const rows = [
    { cells: ["Steady state", ...ci.map(i => r.steady[i])] },
    ...states.map(({ nm, j }, q) => ({ sep: q === 0, cells: [`${nm}(-1)`, ...ci.map(i => r.P[i][j])] })),
    ...m.exo.map((s, j) => ({ sep: j === 0, cells: [s.name, ...ci.map(i => r.Q[i][j])] })),
  ];
  view.append(h("div", { class: "bar" },
    h("span", { class: "dim", text: "Each column is one variable: its steady state, then its response to last period's state variables and to this period's shocks (per unit of shock)." }),
    h("span", { class: "spacer" }),
    exportButtons(() => download(`${stem()}-decision-rule.csv`, csv([["", ...cols], ...rows.map(x => x.cells)]), "text/csv"))),
    table(["", ...cols], rows, { digits: 6 }),
    h("p", { class: "foot", text: "y(t) = steady state + P (y(t−1) − steady state) + Q e(t). This is the layout of Dynare's “policy and transition functions”, with rows and columns exchanged." }));
}

/* ---- Cozy script ------------------------------------------------------------ */
function viewCozy(view) {
  const r = state.result;
  if (!state.model || !r || !r.ok) { view.append(noSolution()); return; }
  const script = standaloneScript(state.model, r, shocksNow(), state.title || stem());
  view.append(h("div", { class: "bar" },
    h("span", { class: "dim", text: "The same model at these parameter values, as a script for Cozy. It runs in the command-line interpreter and in Cozy's playground." }),
    h("span", { class: "spacer" }),
    h("button", { type: "button", class: "small", text: "Copy", onclick: () => navigator.clipboard.writeText(script).then(() => toast("Copied")) }),
    h("button", { type: "button", class: "small", text: "Download", onclick: () => download(`${stem()}.cz`, script, "text/plain") })),
    h("pre", { class: "source", text: script }));
}

const VIEWS = { "Summary": viewSummary, "Impulse responses": viewIrf, "Moments": viewMoments, "Variance": viewVardecomp, "Simulation": viewSimulation, "Decision rule": viewRule, "Cozy script": viewCozy };
function render() {
  hideTip();
  renderStatus();
  renderTabs();
  const view = $("view"), top = view.scrollTop;
  view.replaceChildren();
  VIEWS[state.tab](view);
  view.scrollTop = top;
}

/* ---- figures out of the page ------------------------------------------------ */
/* The charts are styled by the page's stylesheet, which a saved file does
 * not have: write the colours in, and lay the charts out on one canvas. */
function exportFigure(cards, kind) {
  cards = cards.filter(c => c.chart);
  if (!cards.length) return;
  const css = getComputedStyle(document.documentElement), tok = name => css.getPropertyValue(name).trim();
  const resolve = s => s.replace(/var\((--[\w-]+)\)/g, (_, v) => tok(v)).replace(/color-mix\([^;]*\)\)/g, m => m);
  const first = cards[0].chart.viewBox.baseVal, cw = first.width, ch = first.height, head = 34, pad = 14;
  const cols = cards.length === 1 ? 1 : Math.min(4, Math.ceil(Math.sqrt(cards.length)));
  const rowsN = Math.ceil(cards.length / cols);
  const W = cols * (cw + pad) + pad, H = rowsN * (ch + head + pad) + pad;
  const out = svg("svg", { xmlns: "http://www.w3.org/2000/svg", viewBox: `0 0 ${W} ${H}`, width: W, height: H });
  svg("style", {}, out).textContent = `
    text{font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
    .grid{stroke:${tok("--grid")};stroke-width:1}.axis{stroke:${tok("--axis")};stroke-width:1}
    .tick{fill:${tok("--muted")};font-size:10.5px}.label{fill:${tok("--ink-2")};font-size:11.5px;font-family:ui-monospace,Menlo,Consolas,monospace}
    .note{fill:${tok("--muted")};font-size:11px}.line{stroke-width:2;stroke-linejoin:round;stroke-linecap:round;fill:none}
    .line.dashed{stroke-dasharray:5 4;stroke-width:1.5}.cross,.dot{display:none}.unit{stroke:${tok("--ink-2")};stroke-width:1.5}
    .band{fill:${tok("--wash")}}.root{stroke:${tok("--raised")};stroke-width:2}.root.stable{fill:${tok("--series-1")}}.root.unstable{fill:${tok("--series-2")}}
    .t{fill:${tok("--ink")};font-size:12.5px;font-weight:600;font-family:ui-monospace,Menlo,Consolas,monospace}.s{fill:${tok("--muted")};font-size:11px}`;
  svg("rect", { width: W, height: H, fill: tok("--raised") }, out);
  cards.forEach((c, i) => {
    const x = pad + (i % cols) * (cw + pad), y = pad + Math.floor(i / cols) * (ch + head + pad);
    svg("text", { x, y: y + 13, class: "t" }, out).textContent = c.title || "";
    svg("text", { x, y: y + 28, class: "s" }, out).textContent = c.sub || "";
    const copy = c.chart.cloneNode(true);
    for (const el of [copy, ...copy.querySelectorAll("*")]) {
      const st = el.getAttribute("style");
      if (st) {
        /* a mixed colour is asked of the browser, which answers with a plain one */
        const live = [...c.chart.querySelectorAll("*")][[...copy.querySelectorAll("*")].indexOf(el)];
        const fill = live && /color-mix/.test(st) ? getComputedStyle(live).fill : null;
        el.setAttribute("style", fill ? `fill:${fill}` : resolve(st));
      }
    }
    copy.setAttribute("x", x); copy.setAttribute("y", y + head); copy.setAttribute("width", cw); copy.setAttribute("height", ch);
    copy.removeAttribute("class");
    out.appendChild(copy);
  });
  const source = new XMLSerializer().serializeToString(out);
  const name = `${stem()}-${state.tab.toLowerCase().replace(/\s+/g, "-")}`;
  if (kind === "svg") { download(`${name}.svg`, source, "image/svg+xml"); return; }
  const img = new Image();
  img.onload = () => {
    const canvas = Object.assign(document.createElement("canvas"), { width: W * 2, height: H * 2 });
    canvas.getContext("2d").drawImage(img, 0, 0, W * 2, H * 2);
    canvas.toBlob(blob => download(`${name}.png`, blob, "image/png"), "image/png");
  };
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(source);
}

/* ---- files, links, examples -------------------------------------------------- */
async function loadExample(file) {
  const ex = state.examples.find(e => e.file === file);
  const res = await fetch(`examples/${file}`);
  if (!res.ok) { toast(`Could not load ${file}`); return; }
  state.title = ex ? ex.title : file;
  setText(await res.text(), file);
  store("example", file);
}
$("example").addEventListener("change", e => { if (e.target.value) loadExample(e.target.value); });
$("open").addEventListener("click", () => $("file").click());
$("file").addEventListener("change", async e => {
  const f = e.target.files[0];
  if (!f) return;
  state.title = f.name;
  $("example").value = "";
  store("example", "");
  setText(await f.text(), f.name);
  e.target.value = "";
});
document.addEventListener("dragover", e => e.preventDefault());
document.addEventListener("drop", async e => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (!f) return;
  state.title = f.name;
  $("example").value = "";
  store("example", "");
  setText(await f.text(), f.name);
});
$("save").addEventListener("click", () => download(state.fileName.endsWith(".mod") ? state.fileName : stem() + ".mod", text.value, "text/plain"));

/* A link carries the model and what was moved, compressed, after the #. */
const b64 = { enc: bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), dec: s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0)) };
async function pipe(bytes, stream) { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer()); }
$("share").addEventListener("click", async () => {
  const payload = new TextEncoder().encode(JSON.stringify({ t: text.value, o: state.overrides, s: state.sd, n: state.fileName }));
  const packed = "CompressionStream" in window ? await pipe(payload, new CompressionStream("deflate-raw")) : payload;
  const chunk = []; for (let i = 0; i < packed.length; i += 8192) chunk.push(String.fromCharCode(...packed.subarray(i, i + 8192)));
  const url = `${location.origin}${location.pathname}#${"CompressionStream" in window ? "z" : "j"}=${btoa(chunk.join("")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
  history.replaceState(null, "", url);
  try { await navigator.clipboard.writeText(url); toast("Link copied"); } catch { toast("The link is in the address bar"); }
});
async function fromLink() {
  const m = /^#([zj])=(.+)$/.exec(location.hash);
  if (!m) return false;
  try {
    const bytes = b64.dec(m[2]);
    const data = JSON.parse(new TextDecoder().decode(m[1] === "z" ? await pipe(bytes, new DecompressionStream("deflate-raw")) : bytes));
    state.title = data.n || "shared model";
    setText(data.t, data.n || "model.mod");
    state.overrides = data.o || {}; state.sd = data.s || null;       /* the text is read by now; show what was moved */
    renderParams();
    return true;
  } catch { toast("That link could not be read"); return false; }
}

/* ---- theme, about -------------------------------------------------------------- */
const isDark = () => { const t = document.documentElement.dataset.theme; return t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches; };
const themeLabel = () => { $("theme").textContent = isDark() ? "Light" : "Dark"; };
$("theme").addEventListener("click", () => {
  document.documentElement.dataset.theme = isDark() ? "light" : "dark";
  store("theme", document.documentElement.dataset.theme);
  themeLabel();
});
if (recall("theme")) document.documentElement.dataset.theme = recall("theme");
themeLabel();
$("about-open").addEventListener("click", async () => {
  const t = $("validation");
  if (!t.childElementCount) {
    try {
      const rows = await (await fetch("validation.json")).json();
      t.append(h("thead", {}, h("tr", {}, ["Model", "Variables", "Shocks", "Largest difference from Dynare"].map((c, i) => h("th", { class: i === 0 ? "text" : "", text: c })))),
        h("tbody", {}, rows.models.map(r => h("tr", {}, h("td", { class: "text", text: r.title }), h("td", { text: String(r.variables) }), h("td", { text: String(r.shocks) }), h("td", { text: r.worst.toExponential(1).replace("e-", " × 10^−") })))));
    } catch { /* the table is a nicety */ }
  }
  $("about").showModal();
});

/* ---- start ------------------------------------------------------------------------ */
async function boot() {
  render();
  engine.start().catch(e => { state.result = { ok: false, error: `the Cozy engine could not start (${e.message})` }; render(); });
  try { state.examples = await (await fetch("examples/index.json")).json(); } catch { state.examples = []; }
  $("example").replaceChildren(h("option", { value: "", text: "Examples…" }), ...state.examples.map(e => h("option", { value: e.file, text: e.title, title: e.about })));
  const tab = recall("tab");
  if (TABS.includes(tab)) state.tab = tab;
  if (await fromLink()) { run(); return; }
  const saved = recall("text");
  if (saved && saved.trim()) {
    /* pick up where the last visit left off; an untouched example is still that example */
    const ex = state.examples.find(e => e.file === recall("example"));
    state.title = ex ? ex.title : "your model";
    if (ex) $("example").value = ex.file;
    setText(saved, recall("name") || "model.mod");
    return;
  }
  if (state.examples.length) { $("example").value = state.examples[0].file; await loadExample(state.examples[0].file); }
}
boot();
