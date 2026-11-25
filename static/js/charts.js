/**
 * GoldForex Picker - TradingView Lightweight Charts Modal
 */
import { $, state } from "./state.js";
import { esc } from "./format.js";
import { fetchChart } from "./api.js";

let ch1 = null, ch2 = null, cdata = null, cpid = null, cser = null, curRange = 0;

export function killCharts() {
  [ch1, ch2].forEach(c => {
    try {
      if (c) c.remove();
    } catch (_) {}
  });
  ch1 = ch2 = null;
}

export function closeModal() {
  killCharts();
  const m = $("modal");
  if (m) m.style.display = "none";
}

export async function openChartModal(pid, refresh = false) {
  const r = state.rows.find(x => x.pid === pid);
  cpid = pid;
  killCharts();
  const modal = $("modal");
  if (!modal) return;
  modal.style.display = "flex";
  $("mtitle").textContent = r ? r.name : pid;
  $("msub").textContent = "";
  $("rng").innerHTML = "";
  $("mbody").innerHTML = '<div class="cmsg" style="padding:40px 0">Reading price history with Chrome... (first load may take 10–20s)</div>';

  try {
    const d = await fetchChart(pid, refresh);
    cdata = d;
    if (r) r.has_chart = true;
    drawCharts(d);
  } catch (e) {
    $("mbody").innerHTML = `<div class="cmsg" style="color:var(--r);padding:40px 0">Could not load chart: ${esc(e.message)}</div>`;
  }
}

export function reloadCurrentChart() {
  if (cpid) openChartModal(cpid, true);
}

const RANGES = [["Today", -1], ["1W", 7], ["1M", 30], ["3M", 90], ["6M", 180], ["1Y", 365], ["All", 0]];
const p2 = n => String(n).padStart(2, "0");
const localTime = t => {
  const d = new Date(t * 1000);
  return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate()) + " " + p2(d.getHours()) + ":" + p2(d.getMinutes());
};

function tickFmt(t, type) {
  const d = new Date(t * 1000);
  return type === 0 ? String(d.getFullYear()) : type === 1 ? d.toLocaleString("en-GB", { month: "short" }) : type === 2 ? String(d.getDate()) : p2(d.getHours()) + ":" + p2(d.getMinutes());
}

function alignSeries(buy, sell) {
  const times = [...new Set([...buy.map(p => p.time), ...sell.map(p => p.time)])].sort((a, b) => a - b);
  const bm = new Map(buy.map(p => [p.time, p.value])), sm = new Map(sell.map(p => [p.time, p.value]));
  let lb = null, ls = null;
  const B = [], S = [], L = [];
  for (const t of times) {
    if (bm.has(t)) lb = bm.get(t);
    if (sm.has(t)) ls = sm.get(t);
    if (lb == null || ls == null) continue;
    B.push({ time: t, value: lb });
    S.push({ time: t, value: ls });
    L.push({ time: t, value: lb > 0 ? +((lb - ls) / lb * 100).toFixed(3) : 0 });
  }
  return { B, S, L };
}

export function applyRange(days) {
  if (!ch1 || !cser || !cser.B.length) return;
  curRange = days;
  document.querySelectorAll("#rng button").forEach(b => b.classList.toggle("on", +b.dataset.days === days));
  const B = cser.B, first = B[0].time, last = B[B.length - 1].time;
  if (days === 0) {
    ch1.timeScale().fitContent();
    return;
  }
  let from;
  if (days === -1) {
    const d = new Date(last * 1000);
    d.setHours(0, 0, 0, 0);
    from = d.getTime() / 1000;
    if (B.filter(p => p.time >= from).length < 2) from = last - 86400;
  } else {
    from = last - days * 86400;
  }
  from = Math.max(from, first);
  if (from >= last) from = first;
  ch1.timeScale().setVisibleRange({ from, to: last });
}

