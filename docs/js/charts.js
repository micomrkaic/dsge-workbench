/* charts.js — the workbench's charts, drawn as SVG with no library.
 *
 * Four forms: a line chart (impulse responses, simulated paths), a strip of
 * dots on a log axis (eigenvalues against the unit circle), a stacked bar
 * per variable (variance decomposition) and a heatmap (correlations). Every
 * one has a hover readout; colours come from CSS custom properties, so the
 * light and dark themes are chosen in the stylesheet, not here.
 *
 * Part of dsge-workbench. Copyright (C) 2026 Mico Mrkaic.
 * GPL-3.0-or-later; see LICENSE. */

const NS = "http://www.w3.org/2000/svg";
export function svg(tag, attrs = {}, parent) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (parent) parent.appendChild(el);
  return el;
}
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v !== false && v !== null && v !== undefined) el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}

/* The categorical slots, in their fixed order (see app.css). */
export const SERIES = [1, 2, 3, 4, 5, 6, 7, 8].map(i => `var(--series-${i})`);

/* A number for a table or a readout: `digits` significant figures, no
 * exponent for ordinary sizes, an em dash for a missing value. */
export function fmt(v, digits = 4) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  if (!Number.isFinite(v)) return v > 0 ? "∞" : "−∞";
  if (v === 0) return "0";
  const a = Math.abs(v);
  let s;
  if (a >= 1e6 || a < 1e-4) s = v.toExponential(Math.max(0, digits - 1)).replace(/\.?0+e/, "e").replace("e+", "e");
  else s = Number(v.toPrecision(digits)).toString();
  return s.replace("-", "−");
}

/* Round tick values covering [lo, hi], about `want` of them. */
export function ticks(lo, hi, want = 4) {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / want, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) || 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}
const tickText = (v, step) => fmt(v, Math.max(2, Math.min(6, Math.ceil(-Math.log10(Math.abs(step) / (Math.abs(v) || Math.abs(step)))) + 1)));

/* ---- one shared tooltip ------------------------------------------------ */
let tip;
export function showTip(x, y, rows, title) {
  if (!tip) tip = document.body.appendChild(h("div", { class: "tip", role: "status" }));
  tip.replaceChildren();
  if (title) tip.append(h("div", { class: "tip-title", text: title }));
  for (const r of rows) {
    const key = h("span", { class: "tip-key" });
    if (r.color) key.style.background = r.color; else key.style.visibility = "hidden";
    if (r.dashed) key.classList.add("dashed");
    tip.append(h("div", { class: "tip-row" }, key, h("strong", { text: r.value }), h("span", { class: "tip-name", text: r.name })));
  }
  tip.hidden = false;
  const w = tip.offsetWidth, ht = tip.offsetHeight;
  tip.style.left = Math.max(4, Math.min(window.innerWidth - w - 4, x + 14)) + "px";
  tip.style.top = Math.max(4, y - ht - 12 < 4 ? y + 18 : y - ht - 12) + "px";
}
export function hideTip() { if (tip) tip.hidden = true; }

/* ---- line chart -------------------------------------------------------- */
/* series: [{name, values, color, dashed}], one value per period starting at
 * `x0`. Options: width, height, zero (draw the zero line), xLabel, group (a
 * shared object: charts in the same group move their crosshairs together),
 * bands (runs of periods to shade, [[first, last], ...] as positions from 0). */
