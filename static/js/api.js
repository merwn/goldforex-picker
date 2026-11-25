/**
 * GoldForex Picker - API Communication Layer
 */

export async function fetchPrices(refresh = false) {
  const res = await fetch("/api/prices?refresh=" + (refresh ? 1 : 0));
  const data = await res.json();
  if (!res.ok && !data.rows) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return { ok: res.ok, data };
}

export async function fetchSpot(refresh = false) {
  const res = await fetch("/api/spot?refresh=" + (refresh ? 1 : 0));
  return await res.json();
}

export async function fetchSettings() {
  const res = await fetch("/api/settings");
  return await res.json();
}

export async function saveSettings(silent) {
  const res = await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ silent: silent ? 1 : 0 })
  });
  return await res.json();
}

export async function fetchCompetitors(refresh = false) {
  const res = await fetch("/api/competitor?refresh=" + (refresh ? 1 : 0));
  return await res.json();
}

export async function fetchChart(pid, refresh = false) {
  const res = await fetch(`/api/chart/${encodeURIComponent(pid)}?refresh=${refresh ? 1 : 0}`);
  return await res.json();
}

export async function rescanProducts() {
  const res = await fetch("/api/products?refresh=1");
  return await res.json();
}
