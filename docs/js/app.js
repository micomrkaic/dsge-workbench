/* app.js — the DSGE workbench's page.
 *
 * The page keeps one model at a time. When its text changes it is read
 * again (modfile.js) and compiled by Cozy (solve.js, through the worker in
 * engine.js); when a parameter moves it is only solved again. Every solve
 * replaces the results, and the open tab is redrawn from them.
 *
 * Part of dsge-workbench. Copyright (C) 2026 Mico Mrkaic.
 * GPL-3.0-or-later; see LICENSE. */
import { parseMod, printAst } from "./modfile.js";
import { Workbench, standaloneScript } from "./solve.js";
import { EngineClient } from "./engine.js";
import { h, svg, fmt, lineChart, rootsChart, stackedBars, heatmap, legend, SERIES, hideTip } from "./charts.js";

const $ = id => document.getElementById(id);
const BASE_TABS = ["Summary", "Impulse responses", "Moments", "Variance", "Simulation", "Decision rule", "Cozy script"];
const TABS = [...BASE_TABS.slice(0, 5), "Constraint", ...BASE_TABS.slice(5)];
/* The Constraint tab is there for a model that declares an occasionally binding constraint. */
const tabsNow = () => (state.model && state.model.constraints.length ? TABS : BASE_TABS);
const STORE = "dsge-workbench:";

const state = {
  examples: [], title: "", fileName: "model.mod",
  parsed: null, model: null,            /* the last reading of the text; model is null if it has errors */
  loadError: "",                        /* Cozy refused the model */
  overrides: {}, sd: null,              /* parameter values and shock sizes moved away from the model's own */
  horizon: 40,
  order: 1,                             /* 1 or 2: the order of approximation asked for */
  size: 1,                              /* second order: the size of the shock in the responses, in standard deviations */
  result: null, solving: false,
  tab: "Summary",
  shock: 0, units: "dev", pinned: null,
  vars: null,                           /* names shown in charts and tables */
  relTo: null,                          /* moments: standard deviations relative to this variable */
  sim: { T: 200, seed: 1, path: null, vars: [], slots: {}, part: "total" },      /* part: which of a second-order path is drawn */
  /* the simulation with an occasionally binding constraint: the file's surprise shocks or one innovation of
   * `size` standard deviations in period 1, over T periods; levels or deviations; the result, or why there is none */
  occ: { mode: "file", shock: 0, size: -3, T: 40, units: "level", result: null, error: "" },
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
  state.overrides = {}; state.sd = null; state.pinned = null; state.vars = null; state.relTo = null; state.shock = 0; state.size = 1;
  state.sim.vars = []; state.sim.slots = {}; state.sim.path = null;
  freshText = true;
  paint();
  store("text", value);
  store("name", state.fileName);
  $("editor").scrollTop = 0;
  textChanged();
}

