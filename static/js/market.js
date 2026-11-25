/**
 * GoldForex Picker - Market View (Cards, Table, Filters, Best Picks)
 */
import { $, state, saveTableCols } from "./state.js";
import { eur, num, sgn, esc, lossCls, dealScoreCls, karatTxt, f3 } from "./format.js";
import { calcBreakevenSpot, melt } from "./scoring.js";

export function visibleRows() {
  const f = state.filters;
  let list = state.rows.filter(r => {
    if (f.category !== "all" && r.category !== f.category) return false;
    if (f.stockOnly && !r.in_stock) return false;
    if (f.favOnly && !state.favs.has(r.pid)) return false;
    if (f.country && r.country !== f.country) return false;
    if (f.karat) {
      if (!r.karat) return false;
      if (Math.abs(r.karat - parseFloat(f.karat)) > 0.5) return false;
    }
    if (f.weight) {
      const w = r.weight_g || 0;
      if (f.weight === "u2" && w > 2) return false;
      if (f.weight === "2-5" && (w <= 2 || w > 5)) return false;
      if (f.weight === "5-10" && (w <= 5 || w > 10)) return false;
      if (f.weight === "10-20" && (w <= 10 || w > 20)) return false;
      if (f.weight === "o20" && w <= 20) return false;
    }
    if (f.bmin != null && (r.shop_sells || 0) < f.bmin) return false;
    if (f.bmax != null && (r.shop_sells || 0) > f.bmax) return false;
    if (f.search) {
      const q = f.search.toLowerCase();
      const n = (r.name || "").toLowerCase();
      const c = (r.country || "").toLowerCase();
      const wt = (r.weight_g ? String(r.weight_g) + "g" : "");
      if (!n.includes(q) && !c.includes(q) && !wt.includes(q)) return false;
    }
    return true;
  });

  // Sort
  list.sort((a, b) => {
    // Keep favorites pinned at top
    const aFav = state.favs.has(a.pid) ? 1 : 0;
    const bFav = state.favs.has(b.pid) ? 1 : 0;
    if (aFav !== bFav) return bFav - aFav;

    if (f.sort === "deal") return (b.deal_score ?? -1) - (a.deal_score ?? -1);
    if (f.sort === "loss") return (a.spread_pct ?? 999) - (b.spread_pct ?? 999);
    if (f.sort === "pure") return (a.sell_per_pure_g ?? 9999) - (b.sell_per_pure_g ?? 9999);
    if (f.sort === "breakeven") return (a.breakeven_pct ?? 999) - (b.breakeven_pct ?? 999);
    if (f.sort === "price_asc") return (a.shop_sells ?? 99999) - (b.shop_sells ?? 99999);
    if (f.sort === "price_desc") return (b.shop_sells ?? -1) - (a.shop_sells ?? -1);
    if (f.sort === "gold") return (b.pure_g ?? -1) - (a.pure_g ?? -1);
    if (f.sort === "timing") {
      const score = r => (r.history_stats ? (r.history_stats.status === "bargain" ? 3 : r.history_stats.status === "fair" ? 2 : 1) : 0);
      return score(b) - score(a);
    }
    return 0;
  });

  return list;
}

export function candidates() {
  return state.rows.filter(r => r.status === "ok" && r.in_stock && !r.suspect && r.spread_pct != null);
}

export function renderPicks() {
  const el = $("picks");
  if (!el) return;
  const c = candidates();
  if (!c.length) {
    el.innerHTML = "";
    return;
  }

  const byScore = [...c].sort((x, y) => (y.deal_score || 0) - (x.deal_score || 0))[0];
  const byLoss = [...c].sort((x, y) => (x.spread_pct ?? 999) - (y.spread_pct ?? 999))[0];
  const byPure = [...c].sort((x, y) => (x.sell_per_pure_g ?? 9999) - (y.sell_per_pure_g ?? 9999))[0];

  el.innerHTML = `
    <div class="picks-bar">
      <div class="pick-chip" data-goto="${byScore.pid}" title="Top composite deal score: balance of spread, premium and gram cost">
        <span class="pick-chip-icon">🏆</span>
        <div class="pick-chip-text">
          <span class="pick-chip-title">Top Deal Score</span>
          <span class="pick-chip-val">${esc(byScore.name)} (${byScore.deal_score}/100)</span>
        </div>
      </div>
      <div class="pick-chip" data-goto="${byLoss.pid}" title="Lowest resale loss when selling back to shop">
        <span class="pick-chip-icon">💎</span>
        <div class="pick-chip-text">
          <span class="pick-chip-title">Lowest Resale Loss</span>
          <span class="pick-chip-val">${esc(byLoss.name)} (${num(byLoss.spread_pct)}%)</span>
        </div>
      </div>
      <div class="pick-chip" data-goto="${byPure.pid}" title="Cheapest price per pure gram of gold">
        <span class="pick-chip-icon">🥇</span>
        <div class="pick-chip-text">
          <span class="pick-chip-title">Cheapest Pure Gold</span>
          <span class="pick-chip-val">${esc(byPure.name)} (${eur(byPure.sell_per_pure_g)}/g)</span>
        </div>
      </div>
    </div>`;

  el.querySelectorAll(".pick-chip").forEach(chip => {
    chip.onclick = () => {
      const pid = chip.dataset.goto;
      const target = $(`card-${pid}`) || $(`row-${pid}`);
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        target.classList.add("highlight-card");
        setTimeout(() => target.classList.remove("highlight-card"), 2400);
      }
    };
  });
}

