/**
 * GoldForex Picker - My Investment Wallet Dashboard & Holdings Management
 */
import { $, state, saveWallet } from "./state.js";
import { eur, num, esc, f2, f3, showToast } from "./format.js";

export function updateWalletBadge() {
  const badge = $("wallet-badge");
  const countEl = $("wallet-items-count");
  const totalCount = state.wallet.reduce((sum, it) => sum + (parseInt(it.qty) || 1), 0);
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

export function formatBuyDateTime(dtStr) {
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
  } catch (_) {
    return { full: dtStr, rel: "" };
  }
}

export function getHoldingLiveQuote(it) {
  const matched = state.rows.find(r => (it.pid && r.pid === it.pid) || (r.name && r.name.toLowerCase() === (it.name || "").toLowerCase()));
  let liveSellPrice = null;
  let storeSellPrice = null;
  if (matched) {
    liveSellPrice = matched.shop_buys;
    storeSellPrice = matched.shop_sells;
  } else if (state.spot && state.spot.eur_per_g && it.pure_g) {
    liveSellPrice = Math.round(state.spot.eur_per_g * it.pure_g * 0.95 * 100) / 100;
  }
  return { matched, liveSellPrice, storeSellPrice };
}

export function renderWalletDashboard() {
  updateWalletBadge();
  const kpiGrid = $("wallet-kpi-grid");
  const holdingsContainer = $("wallet-holdings-container");
  if (!kpiGrid || !holdingsContainer) return;

  let totalInvested = 0;
  let totalLiquidation = 0;
  let totalPureG = 0;

  state.wallet.forEach(it => {
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
  const meltVal = state.spot && state.spot.eur_per_g ? totalPureG * state.spot.eur_per_g : null;
  const breakevenSpot = totalPureG > 0 ? totalInvested / totalPureG : null;
  const avgCostPerG = totalPureG > 0 ? totalInvested / totalPureG : null;

  kpiGrid.innerHTML = `
    <div class="w-kpi-card kpi-invested">
      <div class="l">Total Invested</div>
      <div class="v">${eur(totalInvested)}</div>
      <div class="sub">${state.wallet.length} holding${state.wallet.length === 1 ? '' : 's'} (${state.wallet.reduce((s, x) => s + (parseInt(x.qty) || 1), 0)} items)</div>
    </div>
    <div class="w-kpi-card kpi-sellback">
      <div class="l">Real-Time Selling Value</div>
      <div class="v">${eur(totalLiquidation)}</div>
      <div class="sub">Shop buyback payout if sold right now</div>
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
      <div class="sub">Market Spot: ${state.spot && state.spot.eur_per_g ? eur(state.spot.eur_per_g) : '-'} / g</div>
    </div>
    <div class="w-kpi-card">
      <div class="l">Portfolio Break-Even</div>
      <div class="v">${eur(breakevenSpot)} <span style="font-size:12px;font-weight:500">/ g</span></div>
      <div class="sub">Gold price needed for 0% loss</div>
    </div>
  `;

  if (!state.wallet.length) {
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
          ${state.wallet.map((it, idx) => {
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
                  <div class="mut" style="font-size:10.5px">Shop buys at</div>
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

  // Wire actions inside table
  holdingsContainer.querySelectorAll("[data-w-edit]").forEach(btn => {
    btn.onclick = () => openWalletModal(null, parseInt(btn.dataset.wEdit));
  });
  holdingsContainer.querySelectorAll("[data-w-del]").forEach(btn => {
    btn.onclick = () => deleteWalletHolding(parseInt(btn.dataset.wDel));
  });
}

export function openWalletModal(prefillPid = null, editIdx = null) {
  const modal = $("wallet-modal");
  if (!modal) return;
  modal.style.display = "flex";

  const sel = $("w-form-product");
  const under1000 = state.rows.filter(r => r.status === "ok" && r.shop_sells && r.shop_sells < 1000.0);
  under1000.sort((a, b) => a.shop_sells - b.shop_sells);

  sel.innerHTML = '<option value="">-- Choose from store (< 1,000 €) or custom --</option>' +
    under1000.map(r => `<option value="${esc(r.pid)}">${esc(r.name)} — Pay: ${eur(r.shop_sells)} | Store Buys: ${eur(r.shop_buys)}</option>`).join("");

  const now = new Date();
  const nowIso = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  $("w-form-datetime").value = nowIso;

  if (editIdx != null && state.wallet[editIdx]) {
    const it = state.wallet[editIdx];
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
      const r = state.rows.find(x => x.pid === prefillPid);
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

export function updateFormLivePreview() {
  const preview = $("w-form-preview");
  if (!preview) return;

  const pid = $("w-form-product").value;
  const name = $("w-form-name").value.trim();
  const buyPrice = parseFloat($("w-form-price").value) || 0;
  const qty = parseInt($("w-form-qty").value) || 1;
  const pureG = parseFloat($("w-form-pure").value) || 0;

  const matched = state.rows.find(r => (pid && r.pid === pid) || (name && r.name.toLowerCase() === name.toLowerCase()));
  let liveSellPrice = matched && matched.shop_buys ? matched.shop_buys : (state.spot && state.spot.eur_per_g && pureG ? state.spot.eur_per_g * pureG * 0.95 : null);

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

export function saveWalletHolding() {
  const editIdxStr = $("w-form-id").value;
  const pid = $("w-form-product").value || null;
  const name = $("w-form-name").value.trim();
  const category = $("w-form-category").value;
  const buyDatetime = $("w-form-datetime").value;
  const price = parseFloat($("w-form-price").value);
  const qty = parseInt($("w-form-qty").value) || 1;
  const pureG = parseFloat($("w-form-pure").value) || null;
  const notes = $("w-form-notes").value.trim();

  if (!name || isNaN(price) || price < 0) {
    alert("Please enter a valid item name and purchase price.");
    return;
  }

  const matched = state.rows.find(r => (pid && r.pid === pid) || (name && r.name.toLowerCase() === name.toLowerCase()));

  const item = {
    id: editIdxStr !== "" && state.wallet[parseInt(editIdxStr)] ? state.wallet[parseInt(editIdxStr)].id : "w_" + Date.now(),
    pid: pid || (matched ? matched.pid : null),
    name: name,
    category: category,
    buy_datetime: buyDatetime,
    date: buyDatetime ? buyDatetime.split("T")[0] : new Date().toISOString().split("T")[0],
    buy_price: price,
    purchase_price: price,
    qty: qty,
    pure_g: pureG != null ? pureG : (matched ? matched.pure_g : null),
    image: matched ? matched.image : null,
    flag: matched ? matched.flag : null,
    url: matched ? matched.url : null,
    notes: notes,
  };

  if (editIdxStr !== "" && state.wallet[parseInt(editIdxStr)]) {
    state.wallet[parseInt(editIdxStr)] = item;
    showToast("Holding Updated", `Updated ${item.name} (${item.qty}x)`);
  } else {
    state.wallet.unshift(item);
    showToast("Holding Added", `Added ${item.name} (${item.qty}x) to your wallet`);
  }

  saveWallet();
  renderWalletDashboard();
  $("wallet-modal").style.display = "none";
}

export function deleteWalletHolding(idx) {
  if (idx < 0 || idx >= state.wallet.length) return;
  const item = state.wallet[idx];
  if (!confirm(`Are you sure you want to delete ${item.name} from your wallet?`)) return;
  state.wallet.splice(idx, 1);
  saveWallet();
  renderWalletDashboard();
  showToast("Holding Removed", `Removed ${item.name} from wallet`);
  if ($("wallet-modal")) $("wallet-modal").style.display = "none";
}

export function backupWallet() {
  const data = JSON.stringify(state.wallet, null, 2);
  const blob = new Blob([data], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `goldforex_wallet_backup_${new Date().toISOString().split("T")[0]}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export function restoreWallet(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      if (!Array.isArray(data)) throw new Error("Invalid file format");
      state.wallet = data;
      saveWallet();
      renderWalletDashboard();
      showToast("Wallet Restored", `Restored ${data.length} holdings from backup`);
    } catch (err) {
      alert("Failed to restore backup: " + err.message);
    }
  };
  reader.readAsText(file);
}