/* ---- from text to results ---------------------------------------------- */
let running = false, again = false, textDirty = false, freshText = false;
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
    if (state.model && freshText) {
      /* a file just opened: at the order it asks for, with its own scenario for its constraint */
      if (state.model.hints.order === 2 && !state.model.linear) state.order = 2;
      const o = state.model.occbin;
      state.occ = { ...state.occ, mode: o && o.shocks ? "file" : "one", shock: 0, size: -3, units: "level", result: null, error: "",
        T: state.model.hints.occbinT || (o && o.shocks ? Math.max(40, o.shocks.length + 20) : 40) };
    }
    freshText = false;
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
  const r = await wb.solve(state.overrides, { horizon: state.horizon, shocks: shocksNow(), order: orderNow(), size: state.size });
  clearTimeout(slow);
  $("view").classList.remove("stale");
  state.solving = false;
  state.result = r;
  state.sim.path = null;
  state.occ.result = null; state.occ.error = "";
  if (r.ok && r.determinate && state.tab === "Simulation") await simulate();
  if (r.ok && r.determinate && state.tab === "Constraint") await constrain();
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
  if (state.occ.shock >= model.exo.length) state.occ.shock = 0;
  if (state.occ.mode === "file" && !(model.occbin && model.occbin.shocks)) state.occ.mode = "one";
  state.horizon = state.horizon && before ? state.horizon : model.hints.irf;
  const names = model.endo.filter(v => !v.aux).map(v => v.name);
  if (!state.vars || !state.vars.every(n => names.includes(n))) state.vars = names.slice(0, 16);
  if (!names.includes(state.relTo)) state.relTo = names[0];
  state.sim.vars = state.sim.vars.filter(n => names.includes(n));
  if (!state.sim.vars.length) names.slice(0, 3).forEach(simToggle);
  if (state.pinned && state.pinned.names.join() !== model.endo.map(v => v.name).join()) state.pinned = null;
}
function shocksNow() { return { sd: state.sd || state.model.shocks.sd, corr: state.model.shocks.corr }; }
/* A model declared linear has no second-order terms: it is solved to first order whatever is asked. */
function orderNow() { return state.order === 2 && state.model && !state.model.linear ? 2 : 1; }
const second = () => (solved() && state.result.second && !state.result.second.linear ? state.result.second : null);
function setOrder(o) {
  if (o === state.order) return;
  state.order = o;
  store("order", String(o));
  state.pinned = null;                  /* a baseline of the other order would be a different thing */
  run();
}

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
/* The order of approximation is chosen in the status line, where it stays in view on every tab. */
function orderSwitch() {
  const linear = !!(state.model && state.model.linear);
  return h("div", { class: "seg order", role: "group", "aria-label": "Order of approximation" },
    h("button", { type: "button", class: orderNow() === 1 ? "on" : "", text: "1st order", title: "The linear solution: y = P y(-1) + Q e", onclick: () => setOrder(1) }),
    h("button", { type: "button", class: orderNow() === 2 ? "on" : "", text: "2nd order", disabled: linear,
      title: linear ? "This model is declared linear: its second-order solution is its first-order one" : "Add the second-order terms: risk shifts the means, and responses depend on the size and sign of a shock",
      onclick: () => setOrder(2) }));
}
function renderStatus() {
  const box = h("div", { class: "status-main" }), r = state.result;
  $("status").replaceChildren(box, orderSwitch());
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
  box.append(h("span", { class: "dim", text: `${r.order === 2 ? "second order, " : ""}solved in ${r.ms} ms by Cozy ${engine.version}` }));
}
function renderTabs() {
  $("tabs").replaceChildren(...tabsNow().map(t => h("button", { type: "button", role: "tab", "aria-selected": String(t === state.tab), text: t, onclick: () => openTab(t) })));
}
async function openTab(t) {
  state.tab = t;
  store("tab", t);
  if (t === "Simulation" && !state.sim.path && solved()) await simulate();
  if (t === "Constraint" && !state.occ.result && solved()) await constrain();
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
    m.constraints.length ? tile("Constraints", m.constraints.length, m.occbin ? `'${m.occbin.name}': see the Constraint tab` : "more than the one the workbench simulates") : null,
    tile("Forward-looking", r.forward, "appear with a lead"),
    tile("State variables", r.backward, "appear with a lag"),
    tile("Unstable roots", r.unstable, r.determinate ? "as many as needed" : `${r.forward} needed`),
    tile("Solved in", `${r.ms} ms`, `${r.order === 2 ? "to second order, " : ""}Cozy ${engine.version}`)));
  view.append(h("h3", { text: "Eigenvalues" }), h("div", { class: "wide" }, rootsChart(r.roots)),
    h("p", { class: "foot", text: "Moduli of the model's generalised eigenvalues, on a log scale. Roots at zero and at infinity sit at the edges. Hover a dot for its value." }));
  const how = wb.steadyKind === "formula" ? "given by the model's steady_state_model block and checked against the equations"
    : wb.steadyKind === "zero" ? "zero: the model is linear and has no constant terms" : "found by Newton's method with exact derivatives, starting from initval";
  const s2 = second();
  const rows = m.endo.filter(v => !v.aux).map(v => { const i = indexOf(v.name); return { cells: [v.name, v.longName, r.steady[i], ...(s2 ? [r.steady[i] + s2.mean[i], s2.mean[i]] : [])] }; });
  const head = ["Variable", "Description", "Steady state", ...(s2 ? ["Mean, second order", "Difference"] : [])];
  view.append(h("h3", { text: s2 ? "Steady state and mean" : "Steady state" }),
    h("div", { class: "bar" }, h("span", { class: "dim", text: `The steady state is ${how}.` }), h("span", { class: "spacer" }),
      exportButtons(() => download(`${stem()}-steady-state.csv`, csv([head.map(x => x.toLowerCase()), ...rows.map(x => x.cells)]), "text/csv"))),
    table(head, rows, { text: [1], digits: 8 }));
  if (s2) view.append(h("p", { class: "foot", text: "To first order a variable's mean is its steady state. To second order it is not: uncertainty about the future shifts the decision rule, and the rule's curvature turns the variance of the states and shocks into a change in the mean." +
    (s2.mean.some(Number.isNaN) ? " A dash marks a variable that has no mean: it has a unit root, or depends on one that has." : "") }));
}