export function lineChart(series, opt = {}) {
  const W = opt.width || 240, H = opt.height || 140, x0 = opt.x0 || 0;
  const m = { l: 44, r: 10, t: 8, b: opt.xLabel ? 30 : 20 };
  const T = Math.max(...series.map(s => s.values.length));
  let lo = Infinity, hi = -Infinity;
  for (const s of series) for (const v of s.values) if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  if (!Number.isFinite(lo)) { lo = -1; hi = 1; }
  if (opt.zero !== false) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  if (hi - lo < 1e-12 * Math.max(1, Math.abs(hi))) { const pad = Math.abs(hi) > 0 ? Math.abs(hi) * 0.5 : 1; lo -= pad; hi += pad; }
  const pad = (hi - lo) * 0.08;
  lo -= pad; hi += pad;
  const px = t => m.l + (T > 1 ? (t / (T - 1)) * (W - m.l - m.r) : 0);
  const py = v => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);

  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": opt.label || "line chart" });
  for (const [a, b] of opt.bands || []) {             /* half a period either side, kept inside the plot */
    const x1 = Math.max(m.l, px(a - 0.5)), x2 = Math.min(W - m.r, px(b + 0.5));
    svg("rect", { x: x1.toFixed(1), y: m.t, width: Math.max(0, x2 - x1).toFixed(1), height: H - m.t - m.b, class: "bind" }, root);
  }
  const yt = ticks(lo, hi, 3), step = yt.length > 1 ? yt[1] - yt[0] : 1;
  for (const v of yt) {
    svg("line", { x1: m.l, x2: W - m.r, y1: py(v), y2: py(v), class: v === 0 ? "axis" : "grid" }, root);
    svg("text", { x: m.l - 6, y: py(v) + 3.5, class: "tick", "text-anchor": "end" }, root).textContent = tickText(v, step);
  }
  for (const t of ticks(x0, x0 + T - 1, Math.min(5, T - 1)).filter(Number.isInteger)) {
    svg("text", { x: px(t - x0), y: H - m.b + 13, class: "tick", "text-anchor": "middle" }, root).textContent = String(t);
  }
  if (opt.xLabel) svg("text", { x: W - m.r, y: H - 3, class: "tick", "text-anchor": "end" }, root).textContent = opt.xLabel;
  for (const s of series) {
    let d = "", pen = false;
    s.values.forEach((v, t) => { if (Number.isFinite(v)) { d += `${pen ? "L" : "M"}${px(t).toFixed(1)},${py(v).toFixed(1)}`; pen = true; } else pen = false; });
    const path = svg("path", { d, class: "line" + (s.dashed ? " dashed" : "") + (opt.thin ? " thin" : ""), fill: "none" }, root);
    path.style.stroke = s.color;
  }
  /* the hover layer: a hairline that snaps to the period, and one readout for every series */
  const cross = svg("line", { y1: m.t, y2: H - m.b, class: "cross", visibility: "hidden" }, root);
  const dots = series.map(s => { const c = svg("circle", { r: 3.5, class: "dot", visibility: "hidden" }, root); c.style.fill = s.color; return c; });
  const hit = svg("rect", { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, fill: "transparent" }, root);
  const mark = t => {
    cross.setAttribute("x1", px(t)); cross.setAttribute("x2", px(t)); cross.setAttribute("visibility", "visible");
    series.forEach((s, i) => {
      const v = s.values[t];
      if (Number.isFinite(v)) { dots[i].setAttribute("cx", px(t)); dots[i].setAttribute("cy", py(v)); dots[i].setAttribute("visibility", "visible"); }
      else dots[i].setAttribute("visibility", "hidden");
    });
  };
  const unmark = () => { cross.setAttribute("visibility", "hidden"); dots.forEach(d => d.setAttribute("visibility", "hidden")); };
  root._mark = mark; root._unmark = unmark;
  if (opt.group) opt.group.charts.push(root);
  hit.addEventListener("pointermove", e => {
    const box = root.getBoundingClientRect(), x = (e.clientX - box.left) * (W / box.width);
    const t = Math.max(0, Math.min(T - 1, Math.round(((x - m.l) / (W - m.l - m.r)) * (T - 1))));
    (opt.group ? opt.group.charts : [root]).forEach(c => c._mark(t));
    showTip(e.clientX, e.clientY, series.map(s => ({ color: s.color, dashed: s.dashed, value: fmt(s.values[t], 5), name: s.name })), `${opt.title ? opt.title + " · " : ""}${opt.period || "period"} ${t + x0}`);
  });
  hit.addEventListener("pointerleave", () => { (opt.group ? opt.group.charts : [root]).forEach(c => c._unmark()); hideTip(); });
  return root;
}

/* ---- eigenvalues ------------------------------------------------------- */
/* Moduli on a log axis from 0.01 to 100, with the unit circle marked. Roots
 * at or below 0.01 pile up at the left edge and those beyond 100 (the
 * infinite ones included) at the right. */
export function rootsChart(roots, opt = {}) {
  const W = opt.width || 640, H = 92, m = { l: 14, r: 14, t: 26, b: 26 };
  const LO = -2, HI = 2;
  const px = v => m.l + ((Math.max(LO, Math.min(HI, Math.log10(Math.max(v, 1e-300)))) - LO) / (HI - LO)) * (W - m.l - m.r);
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": "eigenvalue moduli against the unit circle" });
  const mid = (m.t + H - m.b) / 2;
  svg("rect", { x: px(1), y: m.t, width: W - m.r - px(1), height: H - m.t - m.b, class: "band" }, root);
  svg("line", { x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b, class: "axis" }, root);
  for (const [v, label] of [[0.01, "≤ 0.01"], [0.1, "0.1"], [1, "1"], [10, "10"], [100, "≥ 100"]]) {
    svg("line", { x1: px(v), x2: px(v), y1: H - m.b, y2: H - m.b + 4, class: "axis" }, root);
    svg("text", { x: px(v), y: H - m.b + 16, class: "tick", "text-anchor": v === 0.01 ? "start" : v === 100 ? "end" : "middle" }, root).textContent = label;
  }
  svg("line", { x1: px(1), x2: px(1), y1: m.t - 6, y2: H - m.b, class: "unit" }, root);
  svg("text", { x: px(1) - 6, y: m.t - 10, class: "note", "text-anchor": "end" }, root).textContent = "stable";
  svg("text", { x: px(1) + 6, y: m.t - 10, class: "note" }, root).textContent = "unstable: outside the unit circle";
  /* stack coincident roots vertically so each one is seen */
  const seen = new Map();
  const sorted = roots.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  for (const { v } of sorted) {
    const x = px(v), key = Math.round(x / 7), k = seen.get(key) || 0;
    seen.set(key, k + 1);
    const y = mid + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 8;
    const c = svg("circle", { cx: x, cy: Math.max(m.t + 4, Math.min(H - m.b - 4, y)), r: 4.5, class: "root " + (v > 1 + 1e-6 ? "unstable" : "stable") }, root);
    const text = !Number.isFinite(v) || v > 1e4 ? "infinite" : v < 1e-7 ? "0" : fmt(v, 6);
    const show = e => showTip(e.clientX, e.clientY, [{ color: v > 1 + 1e-6 ? "var(--series-2)" : "var(--series-1)", value: text, name: v > 1 + 1e-6 ? "unstable root" : "stable root" }]);
    const big = svg("circle", { cx: c.getAttribute("cx"), cy: c.getAttribute("cy"), r: 12, fill: "transparent" }, root);
    big.addEventListener("pointermove", show);
    big.addEventListener("pointerleave", hideTip);
  }
  return root;
}