function cmpBlock(r) {
  const m = melt(r);
  if (m == null || !state.spot || !state.spot.eur_per_g) return "";
  const p = (r.shop_sells / m - 1) * 100, g = (r.shop_buys / m - 1) * 100;
  return `<div class="cmp"><div class="t">vs gold on market (${eur(state.spot.eur_per_g)}/g)</div>` +
    `<div><span>Gold value now</span><b>${eur(m)}</b></div>` +
    `<div><span>You pay vs market</span><b class="c-${lossCls(p)}">${sgn(p)} (${eur(r.shop_sells - m)})</b></div>` +
    `<div><span>You receive vs market</span><b class="c-${g >= 0 ? "g" : lossCls(-g)}">${sgn(g)} (${eur(r.shop_buys - m)})</b></div></div>`;
}

export function renderCard(r, bestPid, cheapPid) {
  const lc = lossCls(r.spread_pct);
  const w = Math.min(100, (r.spread_pct || 0) * 4);
  const isFav = state.favs.has(r.pid);
  const isCmp = state.compareSet.has(r.pid);
  const hasAlt = state.alerts.some(a => a.pid === r.pid && a.enabled);
  const beSpot = calcBreakevenSpot(r);
  const isCollector = r.is_collector || (r.premium_pay_pct != null && r.premium_pay_pct >= 20.0);
  const isExpanded = state.expandedCards.has(r.pid);

  const histBadge = r.history_stats ? `<span class="badge ${r.history_stats.status === 'bargain' ? 'b-bargain' : r.history_stats.status === 'fair' ? 'b-fair' : 'b-high'}" title="52W spread: ${r.history_stats.min_52w}% - ${r.history_stats.max_52w}% (cheaper than ${r.history_stats.cheaper_than_pct}% of past year)">${esc(r.history_stats.badge)}</span>` : "";

  const badges = (r.status !== "ok" ? '<span class="badge b-out">failed</span>' : r.in_stock ? '<span class="badge b-in">In stock</span>' : '<span class="badge b-out">Out of stock</span>') +
    (r.suspect ? '<span class="badge b-high" title="Implausible price/weight ratio">⚠️ Suspect</span>' : "") +
    (r.deal_score != null ? `<span class="badge b-score ${dealScoreCls(r.deal_score)}">Score ${r.deal_score}</span>` : "") +
    histBadge +
    (isCollector ? `<span class="badge b-collector" title="Collector premium: ${num(r.premium_pay_pct)}% markup">⚠️ Collector (+${num(r.premium_pay_pct)}%)</span>` : "") +
    (bestPid === r.pid ? '<span class="badge b-best">Top score</span>' : "") +
    (cheapPid === r.pid ? '<span class="badge b-cheap">Cheapest / g</span>' : "");

  if (r.status !== "ok") {
    return `<div class="card" id="card-${esc(r.pid)}"><div class="body"><div class="name">${esc(r.name)}</div><div class="sub">${esc(r.error || "")}</div></div></div>`;
  }

  return `
  <div class="card ${r.in_stock ? "" : "oos"} ${isExpanded ? "details-open" : ""}" id="card-${esc(r.pid)}">
    <div class="imgwrap">
      ${r.image ? `<img loading="lazy" src="${esc(r.image)}" alt="${esc(r.name)}">` : ""}
      <div class="badges">${badges}</div>
      ${r.flag ? `<img class="flag" src="${esc(r.flag)}" alt="${esc(r.country || "")}" title="${esc(r.country || "")}">` : (r.country ? `<span class="flag txt" title="${esc(r.country)}">${r.country === "Various" ? "🌐 Various" : esc(r.country)}</span>` : "")}
      <div class="card-tools">
        <button class="fav-btn ${isFav ? "active" : ""}" data-fav="${esc(r.pid)}" title="${isFav ? "Remove from favourites" : "Pin as favourite"}">${isFav ? "★" : "☆"}</button>
        <button class="alert-btn ${hasAlt ? "active" : ""}" data-alert="${esc(r.pid)}" title="Set price or stock alert">🔔</button>
        <button class="cmp-btn ${isCmp ? "active" : ""}" data-cmp="${esc(r.pid)}" title="${isCmp ? "Remove comparison" : "Add to side-by-side comparison"}">⚖️</button>
      </div>
      ${r.karat ? `<span class="kt">${karatTxt(r.karat)}</span>` : ""}
    </div>
    <div class="body">
      <div>
        <div class="name"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.name)}</a></div>
        <div class="sub">${esc(r.category)} &middot; ${num(r.weight_g, f3)} g &middot; ${karatTxt(r.karat)} &middot; ${num(r.purity_pct)}% pure</div>
      </div>
      <div class="prices">
        <div class="pbox"><div class="l">You pay</div><div class="v">${eur(r.shop_sells)}</div></div>
        <div class="pbox"><div class="l">You receive</div><div class="v">${eur(r.shop_buys)}</div></div>
      </div>
      <div class="loss">
        <div class="top"><span>Loss if you sell back now</span><b class="c-${lc}">${num(r.spread_pct)}% (${eur(r.loss_eur)})</b></div>
        <div class="meter"><i class="m-${lc}" style="width:${w}%"></i></div>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-top:8px">
        <span class="mut">Pure gold: <b>${num(r.pure_g, f3)} g</b></span>
        <span class="mut">Pay / g: <b>${eur(r.sell_per_pure_g)}</b></span>
      </div>

      <!-- Collapsible Detailed Metrics -->
      <button class="card-details-toggle" data-toggle-details="${esc(r.pid)}">
        <span>${isExpanded ? "▲ Hide Details" : "▼ Details & Market Comparison"}</span>
      </button>

      <div class="card-details-body">
        ${cmpBlock(r)}
        <div class="be-box">
          <div class="l">Break-even gold price</div>
          <div class="v">${eur(beSpot)} <span class="sm">/ g</span> <span class="c-${lc}">(+${num(r.breakeven_pct)}%)</span></div>
          <div class="sm">Spot needed to get 100% back when selling &middot; Melt: ${eur(r.sell_per_pure_g)}/g</div>
        </div>
        <div class="stats">
          <div><span>Pure gold</span><span>${num(r.pure_g, f3)} g</span></div>
          <div><span>Deal score</span><b class="c-${lc}">${r.deal_score || "-"} / 100</b></div>
          <div><span>Pay / pure g</span><span>${eur(r.sell_per_pure_g)}</span></div>
          <div><span>Receive / pure g</span><span>${eur(r.buy_per_pure_g)}</span></div>
          <div><span>Spot premium</span><span>${num(r.premium_pay_pct)}%</span></div>
          <div><span>Break-even</span><span>+${num(r.breakeven_pct)}%</span></div>
        </div>
      </div>

      <div class="actions" style="margin-top:12px">
        <button class="wallet-quick-btn" data-wallet-add="${esc(r.pid)}" title="Add this item to My Investment Wallet">+ Wallet</button>
        <button data-chart="${esc(r.pid)}">${r.has_chart ? "Price chart" : "Price chart (load)"}</button>
        <a href="${esc(r.url)}" target="_blank" rel="noopener">Open on site</a>
      </div>
    </div>
  </div>`;
}