/* ---- Impulse responses --------------------------------------------------- */
/* The responses on show: to second order where that was solved for, else to first. */
const irfNow = () => (second() ? second().irf : state.result.irf);
function irfSeries(name) {
  const r = state.result, i = indexOf(name), ss = r.steady[i], s2 = second();
  const pct = state.units === "pct" && Math.abs(ss) > 1e-9;
  const scale = v => (pct ? (100 * v) / Math.abs(ss) : v);
  const out = [{ name: s2 ? "second order" : "now", color: SERIES[0], values: irfNow()[state.shock].map(row => scale(row[i])) }];
  /* what a linear model would say of a shock of this size: the second-order line is read against it */
  if (s2) out.unshift({ name: "first order", color: SERIES[1], dashed: true, values: r.irf[state.shock].map(row => scale(s2.size * row[i])) });
  const p = state.pinned;
  if (p && p.irf[state.shock]) out.unshift({ name: "pinned", color: "var(--muted)", dashed: true, values: p.irf[state.shock].map(row => (pct ? (100 * row[i]) / Math.abs(p.steady[i]) : row[i])) });
  return { series: out, pct };
}
function viewIrf(view) {
  if (!solved()) { view.append(noSolution()); return; }
  const r = state.result, m = state.model, sd = shocksNow().sd, s2 = second();
  const shockSel = h("select", { "aria-label": "Shock", onchange: e => { state.shock = +e.target.value; render(); } },
    m.exo.map((s, j) => h("option", { value: j, selected: j === state.shock, text: `${s.name}${s.longName ? " — " + s.longName : ""}${sd[j] === 0 ? " (size 0)" : ""}` })));
  const anyLevel = r.steady.some(v => Math.abs(v) > 1e-9);
  const names = shown();
  const cards = () => [...view.querySelectorAll(".card")].map(c => ({ title: c.dataset.name, sub: c.dataset.sub, chart: c.querySelector("svg") }));
  view.append(h("div", { class: "bar" },
    h("label", {}, "Shock", shockSel),
    h("label", {}, "Horizon", h("input", { type: "number", min: 4, max: 400, step: 1, value: state.horizon, onchange: e => { state.horizon = Math.max(4, Math.min(400, Math.round(+e.target.value) || 40)); state.pinned = null; run(); } })),
    s2 ? h("label", { title: "The size of the shock, in standard deviations; negative for a shock the other way. To second order the response is not proportional to it." }, "Size",
      h("input", { type: "number", step: 0.5, min: -20, max: 20, value: state.size, "aria-label": "Shock size in standard deviations", onchange: e => { const v = Math.max(-20, Math.min(20, +e.target.value)); state.size = Number.isFinite(v) && v !== 0 ? v : 1; state.pinned = null; run(); } }), "s.d.") : null,
    anyLevel ? h("div", { class: "seg", role: "group", "aria-label": "Units" },
      h("button", { type: "button", class: state.units === "dev" ? "on" : "", text: "Deviation", onclick: () => { state.units = "dev"; render(); } }),
      h("button", { type: "button", class: state.units === "pct" ? "on" : "", text: "% of steady state", onclick: () => { state.units = "pct"; render(); } })) : null,
    h("button", { type: "button", text: state.pinned ? "Re-pin" : "Pin as baseline", title: "Keep these responses on the charts while you change parameters", onclick: () => { state.pinned = { irf: irfNow(), steady: r.steady, names: r.names.slice() }; render(); } }),
    state.pinned ? h("button", { type: "button", text: "Unpin", onclick: () => { state.pinned = null; render(); } }) : null,
    h("span", { class: "spacer" }),
    h("button", { type: "button", class: "small" + (state.table ? " on" : ""), text: "Table", title: "Show the numbers instead of the charts", onclick: () => { state.table = !state.table; render(); } }),
    exportButtons(() => download(`${stem()}-irf-${m.exo[state.shock].name}.csv`, csv([["period", ...names], ...r.irf[state.shock].map((row, t) => [t, ...names.map(nm => irfSeries(nm).series.at(-1).values[t])])]), "text/csv"), state.table ? null : cards)));
  if (state.pinned || s2) view.append(legend([
    { name: s2 ? "second order" : "these settings", color: SERIES[0] },
    ...(s2 ? [{ name: "first order, the same shock", color: SERIES[1], dashed: true }] : []),
    ...(state.pinned ? [{ name: "pinned baseline", color: "var(--muted)", dashed: true }] : [])]));
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
  const what = s2
    ? `Responses to second order to an innovation of ${fmt(s2.size, 3)} standard deviation${Math.abs(s2.size) === 1 ? "" : "s"} in ${m.exo[state.shock].name} (${fmt(s2.size * size, 4)}) at period 0 and no shocks after: the path with the shock less the path without it, both from the steady state and pruned. The dashed line is the first-order response to the same shock`
    : `Responses to a one-standard-deviation innovation in ${m.exo[state.shock].name} (${fmt(size, 4)}) at period 0, as deviations from the steady state`;
  view.append(h("p", { class: "foot", text: `${what}${state.units === "pct" && anyLevel ? ", in percent of the steady state where it is not zero" : ""}.` +
    (m.shocks.corr.some((row, i) => row.some((c, j) => i !== j && c !== 0)) ? " The shocks are correlated; they are orthogonalised in the order declared, as in Dynare." : "") }));
}

