/**
 * GoldForex Picker - Scoring & Derived Investment Calculations
 */
import { state } from "./state.js";

export function getPercentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * (p / 100);
  const low = Math.floor(idx);
  const high = Math.ceil(idx);
  const weight = idx - low;
  return sorted[low] * (1 - weight) + sorted[high] * weight;
}

export function medianImplied() {
  const v = state.rows
    .map(r => r.implied_spot_per_g)
    .filter(x => x && !isNaN(x))
    .sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

export function melt(r) {
  const g = state.spot && state.spot.eur_per_g ? state.spot.eur_per_g : (r.implied_spot_per_g || medianImplied());
  return g && r.pure_g ? g * r.pure_g : null;
}

export function calcBreakevenSpot(r) {
  const s = state.spot && state.spot.eur_per_g ? state.spot.eur_per_g : (r.implied_spot_per_g || medianImplied());
  if (!s || !r.shop_sells || !r.shop_buys) return null;
  return s * (r.shop_sells / r.shop_buys);
}

export function computeDealScores() {
  const allValid = state.rows.filter(r => r.status === "ok" && !r.suspect && r.spread_pct != null && r.sell_per_pure_g != null);
  if (!allValid.length) {
    for (const r of state.rows) r.deal_score = null;
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

  const wLoss = Number.isFinite(+state.dealWeights.loss) ? +state.dealWeights.loss : 45;
  const wPrem = Number.isFinite(+state.dealWeights.prem) ? +state.dealWeights.prem : 35;
  const wPure = Number.isFinite(+state.dealWeights.pure) ? +state.dealWeights.pure : 20;
  const totW = (wLoss + wPrem + wPure) || 100;

  for (const r of state.rows) {
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