export function renderTable(list) {
  const cols = state.tableCols;
  const isCol = k => cols.has(k);

  let html = `
  <div class="tw">
    <div style="display:flex;justify-content:flex-end;margin-bottom:8px;position:relative">
      <button id="col-picker-btn" style="font-size:12px;padding:4px 10px">⚙️ Columns</button>
      <div id="col-picker-pop" class="col-picker-pop">
        <div style="font-weight:700;font-size:12px;margin-bottom:6px;color:var(--gold)">Table Columns</div>
        <label><input type="checkbox" data-col="timing" ${isCol("timing") ? "checked" : ""}> 52W Timing</label>
        <label><input type="checkbox" data-col="country" ${isCol("country") ? "checked" : ""}> Country</label>
        <label><input type="checkbox" data-col="karat" ${isCol("karat") ? "checked" : ""}> Karat</label>
        <label><input type="checkbox" data-col="breakeven" ${isCol("breakeven") ? "checked" : ""}> Break-even Spot</label>
        <label><input type="checkbox" data-col="premium" ${isCol("premium") ? "checked" : ""}> Premium %</label>
        <label><input type="checkbox" data-col="pure_cost" ${isCol("pure_cost") ? "checked" : ""}> Pay / pure g</label>
        <label><input type="checkbox" data-col="market_val" ${isCol("market_val") ? "checked" : ""}> Market Value</label>
      </div>
    </div>
    <table>
      <thead>
        <tr>
          <th style="width:36px">⭐</th>
          <th style="width:36px">⚖️</th>
          <th>Product</th>
          <th>Stock</th>
          <th>Deal Score</th>
          ${isCol("timing") ? "<th>52W Timing</th>" : ""}
          ${isCol("country") ? "<th>Country</th>" : ""}
          <th>Pure g</th>
          ${isCol("karat") ? "<th>Karat</th>" : ""}
          <th>You pay</th>
          <th>You receive</th>
          <th>Loss %</th>
          <th>Loss €</th>
          ${isCol("breakeven") ? "<th>Break-even spot</th>" : ""}
          ${isCol("premium") ? "<th>Premium</th>" : ""}
          ${isCol("pure_cost") ? "<th>Pay / pure g</th>" : ""}
          ${isCol("market_val") ? "<th>Market value</th>" : ""}
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>`;

  html += list.map(r => {
    if (r.status !== "ok") {
      return `<tr><td></td><td></td><td>${esc(r.name)}</td><td colspan="15" class="mut">${esc(r.error || "failed")}</td></tr>`;
    }
    const isFav = state.favs.has(r.pid);
    const isCmp = state.compareSet.has(r.pid);
    const beSpot = calcBreakevenSpot(r);
    const isCollector = r.is_collector || (r.premium_pay_pct != null && r.premium_pay_pct >= 20.0);
    const histBadge = r.history_stats ? `<span class="badge ${r.history_stats.status === 'bargain' ? 'b-bargain' : r.history_stats.status === 'fair' ? 'b-fair' : 'b-high'}" style="font-size:10.5px">${esc(r.history_stats.badge)}</span>` : '<span class="mut">-</span>';

    return `
      <tr id="row-${esc(r.pid)}">
        <td style="text-align:center"><button class="fav-btn ${isFav ? "active" : ""}" style="position:static;display:inline-flex;width:26px;height:26px;font-size:14px" data-fav="${esc(r.pid)}">${isFav ? "★" : "☆"}</button></td>
        <td style="text-align:center"><button class="cmp-btn ${isCmp ? "active" : ""}" style="position:static;display:inline-flex;width:26px;height:26px;font-size:13px" data-cmp="${esc(r.pid)}" title="Compare">⚖️</button></td>
        <td>
          ${r.image ? `<img src="${esc(r.image)}" alt="" style="width:28px;height:28px;object-fit:contain;vertical-align:middle;margin-right:6px">` : ""}
          <a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.name)}</a>
          ${r.suspect ? ' <span class="badge b-high" style="font-size:10px" title="Implausible price/weight ratio">⚠️ Suspect</span>' : ""}
        </td>
        <td>${r.in_stock ? "yes" : '<span class="c-r">no</span>'}</td>
        <td><span class="badge b-score ${dealScoreCls(r.deal_score)}">${r.deal_score || "-"}</span></td>
        ${isCol("timing") ? `<td>${histBadge}</td>` : ""}
        ${isCol("country") ? `<td>${r.flag ? `<img class="cflag" src="${esc(r.flag)}" alt="">` : ""}${esc(r.country || "-")}</td>` : ""}
        <td><b>${num(r.pure_g, f3)}</b></td>
        ${isCol("karat") ? `<td>${karatTxt(r.karat)}</td>` : ""}
        <td><b>${eur(r.shop_sells)}</b></td>
        <td>${eur(r.shop_buys)}</td>
        <td class="c-${lossCls(r.spread_pct)}"><b>${num(r.spread_pct)}%</b></td>
        <td>${eur(r.loss_eur)}</td>
        ${isCol("breakeven") ? `<td><b>${eur(beSpot)}</b> <span class="mut" style="font-size:11px">(+${num(r.breakeven_pct)}%)</span></td>` : ""}
        ${isCol("premium") ? `<td>${num(r.premium_pay_pct)}% ${isCollector ? '<span class="badge b-collector" style="padding:1px 4px;font-size:10px">Collector</span>' : ""}</td>` : ""}
        ${isCol("pure_cost") ? `<td>${eur(r.sell_per_pure_g)}</td>` : ""}
        ${isCol("market_val") ? `<td>${melt(r) == null ? "-" : eur(melt(r))}</td>` : ""}
        <td>
          <button class="wallet-quick-btn" data-wallet-add="${esc(r.pid)}" style="padding:4px 8px;font-size:11.5px;margin-right:4px" title="Add to Wallet">+ Wallet</button>
          <button data-chart="${esc(r.pid)}" style="padding:4px 8px;font-size:11.5px">Chart</button>
        </td>
      </tr>`;
  }).join("");

  html += `</tbody></table></div>`;
  return html;
}

