/**
 * GoldForex Picker - Audio Chimes & Price/Stock Alerts Management
 */
import { $, state, saveAlerts } from "./state.js";
import { eur, num, esc, showToast } from "./format.js";

let audioCtx = null;

export function playChime() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const now = audioCtx.currentTime;
    const osc1 = audioCtx.createOscillator();
    const osc2 = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc1.type = "sine";
    osc1.frequency.setValueAtTime(587.33, now); // D5
    osc1.frequency.exponentialRampToValueAtTime(880.00, now + 0.15); // A5

    osc2.type = "triangle";
    osc2.frequency.setValueAtTime(880.00, now + 0.15);
    osc2.frequency.exponentialRampToValueAtTime(1174.66, now + 0.35); // D6

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.exponentialRampToValueAtTime(0.3, now + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.6);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(audioCtx.destination);

    osc1.start(now);
    osc1.stop(now + 0.2);
    osc2.start(now + 0.15);
    osc2.stop(now + 0.6);
  } catch (_) {}
}

export function updateAlertBadge() {
  const active = state.alerts.filter(a => a.enabled).length;
  const b = $("alerts-count");
  if (b) {
    if (active > 0) {
      b.style.display = "inline-block";
      b.textContent = active;
    } else {
      b.style.display = "none";
    }
  }
}

export function checkAlerts() {
  let triggered = false;
  for (const alt of state.alerts) {
    if (!alt.enabled) continue;
    const r = state.rows.find(x => x.pid === alt.pid);
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
      if (!state.lastFiredAlerts.has(key)) {
        state.lastFiredAlerts.add(key);
        triggered = true;
        showToast(`Alert: ${r.name}`, reason, "alert");
        if (window.Notification && Notification.permission === "granted") {
          new Notification(`GoldForex Alert: ${r.name}`, { body: `${r.name} ${reason}`, icon: r.image });
        }
      }
    }
    alt.was_oos = !r.in_stock;
  }
  if (triggered) playChime();
}

let curAltPid = null;

export function openItemAlertModal(pid) {
  curAltPid = pid;
  const r = state.rows.find(x => x.pid === pid);
  if (!r) return;
  const existing = state.alerts.find(a => a.pid === pid);

  $("alt-title").textContent = `Alert: ${r.name}`;
  $("alt-desc").textContent = `Current: Pay ${eur(r.shop_sells)} · Resale Loss ${num(r.spread_pct)}% · ${r.in_stock ? "In stock" : "Out of stock"}`;
  $("alt-stock").checked = existing ? !!existing.stock : false;
  $("alt-price").value = existing && existing.max_price != null ? existing.max_price : "";
  $("alt-loss").value = existing && existing.max_loss != null ? existing.max_loss : "";
  $("alt-delete").style.display = existing ? "inline-block" : "none";
  $("alt-modal").style.display = "flex";
}

export function saveItemAlert() {
  if (!curAltPid) return;
  const r = state.rows.find(x => x.pid === curAltPid);
  const stock = $("alt-stock").checked;
  const price = parseFloat($("alt-price").value);
  const loss = parseFloat($("alt-loss").value);

  state.alerts = state.alerts.filter(a => a.pid !== curAltPid);
  if (stock || !isNaN(price) || !isNaN(loss)) {
    state.alerts.push({
      id: "a_" + Date.now(),
      pid: curAltPid,
      name: r ? r.name : curAltPid,
      stock,
      max_price: isNaN(price) ? null : price,
      max_loss: isNaN(loss) ? null : loss,
      enabled: true,
      was_oos: r ? !r.in_stock : false,
    });
    showToast("Alert Saved", `Saved alerts for ${r ? r.name : "item"}`);
  }
  saveAlerts();
  updateAlertBadge();
  $("alt-modal").style.display = "none";
}

export function deleteItemAlert() {
  if (!curAltPid) return;
  state.alerts = state.alerts.filter(a => a.pid !== curAltPid);
  saveAlerts();
  updateAlertBadge();
  $("alt-modal").style.display = "none";
  showToast("Alert Deleted", "Removed alert");
}

export function openAlertsManager() {
  const modal = $("mgr-modal");
  const list = $("mgr-list");
  if (!modal || !list) return;

  if (!state.alerts.length) {
    list.innerHTML = `<div class="cmsg" style="padding:24px 0">No active alerts set. Click the 🔔 icon on any product to set target price or stock alerts.</div>`;
  } else {
    list.innerHTML = state.alerts.map(a => {
      const parts = [];
      if (a.stock) parts.push("Back in stock");
      if (a.max_price) parts.push(`Pay ≤ ${eur(a.max_price)}`);
      if (a.max_loss) parts.push(`Loss ≤ ${a.max_loss}%`);
      return `
        <div class="alt-row" data-aid="${esc(a.id)}">
          <input type="checkbox" ${a.enabled ? "checked" : ""} data-toggle-aid="${esc(a.id)}">
          <div style="flex:1">
            <b>${esc(a.name)}</b>
            <div class="mut" style="font-size:11.5px">${parts.join(" · ") || "No criteria"}</div>
          </div>
          <button class="t-close" data-del-aid="${esc(a.id)}" title="Delete alert">&times;</button>
        </div>`;
    }).join("");

    list.querySelectorAll("[data-toggle-aid]").forEach(chk => {
      chk.onchange = () => {
        const alt = state.alerts.find(a => a.id === chk.dataset.toggleAid);
        if (alt) {
          alt.enabled = chk.checked;
          saveAlerts();
          updateAlertBadge();
        }
      };
    });

    list.querySelectorAll("[data-del-aid]").forEach(btn => {
      btn.onclick = () => {
        state.alerts = state.alerts.filter(a => a.id !== btn.dataset.delAid);
        saveAlerts();
        updateAlertBadge();
        openAlertsManager();
      };
    });
  }

  modal.style.display = "flex";
}

export function requestNotificationPermission() {
  if (window.Notification) {
    Notification.requestPermission().then(perm => {
      showToast("Notification Permission", `Browser status: ${perm}`);
    });
  } else {
    alert("Desktop notifications are not supported in this browser.");
  }
}
