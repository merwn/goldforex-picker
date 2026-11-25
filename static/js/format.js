/**
 * GoldForex Picker - Formatting & Presentation Helpers
 */
import { $ } from "./state.js";

export const f2 = new Intl.NumberFormat("nl-BE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const f3 = new Intl.NumberFormat("nl-BE", { minimumFractionDigits: 3, maximumFractionDigits: 3 });

export function eur(v) {
  return v == null || isNaN(v) ? "-" : f2.format(v) + " \u20ac";
}

export function num(v, f = f2) {
  return v == null || isNaN(v) ? "-" : f.format(v);
}

export function sgn(v) {
  return v == null || isNaN(v) ? "-" : (v >= 0 ? "+" : "") + f2.format(v) + "%";
}

export function esc(s) {
  return (s == null ? "" : String(s))
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function lossCls(v) {
  if (v == null || isNaN(v)) return "mut";
  if (v <= 4.5) return "g";
  if (v <= 7.0) return "y";
  if (v <= 12.0) return "o";
  return "r";
}

export function dealScoreCls(score) {
  if (score == null) return "s-none";
  if (score >= 90) return "s-top";
  if (score >= 75) return "s-good";
  if (score >= 50) return "s-mid";
  return "s-low";
}

export function karatTxt(k) {
  return k == null ? "- K" : k.toFixed(1).replace(".0", "") + " K";
}

export function showToast(title, msg, type = "normal") {
  const c = $("toasts");
  if (!c) return;
  const el = document.createElement("div");
  el.className = `toast ${type === "alert" ? "toast-alert" : ""}`;
  el.innerHTML = `<div class="t-top"><b>${esc(title)}</b><button class="t-close">&times;</button></div><div class="t-msg">${esc(msg)}</div>`;
  el.querySelector(".t-close").onclick = () => el.remove();
  c.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transition = "opacity .4s";
    setTimeout(() => el.remove(), 400);
  }, 6000);
}