/* ---- Moments ------------------------------------------------------------- */
function viewMoments(view) {
  if (!solved()) { view.append(noSolution()); return; }
  const r = state.result, m = state.model, names = m.endo.filter(v => !v.aux).map(v => v.name);
  const ref = r.sd[indexOf(state.relTo)], s2 = second();
  const rows = names.map(nm => { const i = indexOf(nm); return { cells: [nm, ...(s2 ? [r.steady[i], r.steady[i] + s2.mean[i]] : [r.steady[i]]), r.sd[i], r.sd[i] / ref, ...r.acorr[i]] }; });
  const head = ["Variable", ...(s2 ? ["Steady state", "Mean"] : ["Mean"]), "Std. dev.", `Relative to ${state.relTo}`, ...r.acorr[0].map((_, j) => `AC(${j + 1})`)];
  const pick = shown();
  const corr = pick.map(a => pick.map(b => r.corr[indexOf(a)][indexOf(b)]));
  view.append(h("div", { class: "bar" },
    h("label", {}, "Standard deviations relative to", h("select", { onchange: e => { state.relTo = e.target.value; render(); } }, names.map(nm => h("option", { value: nm, selected: nm === state.relTo, text: nm })))),
    h("span", { class: "spacer" }),
    exportButtons(() => download(`${stem()}-moments.csv`, csv([head.map(x => x.replace(/^Relative to .*/, `sd relative to ${state.relTo}`)), ...rows.map(x => x.cells)]), "text/csv"))),
    table(head, rows));
  if (s2) view.append(h("p", { class: "foot", text: "The mean is to second order. The standard deviations, correlations and autocorrelations are those of the first-order solution, which is also what Dynare reports at order 2." }));
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
  if (second()) view.append(h("p", { class: "foot", text: "The decomposition is that of the first-order solution: to second order the shocks' effects do not add up, so a variance has no shares." }));
}

