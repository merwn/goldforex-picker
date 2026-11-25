/**
 * GoldForex Picker - Tools (Sweet Spot Scatter Plot, Basket Optimizer, Dealer Compare, Product Compare)
 */
import { $, state, saveWallet } from "./state.js";
import { eur, num, esc, lossCls, dealScoreCls, karatTxt, f2, f3, showToast } from "./format.js";
import { calcBreakevenSpot } from "./scoring.js";
import { fetchCompetitors } from "./api.js";
import { renderWalletDashboard } from "./wallet.js";

// --------------------------------------------------------------------------
// 1. Sweet Spot Scatter Plot (SVG)
// --------------------------------------------------------------------------
export function renderSweetSpotChart() {
  const svg = $("sw-svg"), tip = $("sw-tip"), box = $("sw-chart-box");
  if (!svg || !box) return;
  const isLog = $("sw-log") ? $("sw-log").checked : true;
  const valid = state.rows.filter(r => r.status === "ok" && r.weight_g && r.spread_pct != null);
  if (!valid.length) {
    svg.innerHTML = '<text x="460" y="160" fill="#8b909c" text-anchor="middle">No price data available for chart</text>';
    return;
  }

  const padL = 55, padR = 25, padT = 25, padB = 40, W = 920, H = 320;
  const plotW = W - padL - padR, plotH = H - padT - padB;

  const minW = 1.0, maxW = Math.max(100, ...valid.map(r => r.weight_g));
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

  const stdWeights = isLog ? [1, 2, 5, 10, 20, 31.1, 50, 100] : [1, 10, 25, 50, 75, 100];
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
      if (tip) tip.style.display = "none";
      return;
    }
    const pid = dot.dataset.pid;
    const r = state.rows.find(x => x.pid === pid);
    if (!r || !tip) return;
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
    if (tip) tip.style.display = "none";
  };

  svg.onclick = e => {
    const dot = e.target.closest("[data-pid]");
    if (!dot) return;
    const pid = dot.dataset.pid;
    // Switch to market tab and scroll to card
    window.location.hash = "#market";
    setTimeout(() => {
      const cardEl = $(`card-${pid}`) || $(`row-${pid}`);
      if (cardEl) {
        cardEl.scrollIntoView({ behavior: "smooth", block: "center" });
        cardEl.classList.add("highlight-card");
        setTimeout(() => cardEl.classList.remove("highlight-card"), 2400);
      }
    }, 100);
  };
}

