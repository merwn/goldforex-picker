/**
 * GoldForex Picker - Main Application Entry & Controller
 */
import { $, state, saveFavs, saveView, saveDealWeights } from "./state.js";
import { eur, num, esc, sgn, showToast } from "./format.js";
import { fetchPrices, fetchSpot, fetchSettings, saveSettings, rescanProducts } from "./api.js";
import { computeDealScores, medianImplied } from "./scoring.js";
import { renderMarket, updateCountryOptions, updateFilterBadge } from "./market.js";
import { renderWalletDashboard, openWalletModal, saveWalletHolding, backupWallet, restoreWallet, updateFormLivePreview } from "./wallet.js";
import { renderSweetSpotChart, runBasketOptimizer, openDealerModal, toggleCompare, renderCompareModal } from "./tools.js";
import { checkAlerts, updateAlertBadge, openItemAlertModal, saveItemAlert, deleteItemAlert, openAlertsManager, playChime, requestNotificationPermission } from "./alerts.js";
import { openChartModal, closeModal as closeChartModal, reloadCurrentChart, applyRange } from "./charts.js";

// --------------------------------------------------------------------------
// 1. Data Freshness & Spot Price
// --------------------------------------------------------------------------
export function updateDataAge() {
  const badge = $("age-badge");
  if (!badge) return;
  const first = state.rows.find(r => r.quote_time);
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

export function renderSpot() {
  const s = state.spot;
  const summaryEl = $("spot-summary");
  const detailsEl = $("spot-details");
  const imp = medianImplied();

  if (!summaryEl) return;

  if (!s) {
    summaryEl.innerHTML = `<span class="mut">loading gold price...</span>`;
    return;
  }
  if (s.error) {
    summaryEl.innerHTML = `<span class="c-r">Gold price unavailable: ${esc(s.error)}</span>`;
    return;
  }

  summaryEl.innerHTML = `
    <span>Gold Spot: <b>${eur(s.eur_per_g)}</b>/g (${eur(s.eur_per_oz)}/oz)</span>
    ${s.chg_pct != null ? `<span class="c-${s.chg_pct >= 0 ? 'g' : 'r'}">(${sgn(s.chg_pct)})</span>` : ''}
  `;

  if (detailsEl) {
    detailsEl.innerHTML = `
      <div>Shop-implied gold: <b>${eur(imp)}/g</b></div>
      <div>Source: <b>${esc(s.source || 'BullionByPost')}</b></div>
      ${s.usd_per_oz ? `<div>USD: <b>$${s.usd_per_oz.toFixed(2)}/oz</b></div>` : ''}
      ${s.gbp_per_oz ? `<div>GBP: <b>£${s.gbp_per_oz.toFixed(2)}/oz</b></div>` : ''}
      <div>Checked: <b>${esc((s.fetched_at || '').slice(11, 19))}</b></div>
    `;
  }
}

export async function loadSpot(refresh = false) {
  try {
    state.spot = await fetchSpot(refresh);
    renderSpot();
    if (state.activeTab === "market") renderMarket();
    if (state.activeTab === "wallet") renderWalletDashboard();
  } catch (err) {
    state.spot = { error: String(err) };
    renderSpot();
  }
}

export async function loadPrices(refresh = false) {
  const meta = $("meta");
  const refreshBtn = $("refresh");
  if (meta) meta.textContent = refresh ? "scraping GoldForex..." : "loading cached data...";
  if (refreshBtn) refreshBtn.disabled = true;

  try {
    const { ok, data } = await fetchPrices(refresh);
    state.rows = data.rows || [];

    const httpCount = data.via?.http ?? 0;
    const browserCount = data.via?.browser ?? 0;
    const okCount = data.ok ?? state.rows.filter(r => r.status === "ok").length;
    const totalCount = data.count ?? state.rows.length;
    const elapsed = data.elapsed_s != null ? `${data.elapsed_s}s` : "";
    const scrapedAt = (data.scraped_at || "").replace("T", " ");
    const staleTag = data.stale ? " [stale cache]" : "";

    if (meta) {
      meta.textContent = `${okCount}/${totalCount} ok${elapsed ? " in " + elapsed : ""} (http ${httpCount}, browser ${browserCount}) - ${scrapedAt}${staleTag}`;
    }

    const bad = state.rows.filter(r => r.status !== "ok");
    const errEl = $("err");
    if (errEl) {
      if (data.error && !data.rows) {
        errEl.style.display = "block";
        errEl.textContent = data.error;
      } else {
        errEl.style.display = bad.length ? "block" : "none";
        errEl.textContent = bad.map(r => `${r.name}: ${r.error}`).join("\n");
      }
    }

    updateCountryOptions();
    updateDataAge();
    computeDealScores();
    checkAlerts();
    renderMarket();
    renderWalletDashboard();
    if (state.activeTab === "tools" && state.activeTool === "sweet-spot") {
      renderSweetSpotChart();
    }
  } catch (err) {
    if (meta) meta.textContent = "error: " + err.message;
    const errEl = $("err");
    if (errEl) {
      errEl.style.display = "block";
      errEl.textContent = String(err);
    }
  }

  if (refreshBtn) refreshBtn.disabled = false;
}

// --------------------------------------------------------------------------
// 2. Hash Routing & Tabs
// --------------------------------------------------------------------------
export function handleRoute() {
  const hash = window.location.hash.toLowerCase() || "#market";
  const mainTab = hash.startsWith("#wallet") ? "wallet" : hash.startsWith("#tools") ? "tools" : "market";

  state.activeTab = mainTab;

  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.tab === mainTab);
  });
  document.querySelectorAll(".tab-content").forEach(c => {
    c.classList.toggle("active", c.id === `tab-${mainTab}`);
  });

  if (mainTab === "tools") {
    const sub = hash.split("/")[1] || "sweet-spot";
    state.activeTool = sub;
    document.querySelectorAll(".tools-tab-btn").forEach(b => {
      b.classList.toggle("active", b.dataset.tool === sub);
    });
    document.querySelectorAll(".tool-pane").forEach(p => {
      p.classList.toggle("active", p.id === `tool-${sub}`);
    });
    if (sub === "sweet-spot") renderSweetSpotChart();
    if (sub === "basket") runBasketOptimizer();
    if (sub === "dealer") openDealerModal(false);
    if (sub === "compare") renderCompareModal();
  }

  if (mainTab === "market") {
    renderMarket();
  } else if (mainTab === "wallet") {
    renderWalletDashboard();
  }
}

