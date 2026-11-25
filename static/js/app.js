/**
 * GoldForex Picker - Client Application Logic
 * ============================================
 * Handles live price rendering, TradingView Lightweight Charts,
 * custom deal score weights, interactive sweet-spot scatter plot,
 * favourites pinning, price/stock alerts with audio chimes,
 * "My Gold Vault" portfolio tracker, Budget Basket Optimizer,
 * Side-by-Side Product Comparison, and Competitor Arbitrage scanner.
 */

// --------------------------------------------------------------------------
// PWA Service Worker Registration
// --------------------------------------------------------------------------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

// --------------------------------------------------------------------------
// DOM Helpers & Formatters
// --------------------------------------------------------------------------
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
}[c]));

const nf = d => new Intl.NumberFormat("fr-BE", { minimumFractionDigits: d, maximumFractionDigits: d });
const f2 = nf(2), f3 = nf(3), f1 = nf(1);
const eur = v => v == null ? "-" : f2.format(v) + " \u20ac";
const num = (v, f = f2) => v == null ? "-" : f.format(v);
const karatTxt = v => v == null ? "-" : (Number.isInteger(v) ? v : f1.format(v)) + " K";
const sgn = v => (v >= 0 ? "+" : "") + f2.format(v) + "%";
const lossCls = p => p == null ? "" : p <= 3.5 ? "g" : p <= 6 ? "y" : p <= 10 ? "o" : "r";
const dealScoreCls = s => s >= 85 ? "score-high" : s >= 65 ? "score-mid" : "score-low";

// --------------------------------------------------------------------------
// Application State
// --------------------------------------------------------------------------
let rows = [];
let filter = "all";
let view = "cards";
let spot = null;
let favs = new Set(JSON.parse(localStorage.getItem("gf_favs") || "[]"));
let alerts = JSON.parse(localStorage.getItem("gf_alerts") || "[]");
let vault = JSON.parse(localStorage.getItem("gf_vault") || "[]");
let dealWeights = JSON.parse(localStorage.getItem("gf_deal_weights") || '{"loss":45,"prem":35,"pure":20}');
let lastFiredAlerts = new Set();
let compareSet = new Set();

function melt(r) {
  return spot && spot.eur_per_g && r.pure_g ? spot.eur_per_g * r.pure_g : null;
}

function medianImplied() {
  const a = rows.map(r => r.implied_spot_per_g).filter(v => v != null).sort((x, y) => x - y);
  return a.length ? a[Math.floor(a.length / 2)] : null;
}

// --------------------------------------------------------------------------
// Sound & Toast Notifications
// --------------------------------------------------------------------------
function playChime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    const t = ctx.currentTime;
    osc.frequency.setValueAtTime(587.33, t);        // D5
    osc.frequency.setValueAtTime(880.00, t + 0.12); // A5
    gain.gain.setValueAtTime(0.18, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.48);
    osc.start(t);
    osc.stop(t + 0.5);
  } catch (e) {}
}

function showToast(title, msg) {
  const wrap = $("toasts");
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `<div class="t-icon">🔔</div><div><b>${esc(title)}</b><div class="mut" style="font-size:12px;margin-top:2px">${esc(msg)}</div></div>`;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transition = "opacity .4s";
    setTimeout(() => el.remove(), 400);
  }, 6000);
}

// --------------------------------------------------------------------------
// Break-even Spot & Deal Score Calculation
// --------------------------------------------------------------------------
function calcBreakevenSpot(r) {
  const s = spot && spot.eur_per_g ? spot.eur_per_g : (r.implied_spot_per_g || medianImplied());
  if (!s || !r.shop_sells || !r.shop_buys) return null;
  return s * (r.shop_sells / r.shop_buys);
}

function getPercentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * (p / 100);
  const low = Math.floor(idx);
  const high = Math.ceil(idx);
  const weight = idx - low;
  return sorted[low] * (1 - weight) + sorted[high] * weight;
}

function computeDealScores() {
  const allValid = rows.filter(r => r.status === "ok" && !r.suspect && r.spread_pct != null && r.sell_per_pure_g != null);
  if (!allValid.length) {
    for (const r of rows) r.deal_score = null;
    return;
  }
  const inStockValid = allValid.filter(r => r.in_stock);
  const base = inStockValid.length >= 3 ? inStockValid : allValid;

  const losses = base.map(r => r.spread_pct);
  const p5Loss = getPercentile(losses, 5), p95Loss = getPercentile(losses, 95);

  const prems = base.map(r => r.premium_pay_pct).filter(v => v != null);
  const p5Prem = prems.length ? getPercentile(prems, 5) : 0, p95Prem = prems.length ? getPercentile(prems, 95) : 100;

  const pures = base.map(r => r.sell_per_pure_g);
  const p5Pure = getPercentile(pures, 5), p95Pure = getPercentile(pures, 95);

  const wLoss = Number.isFinite(+dealWeights.loss) ? +dealWeights.loss : 45;
  const wPrem = Number.isFinite(+dealWeights.prem) ? +dealWeights.prem : 35;
  const wPure = Number.isFinite(+dealWeights.pure) ? +dealWeights.pure : 20;
  const totW = (wLoss + wPrem + wPure) || 100;

  for (const r of rows) {
    if (r.status !== "ok" || r.suspect || r.spread_pct == null || r.sell_per_pure_g == null) {
      r.deal_score = null;
      continue;
    }
    const vLoss = Math.max(p5Loss, Math.min(p95Loss, r.spread_pct));
    const sLoss = p95Loss <= p5Loss ? 1 : 1 - (vLoss - p5Loss) / Math.max(0.001, p95Loss - p5Loss);

    const prem = r.premium_pay_pct != null ? r.premium_pay_pct : p95Prem;
    const vPrem = Math.max(p5Prem, Math.min(p95Prem, prem));
    const sPrem = p95Prem <= p5Prem ? 1 : 1 - (vPrem - p5Prem) / Math.max(0.001, p95Prem - p5Prem);

    const vPure = Math.max(p5Pure, Math.min(p95Pure, r.sell_per_pure_g));
    const sPure = p95Pure <= p5Pure ? 1 : 1 - (vPure - p5Pure) / Math.max(0.001, p95Pure - p5Pure);

    const score = Math.round(((wLoss * sLoss) + (wPrem * sPrem) + (wPure * sPure)) / totW * 100);
    r.deal_score = Math.max(1, Math.min(100, score));
  }
}

// --------------------------------------------------------------------------
// Spot Market Price & Quote Freshness
// --------------------------------------------------------------------------
function updateDataAge() {
  const badge = $("age-badge");
  const first = rows.find(r => r.quote_time);
  if (!first || !first.quote_time) {
    badge.style.display = "none";
    return;
  }
  const d = new Date(first.quote_time.includes("T") ? first.quote_time : first.quote_time.replace(" ", "T"));
  const diffM = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
  badge.style.display = "inline-block";
  if (diffM <= 15) {
    badge.className = "b-age b-live";
    badge.textContent = `● Live (${diffM === 0 ? "just now" : diffM + "m ago"})`;
  } else if (diffM <= 60) {
    badge.className = "b-age b-stale";
    badge.textContent = `● Quotes ${diffM}m ago`;
  } else {
    const h = Math.round(diffM / 60);
    badge.className = "b-age b-old";
    badge.textContent = `⚠️ Quote ${h}h ago`;
    badge.title = "Shop quote time is older than 1 hour (market may be closed)";
  }
}

function renderSpot() {
  const imp = medianImplied(), impTxt = imp ? `Shop-implied gold: <b>${eur(imp)}</b>/g` : "";
  if (!spot) {
    $("spot").innerHTML = "loading the gold price...";
    return;
  }
  if (spot.error) {
    $("spot").innerHTML = `<span class="warn">Market gold price unavailable: ${esc(spot.error)}</span><span class="sm">${impTxt}</span>`;
    return;
  }
  const d = imp ? (spot.eur_per_g / imp - 1) * 100 : null, bad = d != null && Math.abs(d) > 10;
  $("spot").innerHTML =
    `<div><div class="sm">Gold on the market (24K)</div><span class="big">${eur(spot.eur_per_g)}</span> <span class="mut">/ gram</span></div>` +
    `<div class="sm">${eur(spot.eur_per_g * 31.1034768)} / oz${spot.week_low ? ` &middot; week ${eur(spot.week_low)} - ${eur(spot.week_high)}` : ""}</div>` +
    `<div class="sm">${impTxt}${d != null ? ` (market is ${sgn(d)} vs shop)` : ""}</div>` +
    (bad ? `<div class="warn">Prices differ by >10%: check <a href="${esc(spot.url)}" target="_blank" rel="noopener"><u>${esc(spot.source)}</u></a>.</div>` : "") +
    `<div class="sm">${esc(spot.source)} &middot; ${esc((spot.fetched_at || "").slice(11))}</div>`;
}

async function loadSpot(refresh) {
  try {
    const res = await fetch("/api/spot" + (refresh ? "?refresh=1" : ""));
    const d = await res.json();
    if (!res.ok || d.error) throw new Error(d.error || ("HTTP " + res.status));
    spot = d;
  } catch (e) {
    spot = { error: String(e.message || e) };
  }
  renderSpot();
  render();
}

// --------------------------------------------------------------------------
// Filters, Search & Budget Selection
// --------------------------------------------------------------------------
function budgetRange() {
  return [parseFloat($("bmin").value) || 0, parseFloat($("bmax").value) || 0];
}

function inBudget(r, lo, hi) {
  return (!lo && !hi) || (r.shop_sells != null && (!lo || r.shop_sells >= lo) && (!hi || r.shop_sells <= hi));
}

function matchSearch(r, q) {
  if (!q) return true;
  const hay = [r.name, r.category, r.country, r.karat ? r.karat + "k" : "", r.weight_g ? r.weight_g + "g" : ""].join(" ").toLowerCase();
  return q.toLowerCase().split(/\s+/).every(term => hay.includes(term));
}

function matchKarat(r, k) {
  if (!k) return true;
  if (!r.karat) return false;
  return Math.abs(r.karat - parseFloat(k)) < 0.5;
}

function matchWeight(r, w) {
  if (!w || !r.weight_g) return !w;
  const g = r.weight_g;
  if (w === "u5") return g <= 5.0;
  if (w === "5-20") return g > 5.0 && g <= 20.0;
  if (w === "20-35") return g > 20.0 && g <= 35.0;
  if (w === "50-100") return g >= 50.0 && g <= 100.0;
  if (w === "o100") return g > 100.0;
  return true;
}

function updateCountryOptions() {
  const sel = $("fcountry"), cur = sel.value;
  const set = new Set(rows.map(r => r.country).filter(Boolean));
  const sorted = [...set].sort();
  sel.innerHTML = '<option value="">All countries</option>' + sorted.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
  if (sorted.includes(cur)) sel.value = cur;
}