// --------------------------------------------------------------------------
// 2. Budget Basket Optimizer
// --------------------------------------------------------------------------
export function runBasketOptimizer() {
  const budget = parseFloat($("bkt-budget").value) || 0;
  if (budget <= 50) {
    $("bkt-results").innerHTML = `<div class="mut" style="padding:20px;text-align:center">Please enter a budget of at least €50.</div>`;
    return;
  }
  const strategy = $("bkt-strat").value;
  const typeFilter = $("bkt-type").value;
  const maxCopies = parseInt($("bkt-max-copies").value) || 99;

  let pool = state.rows.filter(r => r.status === "ok" && r.in_stock && r.shop_sells && r.pure_g && r.shop_sells <= budget);
  if (typeFilter !== "all") {
    pool = pool.filter(r => r.category === typeFilter);
  }
  if (!pool.length) {
    $("bkt-results").innerHTML = `<div class="mut" style="padding:20px;text-align:center">No in-stock items fit within that budget. Try increasing your budget or changing category filters.</div>`;
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
      <div><span class="l">Total Spent</span><span class="v">${eur(totalSpent)}</span><span class="mut" style="font-size:11px">Change remaining: ${eur(bestRemaining)}</span></div>
      <div><span class="l">Pure Gold Obtained</span><span class="v">${num(totalPureG, f3)} g</span><span class="mut" style="font-size:11px">${num(totalPureG / 31.1034768, f2)} oz</span></div>
      <div><span class="l">Effective Cost / Pure Gram</span><span class="v">${eur(effPricePerG)} / g</span><span class="mut" style="font-size:11px">All-in cost</span></div>
      <div><span class="l">Weighted Resale Spread</span><span class="v c-${lossCls(weightedLossPct)}">${num(weightedLossPct)}%</span><span class="mut" style="font-size:11px">Loss: ${eur(totalLossEur)}</span></div>
      <div><span class="l">Current Cash-In Value</span><span class="v">${eur(totalBuys)}</span><span class="mut" style="font-size:11px">Immediate liquidation</span></div>
    </div>
    <div style="font-weight:700;font-size:14px;color:var(--txt);margin:16px 0 10px;display:flex;justify-content:space-between;align-items:center">
      <span>Recommended Optimal Allocation (${bestBundle.length} items):</span>
      <button id="bkt-add-wallet" class="on" style="font-size:12px;padding:6px 14px">+ Add Entire Basket to My Wallet</button>
    </div>
    <div style="display:grid;gap:8px">
      ${bundleList.map(({ item, count }) => `
        <div class="bkt-item">
          <div class="bkt-qty">${count}&times;</div>
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

  const addWalletBtn = $("bkt-add-wallet");
  if (addWalletBtn) {
    addWalletBtn.onclick = () => addBasketToWallet(bundleList);
  }
}

export function addBasketToWallet(bundleList) {
  const now = new Date().toISOString();
  let addedCount = 0;
  for (const { item, count } of bundleList) {
    state.wallet.unshift({
      id: "w_" + Date.now() + "_" + Math.random().toString(36).substr(2, 5),
      pid: item.pid,
      name: item.name,
      category: item.category,
      buy_datetime: now,
      date: now.split("T")[0],
      buy_price: item.shop_sells,
      purchase_price: item.shop_sells,
      qty: count,
      pure_g: item.pure_g,
      image: item.image,
      flag: item.flag,
      url: item.url,
      notes: "Basket Optimizer recommendation",
    });
    addedCount += count;
  }
  saveWallet();
  renderWalletDashboard();
  showToast("Basket Added to Wallet", `Added ${addedCount} items to your portfolio`);
}

// --------------------------------------------------------------------------
// 3. Dealer Price Comparison (BullionByPost benchmarks)
// --------------------------------------------------------------------------
export async function openDealerModal(refresh = false) {
  const content = $("dealer-content");
  if (!content) return;
  content.innerHTML = `<div class="cmsg" style="padding:40px 0">Fetching live benchmark prices from BullionByPost.eu...</div>`;
  try {
    const data = await fetchCompetitors(refresh);
    renderDealerTable(data);
  } catch (err) {
    content.innerHTML = `<div class="cmsg" style="color:var(--r)">Failed to load competitor data: ${esc(err.message)}</div>`;
  }
}

export function renderDealerTable(data) {
  const content = $("dealer-content");
  if (!content) return;
  const bms = data.benchmarks || [];
  if (!bms.length) {
    content.innerHTML = `<div class="cmsg">No benchmark comparison data available.</div>`;
    return;
  }

  content.innerHTML = `
    <div class="mut" style="font-size:12px;margin-bottom:12px">Last checked: ${esc((data.fetched_at || '').replace('T', ' '))} &middot; Live benchmark prices from BullionByPost.eu (EU checkout rate).</div>
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
                ${b.gf_price ? `<b style="font-size:15px;color:var(--txt)">${eur(b.gf_price)}</b>` : '<span class="mut">Not in &lt;1,000 € catalog</span>'}
                ${b.gf_url ? `<br><a href="${esc(b.gf_url)}" target="_blank" class="mut" style="font-size:11px"><u>GoldForex (${esc(b.gf_name)})</u></a>` : ''}
              </td>
              <td>
                <b style="font-size:15px;color:var(--txt)">${eur(b.bbp_price)}</b>
                ${b.bbp_url ? `<br><a href="${esc(b.bbp_url)}" target="_blank" class="mut" style="font-size:11px"><u>BullionByPost</u></a>` : ''}
              </td>
              <td>
                ${b.diff_eur != null ? `<b>${eur(b.diff_eur)}</b> <span class="mut" style="font-size:11px">(${b.diff_pct}%)</span>` : '-'}
              </td>
              <td>
                ${isGfCheaper ? `<span class="b-cheaper gf">🟢 GoldForex is €${b.diff_eur} cheaper!</span>` : (isBbpCheaper ? `<span class="b-cheaper bbp">🟡 BullionByPost is €${b.diff_eur} cheaper</span>` : `<span class="mut">${b.gf_price ? 'Similar Price' : 'Benchmark only'}</span>`)}
              </td>
            </tr>
          `;
        }).join("")}
      </tbody>
    </table>
  `;
}

// --------------------------------------------------------------------------
// 4. Side-by-Side Product Comparison
// --------------------------------------------------------------------------
export function toggleCompare(pid) {
  if (state.compareSet.has(pid)) {
    state.compareSet.delete(pid);
  } else {
    if (state.compareSet.size >= 4) {
      showToast("Comparison Limit", "You can compare up to 4 products at once.");
      return;
    }
    state.compareSet.add(pid);
  }
  updateCompareDock();
  renderCompareModal();
}

export function updateCompareDock() {
  const dock = $("compare-bar");
  if (!dock) return;
  if (state.compareSet.size === 0) {
    dock.style.display = "none";
    return;
  }
  dock.style.display = "flex";
  $("compare-count").textContent = `${state.compareSet.size} item${state.compareSet.size > 1 ? "s" : ""} (max 4)`;
  const thumbs = $("compare-thumbs");
  thumbs.innerHTML = [...state.compareSet].map(pid => {
    const r = state.rows.find(x => x.pid === pid);
    return r && r.image ? `<img class="cmp-thumb" src="${esc(r.image)}" title="${esc(r.name)}">` : "";
  }).join("");
}

export function renderCompareModal() {
  const content = $("compare-content");
  if (!content) return;
  if (!state.compareSet.size) {
    content.innerHTML = `<div class="mut" style="padding:24px;text-align:center">No products selected for comparison. Click the ⚖️ icon on 2 to 4 product cards to compare them side by side.</div>`;
    return;
  }
  const items = [...state.compareSet].map(pid => state.rows.find(x => x.pid === pid)).filter(Boolean);

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
    { label: "Actions", render: r => `<div style="display:flex;gap:6px;justify-content:center"><a href="${esc(r.url)}" target="_blank" rel="noopener"><button style="font-size:11.5px;padding:5px 8px">Open Site</button></a><button class="wallet-quick-btn" data-wallet-add="${esc(r.pid)}" style="font-size:11.5px;padding:5px 8px">+ Wallet</button></div>` }
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