export function renderMarket() {
  const container = $("view");
  if (!container) return;

  renderPicks();
  const list = visibleRows();
  const c = candidates();

  $("shown").textContent = `${list.length} of ${state.rows.length} shown`;

  const bestPid = c.length ? [...c].sort((x, y) => (y.deal_score || 0) - (x.deal_score || 0))[0].pid : null;
  const cheapPid = c.length ? [...c].sort((x, y) => (x.sell_per_pure_g ?? 1e9) - (y.sell_per_pure_g ?? 1e9))[0].pid : null;

  if (state.view === "cards") {
    container.innerHTML = `<div class="grid">${list.map(r => renderCard(r, bestPid, cheapPid)).join("") || '<div class="mut" style="padding:24px;text-align:center">Nothing to show with these filters.</div>'}</div>`;
  } else {
    container.innerHTML = renderTable(list);
    // Wire column picker listeners
    const btn = $("col-picker-btn"), pop = $("col-picker-pop");
    if (btn && pop) {
      btn.onclick = e => {
        e.stopPropagation();
        pop.style.display = pop.style.display === "block" ? "none" : "block";
      };
      pop.querySelectorAll("input[data-col]").forEach(chk => {
        chk.onchange = () => {
          const col = chk.dataset.col;
          if (chk.checked) state.tableCols.add(col);
          else state.tableCols.delete(col);
          saveTableCols();
          renderMarket();
        };
      });
    }
  }

  updateFilterBadge();
}