/* ---- Simulation ----------------------------------------------------------- */
async function simulate() {
  if (!solved()) return;
  const s = state.sim;
  try {
    if (second()) {
      /* the same draws to both orders: the first-order path and the correction that second order adds */
      const both = await wb.simulate(s.T, s.seed, true);
      s.path = both.first.map((row, t) => Array.from(row, (v, i) => (s.part === "first" ? v : s.part === "diff" ? both.second[t][i] : v + both.second[t][i])));
    } else s.path = await wb.simulate(s.T, s.seed);
  } catch (e) { s.path = null; toast(e.message); }
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
  const r = state.result, s = state.sim, s2 = second();
  const redo = async () => { await simulate(); render(); };
  const all = state.model.endo.filter(v => !v.aux).map(v => v.name);
  const part = s2 ? s.part : "first";
  const partButton = (key, label, title) => h("button", { type: "button", class: s.part === key ? "on" : "", text: label, title, onclick: () => { s.part = key; redo(); } });
  view.append(h("div", { class: "bar" },
    h("label", {}, "Periods", h("input", { type: "number", min: 20, max: 5000, step: 10, value: s.T, onchange: e => { s.T = Math.max(20, Math.min(5000, Math.round(+e.target.value) || 200)); redo(); } })),
    h("label", {}, "Seed", h("input", { type: "number", min: 0, step: 1, value: s.seed, onchange: e => { s.seed = Math.max(0, Math.round(+e.target.value) || 0); redo(); } })),
    h("button", { type: "button", text: "New draw", onclick: () => { s.seed++; redo(); } }),
    s2 ? h("div", { class: "seg", role: "group", "aria-label": "Which path" },
      partButton("total", "Second order", "The pruned second-order path"),
      partButton("first", "First order", "The first-order path for the same shocks"),
      partButton("diff", "Difference", "What the second-order terms add to the first-order path")) : null,
    h("span", { class: "spacer" }),
    exportButtons(() => s.path && download(`${stem()}-simulation${part === "diff" ? "-difference" : ""}.csv`, csv([["period", ...all], ...s.path.map((row, t) => [t + 1, ...all.map(nm => row[indexOf(nm)] + (part === "diff" ? 0 : r.steady[indexOf(nm)]))])]), "text/csv"),
      () => [{ title: part === "diff" ? "Simulated path, second order less first order" : "Simulated path, deviations from the steady state", sub: s.vars.join(" · "), chart: view.querySelector("svg.chart") }])));
  view.append(h("div", { class: "pickers", role: "group", "aria-label": "Variables drawn (up to four)" },
    all.map(n => h("button", { type: "button", class: "chip", "aria-pressed": String(s.vars.includes(n)), title: longOf(n) || n, text: n, onclick: () => { simToggle(n); render(); } }))));
  if (!s.path) { view.append(h("p", { class: "empty", text: "Drawing…" })); return; }
  if (!s.vars.length) { view.append(h("p", { class: "empty", text: "Choose up to four variables above." })); return; }
  const series = s.vars.slice().sort((a, b) => s.slots[a] - s.slots[b]).map(nm => ({ name: nm + (longOf(nm) ? ` — ${longOf(nm)}` : ""), color: SERIES[s.slots[nm]], values: s.path.map(row => row[indexOf(nm)]) }));
  if (series.length > 1) view.append(legend(series));
  const width = Math.max(480, Math.min(1400, view.clientWidth - 58));
  view.append(h("div", { class: "wide" }, lineChart(series, { width, height: Math.round(Math.max(260, Math.min(380, width * 0.4))), x0: 1, xLabel: "period", period: "period", label: "simulated path", thin: s.T > 120 })),
    h("p", { class: "foot", text: (part === "diff"
      ? `What the second-order terms add to a first-order path of ${s.T} periods from the steady state: the pruned second-order path less the first-order path for the same shocks${series.length === 1 ? ` (${series[0].name})` : ""}. The CSV holds this difference for every variable.`
      : `One random path of ${s.T} periods from the steady state, as deviations from it${series.length === 1 ? ` (${series[0].name})` : ""}${s2 && part === "total" ? ", to second order with pruning: the first-order path feeds the second-order correction and never the other way, so the path cannot explode" : ""}. The CSV holds every variable, in levels.`) + " The same seed gives the same path." }));
}

/* ---- Constraint -------------------------------------------------------------- */
/* The shocks of the run, one row per period in the shocks' own units: the
 * file's, or one orthogonalised innovation of `size` standard deviations in
 * period 1 (the innovation of the impulse responses). */
