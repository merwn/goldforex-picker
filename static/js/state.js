/**
 * GoldForex Picker - Global State & Storage Persistence
 */

export const $ = id => document.getElementById(id);

export function migrateStorage() {
  // Backward compatibility: migrate old gf_vault to gf_wallet if present
  if (!localStorage.getItem("gf_wallet") && localStorage.getItem("gf_vault")) {
    try {
      localStorage.setItem("gf_wallet", localStorage.getItem("gf_vault"));
    } catch (_) {}
  }
}

migrateStorage();

// Saved table optional column defaults
const DEFAULT_TABLE_COLS = ["timing", "country", "pure_g", "karat", "breakeven", "premium", "pure_cost"];

export const state = {
  rows: [],
  spot: null,
  favs: new Set(JSON.parse(localStorage.getItem("gf_favs") || "[]")),
  alerts: JSON.parse(localStorage.getItem("gf_alerts") || "[]"),
  wallet: JSON.parse(localStorage.getItem("gf_wallet") || "[]"),
  dealWeights: (() => {
    try {
      const w = JSON.parse(localStorage.getItem("gf_deal_weights") || "{}");
      return {
        loss: Number.isFinite(+w.loss) ? +w.loss : 45,
        prem: Number.isFinite(+w.prem) ? +w.prem : 35,
        pure: Number.isFinite(+w.pure) ? +w.pure : 20,
      };
    } catch (_) {
      return { loss: 45, prem: 35, pure: 20 };
    }
  })(),
  compareSet: new Set(),
  expandedCards: new Set(),
  tableCols: new Set(JSON.parse(localStorage.getItem("gf_table_cols") || JSON.stringify(DEFAULT_TABLE_COLS))),
  filters: {
    category: "all",
    stockOnly: true,
    favOnly: false,
    search: "",
    country: "",
    karat: "",
    weight: "",
    bmin: null,
    bmax: null,
    sort: "deal",
  },
  view: localStorage.getItem("gf_view") || "cards",
  activeTab: "market",
  activeTool: "sweet-spot",
  lastFiredAlerts: new Set(),
};

export function saveFavs() {
  localStorage.setItem("gf_favs", JSON.stringify([...state.favs]));
}

export function saveAlerts() {
  localStorage.setItem("gf_alerts", JSON.stringify(state.alerts));
}

export function saveWallet() {
  localStorage.setItem("gf_wallet", JSON.stringify(state.wallet));
}

export function saveDealWeights() {
  localStorage.setItem("gf_deal_weights", JSON.stringify(state.dealWeights));
}

export function saveTableCols() {
  localStorage.setItem("gf_table_cols", JSON.stringify([...state.tableCols]));
}

export function saveView(view) {
  state.view = view;
  localStorage.setItem("gf_view", view);
}