export function updateCountryOptions() {
  const sel = $("fcountry");
  if (!sel) return;
  const cur = sel.value;
  const countries = [...new Set(state.rows.map(r => r.country).filter(Boolean))].sort();
  sel.innerHTML = '<option value="">All countries</option>' +
    countries.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
  sel.value = cur;
}

export function updateFilterBadge() {
  const f = state.filters;
  let activeCount = 0;
  if (f.country) activeCount++;
  if (f.karat) activeCount++;
  if (f.weight) activeCount++;
  if (f.bmin != null) activeCount++;
  if (f.bmax != null) activeCount++;

  const b = $("filters-count-badge");
  if (b) {
    if (activeCount > 0) {
      b.style.display = "inline-block";
      b.textContent = activeCount;
    } else {
      b.style.display = "none";
    }
  }

  const chips = $("active-filter-chips");
  if (chips) {
    if (activeCount > 0 || f.favOnly) {
      chips.style.display = "inline-flex";
      chips.innerHTML = `<button id="clear-filters-chip" class="mut" style="font-size:11px;padding:2px 8px;border-radius:12px">Clear ${activeCount} filter(s) ✕</button>`;
      $("clear-filters-chip").onclick = () => {
        f.country = "";
        f.karat = "";
        f.weight = "";
        f.bmin = null;
        f.bmax = null;
        f.favOnly = false;
        if ($("fcountry")) $("fcountry").value = "";
        if ($("fkarat")) $("fkarat").value = "";
        if ($("fweight")) $("fweight").value = "";
        if ($("bmin")) $("bmin").value = "";
        if ($("bmax")) $("bmax").value = "";
        if ($("fav-filter")) $("fav-filter").classList.remove("on");
        renderMarket();
      };
    } else {
      chips.style.display = "none";
      chips.innerHTML = "";
    }
  }
}