function scenarioShocks() {
  const m = state.model, o = state.occ, { sd, corr } = shocksNow(), k = m.exo.length;
  if (o.mode === "file" && m.occbin.shocks) return m.occbin.shocks;
  const L = corr.map(row => row.map(() => 0));        /* Cholesky factor of the correlations */
  for (let i = 0; i < k; i++) for (let j = 0; j <= i; j++) {
    let sum = corr[i][j];
    for (let q = 0; q < j; q++) sum -= L[i][q] * L[j][q];
    L[i][j] = i === j ? Math.sqrt(Math.max(sum, 0)) : (L[j][j] > 0 ? sum / L[j][j] : 0);
  }
  return [m.exo.map((_, i) => o.size * sd[i] * L[i][o.shock])];
}
const scenarioNow = () => ({ shocks: scenarioShocks(), T: state.occ.T, ahead: state.model.hints.occbinAhead || 100 });
async function constrain() {
  const o = state.occ;
  o.result = null; o.error = "";
  if (!solved() || !state.model.occbin) return;
  try { const s = scenarioNow(); o.result = await wb.occbin(s.shocks, { T: s.T, ahead: s.ahead }); }
  catch (e) { o.error = e.message; }
}
/* Runs of true in a list, as [first, last] positions. */
const runs = flags => { const out = []; flags.forEach((f, t) => { if (!f) return; if (out.length && out.at(-1)[1] === t - 1) out.at(-1)[1] = t; else out.push([t, t]); }); return out; };
function viewConstraint(view) {
  const m = state.model, r = state.result, o = state.occ;
  if (!m) { view.append(noSolution()); return; }
  if (!m.occbin) {
    view.append(h("p", { class: "empty", text: `This model declares ${m.constraints.length} occasionally binding constraints (${m.constraints.join(", ")}). The workbench simulates models with one; the other tabs show this model with none of them binding.` }));
    return;
  }
  /* the conditions as the file wrote them: a hidden steady-state parameter is shown as steady_state(x) */
  const ssOf = new Map(m.ssParams.map(s => [s.name, s.of]));
  const show = e => printAst(e, n => (ssOf.has(n.name) ? `steady_state(${ssOf.get(n.name)})` : n.name));
  view.append(h("div", { class: "condition" },
    h("strong", { text: `Constraint '${m.occbin.name}'` }), " binds when ", h("code", { text: show(m.occbin.bind) }),
    m.occbin.relax ? [" and is released when ", h("code", { text: show(m.occbin.relax) }), "."] : " and is released when that is no longer so.",
    h("div", { class: "dim", text: "The equations tagged relax hold while it is slack, and those tagged bind replace them while it binds. Every other tab shows the model with the constraint slack." })));
  if (!solved()) { view.append(noSolution()); return; }
  const sd = shocksNow().sd, redo = async () => { await constrain(); render(); };
  const fromFile = !!m.occbin.shocks, one = o.mode !== "file" || !fromFile;
  const names = shown();
  const level = o.units === "level";
  const value = (rows, t, i) => rows[t][i] - (level ? 0 : r.steady[i]);
  const cards = () => [...view.querySelectorAll(".card")].map(c => ({ title: c.dataset.name, sub: c.dataset.sub, chart: c.querySelector("svg") }));
  const res = o.result;
  view.append(h("div", { class: "bar" },
    fromFile ? h("div", { class: "seg", role: "group", "aria-label": "Shocks" },
      h("button", { type: "button", class: one ? "" : "on", text: "The file's shocks", title: "The surprise shocks of the model file's shocks(surprise) block", onclick: () => { o.mode = "file"; redo(); } }),
      h("button", { type: "button", class: one ? "on" : "", text: "One shock", title: "A single innovation in period 1", onclick: () => { o.mode = "one"; redo(); } })) : null,
    one ? h("label", {}, "Shock", h("select", { "aria-label": "Shock", onchange: e => { o.shock = +e.target.value; redo(); } },
      m.exo.map((x, j) => h("option", { value: j, selected: j === o.shock, text: `${x.name}${x.longName ? " — " + x.longName : ""}${sd[j] === 0 ? " (size 0)" : ""}` })))) : null,
    one ? h("label", { title: "The size of the innovation in period 1, in standard deviations; negative for a shock the other way" }, "Size",
      h("input", { type: "number", step: 0.5, min: -50, max: 50, value: o.size, "aria-label": "Shock size in standard deviations", onchange: e => { const v = Math.max(-50, Math.min(50, +e.target.value)); o.size = Number.isFinite(v) ? v : -3; redo(); } }), "s.d.") : null,
    h("label", {}, "Periods", h("input", { type: "number", min: 4, max: 400, step: 1, value: o.T, "aria-label": "Periods simulated", onchange: e => { o.T = Math.max(4, Math.min(400, Math.round(+e.target.value) || 40)); redo(); } })),
    h("div", { class: "seg", role: "group", "aria-label": "Units" },
      h("button", { type: "button", class: level ? "on" : "", text: "Level", onclick: () => { o.units = "level"; render(); } }),
      h("button", { type: "button", class: level ? "" : "on", text: "Deviation", title: "From the steady state", onclick: () => { o.units = "dev"; render(); } })),
    h("span", { class: "spacer" }),
    h("button", { type: "button", class: "small" + (state.table ? " on" : ""), text: "Table", title: "Show the numbers instead of the charts", onclick: () => { state.table = !state.table; render(); } }),
    exportButtons(() => res && download(`${stem()}-constraint.csv`, csv([["period", "binding", ...names.flatMap(nm => [nm, `${nm} (ignoring the constraint)`])],
      ...res.path.map((_, t) => [t + 1, res.binding[t] ? 1 : 0, ...names.flatMap(nm => [value(res.path, t, indexOf(nm)), value(res.linear, t, indexOf(nm))])])]), "text/csv"), state.table || !res ? null : cards)));
  if (o.error) { view.append(h("div", { class: "verdict bad" }, h("strong", { text: "No path was found" }), h("span", { text: o.error }))); return; }
  if (!res) { view.append(h("p", { class: "empty", text: "Simulating…" })); return; }
  const bands = runs(res.binding), bound = res.binding.filter(Boolean).length;
  const spans = bands.map(([a, b]) => (a === b ? `${a + 1}` : `${a + 1}–${b + 1}`)).join(", ");
  view.append(h("div", { class: "verdict" },
    h("strong", { text: bound ? `The constraint binds in ${bound} of ${res.path.length} periods` : "The constraint never binds" }),
    h("span", { text: bound ? `Period${bands.length === 1 && bands[0][0] === bands[0][1] ? "" : "s"} ${spans}. Where the two lines part, the constraint is changing the outcome, in the periods it binds and in those before and after.` : "With these shocks the path is the linear one. Try a larger shock, or one of the other sign." })));
  view.append(legend([{ name: "with the constraint", color: SERIES[0] }, { name: "ignoring it", color: SERIES[1], dashed: true }, ...(bound ? [{ name: "periods in which it binds", color: SERIES[1], kind: "box", faint: true }] : [])]));
  const picker = chips(state.vars, toggleVar, allNone());
  if (picker) view.append(picker);
  if (!names.length) { view.append(h("p", { class: "empty", text: "Choose variables above." })); return; }
  if (state.table) {
    view.append(table(["Period", "Binds", ...names.flatMap(nm => [nm, `${nm}, ignoring it`])],
      res.path.map((_, t) => ({ cells: [String(t + 1), res.binding[t] ? "yes" : "", ...names.flatMap(nm => [value(res.path, t, indexOf(nm)), value(res.linear, t, indexOf(nm))])] })), { text: [1] }));
  } else {
    const group = { charts: [] };
    view.append(h("div", { class: "multiples" }, names.map(nm => {
      const i = indexOf(nm), sub = (longOf(nm) || "") + (level ? "" : (longOf(nm) ? ", " : "") + "deviation from the steady state");
      const series = [{ name: "ignoring it", color: SERIES[1], dashed: true, values: res.linear.map((_, t) => value(res.linear, t, i)) },
        { name: "with the constraint", color: SERIES[0], values: res.path.map((_, t) => value(res.path, t, i)) }];
      return h("div", { class: "card", "data-name": nm, "data-sub": sub }, h("h4", { text: nm }), h("div", { class: "sub", text: sub }),
        lineChart(series, { group, title: nm, period: "period", x0: 1, bands, zero: !level ? true : false, label: `path of ${nm} with and without the constraint` }));
    })));
  }
  const what = one ? `an innovation of ${fmt(o.size, 3)} standard deviation${Math.abs(o.size) === 1 ? "" : "s"} in ${m.exo[o.shock].name} in period 1` : "the surprise shocks of the model file";
  view.append(h("p", { class: "foot", text: `The path from the steady state for ${what}, by the piecewise-linear method of Guerrieri and Iacoviello (2015), the method of Dynare's OccBin: in each period agents expect no further shocks, and the periods in which the constraint will bind are guessed and checked until the guess agrees with the path. The model is linear within each regime, so this is not the second-order solution; the order switch does not change it.` }));
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
  const s2 = second();
  if (!s2) return;
  /* each product once: a square's coefficient is half the second derivative, a cross term's the whole of it */
  const nx = s2.states.length, k = m.exo.length, lag = nm => `${nm}(-1)`, terms = [{ label: "Risk (no product)", of: i => 0.5 * s2.s2[i] }];
  for (let a = 0; a < nx; a++) for (let b = a; b < nx; b++) terms.push({ label: `${lag(s2.states[a])} × ${lag(s2.states[b])}`, of: i => (a === b ? 0.5 : 1) * s2.Gxx[i][a * nx + b], sep: a === 0 && b === 0 });
  for (let a = 0; a < nx; a++) for (let j = 0; j < k; j++) terms.push({ label: `${lag(s2.states[a])} × ${m.exo[j].name}`, of: i => s2.Gxu[i][a * k + j], sep: a === 0 && j === 0 });
  for (let j = 0; j < k; j++) for (let l = j; l < k; l++) terms.push({ label: `${m.exo[j].name} × ${m.exo[l].name}`, of: i => (j === l ? 0.5 : 1) * s2.Guu[i][j * k + l], sep: j === 0 && l === 0 });
  const rows2 = terms.map(t => ({ sep: t.sep, cells: [t.label, ...ci.map(t.of)] })).filter((row, q) => q === 0 || row.cells.slice(1).some(v => v !== 0));
  view.append(h("h3", { text: "Second-order terms" }),
    h("div", { class: "bar" },
      h("span", { class: "dim", text: `What second order adds to each variable: a constant for risk, and a coefficient on each product of two of last period's state variables or this period's shocks (${rows2.length - 1} of ${terms.length - 1} products have one).` }),
      h("span", { class: "spacer" }),
      exportButtons(() => download(`${stem()}-decision-rule-second-order.csv`, csv([["", ...cols], ...rows2.map(x => x.cells)]), "text/csv"))),
    table(["", ...cols], rows2, { digits: 6 }),
    h("p", { class: "foot", text: "Add to the first-order rule: the first row, and each coefficient times its product (state variables as deviations from the steady state). Each product is listed once, so the coefficient of a square is half of Dynare's ghxx or ghuu entry, that of a cross term the whole entry, and the first row is half of ghs2." }));
}