// --------------------------------------------------------------------------
// 3. Global Event Delegation & Setup
// --------------------------------------------------------------------------
function setupEvents() {
  window.addEventListener("hashchange", handleRoute);

  // Spot expander toggle
  const spotExpBtn = $("spot-expander");
  const spotDetails = $("spot-details");
  if (spotExpBtn && spotDetails) {
    spotExpBtn.onclick = () => {
      const isHidden = spotDetails.style.display === "none";
      spotDetails.style.display = isHidden ? "flex" : "none";
      spotExpBtn.textContent = isHidden ? "▲ Hide Details" : "▼ Spot Details";
    };
  }

  // Market Category buttons
  document.querySelectorAll("[data-f]").forEach(b => {
    b.onclick = () => {
      state.filters.category = b.dataset.f;
      document.querySelectorAll("[data-f]").forEach(x => x.classList.toggle("on", x === b));
      renderMarket();
    };
  });

  // Favourites only filter
  const favBtn = $("fav-filter");
  if (favBtn) {
    favBtn.onclick = () => {
      state.filters.favOnly = !state.filters.favOnly;
      favBtn.classList.toggle("on", state.filters.favOnly);
      renderMarket();
    };
  }

  // In-stock checkbox
  const stockChk = $("stock");
  if (stockChk) {
    stockChk.onchange = e => {
      state.filters.stockOnly = e.target.checked;
      renderMarket();
    };
  }

  // Search input
  const searchInput = $("search");
  if (searchInput) {
    searchInput.oninput = e => {
      state.filters.search = e.target.value.trim();
      renderMarket();
    };
  }

  // Sort dropdown
  const sortSel = $("sort");
  if (sortSel) {
    sortSel.value = state.filters.sort;
    sortSel.onchange = e => {
      state.filters.sort = e.target.value;
      renderMarket();
    };
  }

  // View toggle: Cards vs Table
  document.querySelectorAll("[data-v]").forEach(b => {
    b.onclick = () => {
      const v = b.dataset.v;
      saveView(v);
      document.querySelectorAll("[data-v]").forEach(x => x.classList.toggle("on", x === b));
      renderMarket();
    };
  });
  document.querySelectorAll("[data-v]").forEach(b => {
    b.classList.toggle("on", b.dataset.v === state.view);
  });

  // Filters Panel toggle button
  const filtersToggle = $("filters-toggle");
  const filtersPanel = $("filters-panel");
  if (filtersToggle && filtersPanel) {
    filtersToggle.onclick = () => {
      const isOpen = filtersPanel.style.display === "flex";
      filtersPanel.style.display = isOpen ? "none" : "flex";
      filtersToggle.classList.toggle("on", !isOpen);
    };
  }

  // Filters inputs
  const fCountry = $("fcountry");
  if (fCountry) {
    fCountry.onchange = e => {
      state.filters.country = e.target.value;
      renderMarket();
    };
  }
  const fKarat = $("fkarat");
  if (fKarat) {
    fKarat.onchange = e => {
      state.filters.karat = e.target.value;
      renderMarket();
    };
  }
  const fWeight = $("fweight");
  if (fWeight) {
    fWeight.onchange = e => {
      state.filters.weight = e.target.value;
      renderMarket();
    };
  }
  const bMin = $("bmin");
  if (bMin) {
    bMin.oninput = e => {
      state.filters.bmin = e.target.value ? parseFloat(e.target.value) : null;
      renderMarket();
    };
  }
  const bMax = $("bmax");
  if (bMax) {
    bMax.oninput = e => {
      state.filters.bmax = e.target.value ? parseFloat(e.target.value) : null;
      renderMarket();
    };
  }
  const clearFiltersBtn = $("clear-filters");
  if (clearFiltersBtn) {
    clearFiltersBtn.onclick = () => {
      state.filters.country = "";
      state.filters.karat = "";
      state.filters.weight = "";
      state.filters.bmin = null;
      state.filters.bmax = null;
      if (fCountry) fCountry.value = "";
      if (fKarat) fKarat.value = "";
      if (fWeight) fWeight.value = "";
      if (bMin) bMin.value = "";
      if (bMax) bMax.value = "";
      renderMarket();
    };
  }

  // Refresh prices button
  const refreshBtn = $("refresh");
  if (refreshBtn) {
    refreshBtn.onclick = () => {
      loadPrices(true);
      loadSpot(true);
    };
  }

  // More menu popover
  const moreBtn = $("more-menu-btn");
  const morePop = $("more-menu-pop");
  if (moreBtn && morePop) {
    moreBtn.onclick = e => {
      e.stopPropagation();
      morePop.style.display = morePop.style.display === "block" ? "none" : "block";
    };
    document.addEventListener("click", e => {
      if (!e.target.closest("#more-menu-pop")) morePop.style.display = "none";
    });
  }

  // Silent browsing setting
  const silentChk = $("silent");
  if (silentChk) {
    silentChk.onchange = async e => {
      try {
        const d = await saveSettings(e.target.checked);
        e.target.checked = !!d.silent;
        showToast("Settings Saved", `Silent browsing ${d.silent ? "enabled (hidden Chrome)" : "disabled (visible Chrome)"}`);
      } catch (err) {
        showToast("Settings Error", err.message, "alert");
      }
    };
  }

  // Rescan product list
  const rescanBtn = $("rescan");
  if (rescanBtn) {
    rescanBtn.onclick = async () => {
      rescanBtn.disabled = true;
      rescanBtn.textContent = "Scanning...";
      try {
        const d = await rescanProducts();
        showToast("Rescan Complete", `Discovered ${d.count || 0} products`);
        await loadPrices(true);
      } catch (err) {
        showToast("Scan Error", err.message, "alert");
      }
      rescanBtn.disabled = false;
      rescanBtn.textContent = "Rescan";
    };
  }

  // Auto-refresh interval (calls cache & spot only)
  let autoTimer = null;
  const autoChk = $("auto");
  if (autoChk) {
    autoChk.onchange = e => {
      clearInterval(autoTimer);
      if (e.target.checked) {
        autoTimer = setInterval(() => {
          loadPrices(false);
          loadSpot(false);
        }, 60000);
      }
    };
  }

  // Tools Sub-Tabs Navigation
  document.querySelectorAll(".tools-tab-btn").forEach(btn => {
    btn.onclick = () => {
      const tool = btn.dataset.tool;
      window.location.hash = `#tools/${tool}`;
    };
  });

  // Sweet spot controls
  const swLog = $("sw-log");
  if (swLog) swLog.onchange = renderSweetSpotChart;

  // Basket Optimizer inputs
  const bktRun = $("bkt-run");
  if (bktRun) bktRun.onclick = runBasketOptimizer;
  document.querySelectorAll(".bkt-preset").forEach(btn => {
    btn.onclick = () => {
      $("bkt-budget").value = btn.dataset.b;
      runBasketOptimizer();
    };
  });

  // Dealer compare refresh
  const dealerRefresh = $("dealer-refresh");
  if (dealerRefresh) dealerRefresh.onclick = () => openDealerModal(true);

  // Compare clear button
  const cmpClear = $("compare-clear");
  if (cmpClear) {
    cmpClear.onclick = () => {
      state.compareSet.clear();
      $("compare-bar").style.display = "none";
      renderMarket();
      renderCompareModal();
    };
  }

  // Weights modal
  const weightsBtn = $("weights-btn");
  const weightsModal = $("weights-modal");
  if (weightsBtn && weightsModal) {
    weightsBtn.onclick = () => {
      $("w-loss").value = Number.isFinite(+state.dealWeights.loss) ? state.dealWeights.loss : 45;
      $("w-prem").value = Number.isFinite(+state.dealWeights.prem) ? state.dealWeights.prem : 35;
      $("w-pure").value = Number.isFinite(+state.dealWeights.pure) ? state.dealWeights.pure : 20;
      $("w-loss-val").textContent = $("w-loss").value + "%";
      $("w-prem-val").textContent = $("w-prem").value + "%";
      $("w-pure-val").textContent = $("w-pure").value + "%";
      weightsModal.style.display = "flex";
    };
    $("w-close").onclick = () => { weightsModal.style.display = "none"; };
    ["w-loss", "w-prem", "w-pure"].forEach(id => {
      $(id).oninput = () => { $(id + "-val").textContent = $(id).value + "%"; };
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
      state.dealWeights = {
        loss: Number.isFinite(+($("w-loss").value)) ? +($("w-loss").value) : 45,
        prem: Number.isFinite(+($("w-prem").value)) ? +($("w-prem").value) : 35,
        pure: Number.isFinite(+($("w-pure").value)) ? +($("w-pure").value) : 20
      };
      saveDealWeights();
      weightsModal.style.display = "none";
      showToast("Weights Saved", "Recomputed Deal Scores with custom weights");
      computeDealScores();
      renderMarket();
    };
  }

  // Alerts Manager modal
  const alertsBtn = $("alerts-btn");
  if (alertsBtn) alertsBtn.onclick = openAlertsManager;
  const mgrClose = $("mgr-close");
  if (mgrClose) mgrClose.onclick = () => { $("mgr-modal").style.display = "none"; };
  const mgrTestSound = $("mgr-test-sound");
  if (mgrTestSound) mgrTestSound.onclick = playChime;
  const mgrReqNotif = $("mgr-req-notif");
  if (mgrReqNotif) mgrReqNotif.onclick = requestNotificationPermission;
  const mgrClear = $("mgr-clear");
  if (mgrClear) {
    mgrClear.onclick = () => {
      state.alerts = [];
      saveAlerts();
      updateAlertBadge();
      openAlertsManager();
    };
  }

  // Single Item Alert Modal
  const altClose = $("alt-close");
  if (altClose) altClose.onclick = () => { $("alt-modal").style.display = "none"; };
  const altCancel = $("alt-cancel");
  if (altCancel) altCancel.onclick = () => { $("alt-modal").style.display = "none"; };
  const altSave = $("alt-save");
  if (altSave) altSave.onclick = saveItemAlert;
  const altDelete = $("alt-delete");
  if (altDelete) altDelete.onclick = deleteItemAlert;

  // Chart modal
  const mClose = $("mclose");
  if (mClose) mClose.onclick = closeChartModal;
  const mReload = $("mreload");
  if (mReload) mReload.onclick = reloadCurrentChart;
  const rngBox = $("rng");
  if (rngBox) {
    rngBox.onclick = e => {
      const b = e.target.closest("[data-days]");
      if (b) applyRange(+b.dataset.days);
    };
  }

  // Wallet Header Actions
  const wAddBtn = $("w-add-btn");
  if (wAddBtn) wAddBtn.onclick = () => openWalletModal();
  const wModalClose = $("w-modal-close");
  if (wModalClose) wModalClose.onclick = () => { $("wallet-modal").style.display = "none"; };
  const wFormCancel = $("w-form-cancel");
  if (wFormCancel) wFormCancel.onclick = () => { $("wallet-modal").style.display = "none"; };
  const wFormSave = $("w-form-save");
  if (wFormSave) wFormSave.onclick = saveWalletHolding;
  const wBackupBtn = $("w-backup-btn");
  if (wBackupBtn) wBackupBtn.onclick = backupWallet;
  const wRestoreBtn = $("w-restore-btn");
  const wFileInput = $("w-file-input");
  if (wRestoreBtn && wFileInput) {
    wRestoreBtn.onclick = () => wFileInput.click();
    wFileInput.onchange = e => {
      if (e.target.files && e.target.files[0]) restoreWallet(e.target.files[0]);
    };
  }

  // Wallet live form listeners
  ["w-form-product", "w-form-name", "w-form-price", "w-form-qty", "w-form-pure"].forEach(id => {
    const el = $(id);
    if (el) {
      el.oninput = updateFormLivePreview;
      el.onchange = updateFormLivePreview;
    }
  });

  // Global delegation for dynamic card & table actions
  document.addEventListener("click", e => {
    // 1. Star / Favourites toggle
    const favBtn = e.target.closest("[data-fav]");
    if (favBtn) {
      e.stopPropagation();
      const pid = favBtn.dataset.fav;
      if (state.favs.has(pid)) state.favs.delete(pid);
      else state.favs.add(pid);
      saveFavs();
      renderMarket();
      return;
    }

    // 2. Add to Wallet quick button
    const walletAddBtn = e.target.closest("[data-wallet-add]");
    if (walletAddBtn) {
      e.stopPropagation();
      const pid = walletAddBtn.dataset.walletAdd;
      openWalletModal(pid);
      return;
    }

    // 3. Open Price Chart
    const chartBtn = e.target.closest("[data-chart]");
    if (chartBtn) {
      e.stopPropagation();
      const pid = chartBtn.dataset.chart;
      openChartModal(pid);
      return;
    }

    // 4. Open Alert Modal
    const alertBtn = e.target.closest("[data-alert]");
    if (alertBtn) {
      e.stopPropagation();
      const pid = alertBtn.dataset.alert;
      openItemAlertModal(pid);
      return;
    }

    // 5. Compare toggle
    const cmpBtn = e.target.closest("[data-cmp]");
    if (cmpBtn) {
      e.stopPropagation();
      const pid = cmpBtn.dataset.cmp;
      toggleCompare(pid);
      renderMarket();
      return;
    }

    // 6. Card Details accordion toggle
    const detailsBtn = e.target.closest("[data-toggle-details]");
    if (detailsBtn) {
      e.stopPropagation();
      const pid = detailsBtn.dataset.toggleDetails;
      if (state.expandedCards.has(pid)) {
        state.expandedCards.delete(pid);
      } else {
        state.expandedCards.add(pid);
      }
      const card = $(`card-${pid}`);
      if (card) {
        const isOpen = state.expandedCards.has(pid);
        card.classList.toggle("details-open", isOpen);
        detailsBtn.querySelector("span").textContent = isOpen ? "▲ Hide Details" : "▼ Details & Market Comparison";
      }
      return;
    }
  });
}

// --------------------------------------------------------------------------
// 4. Initialization
// --------------------------------------------------------------------------
async function init() {
  setupEvents();
  updateAlertBadge();

  // Load initial settings
  try {
    const s = await fetchSettings();
    if ($("silent")) $("silent").checked = !!s.silent;
  } catch (_) {}

  // Initial routing
  handleRoute();

  // Fetch prices and spot
  await Promise.all([
    loadPrices(false),
    loadSpot(false)
  ]);

  // Periodic spot price update (every 60s)
  setInterval(() => loadSpot(false), 60000);
}

// Start app
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