/* ---- variance decomposition ------------------------------------------- */
/* rows: [{name, shares}] with shares in percent, one per shock (nan where a
 * variable has no variance). A horizontal bar per variable, a segment per
 * shock, 2px of surface between segments. */
export function stackedBars(rows, shockNames, opt = {}) {
  const W = opt.width || 640, bar = 18, gap = 10, left = opt.left || 120, right = 12, top = 6, bottom = 24;
  const H = top + rows.length * (bar + gap) + bottom;
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": "variance decomposition" });
  const px = p => left + (p / 100) * (W - left - right);
  for (const p of [0, 25, 50, 75, 100]) {
    svg("line", { x1: px(p), x2: px(p), y1: top, y2: H - bottom, class: p === 0 ? "axis" : "grid" }, root);
    svg("text", { x: px(p), y: H - bottom + 14, class: "tick", "text-anchor": "middle" }, root).textContent = p + "%";
  }
  rows.forEach((r, i) => {
    const y = top + i * (bar + gap);
    const label = svg("text", { x: left - 8, y: y + bar / 2 + 4, class: "label", "text-anchor": "end" }, root);
    label.textContent = r.name;
    if (r.shares.some(Number.isNaN)) { svg("text", { x: left + 6, y: y + bar / 2 + 4, class: "note" }, root).textContent = r.why || "no variance to decompose"; return; }
    let acc = 0;
    r.shares.forEach((p, j) => {
      const x1 = px(acc), x2 = px(acc + p);
      acc += p;
      if (x2 - x1 < 0.4) return;
      const seg = svg("rect", { x: x1 + 1, y, width: Math.max(0.5, x2 - x1 - 2), height: bar, rx: 2, class: "seg" }, root);
      seg.style.fill = SERIES[j % SERIES.length];
      seg.addEventListener("pointermove", e => showTip(e.clientX, e.clientY, [{ color: SERIES[j % SERIES.length], value: fmt(p, 4) + "%", name: shockNames[j] }], r.name));
      seg.addEventListener("pointerleave", hideTip);
    });
  });
  return root;
}

/* ---- correlations ------------------------------------------------------ */
/* A diverging scale: blue for negative, red for positive, grey at zero. */
export function corrColor(r) {
  if (!Number.isFinite(r)) return "var(--cell-none)";
  const t = Math.max(-1, Math.min(1, r));
  return `color-mix(in oklab, var(${t < 0 ? "--div-neg" : "--div-pos"}) ${Math.round(Math.abs(t) * 100)}%, var(--div-mid))`;
}
export function heatmap(names, matrix, opt = {}) {
  const n = names.length, cell = Math.max(14, Math.min(34, Math.floor(520 / n))), left = opt.left || 90, top = 6;
  const W = left + n * cell + 8, H = top + n * cell + (opt.left || 90) * 0.75;
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart heat", role: "img", "aria-label": "correlation matrix", width: W, height: H });
  names.forEach((nm, i) => {
    svg("text", { x: left - 6, y: top + i * cell + cell / 2 + 4, class: "label", "text-anchor": "end" }, root).textContent = nm;
    const t = svg("text", { class: "label", "text-anchor": "end", transform: `translate(${left + i * cell + cell / 2 + 4}, ${top + n * cell + 10}) rotate(-50)` }, root);
    t.textContent = nm;
    names.forEach((other, j) => {
      const r = matrix[i][j];
      const c = svg("rect", { x: left + j * cell + 1, y: top + i * cell + 1, width: cell - 2, height: cell - 2, rx: 2, class: "cell" }, root);
      c.style.fill = corrColor(r);
      c.addEventListener("pointermove", e => showTip(e.clientX, e.clientY, [{ value: fmt(r, 3), name: `${nm} with ${other}` }]));
      c.addEventListener("pointerleave", hideTip);
    });
  });
  return root;
}

/* A legend: a line or a box per series, named. */
export function legend(items, kind = "line") {
  return h("div", { class: "legend" }, items.map(it => {
    const key = h("span", { class: `key ${it.kind || kind}${it.dashed ? " dashed" : ""}${it.faint ? " faint" : ""}` });
    key.style.setProperty("--c", it.color);
    return h("span", { class: "legend-item" }, key, h("span", { text: it.name }));
  }));
}