/* ---- Cozy script ------------------------------------------------------------ */
function viewCozy(view) {
  const r = state.result;
  if (!state.model || !r || !r.ok) { view.append(noSolution()); return; }
  const script = standaloneScript(state.model, r, shocksNow(), state.title || stem(), state.model.occbin && r.determinate ? scenarioNow() : null);
  view.append(h("div", { class: "bar" },
    h("span", { class: "dim", text: "The same model at these parameter values, as a script for Cozy. It runs in the command-line interpreter and in Cozy's playground." }),
    h("span", { class: "spacer" }),
    h("button", { type: "button", class: "small", text: "Copy", onclick: () => navigator.clipboard.writeText(script).then(() => toast("Copied")) }),
    h("button", { type: "button", class: "small", text: "Download", onclick: () => download(`${stem()}.cz`, script, "text/plain") })),
    h("pre", { class: "source", text: script }));
}

const VIEWS = { "Summary": viewSummary, "Impulse responses": viewIrf, "Moments": viewMoments, "Variance": viewVardecomp, "Simulation": viewSimulation, "Constraint": viewConstraint, "Decision rule": viewRule, "Cozy script": viewCozy };
function render() {
  hideTip();
  if (!tabsNow().includes(state.tab)) state.tab = "Summary";      /* a tab the model in hand does not have */
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
    .band{fill:${tok("--wash")}}.bind{fill:${tok("--series-2")};fill-opacity:0.13}.root{stroke:${tok("--raised")};stroke-width:2}.root.stable{fill:${tok("--series-1")}}.root.unstable{fill:${tok("--series-2")}}
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
  const payload = new TextEncoder().encode(JSON.stringify({ t: text.value, o: state.overrides, s: state.sd, n: state.fileName, q: state.order, z: state.size }));
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
    state.order = data.q === 2 ? 2 : 1;
    state.size = Number.isFinite(data.z) && data.z !== 0 ? data.z : 1;
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
      const sci = v => v.toExponential(1).replace("e-", " × 10^−");
      t.append(h("thead", {}, h("tr", {}, ["Model", "Variables", "Shocks", "First order", "Second order", "Constraint"].map((c, i) => h("th", { class: i === 0 ? "text" : "", text: c })))),
        h("tbody", {}, rows.models.map(r => h("tr", {}, h("td", { class: "text", text: r.title }), h("td", { text: String(r.variables) }), h("td", { text: String(r.shocks) }), h("td", { text: sci(r.worst) }),
          h("td", { class: r.second === null ? "none" : "", text: r.second === null ? "linear" : sci(r.second) }),
          h("td", { class: r.occbin === undefined ? "none" : "", text: r.occbin === undefined ? "" : sci(r.occbin) })))));
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
  if (recall("order") === "2") state.order = 2;
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