function visible() {
  const onlyStock = $("stock").checked, [lo, hi] = budgetRange();
  const q = $("search").value.trim(), fC = $("fcountry").value, fK = $("fkarat").value, fW = $("fweight").value;

  let list = rows.filter(r => {
    if (filter === "bar" && r.category !== "bar") return false;
    if (filter === "coin" && r.category !== "coin") return false;
    if (filter === "fav" && !favs.has(r.pid)) return false;
    if (onlyStock && !r.in_stock) return false;
    if (!inBudget(r, lo, hi)) return false;
    if (!matchSearch(r, q)) return false;
    if (fC && r.country !== fC) return false;
    if (!matchKarat(r, fK)) return false;
    if (!matchWeight(r, fW)) return false;
    return true;
  });

  const sortKey = $("sort").value;
  const key = {
    deal: r => -(r.deal_score || 0),
    loss: r => r.spread_pct,
    pure: r => r.sell_per_pure_g,
    breakeven: r => calcBreakevenSpot(r),
    price: r => r.shop_sells,
    gold: r => -(r.pure_g || 0)
  }[sortKey] || (r => -(r.deal_score || 0));

  return list.sort((a, b) => {
    const aFav = favs.has(a.pid) ? 1 : 0, bFav = favs.has(b.pid) ? 1 : 0;
    if (filter !== "fav" && aFav !== bFav) return bFav - aFav;
    const x = key(a), y = key(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return x - y;
  });
}

function candidates() {
  const [lo, hi] = budgetRange();
  return rows.filter(r => r.status === "ok" && r.in_stock && r.spread_pct != null && (filter === "all" || filter === "fav" || r.category === filter) && inBudget(r, lo, hi));
}

// --------------------------------------------------------------------------
// Best Picks Panel
// --------------------------------------------------------------------------
function renderPicks() {
  const [lo, b] = budgetRange(), c = candidates();
  if (!c.length) {
    $("picks").innerHTML = `<h2>Best picks</h2><div class="mut">${(b || lo) ? "Nothing in stock fits that budget." : "No in-stock products with prices right now."}</div>`;
    return;
  }
  const byScore = [...c].sort((x, y) => (y.deal_score || 0) - (x.deal_score || 0));
  const cheap = [...c].sort((x, y) => (x.sell_per_pure_g ?? 1e9) - (y.sell_per_pure_g ?? 1e9))[0], best = byScore[0];
  const top = byScore.slice(0, 3);
  const sum = `Highest Deal Score: <b>${esc(best.name)}</b> (Score <b>${best.deal_score}/100</b> &middot; loss ${num(best.spread_pct)}% = ${eur(best.loss_eur)}). ` +
    `Cheapest per pure gram: <b>${esc(cheap.name)}</b> (${eur(cheap.sell_per_pure_g)}/g).` + (best.pid === cheap.pid ? " Same product wins both." : "");
  $("picks").innerHTML = `<h2>Best picks to buy${lo && b ? " between " + eur(lo) + " and " + eur(b) : b ? " with up to " + eur(b) : lo ? " from " + eur(lo) : ""}</h2><p class="pick-sum">${sum}</p><div class="pick-row">` +
    top.map((r, i) => {
      let extra = "";
      if (b) {
        const n = Math.floor(b / r.shop_sells);
        extra = `<br>${eur(b)} buys <b>${n} \u00d7</b> = ${eur(n * r.shop_sells)}; selling back loses ~${eur(n * r.loss_eur)}.`;
      }
      const beSpot = calcBreakevenSpot(r);
      return `<div class="pick"><div class="rk">${i + 1}</div>${r.image ? `<img src="${esc(r.image)}" alt="">` : ""}<div><div class="t">${esc(r.name)} <span class="badge b-score ${dealScoreCls(r.deal_score)}">Score ${r.deal_score}</span></div>
      <div class="d"><span class="c-${lossCls(r.spread_pct)}"><b>${num(r.spread_pct)}%</b> loss</span> if sold now (${eur(r.loss_eur)}) &middot; premium ${num(r.premium_pay_pct)}%<br>
      Break-even spot: <b>${eur(beSpot)}/g</b> (+${num(r.breakeven_pct)}%) &middot; ${eur(r.sell_per_pure_g)}/pure g${extra}</div></div></div>`;
    }).join("") +
    `</div><div class="note">Deal score combines resale loss, spot premium, and price per pure gram. Ranking compares costs only and does not predict market movement.</div>`;
}

// --------------------------------------------------------------------------
// Cards & Table Views
// --------------------------------------------------------------------------
function cmpBlock(r) {
  const m = melt(r);
  if (m == null) return "";
  const p = (r.shop_sells / m - 1) * 100, g = (r.shop_buys / m - 1) * 100;
  return `<div class="cmp"><div class="t">vs gold on the market (${eur(spot.eur_per_g)}/g)</div><div><span>Gold value now</span><b>${eur(m)}</b></div>` +
    `<div><span>You pay vs market</span><b class="c-${lossCls(p)}">${sgn(p)} (${eur(r.shop_sells - m)})</b></div>` +
    `<div><span>You receive vs market</span><b class="c-${g >= 0 ? "g" : lossCls(-g)}">${sgn(g)} (${eur(r.shop_buys - m)})</b></div></div>`;
}

function card(r, best, cheap) {
  const lc = lossCls(r.spread_pct), w = Math.min(100, (r.spread_pct || 0) * 4);
  const isFav = favs.has(r.pid);
  const isCmp = compareSet.has(r.pid);
  const hasAlt = alerts.some(a => a.pid === r.pid && a.enabled);
  const beSpot = calcBreakevenSpot(r);
  const isCollector = r.is_collector || (r.premium_pay_pct != null && r.premium_pay_pct >= 20.0);

  const histBadge = r.history_stats ? `<span class="badge ${r.history_stats.status === 'bargain' ? 'b-bargain' : r.history_stats.status === 'fair' ? 'b-fair' : 'b-high'}" title="52W spread range: ${r.history_stats.min_52w}% - ${r.history_stats.max_52w}% (cheaper than ${r.history_stats.cheaper_than_pct}% of the past year)">${esc(r.history_stats.badge)}</span>` : "";

  const badges = (r.status !== "ok" ? '<span class="badge b-out">failed</span>' : r.in_stock ? '<span class="badge b-in">In stock</span>' : '<span class="badge b-out">Out of stock</span>') +
    (r.suspect ? '<span class="badge b-high" title="Implausible price/weight ratio">⚠️ Suspect</span>' : "") +
    (r.deal_score != null ? `<span class="badge b-score ${dealScoreCls(r.deal_score)}">Score ${r.deal_score}</span>` : "") +
    histBadge +
    (isCollector ? `<span class="badge b-collector" title="Collector / Numismatic premium: ${num(r.premium_pay_pct)}% markup over metal value">⚠️ Collector (+${num(r.premium_pay_pct)}%)</span>` : "") +
    (best === r.pid ? '<span class="badge b-best">Top score</span>' : "") + (cheap === r.pid ? '<span class="badge b-cheap">Cheapest / g</span>' : "");

  if (r.status !== "ok") {
    return `<div class="card" id="card-${esc(r.pid)}"><div class="body"><div class="name">${esc(r.name)}</div><div class="sub">${esc(r.error || "")}</div></div></div>`;
  }

  return `<div class="card ${r.in_stock ? "" : "oos"}" id="card-${esc(r.pid)}">
  <div class="imgwrap">
   ${r.image ? `<img loading="lazy" src="${esc(r.image)}" alt="${esc(r.name)}">` : ""}
   <div class="badges">${badges}</div>
   ${r.flag ? `<img class="flag" src="${esc(r.flag)}" alt="${esc(r.country || "")}" title="${esc(r.country || "")}">` : (r.country ? `<span class="flag txt" title="${esc(r.country)}">${r.country === "Various" ? "🌐 Various" : esc(r.country)}</span>` : "")}
   <div class="card-tools">
    <button class="fav-btn ${isFav ? "active" : ""}" data-fav="${esc(r.pid)}" title="${isFav ? "Remove from favourites" : "Pin as favourite"}">${isFav ? "★" : "☆"}</button>
    <button class="alert-btn ${hasAlt ? "active" : ""}" data-alert="${esc(r.pid)}" title="Set price or stock alert">🔔</button>
    <button class="cmp-btn ${isCmp ? "active" : ""}" data-cmp="${esc(r.pid)}" title="${isCmp ? "Remove from comparison" : "Add to side-by-side comparison"}">⚖️</button>
   </div>
   ${r.karat ? `<span class="kt">${karatTxt(r.karat)}</span>` : ""}
  </div>
  <div class="body">
   <div>
    <div class="name"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.name)}</a></div>
    <div class="sub">${esc(r.category)} \u00b7 ${num(r.weight_g, f3)} g \u00b7 ${karatTxt(r.karat)} \u00b7 ${num(r.purity_pct)}% pure</div>
   </div>
   <div class="prices">
    <div class="pbox"><div class="l">You pay</div><div class="v">${eur(r.shop_sells)}</div></div>
    <div class="pbox"><div class="l">You receive</div><div class="v">${eur(r.shop_buys)}</div></div>
   </div>
   ${cmpBlock(r)}
   <div class="be-box">
    <div class="l">Break-even gold price</div>
    <div class="v">${eur(beSpot)} <span class="sm">/ g</span> <span class="c-${lc}">(+${num(r.breakeven_pct)}%)</span></div>
    <div class="sm">Spot needed to get 100% back when selling &middot; Melt: ${eur(r.sell_per_pure_g)}/g</div>
   </div>
   <div class="loss">
    <div class="top"><span>Loss if you sell back now</span><b class="c-${lc}">${num(r.spread_pct)}% (${eur(r.loss_eur)})</b></div>
    <div class="meter"><i class="m-${lc}" style="width:${w}%"></i></div>
   </div>
   <div class="stats">
    <div><span>Pure gold</span><span>${num(r.pure_g, f3)} g</span></div>
    <div><span>Deal score</span><b class="c-${lc}">${r.deal_score || "-"} / 100</b></div>
    <div><span>Pay / pure g</span><span>${eur(r.sell_per_pure_g)}</span></div>
    <div><span>Receive / pure g</span><span>${eur(r.buy_per_pure_g)}</span></div>
    <div><span>Spot premium</span><span>${num(r.premium_pay_pct)}%</span></div>
    <div><span>Break-even</span><span>+${num(r.breakeven_pct)}%</span></div>
   </div>
   <div class="actions">
    <button class="wallet-quick-btn" data-wallet-add="${esc(r.pid)}" title="Add this item to My Investment Wallet">+ Add to Wallet</button>
    <button data-chart="${esc(r.pid)}">${r.has_chart ? "Price chart" : "Price chart (load)"}</button>
    <a href="${esc(r.url)}" target="_blank" rel="noopener">Open on site</a>
   </div>
  </div>
 </div>`;
}

function render() {
  computeDealScores();
  renderPicks();
  const list = visible(), c = candidates();
  $("shown").textContent = list.length + " of " + rows.length + " shown";
  const best = c.length ? [...c].sort((x, y) => (y.deal_score || 0) - (x.deal_score || 0))[0].pid : null;
  const cheap = c.length ? [...c].sort((x, y) => (x.sell_per_pure_g ?? 1e9) - (y.sell_per_pure_g ?? 1e9))[0].pid : null;

  if (view === "cards") {
    $("view").innerHTML = `<div class="grid">${list.map(r => card(r, best, cheap)).join("") || '<div class="mut">Nothing to show with these filters.</div>'}</div>`;
  } else {
    $("view").innerHTML = `<div class="tw"><table><thead><tr>
   <th>⭐</th><th>⚖️</th><th>Product</th><th>Stock</th><th>Deal Score</th><th>52W Timing</th><th>Country</th><th>Pure g</th><th>Karat</th><th>You pay</th><th>You receive</th>
   <th>Loss %</th><th>Loss \u20ac</th><th>Break-even spot</th><th>Premium</th><th>Pay / pure g</th><th>Market value</th><th>Pay vs market</th><th></th>
  </tr></thead><tbody>` +
      list.map(r => {
        if (r.status !== "ok") return `<tr><td></td><td></td><td>${esc(r.name)}</td><td colspan="16" class="mut">${esc(r.error || "failed")}</td></tr>`;
        const isFav = favs.has(r.pid), isCmp = compareSet.has(r.pid), beSpot = calcBreakevenSpot(r);
        const isCollector = r.is_collector || (r.premium_pay_pct != null && r.premium_pay_pct >= 20.0);
        const histBadge = r.history_stats ? `<span class="badge ${r.history_stats.status === 'bargain' ? 'b-bargain' : r.history_stats.status === 'fair' ? 'b-fair' : 'b-high'}" style="font-size:10.5px">${esc(r.history_stats.badge)}</span>` : '<span class="mut">-</span>';
        return `<tr id="row-${esc(r.pid)}">
    <td style="text-align:center"><button class="fav-btn ${isFav ? "active" : ""}" style="position:static;display:inline-flex;width:26px;height:26px;font-size:14px" data-fav="${esc(r.pid)}">${isFav ? "★" : "☆"}</button></td>
    <td style="text-align:center"><button class="cmp-btn ${isCmp ? "active" : ""}" style="position:static;display:inline-flex;width:26px;height:26px;font-size:13px" data-cmp="${esc(r.pid)}" title="Compare">⚖️</button></td>
    <td>${r.image ? `<img src="${esc(r.image)}" alt="">` : ""}<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.name)}</a>${r.suspect ? ' <span class="badge b-high" style="font-size:10px" title="Implausible price/weight ratio">⚠️ Suspect</span>' : ""}</td>
    <td>${r.in_stock ? "yes" : '<span class="c-r">no</span>'}</td>
    <td><span class="badge b-score ${dealScoreCls(r.deal_score)}">${r.deal_score || "-"}</span></td>
    <td>${histBadge}</td>
    <td>${r.flag ? `<img class="cflag" src="${esc(r.flag)}" alt="">` : ""}${esc(r.country || "-")}</td>
    <td>${num(r.pure_g, f3)}</td><td>${karatTxt(r.karat)}</td><td>${eur(r.shop_sells)}</td><td>${eur(r.shop_buys)}</td>
    <td class="c-${lossCls(r.spread_pct)}"><b>${num(r.spread_pct)}%</b></td><td>${eur(r.loss_eur)}</td>
    <td><b>${eur(beSpot)}</b> <span class="mut" style="font-size:11px">(+${num(r.breakeven_pct)}%)</span></td>
    <td>${num(r.premium_pay_pct)}% ${isCollector ? '<span class="badge b-collector" style="padding:1px 4px;font-size:10px">Collector</span>' : ""}</td>
    <td>${eur(r.sell_per_pure_g)}</td><td>${melt(r) == null ? "-" : eur(melt(r))}</td><td>${melt(r) == null ? "-" : sgn((r.shop_sells / melt(r) - 1) * 100)}</td>
    <td><button class="wallet-quick-btn" data-wallet-add="${esc(r.pid)}" style="padding:4px 8px;font-size:11.5px;margin-right:4px" title="Add to Wallet">+ Wallet</button><button data-chart="${esc(r.pid)}">Chart</button> <button data-alert="${esc(r.pid)}" title="Alert">🔔</button></td>
   </tr>`;
      }).join("") + `</tbody></table></div>`;
  }
  if ($("sw-wrap").style.display !== "none") renderSweetSpotChart();
  updateAlertBadge();
  renderWalletDashboard();
  updateCompareDock();
}

// --------------------------------------------------------------------------
// Sweet Spot Scatter Plot (SVG)
// --------------------------------------------------------------------------
function renderSweetSpotChart() {
  const svg = $("sw-svg"), tip = $("sw-tip"), box = $("sw-chart-box");
  if (!svg) return;
  const isLog = $("sw-log").checked;
  const valid = rows.filter(r => r.status === "ok" && r.weight_g && r.spread_pct != null);
  if (!valid.length) {
    svg.innerHTML = '<text x="460" y="160" fill="#8b909c" text-anchor="middle">No price data for chart</text>';
    return;
  }

  const padL = 55, padR = 25, padT = 25, padB = 40, W = 920, H = 320;
  const plotW = W - padL - padR, plotH = H - padT - padB;

  const minW = 1.0, maxW = Math.max(1000, ...valid.map(r => r.weight_g));
  const maxY = Math.min(35, Math.max(25, Math.ceil((Math.max(...valid.map(r => r.spread_pct)) + 2) / 5) * 5));

  const mapX = w => {
    if (isLog) {
      const logMin = Math.log10(minW), logMax = Math.log10(maxW);
      return padL + ((Math.log10(Math.max(minW, w)) - logMin) / (logMax - logMin)) * plotW;
    }
    return padL + ((w - minW) / (maxW - minW)) * plotW;
  };
  const mapY = loss => padT + (1 - Math.max(0, loss) / maxY) * plotH;

  let svgHtml = `<defs>
  <linearGradient id="sweetZone" x1="0" y1="0" x2="0" y2="1">
   <stop offset="0%" stop-color="#4cc38a" stop-opacity="0.18"/>
   <stop offset="100%" stop-color="#4cc38a" stop-opacity="0.04"/>
  </linearGradient>
 </defs>`;

  const yZone = mapY(4.5), hZone = mapY(0) - yZone;
  svgHtml += `<rect x="${padL}" y="${yZone}" width="${plotW}" height="${hZone}" fill="url(#sweetZone)"/>`;
  svgHtml += `<line x1="${padL}" y1="${yZone}" x2="${padL + plotW}" y2="${yZone}" stroke="#4cc38a" stroke-width="1" stroke-dasharray="4,4"/>`;
  svgHtml += `<text x="${padL + 8}" y="${yZone - 6}" fill="#4cc38a" font-size="11" font-weight="600">Sweet Spot Zone (&lt; 4.5% spread)</text>`;

  for (let y = 0; y <= maxY; y += 5) {
    const py = mapY(y);
    svgHtml += `<line x1="${padL}" y1="${py}" x2="${padL + plotW}" y2="${py}" stroke="#2a2f3a" stroke-width="1"/>`;
    svgHtml += `<text x="${padL - 8}" y="${py + 4}" fill="#8b909c" font-size="11" text-anchor="end">${y}%</text>`;
  }

  const stdWeights = isLog ? [1, 2, 5, 10, 20, 31.1, 50, 100, 250, 500, 1000] : [1, 100, 250, 500, 750, 1000];
  for (const w of stdWeights) {
    if (w > maxW) continue;
    const px = mapX(w);
    svgHtml += `<line x1="${px}" y1="${padT}" x2="${px}" y2="${padT + plotH}" stroke="#222631" stroke-width="1" stroke-dasharray="2,3"/>`;
    svgHtml += `<text x="${px}" y="${padT + plotH + 16}" fill="#8b909c" font-size="10" text-anchor="middle">${w === 31.1 ? "1oz" : w + "g"}</text>`;
  }

  svgHtml += `<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" stroke="#3e4554" stroke-width="1"/>`;
  svgHtml += `<line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="#3e4554" stroke-width="1"/>`;

  for (const r of valid) {
    const cx = mapX(r.weight_g), cy = mapY(r.spread_pct);
    const isCoin = r.category === "coin";
    const isColl = r.is_collector || (r.premium_pay_pct != null && r.premium_pay_pct >= 20.0);
    const fill = isColl ? "#e0884c" : isCoin ? "#4cc38a" : "#e0b44c";
    const oos = !r.in_stock;

    if (isCoin) {
      svgHtml += `<circle cx="${cx}" cy="${cy}" r="6" fill="${oos ? "transparent" : fill}" stroke="${fill}" stroke-width="${oos ? 2 : 1}" 
    opacity="${oos ? 0.5 : 0.9}" style="cursor:pointer" data-pid="${esc(r.pid)}"/>`;
    } else {
      svgHtml += `<rect x="${cx - 5}" y="${cy - 5}" width="10" height="10" transform="rotate(45 ${cx} ${cy})" 
    fill="${oos ? "transparent" : fill}" stroke="${fill}" stroke-width="${oos ? 2 : 1}" opacity="${oos ? 0.5 : 0.9}" style="cursor:pointer" data-pid="${esc(r.pid)}"/>`;
    }
  }

  svg.innerHTML = svgHtml;

  svg.onmousemove = e => {
    const dot = e.target.closest("[data-pid]");
    if (!dot) {
      tip.style.display = "none";
      return;
    }
    const pid = dot.dataset.pid;
    const r = rows.find(x => x.pid === pid);
    if (!r) return;
    const rect = box.getBoundingClientRect();
    const x = e.clientX - rect.left + 12, y = e.clientY - rect.top - 10;
    tip.style.left = Math.min(x, rect.width - 250) + "px";
    tip.style.top = Math.max(10, Math.min(y, rect.height - 120)) + "px";
    tip.style.display = "block";
    tip.innerHTML = `<div class="tt-name">${esc(r.name)}</div>
   <div class="tt-row"><span>Weight:</span><b>${num(r.weight_g, f3)} g</b></div>
   <div class="tt-row"><span>You pay:</span><b>${eur(r.shop_sells)}</b></div>
   <div class="tt-row"><span>Loss if sold:</span><b class="c-${lossCls(r.spread_pct)}">${num(r.spread_pct)}% (${eur(r.loss_eur)})</b></div>
   <div class="tt-row"><span>Spot premium:</span><b>${num(r.premium_pay_pct)}%</b></div>
   <div class="tt-row"><span>Deal score:</span><b class="c-${lossCls(r.spread_pct)}">${r.deal_score || "-"} / 100</b></div>
   <div class="tt-row"><span class="mut">${r.in_stock ? "In stock" : "Out of stock"}</span><span class="mut">Click to inspect</span></div>`;
  };

  svg.onmouseleave = () => {
    tip.style.display = "none";
  };

  svg.onclick = e => {
    const dot = e.target.closest("[data-pid]");
    if (!dot) return;
    const pid = dot.dataset.pid;
    const cardEl = $("card-" + pid) || document.querySelector(`[data-fav="${pid}"]`)?.closest(".card");
    if (cardEl) {
      cardEl.scrollIntoView({ behavior: "smooth", block: "center" });
      cardEl.classList.add("card-pulse");
      setTimeout(() => cardEl.classList.remove("card-pulse"), 2800);
    }
  };
}

// --------------------------------------------------------------------------
// Side-by-Side Comparison System
// --------------------------------------------------------------------------
function toggleCompare(pid) {
  if (compareSet.has(pid)) {
    compareSet.delete(pid);
  } else {
    if (compareSet.size >= 4) {
      showToast("Comparison Limit", "You can compare up to 4 products at once.");
      return;
    }
    compareSet.add(pid);
  }
  updateCompareDock();
  render();
}

function updateCompareDock() {
  const dock = $("compare-bar");
  if (!dock) return;
  if (compareSet.size === 0) {
    dock.style.display = "none";
    return;
  }
  dock.style.display = "flex";
  $("compare-count").textContent = `${compareSet.size} item${compareSet.size > 1 ? "s" : ""} (max 4)`;
  const thumbs = $("compare-thumbs");
  thumbs.innerHTML = [...compareSet].map(pid => {
    const r = rows.find(x => x.pid === pid);
    return r && r.image ? `<img class="cmp-thumb" src="${esc(r.image)}" title="${esc(r.name)}">` : "";
  }).join("");
}

function renderCompareModal() {
  const modal = $("compare-modal");
  const content = $("compare-content");
  if (!compareSet.size) {
    showToast("Comparison", "Please select at least 1 item to compare.");
    return;
  }
  const items = [...compareSet].map(pid => rows.find(x => x.pid === pid)).filter(Boolean);
  modal.style.display = "flex";

  const rowsDef = [
    { label: "Product", render: r => `<div class="cmp-prod-col">${r.image ? `<img class="cmp-prod-img" src="${esc(r.image)}">` : ""}<div style="font-weight:700;font-size:14px">${esc(r.name)}</div><div class="mut" style="font-size:11px">${r.flag ? `<img class="cflag" src="${esc(r.flag)}">` : ""}${esc(r.country || "-")}</div></div>` },
    { label: "Category", render: r => esc(r.category || "-").toUpperCase() },
    { label: "Stock Status", render: r => r.in_stock ? `<span class="badge b-in">In Stock</span>` : `<span class="badge b-out">Out of Stock</span>` },
    { label: "Deal Score", render: r => `<span class="badge b-score ${dealScoreCls(r.deal_score)}">Score ${r.deal_score || "-"}</span>` },
    { label: "You Pay", render: r => `<b style="font-size:16px;color:var(--txt)">${eur(r.shop_sells)}</b>` },
    { label: "You Receive", render: r => `<b style="font-size:16px;color:var(--txt)">${eur(r.shop_buys)}</b>` },
    { label: "Resale Loss %", render: r => `<b class="c-${lossCls(r.spread_pct)}">${num(r.spread_pct)}%</b>` },
    { label: "Loss in €", render: r => `<span class="c-${lossCls(r.spread_pct)}">${eur(r.loss_eur)}</span>` },
    { label: "Pay / Pure Gram", render: r => `<b>${eur(r.sell_per_pure_g)}</b> / g` },
    { label: "Receive / Pure Gram", render: r => `${eur(r.buy_per_pure_g)} / g` },
    { label: "Spot Premium", render: r => `+${num(r.premium_pay_pct)}%` },
    { label: "Break-Even Spot", render: r => `<b>${eur(calcBreakevenSpot(r))}</b>/g <span class="mut" style="font-size:11px">(+${num(r.breakeven_pct)}%)</span>` },
    { label: "Purity & Karat", render: r => `${num(r.purity_pct)}% (${karatTxt(r.karat)})` },
    { label: "Pure Gold", render: r => `<b>${num(r.pure_g, f3)} g</b>` },
    { label: "Gross Weight", render: r => `${num(r.weight_g, f3)} g` },
    { label: "52W Timing", render: r => r.history_stats ? `<span class="badge ${r.history_stats.status === 'bargain' ? 'b-bargain' : r.history_stats.status === 'fair' ? 'b-fair' : 'b-high'}">${r.history_stats.badge}</span><div class="mut" style="font-size:11px;margin-top:2px">Cheaper than ${r.history_stats.cheaper_than_pct}% of year</div>` : `<span class="mut">-</span>` },
    { label: "Actions", render: r => `<div style="display:flex;gap:6px;justify-content:center"><a href="${esc(r.url)}" target="_blank" rel="noopener"><button style="font-size:11.5px;padding:5px 8px">Open Site</button></a><button data-wallet-add="${esc(r.pid)}" style="font-size:11.5px;padding:5px 8px" class="on">+ Wallet</button></div>` }
  ];

  content.innerHTML = `<table class="cmp-table">
    <tbody>
      ${rowsDef.map(rw => `
        <tr>
          <td>${rw.label}</td>
          ${items.map(it => `<td>${rw.render(it)}</td>`).join("")}
        </tr>
      `).join("")}
    </tbody>
  </table>`;
}

// --------------------------------------------------------------------------
// "My Investment Wallet" Portfolio Tracker & Real-Time Selling Valuation
// --------------------------------------------------------------------------
let wallet = JSON.parse(localStorage.getItem("gf_wallet") || localStorage.getItem("gf_vault") || "[]");

function saveWallet() {
  localStorage.setItem("gf_wallet", JSON.stringify(wallet));
  localStorage.setItem("gf_vault", JSON.stringify(wallet));
  updateWalletBadge();
  renderWalletDashboard();
}

function updateWalletBadge() {
  const badge = $("wallet-badge");
  const countEl = $("wallet-items-count");
  const totalCount = wallet.reduce((sum, it) => sum + (parseInt(it.qty) || 1), 0);
  if (badge) {
    if (totalCount > 0) {
      badge.style.display = "inline-block";
      badge.textContent = totalCount;
    } else {
      badge.style.display = "none";
    }
  }
  if (countEl) {
    countEl.textContent = `${totalCount} item${totalCount === 1 ? '' : 's'}`;
  }
}

function formatBuyDateTime(dtStr) {
  if (!dtStr) return { full: "-", rel: "" };
  try {
    const d = new Date(dtStr);
    if (isNaN(d.getTime())) return { full: dtStr, rel: "" };
    const now = new Date();
    const diffMs = now - d;
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHrs = Math.floor(diffMin / 60);
    const diffDays = Math.floor(diffHrs / 24);

    let rel = "";
    if (diffSec < 60) rel = "just now";
    else if (diffMin < 60) rel = `${diffMin}m ago`;
    else if (diffHrs < 24) rel = `${diffHrs}h ago`;
    else if (diffDays === 1) rel = "yesterday";
    else if (diffDays < 30) rel = `${diffDays}d ago`;
    else if (diffDays < 365) rel = `${Math.floor(diffDays / 30)}mo ago`;
    else rel = `${(diffDays / 365).toFixed(1)}y ago`;

    const full = d.toLocaleString(undefined, {
      year: "numeric", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit"
    });
    return { full, rel };
  } catch (e) {
    return { full: dtStr, rel: "" };
  }
}

function getHoldingLiveQuote(it) {
  const matched = rows.find(r => (it.pid && r.pid === it.pid) || r.name.toLowerCase() === (it.name || "").toLowerCase());
  let liveSellPrice = null; // what store pays if you sell now
  let storeSellPrice = null; // what store sells it for now
  if (matched) {
    liveSellPrice = matched.shop_buys;
    storeSellPrice = matched.shop_sells;
  } else if (spot && spot.eur_per_g && it.pure_g) {
    liveSellPrice = Math.round(spot.eur_per_g * it.pure_g * 0.95 * 100) / 100;
  }
  return { matched, liveSellPrice, storeSellPrice };
}

function renderWalletDashboard() {
  updateWalletBadge();
  const kpiGrid = $("wallet-kpi-grid");
  const holdingsContainer = $("wallet-holdings-container");
  if (!kpiGrid || !holdingsContainer) return;

  let totalInvested = 0;
  let totalLiquidation = 0;
  let totalPureG = 0;

  wallet.forEach(it => {
    const qty = parseInt(it.qty) || 1;
    const price = it.buy_price != null ? it.buy_price : (it.purchase_price || 0);
    totalInvested += price * qty;
    totalPureG += (it.pure_g || 0) * qty;

    const { liveSellPrice } = getHoldingLiveQuote(it);
    if (liveSellPrice != null) {
      totalLiquidation += liveSellPrice * qty;
    } else {
      totalLiquidation += price * qty;
    }
  });

  const netPnlEur = totalLiquidation - totalInvested;
  const netPnlPct = totalInvested > 0 ? (netPnlEur / totalInvested) * 100 : 0;
  const isProfit = netPnlEur >= 0;
  const meltVal = spot && spot.eur_per_g ? totalPureG * spot.eur_per_g : null;
  const breakevenSpot = totalPureG > 0 ? totalInvested / totalPureG : null;
  const avgCostPerG = totalPureG > 0 ? totalInvested / totalPureG : null;

  kpiGrid.innerHTML = `
    <div class="w-kpi-card kpi-invested">
      <div class="l">Total Invested</div>
      <div class="v">${eur(totalInvested)}</div>
      <div class="sub">${wallet.length} holding${wallet.length === 1 ? '' : 's'} (${wallet.reduce((s, x) => s + (parseInt(x.qty) || 1), 0)} items)</div>
    </div>
    <div class="w-kpi-card kpi-sellback">
      <div class="l">Real-Time Selling Value</div>
      <div class="v">${eur(totalLiquidation)}</div>
      <div class="sub">Store buyback payout if sold right now</div>
    </div>
    <div class="w-kpi-card ${isProfit ? 'kpi-win' : 'kpi-loss'}">
      <div class="l">Net Win / Loss If Sold Now</div>
      <div class="v ${isProfit ? 'c-g' : 'c-r'}">${isProfit ? '+' : ''}${eur(netPnlEur)}</div>
      <div class="sub">
        <span class="${isProfit ? 'badge-win' : 'badge-loss'}">${isProfit ? '▲ WIN +' : '▼ LOSS '}${Math.abs(netPnlPct).toFixed(2)}%</span>
      </div>
    </div>
    <div class="w-kpi-card kpi-gold">
      <div class="l">Total Pure Gold</div>
      <div class="v">${num(totalPureG, f3)} g</div>
      <div class="sub">${num(totalPureG / 31.1034768, f2)} troy oz &middot; Melt: ${eur(meltVal)}</div>
    </div>
    <div class="w-kpi-card">
      <div class="l">Avg Cost / Pure Gram</div>
      <div class="v">${eur(avgCostPerG)} <span style="font-size:12px;font-weight:500">/ g</span></div>
      <div class="sub">Spot: ${spot && spot.eur_per_g ? eur(spot.eur_per_g) : '-'} / g</div>
    </div>
    <div class="w-kpi-card">
      <div class="l">Portfolio Break-Even</div>
      <div class="v">${eur(breakevenSpot)} <span style="font-size:12px;font-weight:500">/ g</span></div>
      <div class="sub">Market gold price needed for 0% loss</div>
    </div>
  `;

  if (!wallet.length) {
    holdingsContainer.innerHTML = `
      <div class="w-empty-state">
        <div style="font-size:32px;margin-bottom:8px">🪙</div>
        <h3>Your Investment Wallet is Empty</h3>
        <p>Log your physical gold coins and bars under 1,000 € with your exact purchase date/time and price paid. The dashboard automatically tracks your immediate profit or loss if sold to GoldForex today.</p>
        <button id="w-empty-add-btn" class="on" style="padding:8px 18px;font-weight:700">+ Add Your First Holding</button>
      </div>
    `;
    const emptyBtn = $("w-empty-add-btn");
    if (emptyBtn) emptyBtn.onclick = () => openWalletModal();
    return;
  }

  holdingsContainer.innerHTML = `
    <div style="overflow-x:auto">
      <table class="w-holdings-table">
        <thead>
          <tr>
            <th>Coin / Bar</th>
            <th>Qty</th>
            <th>Exact Buy Time</th>
            <th>Purchase Price</th>
            <th>Total Cost</th>
            <th>Selling Price NOW</th>
            <th>Line Liquidation</th>
            <th>Win / Loss If Sold Now</th>
            <th>Pure Gold</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${wallet.map((it, idx) => {
            const qty = parseInt(it.qty) || 1;
            const price = it.buy_price != null ? it.buy_price : (it.purchase_price || 0);
            const totalCost = price * qty;
            const { matched, liveSellPrice } = getHoldingLiveQuote(it);

            const unitSell = liveSellPrice != null ? liveSellPrice : price;
            const lineSell = unitSell * qty;
            const linePnl = lineSell - totalCost;
            const linePnlPct = totalCost > 0 ? (linePnl / totalCost) * 100 : 0;
            const isLineWin = linePnl >= 0;

            const timeInfo = formatBuyDateTime(it.buy_datetime || it.date);
            const img = it.image || (matched ? matched.image : null);
            const flag = it.flag || (matched ? matched.flag : null);

            return `
              <tr id="holding-${idx}">
                <td>
                  <div class="w-holding-item">
                    ${img ? `<img src="${esc(img)}" class="w-holding-img" alt="">` : ''}
                    <div>
                      <div style="display:flex;align-items:center;gap:6px">
                        <b>${esc(it.name)}</b>
                        ${flag ? `<img src="${esc(flag)}" style="width:16px;height:11px;border-radius:2px;object-fit:cover" alt="">` : ''}
                      </div>
                      <div class="mut" style="font-size:11.5px">
                        ${esc(it.category || 'coin')} &middot; ${it.pure_g ? `${num(it.pure_g, f3)}g pure` : ''}
                        ${it.notes ? `&middot; <i>${esc(it.notes)}</i>` : ''}
                      </div>
                    </div>
                  </div>
                </td>
                <td><b>${qty}&times;</b></td>
                <td>
                  <div><b>${timeInfo.full}</b></div>
                  ${timeInfo.rel ? `<div class="mut" style="font-size:11px">${timeInfo.rel}</div>` : ''}
                </td>
                <td><b>${eur(price)}</b></td>
                <td>${eur(totalCost)}</td>
                <td>
                  <div style="font-weight:700;color:var(--txt)">${eur(unitSell)}</div>
                  <div class="mut" style="font-size:10.5px">GoldForex buys at</div>
                </td>
                <td><b>${eur(lineSell)}</b></td>
                <td>
                  <span class="${isLineWin ? 'badge-win' : 'badge-loss'}">
                    ${isLineWin ? '▲ +' : '▼ '}${eur(linePnl)} (${isLineWin ? '+' : ''}${num(linePnlPct)}%)
                  </span>
                </td>
                <td>${num((it.pure_g || 0) * qty, f3)} g</td>
                <td>
                  <div style="display:flex;gap:6px;justify-content:flex-end">
                    <button class="w-action-btn" data-w-edit="${idx}" title="Edit holding" style="padding:4px 7px;font-size:12px">✏️</button>
                    ${it.pid ? `<button class="w-action-btn" data-chart="${esc(it.pid)}" title="View price chart" style="padding:4px 7px;font-size:12px">📈</button>` : ''}
                    ${it.url || (matched ? matched.url : '') ? `<a href="${esc(it.url || matched.url)}" target="_blank" rel="noopener"><button class="w-action-btn" style="padding:4px 7px;font-size:12px" title="Open product on site">🔗</button></a>` : ''}
                    <button class="w-action-btn" data-w-del="${idx}" title="Delete holding" style="padding:4px 7px;font-size:12px;color:var(--r);border-color:#611919">✕</button>
                  </div>
                </td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function openWalletModal(prefillPid = null, editIdx = null) {
  const modal = $("wallet-modal");
  if (!modal) return;
  modal.style.display = "flex";

  const sel = $("w-form-product");
  const under1000 = rows.filter(r => r.status === "ok" && r.shop_sells && r.shop_sells < 1000.0);
  under1000.sort((a, b) => a.shop_sells - b.shop_sells);

  sel.innerHTML = '<option value="">-- Choose from store (< 1,000 €) or custom --</option>' +
    under1000.map(r => `<option value="${esc(r.pid)}">${esc(r.name)} — Pay: ${eur(r.shop_sells)} | Store Buys: ${eur(r.shop_buys)}</option>`).join("");

  const now = new Date();
  const nowIso = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  $("w-form-datetime").value = nowIso;

  if (editIdx != null && wallet[editIdx]) {
    const it = wallet[editIdx];
    $("w-modal-title").textContent = "✏️ Edit Investment Holding";
    $("w-form-id").value = String(editIdx);
    $("w-form-product").value = it.pid || "";
    $("w-form-name").value = it.name || "";
    $("w-form-category").value = it.category || "coin";
    $("w-form-datetime").value = it.buy_datetime || (it.date ? it.date + "T12:00" : nowIso);
    $("w-form-price").value = it.buy_price != null ? it.buy_price : (it.purchase_price || "");
    $("w-form-qty").value = it.qty || 1;
    $("w-form-pure").value = it.pure_g || "";
    $("w-form-notes").value = it.notes || "";
    $("w-form-del").style.display = "inline-block";
  } else {
    $("w-modal-title").textContent = "➕ Add Gold Coin or Bar to Wallet";
    $("w-form-id").value = "";
    $("w-form-del").style.display = "none";
    if (prefillPid) {
      const r = rows.find(x => x.pid === prefillPid);
      if (r) {
        sel.value = prefillPid;
        $("w-form-name").value = r.name;
        $("w-form-category").value = r.category || "coin";
        $("w-form-price").value = r.shop_sells || "";
        $("w-form-qty").value = 1;
        $("w-form-pure").value = r.pure_g || "";
        $("w-form-notes").value = "";
      }
    } else {
      $("w-form-name").value = "";
      $("w-form-category").value = "coin";
      $("w-form-price").value = "";
      $("w-form-qty").value = 1;
      $("w-form-pure").value = "";
      $("w-form-notes").value = "";
    }
  }

  updateFormLivePreview();
}

function updateFormLivePreview() {
  const preview = $("w-form-preview");
  if (!preview) return;

  const pid = $("w-form-product").value;
  const name = $("w-form-name").value.trim();
  const buyPrice = parseFloat($("w-form-price").value) || 0;
  const qty = parseInt($("w-form-qty").value) || 1;
  const pureG = parseFloat($("w-form-pure").value) || 0;

  const matched = rows.find(r => (pid && r.pid === pid) || (name && r.name.toLowerCase() === name.toLowerCase()));
  let liveSellPrice = matched && matched.shop_buys ? matched.shop_buys : (spot && spot.eur_per_g && pureG ? spot.eur_per_g * pureG * 0.95 : null);

  if (liveSellPrice != null && buyPrice > 0) {
    const diff = (liveSellPrice - buyPrice) * qty;
    const diffPct = ((liveSellPrice / buyPrice) - 1) * 100;
    const isWin = diff >= 0;
    preview.innerHTML = `
      <div>
        <span>If sold now, GoldForex pays: <b>${eur(liveSellPrice)}</b> / unit</span>
        <span class="mut" style="font-size:11px"> (Total: ${eur(liveSellPrice * qty)})</span>
      </div>
      <div>
        Immediate Win/Loss:
        <span class="${isWin ? 'badge-win' : 'badge-loss'}">
          ${isWin ? '▲ +' : '▼ '}${eur(diff)} (${isWin ? '+' : ''}${num(diffPct)}% ${isWin ? 'WIN' : 'LOSS'})
        </span>
      </div>
    `;
  } else if (matched && matched.shop_buys) {
    preview.innerHTML = `
      <div>GoldForex currently pays <b>${eur(matched.shop_buys)}</b> for this item. Enter your buy price to calculate win/loss.</div>
    `;
  } else {
    preview.innerHTML = `
      <span class="mut">Select a product or enter buy price to view real-time liquidation value &amp; estimated win/loss.</span>
    `;
  }
}

function saveWalletHolding() {
  const name = $("w-form-name").value.trim();
  if (!name) {
    alert("Please enter the coin or bar name.");
    return;
  }
  const buyPrice = parseFloat($("w-form-price").value);
  if (isNaN(buyPrice) || buyPrice < 0) {
    alert("Please enter a valid purchase price.");
    return;
  }
  const qty = parseInt($("w-form-qty").value) || 1;
  const pureG = parseFloat($("w-form-pure").value) || 0;
  const buyDatetime = $("w-form-datetime").value || new Date().toISOString().slice(0, 16);
  const category = $("w-form-category").value || "coin";
  const notes = $("w-form-notes").value.trim();
  const pid = $("w-form-product").value || null;
  const matched = pid ? rows.find(x => x.pid === pid) : null;
  const image = matched ? matched.image : null;
  const flag = matched ? matched.flag : null;
  const url = matched ? matched.url : null;
  const country = matched ? matched.country : null;

  const editIdStr = $("w-form-id").value;
  if (editIdStr !== "" && wallet[parseInt(editIdStr)]) {
    const idx = parseInt(editIdStr);
    wallet[idx] = {
      ...wallet[idx],
      pid,
      name,
      category,
      buy_datetime: buyDatetime,
      buy_price: buyPrice,
      qty,
      pure_g: pureG,
      notes,
      image: image || wallet[idx].image,
      flag: flag || wallet[idx].flag,
      url: url || wallet[idx].url,
      country: country || wallet[idx].country,
      updated_at: new Date().toISOString()
    };
    showToast("Wallet Updated", `Updated ${name} in your wallet`);
  } else {
    wallet.push({
      id: "w_" + Date.now() + "_" + Math.random().toString(36).substr(2, 4),
      pid,
      name,
      category,
      buy_datetime: buyDatetime,
      buy_price: buyPrice,
      qty,
      pure_g: pureG,
      notes,
      image,
      flag,
      url,
      country,
      created_at: new Date().toISOString()
    });
    showToast("Added to Wallet", `Logged ${qty}× ${name} in your investment wallet`);
  }

  saveWallet();
  $("wallet-modal").style.display = "none";
}

function deleteWalletHolding(idx) {
  if (idx == null || !wallet[idx]) return;
  if (confirm(`Remove ${wallet[idx].name} from your investment wallet?`)) {
    const removedName = wallet[idx].name;
    wallet.splice(idx, 1);
    saveWallet();
    showToast("Removed", `Removed ${removedName} from wallet`);
    $("wallet-modal").style.display = "none";
  }
}

function exportWalletJSON() {
  const blob = new Blob([JSON.stringify(wallet, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `gold_wallet_backup_${new Date().toISOString().split("T")[0]}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importWalletJSON(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      if (Array.isArray(data)) {
        wallet = data;
        saveWallet();
        showToast("Wallet Restored", `Successfully imported ${wallet.length} holdings`);
      } else {
        alert("Invalid wallet file format (expected JSON array).");
      }
    } catch (err) {
      alert("Failed to parse JSON file: " + err.message);
    }
  };
  reader.readAsText(file);
}

// Basket Optimizer Add-to-Wallet Helper
function addBasketToWallet(bundleList) {
  const now = new Date();
  const nowIso = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  bundleList.forEach(({ item, count }) => {
    wallet.push({
      id: "w_" + Date.now() + "_" + Math.random().toString(36).substr(2, 4),
      pid: item.pid,
      name: item.name,
      category: item.category || "coin",
      buy_datetime: nowIso,
      buy_price: item.shop_sells,
      qty: count,
      pure_g: item.pure_g,
      notes: "Basket Optimizer recommendation",
      image: item.image,
      flag: item.flag,
      url: item.url,
      country: item.country,
      created_at: new Date().toISOString()
    });
  });
  saveWallet();
  showToast("Basket Saved", `Added ${bundleList.reduce((s, x) => s + x.count, 0)} items to your wallet!`);
  $("basket-modal").style.display = "none";
}

// --------------------------------------------------------------------------
// Budget Basket Optimizer
// --------------------------------------------------------------------------
function openBasketModal() {
  $("basket-modal").style.display = "flex";
  runBasketOptimizer();
}

function runBasketOptimizer() {
  const budget = parseFloat($("bkt-budget").value) || 0;
  if (budget <= 50) {
    $("bkt-results").innerHTML = `<div class="mut" style="padding:20px;text-align:center">Please enter a budget of at least €50.</div>`;
    return;
  }
  const strategy = $("bkt-strat").value;
  const typeFilter = $("bkt-type").value;
  const maxCopies = parseInt($("bkt-max-copies").value) || 99;

  let pool = rows.filter(r => r.status === "ok" && r.in_stock && r.shop_sells && r.pure_g && r.shop_sells <= budget);
  if (typeFilter !== "all") {
    pool = pool.filter(r => r.category === typeFilter);
  }
  if (!pool.length) {
    $("bkt-results").innerHTML = `<div class="mut" style="padding:20px;text-align:center">No in-stock items fit within that budget. Try increasing your budget or changing filters.</div>`;
    return;
  }

  if (strategy === "pure") {
    pool.sort((a, b) => (a.sell_per_pure_g || 1e9) - (b.sell_per_pure_g || 1e9));
  } else {
    pool.sort((a, b) => (a.spread_pct || 100) - (b.spread_pct || 100));
  }

  let curRemaining = budget;
  let curBundle = [];

  for (const item of pool) {
    let count = 0;
    while (count < maxCopies && curRemaining >= item.shop_sells) {
      curBundle.push(item);
      curRemaining -= item.shop_sells;
      count++;
    }
  }

  for (const item of pool) {
    while (curRemaining >= item.shop_sells) {
      const existingCount = curBundle.filter(x => x.pid === item.pid).length;
      if (existingCount >= maxCopies) break;
      curBundle.push(item);
      curRemaining -= item.shop_sells;
    }
  }

  const bestBundle = curBundle;
  const bestRemaining = curRemaining;

  const itemCounts = new Map();
  bestBundle.forEach(it => {
    itemCounts.set(it.pid, (itemCounts.get(it.pid) || { item: it, count: 0 }));
    itemCounts.get(it.pid).count++;
  });

  const bundleList = [...itemCounts.values()];
  const totalSpent = budget - bestRemaining;
  const totalPureG = bestBundle.reduce((sum, it) => sum + (it.pure_g || 0), 0);
  const totalBuys = bestBundle.reduce((sum, it) => sum + (it.shop_buys || (it.shop_sells * 0.95)), 0);
  const totalLossEur = totalSpent - totalBuys;
  const weightedLossPct = totalSpent > 0 ? (totalLossEur / totalSpent) * 100 : 0;
  const effPricePerG = totalPureG > 0 ? totalSpent / totalPureG : 0;

  $("bkt-results").innerHTML = `
    <div class="bkt-summary">
      <div><span class="l">Total Spent</span><span class="v">${eur(totalSpent)}</span><span class="mut" style="font-size:11px">Change: ${eur(bestRemaining)}</span></div>
      <div><span class="l">Pure Gold Obtained</span><span class="v">${num(totalPureG, f3)} g</span><span class="mut" style="font-size:11px">${num(totalPureG / 31.1034768, f2)} oz</span></div>
      <div><span class="l">Effective Cost / Pure Gram</span><span class="v">${eur(effPricePerG)} / g</span><span class="mut" style="font-size:11px">All-in cost</span></div>
      <div><span class="l">Weighted Resale Spread</span><span class="v c-${lossCls(weightedLossPct)}">${num(weightedLossPct)}%</span><span class="mut" style="font-size:11px">Loss: ${eur(totalLossEur)}</span></div>
      <div><span class="l">Current Cash-In Value</span><span class="v">${eur(totalBuys)}</span><span class="mut" style="font-size:11px">Immediate liquidation</span></div>
    </div>
    <div style="font-weight:700;font-size:14px;color:var(--txt);margin-bottom:10px;display:flex;justify-content:space-between;align-items:center">
      <span>Recommended Optimal Allocation (${bestBundle.length} items):</span>
      <button id="bkt-add-vault" class="on" style="font-size:12px;padding:5px 12px">+ Add Entire Basket to My Vault</button>
    </div>
    <div>
      ${bundleList.map(({ item, count }) => `
        <div class="bkt-item">
          <div class="bkt-qty">${count}×</div>
          ${item.image ? `<img src="${esc(item.image)}">` : ''}
          <div style="flex:1">
            <div style="font-weight:700">${esc(item.name)} <span class="badge b-score ${dealScoreCls(item.deal_score)}">Score ${item.deal_score || '-'}</span></div>
            <div class="mut" style="font-size:12px">${num(item.pure_g, f3)} g pure each &middot; Spread: <b class="c-${lossCls(item.spread_pct)}">${num(item.spread_pct)}%</b> &middot; ${eur(item.shop_sells)} each</div>
          </div>
          <div style="text-align:right">
            <div style="font-size:16px;font-weight:700;color:var(--gold)">${eur(item.shop_sells * count)}</div>
            <div class="mut" style="font-size:11.5px">${num(item.pure_g * count, f3)} g pure gold</div>
          </div>
        </div>
      `).join("")}
    </div>
  `;

  const addVaultBtn = $("bkt-add-vault");
  if (addVaultBtn) {
    addVaultBtn.onclick = () => addBasketToWallet(bundleList);
  }
}

// --------------------------------------------------------------------------
// Competitor Dealer Arbitrage
// --------------------------------------------------------------------------
async function openDealerModal(refresh = false) {
  $("dealer-modal").style.display = "flex";
  const content = $("dealer-content");
  content.innerHTML = `<div class="cmsg" style="padding:40px 0">Fetching live benchmark prices from BullionByPost.eu...</div>`;
  try {
    const res = await fetch("/api/competitor" + (refresh ? "?refresh=1" : ""));
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || "Failed to load competitor data");
    renderDealerTable(data);
  } catch (err) {
    content.innerHTML = `<div class="cmsg" style="color:var(--r)">Failed to load competitor data: ${esc(err.message)}</div>`;
  }
}

function renderDealerTable(data) {
  const content = $("dealer-content");
  const bms = data.benchmarks || [];
  if (!bms.length) {
    content.innerHTML = `<div class="cmsg">No benchmark comparison data available.</div>`;
    return;
  }

  content.innerHTML = `
    <div class="mut" style="font-size:12px;margin-bottom:12px">Last checked: ${esc((data.fetched_at || '').replace('T', ' '))} &middot; Live benchmark prices from BullionByPost.eu (EU standard checkout rate).</div>
    <table class="cmp-table">
      <thead>
        <tr>
          <th>Benchmark Product</th>
          <th>GoldForex (Brussels)</th>
          <th>BullionByPost.eu</th>
          <th>Difference</th>
          <th>Best Price Verdict</th>
        </tr>
      </thead>
      <tbody>
        ${bms.map(b => {
          const isGfCheaper = b.cheaper === "goldforex";
          const isBbpCheaper = b.cheaper === "bullionbypost";
          return `
            <tr>
              <td>
                <div style="font-weight:700">${esc(b.name)}</div>
                <div class="mut" style="font-size:11px">${num(b.pure_g, f3)} g pure gold</div>
              </td>
              <td>
                <b style="font-size:15px;color:var(--txt)">${eur(b.gf_price)}</b>
                ${b.gf_url ? `<br><a href="${esc(b.gf_url)}" target="_blank" class="mut" style="font-size:11px"><u>GoldForex</u></a>` : ''}
              </td>
              <td>
                <b style="font-size:15px;color:var(--txt)">${eur(b.bbp_price)}</b>
                ${b.bbp_url ? `<br><a href="${esc(b.bbp_url)}" target="_blank" class="mut" style="font-size:11px"><u>BullionByPost</u></a>` : ''}
              </td>
              <td>
                ${b.diff_eur != null ? `<b>${eur(b.diff_eur)}</b> <span class="mut" style="font-size:11px">(${b.diff_pct}%)</span>` : '-'}
              </td>
              <td>
                ${isGfCheaper ? `<span class="b-cheaper gf">🟢 GoldForex is €${b.diff_eur} cheaper!</span>` : (isBbpCheaper ? `<span class="b-cheaper bbp">🟡 BullionByPost is €${b.diff_eur} cheaper</span>` : `<span class="mut">Similar Price</span>`)}
              </td>
            </tr>
          `;
        }).join("")}
      </tbody>
    </table>
  `;
}

// --------------------------------------------------------------------------
// Alerts Management
// --------------------------------------------------------------------------
function updateAlertBadge() {
  const active = alerts.filter(a => a.enabled).length;
  const b = $("alerts-count");
  if (active > 0) {
    b.style.display = "inline-block";
    b.textContent = active;
  } else {
    b.style.display = "none";
  }
}

function checkAlerts() {
  let triggered = false;
  for (const alt of alerts) {
    if (!alt.enabled) continue;
    const r = rows.find(x => x.pid === alt.pid);
    if (!r || r.status !== "ok") continue;
    let hit = false, reason = "";
    if (alt.stock && r.in_stock && alt.was_oos) {
      hit = true;
      reason = "is back in stock!";
    }
    if (alt.max_price && r.shop_sells && r.shop_sells <= alt.max_price) {
      hit = true;
      reason = `dropped to ${eur(r.shop_sells)} (target ${eur(alt.max_price)})`;
    }
    if (alt.max_loss && r.spread_pct && r.spread_pct <= alt.max_loss) {
      hit = true;
      reason = `loss dropped to ${num(r.spread_pct)}% (target ${alt.max_loss}%)`;
    }

    if (hit) {
      const key = alt.id + ":" + reason;
      if (!lastFiredAlerts.has(key)) {
        lastFiredAlerts.add(key);
        triggered = true;
        showToast(`Alert: ${r.name}`, reason);
        if (window.Notification && Notification.permission === "granted") {
          new Notification(`GoldForex Alert: ${r.name}`, { body: `${r.name} ${reason}`, icon: r.image });
        }
      }
    }
    alt.was_oos = !r.in_stock;
  }
  if (triggered) playChime();
}

function openItemAlert(pid) {
  const r = rows.find(x => x.pid === pid);
  if (!r) return;
  const existing = alerts.find(a => a.pid === pid);
  $("alt-modal").style.display = "flex";
  $("alt-modal").dataset.pid = pid;
  $("alt-title").textContent = "Set Alert: " + r.name;
  $("alt-desc").textContent = `Current price: ${eur(r.shop_sells)} · Loss: ${num(r.spread_pct)}% · ${r.in_stock ? "In stock" : "Out of stock"}`;
  $("alt-stock").checked = existing ? !!existing.stock : !r.in_stock;
  $("alt-price").value = existing && existing.max_price ? existing.max_price : (r.shop_sells ? Math.round(r.shop_sells * 0.98) : "");
  $("alt-loss").value = existing && existing.max_loss ? existing.max_loss : (r.spread_pct ? Math.max(1, +(r.spread_pct - 0.5).toFixed(1)) : "");
  $("alt-delete").style.display = existing ? "inline-block" : "none";
}

function saveItemAlert() {
  const pid = $("alt-modal").dataset.pid;
  const r = rows.find(x => x.pid === pid);
  if (!r) return;
  const stock = $("alt-stock").checked;
  const price = parseFloat($("alt-price").value) || null;
  const loss = parseFloat($("alt-loss").value) || null;
  if (!stock && !price && !loss) {
    alert("Please select at least one alert condition.");
    return;
  }

  alerts = alerts.filter(a => a.pid !== pid);
  alerts.push({
    id: "alt_" + Date.now(),
    pid,
    name: r.name,
    stock,
    max_price: price,
    max_loss: loss,
    enabled: true,
    was_oos: !r.in_stock,
    created_at: new Date().toISOString()
  });
  localStorage.setItem("gf_alerts", JSON.stringify(alerts));
  $("alt-modal").style.display = "none";
  showToast("Alert Saved", `Alert set for ${r.name}`);
  render();
}

function deleteItemAlert() {
  const pid = $("alt-modal").dataset.pid;
  alerts = alerts.filter(a => a.pid !== pid);
  localStorage.setItem("gf_alerts", JSON.stringify(alerts));
  $("alt-modal").style.display = "none";
  render();
}

function renderAlertsManager() {
  $("mgr-modal").style.display = "flex";
  const list = $("mgr-list");
  if (!alerts.length) {
    list.innerHTML = '<div class="cmsg" style="padding:20px">No active alerts. Click 🔔 on any card to add an alert.</div>';
    return;
  }
  list.innerHTML = alerts.map((a, i) => `
  <div class="alt-row">
   <div>
    <b>${esc(a.name)}</b>
    <div class="mut" style="font-size:12px;margin-top:2px">
     ${a.stock ? "● Back in stock " : ""}${a.max_price ? "● Price \u2264 " + eur(a.max_price) + " " : ""}${a.max_loss ? "● Loss \u2264 " + a.max_loss + "% " : ""}
    </div>
   </div>
   <div style="display:flex;gap:8px;align-items:center">
    <label class="mut" style="font-size:12px"><input type="checkbox" data-alt-toggle="${i}" ${a.enabled ? "checked" : ""}> active</label>
    <button data-alt-del="${i}" style="padding:4px 8px;font-size:12px;color:var(--r);border-color:#611919">✕</button>
   </div>
  </div>
 `).join("");
}

// --------------------------------------------------------------------------
// Data Loading
// --------------------------------------------------------------------------
async function load(refresh) {
  $("meta").textContent = refresh ? "scraping..." : "loading cached data...";
  $("refresh").disabled = true;
  try {
    const res = await fetch("/api/prices?refresh=" + (refresh ? 1 : 0));
    const d = await res.json();
    if (!res.ok || d.error) {
      const e = $("err");
      e.style.display = "block";
      e.textContent = d.error || ("HTTP error " + res.status);
      if (!d.rows) {
        $("meta").textContent = "Error: " + (d.error || res.statusText);
        $("refresh").disabled = false;
        return;
      }
    }
    rows = d.rows || [];
    const httpCount = d.via?.http ?? 0;
    const browserCount = d.via?.browser ?? 0;
    const okCount = d.ok ?? rows.filter(r => r.status === "ok").length;
    const totalCount = d.count ?? rows.length;
    const elapsed = d.elapsed_s != null ? d.elapsed_s + "s" : "";
    const scrapedAt = (d.scraped_at || "").replace("T", " ");
    const staleTag = d.stale ? " [stale cache]" : "";
    $("meta").textContent = `${okCount}/${totalCount} ok${elapsed ? " in " + elapsed : ""} (http ${httpCount}, browser ${browserCount}) - ${scrapedAt}${staleTag}`;
    const bad = rows.filter(r => r.status !== "ok"), e = $("err");
    if (!d.error) {
      e.style.display = bad.length ? "block" : "none";
      e.textContent = bad.map(r => r.name + ": " + r.error).join("\n");
    }
    updateCountryOptions();
    updateDataAge();
    computeDealScores();
    checkAlerts();
    render();
  } catch (x) {
    $("meta").textContent = "error: " + x;
    const e = $("err");
    e.style.display = "block";
    e.textContent = String(x);
  }
  $("refresh").disabled = false;
}

// --------------------------------------------------------------------------
// TradingView Lightweight Charts Modal
// --------------------------------------------------------------------------
let ch1 = null, ch2 = null, cdata = null, cpid = null, cser = null, curRange = 0;

function killCharts() {
  [ch1, ch2].forEach(c => {
    try {
      c && c.remove();
    } catch (e) {}
  });
  ch1 = ch2 = null;
}

function closeModal() {
  killCharts();
  $("modal").style.display = "none";
}

async function openChart(pid, refresh) {
  const r = rows.find(x => x.pid === pid);
  cpid = pid;
  killCharts();
  $("modal").style.display = "flex";
  $("mtitle").textContent = r ? r.name : pid;
  $("msub").textContent = "";
  $("rng").innerHTML = "";
  $("mbody").innerHTML = '<div class="cmsg">Reading the price history with Chrome... (first time can take 10-20 s)</div>';
  try {
    const res = await fetch("/api/chart/" + pid + (refresh ? "?refresh=1" : ""));
    const d = await res.json();
    if (!res.ok || d.error) throw new Error(d.error || ("HTTP " + res.status));
    cdata = d;
    if (r) r.has_chart = true;
    drawCharts(d);
  } catch (e) {
    $("mbody").innerHTML = '<div class="cmsg">Could not load the chart: ' + esc(e.message) + '</div>';
  }
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

function applyRange(days) {
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

function drawCharts(d) {
  if (typeof LightweightCharts === "undefined") {
    $("mbody").innerHTML = '<div class="cmsg">Lightweight Charts library could not be loaded.</div>';
    return;
  }
  cser = alignSeries(d.buy, d.sell);
  if (!cser.B.length) {
    $("mbody").innerHTML = '<div class="cmsg">The site returned no price history for this product.</div>';
    return;
  }
  $("mbody").innerHTML = '<div class="leg"><span><i style="background:#e0b44c"></i>You pay (shop sells)</span><span><i style="background:#4cc38a"></i>You receive (shop buys)</span></div><div id="ch1"></div><div class="leg"><span><i style="background:#e05c5c"></i>Loss when selling back (%)</span></div><div id="ch2"></div><div class="cstats" id="cstats"></div>';
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
  $("msub").textContent = "Loaded " + d.fetched_at.replace("T", " ") + " - history from site Highcharts";
}

// --------------------------------------------------------------------------
// Event Listeners & Startup
// --------------------------------------------------------------------------
$("rng").onclick = e => {
  const b = e.target.closest("[data-days]");
  if (b) applyRange(+b.dataset.days);
};

document.querySelectorAll("[data-f]").forEach(b => b.onclick = () => {
  filter = b.dataset.f;
  document.querySelectorAll("[data-f]").forEach(x => x.classList.toggle("on", x === b));
  render();
});

document.querySelectorAll("[data-v]").forEach(b => b.onclick = () => {
  view = b.dataset.v;
  document.querySelectorAll("[data-v]").forEach(x => x.classList.toggle("on", x === b));
  render();
});

["stock", "sort", "fcountry", "fkarat", "fweight"].forEach(i => $(i).onchange = render);
["bmin", "bmax", "search"].forEach(i => $(i).oninput = render);

$("clear-filters").onclick = () => {
  $("search").value = "";
  $("fcountry").value = "";
  $("fkarat").value = "";
  $("fweight").value = "";
  $("bmin").value = "";
  $("bmax").value = "";
  render();
};

$("refresh").onclick = () => {
  load(true);
  loadSpot(true);
};

$("setbtn").onclick = e => {
  e.stopPropagation();
  const p = $("settings");
  p.style.display = p.style.display === "block" ? "none" : "block";
};

document.addEventListener("click", e => {
  if (!e.target.closest("#settings")) $("settings").style.display = "none";
});

$("silent").onchange = async e => {
  const on = e.target.checked;
  try {
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ silent: on ? 1 : 0 })
    });
    const d = await res.json();
    e.target.checked = !!d.silent;
  } catch (x) {
    e.target.checked = !on;
  }
};

(async () => {
  try {
    const d = await (await fetch("/api/settings")).json();
    $("silent").checked = !!d.silent;
  } catch (x) {}
})();

$("rescan").onclick = async () => {
  const b = $("rescan");
  b.disabled = true;
  b.textContent = "Scanning...";
  try {
    const d = await (await fetch("/api/products?refresh=1")).json();
    b.textContent = d.error && d.source !== "site" ? "Scan failed" : `List: ${d.urls.length} products`;
    if (d.error) {
      $("err").style.display = "block";
      $("err").textContent = "Product list: " + d.error;
    }
    await load(true);
  } catch (x) {
    b.textContent = "Scan failed";
  }
  b.disabled = false;
};

// Delegated Clicks for Cards & Tables
document.addEventListener("click", e => {
  const chBtn = e.target.closest("[data-chart]");
  if (chBtn) openChart(chBtn.dataset.chart, false);

  const favBtn = e.target.closest("[data-fav]");
  if (favBtn) {
    const pid = favBtn.dataset.fav;
    if (favs.has(pid)) favs.delete(pid);
    else favs.add(pid);
    localStorage.setItem("gf_favs", JSON.stringify([...favs]));
    render();
  }

  const cmpBtn = e.target.closest("[data-cmp]");
  if (cmpBtn) {
    toggleCompare(cmpBtn.dataset.cmp);
  }

  const altBtn = e.target.closest("[data-alert]");
  if (altBtn) openItemAlert(altBtn.dataset.alert);

  const wAdd = e.target.closest("[data-wallet-add]");
  if (wAdd) {
    $("compare-modal").style.display = "none";
    openWalletModal(wAdd.dataset.walletAdd);
  }

  const wEdit = e.target.closest("[data-w-edit]");
  if (wEdit) {
    openWalletModal(null, parseInt(wEdit.dataset.wEdit));
  }

  const wDel = e.target.closest("[data-w-del]");
  if (wDel) {
    deleteWalletHolding(parseInt(wDel.dataset.wDel));
  }
});

// Favourites filter toggle
$("fav-filter").onclick = () => {
  filter = filter === "fav" ? "all" : "fav";
  document.querySelectorAll("[data-f]").forEach(x => x.classList.toggle("on", x.dataset.f === filter));
  render();
};

// Modal close handling
$("mclose").onclick = closeModal;
$("modal").onclick = e => {
  if (e.target === $("modal")) closeModal();
};

document.addEventListener("keydown", e => {
  if (e.key === "Escape") {
    closeModal();
    $("alt-modal").style.display = "none";
    $("mgr-modal").style.display = "none";
    $("weights-modal").style.display = "none";
    $("compare-modal").style.display = "none";
    $("wallet-modal").style.display = "none";
    $("basket-modal").style.display = "none";
    $("dealer-modal").style.display = "none";
  }
});

$("mreload").onclick = () => cpid && openChart(cpid, true);

// Sweet spot chart toggle
$("sw-btn").onclick = () => {
  const s = $("sw-wrap");
  const show = s.style.display === "none";
  s.style.display = show ? "block" : "none";
  $("sw-btn").classList.toggle("on", show);
  if (show) renderSweetSpotChart();
};

$("sw-close").onclick = () => {
  $("sw-wrap").style.display = "none";
  $("sw-btn").classList.remove("on");
};

$("sw-log").onchange = renderSweetSpotChart;

// Weights modal handling
$("weights-btn").onclick = () => {
  $("w-loss").value = Number.isFinite(+dealWeights.loss) ? dealWeights.loss : 45;
  $("w-prem").value = Number.isFinite(+dealWeights.prem) ? dealWeights.prem : 35;
  $("w-pure").value = Number.isFinite(+dealWeights.pure) ? dealWeights.pure : 20;
  $("w-loss-val").textContent = $("w-loss").value + "%";
  $("w-prem-val").textContent = $("w-prem").value + "%";
  $("w-pure-val").textContent = $("w-pure").value + "%";
  $("weights-modal").style.display = "flex";
};

$("w-close").onclick = () => {
  $("weights-modal").style.display = "none";
};

["w-loss", "w-prem", "w-pure"].forEach(id => {
  $(id).oninput = () => {
    $(id + "-val").textContent = $(id).value + "%";
  };
});

$("w-reset").onclick = () => {
  $("w-loss").value = 45;
  $("w-prem").value = 35;
  $("w-pure").value = 20;
  $("w-loss-val").textContent = "45%";
  $("w-prem-val").textContent = "35%";
  $("w-pure-val").textContent = "20%";
};

$("w-save").onclick = () => {
  dealWeights = {
    loss: Number.isFinite(+($("w-loss").value)) ? +($("w-loss").value) : 45,
    prem: Number.isFinite(+($("w-prem").value)) ? +($("w-prem").value) : 35,
    pure: Number.isFinite(+($("w-pure").value)) ? +($("w-pure").value) : 20
  };
  localStorage.setItem("gf_deal_weights", JSON.stringify(dealWeights));
  $("weights-modal").style.display = "none";
  showToast("Weights Updated", "Deal scores recomputed with custom weights");
  computeDealScores();
  render();
};

// Item alert modal
$("alt-close").onclick = () => {
  $("alt-modal").style.display = "none";
};
$("alt-cancel").onclick = () => {
  $("alt-modal").style.display = "none";
};
$("alt-save").onclick = saveItemAlert;
$("alt-delete").onclick = deleteItemAlert;

// Alerts manager modal
$("alerts-btn").onclick = renderAlertsManager;
$("mgr-close").onclick = () => {
  $("mgr-modal").style.display = "none";
};
$("mgr-test-sound").onclick = () => {
  playChime();
  showToast("Sound Test", "Audio chime played successfully!");
};
$("mgr-req-notif").onclick = () => {
  if (window.Notification) {
    Notification.requestPermission().then(p => {
      showToast("Notifications", p === "granted" ? "Browser notifications enabled!" : "Notification permission denied.");
    });
  }
};

$("mgr-clear").onclick = () => {
  if (confirm("Clear all alerts?")) {
    alerts = [];
    localStorage.setItem("gf_alerts", "[]");
    renderAlertsManager();
    render();
  }
};

$("mgr-list").onclick = e => {
  const tog = e.target.closest("[data-alt-toggle]");
  if (tog) {
    const idx = +tog.dataset.altToggle;
    if (alerts[idx]) {
      alerts[idx].enabled = tog.checked;
      localStorage.setItem("gf_alerts", JSON.stringify(alerts));
      render();
    }
  }
  const del = e.target.closest("[data-alt-del]");
  if (del) {
    const idx = +del.dataset.altDel;
    alerts.splice(idx, 1);
    localStorage.setItem("gf_alerts", JSON.stringify(alerts));
    renderAlertsManager();
    render();
  }
};

// Comparison Events
$("compare-open").onclick = renderCompareModal;
$("cmp-close").onclick = () => { $("compare-modal").style.display = "none"; };
$("compare-clear").onclick = () => {
  compareSet.clear();
  updateCompareDock();
  render();
};

// Wallet Dashboard & Modal Events
const walletNavBtn = $("wallet-nav-btn") || $("vault-btn");
if (walletNavBtn) {
  walletNavBtn.onclick = () => {
    const dash = $("wallet-dashboard");
    if (dash) {
      dash.scrollIntoView({ behavior: "smooth", block: "start" });
      dash.classList.add("card-pulse");
      setTimeout(() => dash.classList.remove("card-pulse"), 2500);
    } else {
      openWalletModal();
    }
  };
}

const wAddBtn = $("w-add-btn");
if (wAddBtn) wAddBtn.onclick = () => openWalletModal();

const wModalClose = $("w-modal-close");
if (wModalClose) wModalClose.onclick = () => { $("wallet-modal").style.display = "none"; };

const wFormCancel = $("w-form-cancel");
if (wFormCancel) wFormCancel.onclick = () => { $("wallet-modal").style.display = "none"; };

const wFormSave = $("w-form-save");
if (wFormSave) wFormSave.onclick = saveWalletHolding;

const wFormDel = $("w-form-del");
if (wFormDel) {
  wFormDel.onclick = () => {
    const idVal = $("w-form-id").value;
    if (idVal !== "") deleteWalletHolding(parseInt(idVal));
  };
}

const wBackupBtn = $("w-backup-btn");
if (wBackupBtn) wBackupBtn.onclick = exportWalletJSON;

const wRestoreBtn = $("w-restore-btn");
const wFileInput = $("w-file-input");
if (wRestoreBtn && wFileInput) {
  wRestoreBtn.onclick = () => wFileInput.click();
  wFileInput.onchange = e => {
    if (e.target.files && e.target.files[0]) {
      importWalletJSON(e.target.files[0]);
      e.target.value = "";
    }
  };
}

// Time Preset helper buttons in modal
document.querySelectorAll(".w-time-btn").forEach(btn => {
  btn.onclick = () => {
    const preset = btn.dataset.preset;
    const now = new Date();
    let target = new Date();
    if (preset === "now") target = now;
    else if (preset === "yesterday") target = new Date(now.getTime() - 24 * 3600 * 1000);
    else if (preset === "1week") target = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
    else if (preset === "1month") target = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
    const iso = new Date(target.getTime() - target.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    $("w-form-datetime").value = iso;
  };
});

// Real-time live calculation preview as inputs change in form
const wFormProd = $("w-form-product");
if (wFormProd) {
  wFormProd.onchange = e => {
    const pid = e.target.value;
    if (!pid) return;
    const r = rows.find(x => x.pid === pid);
    if (r) {
      $("w-form-name").value = r.name;
      $("w-form-category").value = r.category || "coin";
      $("w-form-price").value = r.shop_sells || "";
      $("w-form-pure").value = r.pure_g || "";
    }
    updateFormLivePreview();
  };
}

["w-form-price", "w-form-qty", "w-form-name", "w-form-pure"].forEach(id => {
  const el = $(id);
  if (el) el.oninput = updateFormLivePreview;
});

// Basket Optimizer Events
$("basket-btn").onclick = openBasketModal;
$("bkt-close").onclick = () => { $("basket-modal").style.display = "none"; };
$("bkt-run").onclick = runBasketOptimizer;
document.querySelectorAll(".bkt-preset").forEach(btn => {
  btn.onclick = () => {
    $("bkt-budget").value = btn.dataset.b;
    runBasketOptimizer();
  };
});

// Competitor Dealer Events
$("dealer-btn").onclick = () => openDealerModal(false);
$("dealer-close").onclick = () => { $("dealer-modal").style.display = "none"; };
$("dealer-refresh").onclick = () => openDealerModal(true);

// Auto-refresh interval
let timer = null;
$("auto").onchange = e => {
  clearInterval(timer);
  if (e.target.checked) timer = setInterval(() => { load(false); loadSpot(false); }, 60000);
};

// Initial page data load
load(false);
loadSpot(false);
renderWalletDashboard();
setInterval(() => loadSpot(false), 60000);