export function drawCharts(d) {
  if (typeof LightweightCharts === "undefined") {
    $("mbody").innerHTML = '<div class="cmsg" style="padding:40px 0">Lightweight Charts library could not be loaded.</div>';
    return;
  }
  cser = alignSeries(d.buy || [], d.sell || []);
  if (!cser.B.length) {
    $("mbody").innerHTML = '<div class="cmsg" style="padding:40px 0">The site returned no price history for this product.</div>';
    return;
  }
  $("mbody").innerHTML = `
    <div class="leg"><span><i style="background:#e0b44c"></i>You pay (shop sells)</span><span><i style="background:#4cc38a"></i>You receive (shop buys)</span></div>
    <div id="ch1"></div>
    <div class="leg"><span><i style="background:#e05c5c"></i>Loss when selling back (%)</span></div>
    <div id="ch2"></div>
    <div class="cstats" id="cstats"></div>`;

  const base = {
    autoSize: true,
    layout: { background: { color: "#171a21" }, textColor: "#8b909c" },
    grid: { vertLines: { color: "#232833" }, horzLines: { color: "#232833" } },
    rightPriceScale: { borderColor: "#2a2f3a" },
    timeScale: { borderColor: "#2a2f3a", timeVisible: true, tickMarkFormatter: tickFmt },
    crosshair: { mode: 0 },
    localization: { timeFormatter: localTime }
  };

  ch1 = LightweightCharts.createChart($("ch1"), base);
  const sPay = ch1.addLineSeries({ color: "#e0b44c", lineWidth: 2, title: "pay" });
  const sRec = ch1.addLineSeries({ color: "#4cc38a", lineWidth: 2, title: "receive" });
  sPay.setData(cser.B);
  sRec.setData(cser.S);

  ch2 = LightweightCharts.createChart($("ch2"), base);
  const sSp = ch2.addLineSeries({ color: "#e05c5c", lineWidth: 2, priceFormat: { type: "custom", formatter: v => v.toFixed(1) + "%" } });
  sSp.setData(cser.L);

  let lock = false;
  const link = (a, b) => a.timeScale().subscribeVisibleLogicalRangeChange(rg => {
    if (!rg || lock) return;
    lock = true;
    try {
      b.timeScale().setVisibleLogicalRange(rg);
    } finally {
      lock = false;
    }
  });
  link(ch1, ch2);
  link(ch2, ch1);

  $("rng").innerHTML = RANGES.map(([l, dd]) => `<button data-days="${dd}">${l}</button>`).join("");
  requestAnimationFrame(() => requestAnimationFrame(() => applyRange(curRange)));

  const last = cser.B[cser.B.length - 1].time;
  const yr = cser.L.filter(p => p.time >= last - 365 * 86400).map(p => p.value);
  const avg = yr.reduce((a, b) => a + b, 0) / (yr.length || 1);
  const cur = cser.L[cser.L.length - 1].value;
  const mn = Math.min(...yr), mx = Math.max(...yr);
  const pctRank = mx > mn ? (cur - mn) / (mx - mn) * 100 : 50;
  const cheaperThan = Math.round(100 - pctRank);

  const pay365 = cser.B.filter(p => p.time >= last - 365 * 86400);
  const chg = pay365.length > 1 ? (pay365[pay365.length - 1].value / pay365[0].value - 1) * 100 : null;
  const cell = (l, v) => `<div><div class="l">${l}</div><div class="v">${v}</div></div>`;
  $("cstats").innerHTML = cell("Loss now", cur.toFixed(2) + "%") +
    cell("Average loss (1 year)", yr.length ? avg.toFixed(2) + "%" : "-") +
    cell("Lowest / highest (1 year)", yr.length ? mn.toFixed(2) + "% / " + mx.toFixed(2) + "%" : "-") +
    cell("52-Week Timing", yr.length ? `Cheaper than <b>${cheaperThan}%</b> of year` : "-") +
    cell("Price change (1 year)", chg == null ? "-" : (chg >= 0 ? "+" : "") + chg.toFixed(1) + "%") +
    cell("History points", cser.B.length);
  $("msub").textContent = "Loaded " + (d.fetched_at || "").replace("T", " ") + " - history from site Highcharts";
}
