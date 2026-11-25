"""
Product page scrapers, parsing, derived investment metrics, and transparency floodfill.
"""
from __future__ import annotations

import json
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from urllib.parse import urljoin

from bs4 import BeautifulSoup

from browser import BrowserPool, discover_urls, pool as default_pool
import config
from config import (
    BROWSER_TIMEOUT,
    CHART_DIR,
    COUNTRY_HINTS,
    FALLBACK_URLS,
    HTTP_RETRIES,
    HTTP_TIMEOUT,
    PRICE_SELECTOR,
    BlockedError,
    ParseError,
    get_session,
    proxied,
    set_products,
)
from spot import parse_money

try:
    from zoneinfo import ZoneInfo
    BRUSSELS_TZ = ZoneInfo("Europe/Brussels")
except Exception:
    BRUSSELS_TZ = None

# Known coin reference specifications: (pattern, purity_pct, gross_weight_g, pure_gold_g)
KNOWN_COIN_DATA = [
    (r"1\s*ducat", 98.6, 3.49, 3.44),
    (r"4\s*ducat", 98.6, 13.96, 13.76),
    (r"1/10\s*(?:oz|ounce)?\s*krugerrand", 91.67, 3.393, 3.1103),
    (r"1/4\s*(?:oz|ounce)?\s*krugerrand", 91.67, 8.482, 7.7759),
    (r"1/2\s*(?:oz|ounce)?\s*krugerrand", 91.67, 16.965, 15.5517),
    (r"1\s*(?:oz|ounce)?\s*krugerrand", 91.67, 33.93, 31.1035),
    (r"1/10\s*(?:oz|ounce)?\s*maple\s*leaf", 99.99, 3.1103, 3.1103),
    (r"1/4\s*(?:oz|ounce)?\s*maple\s*leaf", 99.99, 7.7759, 7.7759),
    (r"1/2\s*(?:oz|ounce)?\s*maple\s*leaf", 99.99, 15.5517, 15.5517),
    (r"1\s*(?:oz|ounce)?\s*maple\s*leaf", 99.99, 31.1035, 31.1035),
    (r"1/10\s*(?:oz|ounce)?\s*eagle", 91.67, 3.393, 3.1103),
    (r"1/4\s*(?:oz|ounce)?\s*eagle", 91.67, 8.482, 7.7759),
    (r"1/2\s*(?:oz|ounce)?\s*eagle", 91.67, 16.965, 15.5517),
    (r"1\s*(?:oz|ounce)?\s*eagle", 91.67, 33.93, 31.1035),
    (r"1/10\s*(?:oz|ounce)?\s*phil+ar?moni", 99.99, 3.1103, 3.1103),
    (r"1/4\s*(?:oz|ounce)?\s*phil+ar?moni", 99.99, 7.7759, 7.7759),
    (r"1/2\s*(?:oz|ounce)?\s*phil+ar?moni", 99.99, 15.5517, 15.5517),
    (r"1\s*(?:oz|ounce)?\s*phil+ar?moni", 99.99, 31.1035, 31.1035),
    (r"1/10\s*(?:oz|ounce)?\s*britannia", 99.99, 3.1103, 3.1103),
    (r"1/4\s*(?:oz|ounce)?\s*britannia", 99.99, 7.7759, 7.7759),
    (r"1/2\s*(?:oz|ounce)?\s*britannia", 99.99, 15.5517, 15.5517),
    (r"1\s*(?:oz|ounce)?\s*britannia", 99.99, 31.1035, 31.1035),
    (r"1/10\s*(?:oz|ounce)?\s*panda", 99.9, 3.1103, 3.1103),
    (r"1/4\s*(?:oz|ounce)?\s*panda", 99.9, 7.7759, 7.7759),
    (r"10\s*deutsche\s*mark", 90.0, 3.982, 3.584),
    (r"20\s*deutsche\s*mark", 90.0, 7.965, 7.1685),
    (r"20\s*(?:francs|frs|frank|lires|lire)", 90.0, 6.45, 5.805),
    (r"10\s*(?:francs|frs|frank)", 90.0, 3.225, 2.9025),
    (r"50\s*pesos", 90.0, 41.666, 37.5),
    (r"20\s*pesos", 90.0, 16.666, 15.0),
    (r"10\s*pesos", 90.0, 8.333, 7.5),
    (r"5\s*pesos", 90.0, 4.166, 3.75),
    (r"2[.,]5\s*pesos", 90.0, 2.083, 1.875),
    (r"2\s*pesos", 90.0, 1.666, 1.5),
    (r"10\s*gulden", 90.0, 6.729, 6.056),
    (r"5\s*gulden", 90.0, 3.364, 3.028),
    (r"vreneli", 90.0, 6.45, 5.805),
    (r"sovereign\s*1/2|half\s*sovereign", 91.67, 3.99, 3.6588),
    (r"sovereign", 91.67, 7.988, 7.322),
]

FRACTIONAL_OUNCES = [
    (r"1/10\s*(?:oz|ounce)", 3.1103),
    (r"1/4\s*(?:oz|ounce)", 7.7759),
    (r"1/2\s*(?:oz|ounce)", 15.5517),
    (r"1\s*(?:oz|ounce)", 31.1035),
    (r"2\s*(?:oz|ounce)", 62.207),
]


def first_number(text: str) -> float | None:
    """Weights/percentages: '3,225 g' -> 3.225, '2,902500 g' -> 2.9025, '999.9\u2030' -> 999.9"""
    m = re.search(r"-?\d+(?:[.,]\d+)?", text or "")
    return float(m.group(0).replace(",", ".")) if m else None


def parse_images(soup: BeautifulSoup) -> tuple[str | None, str | None]:
    """Extract (card image, full-size image) from the product gallery."""
    large = []
    for a in soup.select("li[id^=thumbnail_] a"):
        rel = a.get("rel")
        rel = " ".join(rel) if isinstance(rel, list) else (rel or "")
        m = re.search(r"largeimage:\s*'([^']+)'", rel)
        if m:
            large.append(m.group(1))
    img = soup.select_one("img.img-responsive[itemprop=url], img[itemprop=url]")
    card = img.get("src") if img else None
    full = large[0] if large else card
    if not card and full:
        card = full.replace("thickbox_default", "large_default")
    return card, full


def parse_product(html: str, url: str) -> dict:
    """Extract everything from one product page (works on raw HTML and browser DOM)."""
    soup = BeautifulSoup(html, "lxml")

    def prop(name):
        return soup.select_one(f'[data-refresh-property="{name}"]')

    sell_el, buy_el = prop("sell_price"), prop("buy_price")
    if sell_el is None and buy_el is None:
        raise ParseError("price elements not found")

    def price(el):
        if el is None:
            return None
        if el.get("content"):
            try:
                return float(el["content"])
            except ValueError:
                pass
        return parse_money(el.get_text(" ", strip=True))

    def pct(el):
        return first_number(el.get_text(strip=True)) if el is not None else None

    # Stock check
    buy_block = soup.select_one("div.buy")
    block_txt = (buy_block.get_text(" ", strip=True) if buy_block else "").lower()
    sold_out = any(k in block_txt for k in ("indisponible", "notify me when", "out of stock", "rupture"))
    in_stock = (soup.select_one("p.instock") is not None) and not sold_out

    h1 = soup.select_one("h1[itemprop=name] span") or soup.select_one("h1")
    name = h1.get_text(strip=True) if h1 else url.rsplit("/", 1)[-1]
    name_low = name.lower()

    feats = {}
    for li in soup.select("#tab-features li"):
        lab, val = li.find("label"), li.select_one(".fvalue")
        if lab and val:
            feats[lab.get_text(strip=True).lower()] = val.get_text(" ", strip=True)

    ptype = feats.get("type of products", "").strip().lower()
    category = ptype if ptype in ("bar", "coin") else ("bar" if "bar" in url or "ingot" in url else "coin")

    w1, w2 = first_number(feats.get("net weight", "")), first_number(feats.get("gross weight", ""))
    weights = [w for w in (w1, w2) if w and w > 0]
    purity_raw = first_number(feats.get("purity", ""))

    purity_pct = None
    if purity_raw is not None and purity_raw > 0:
        if purity_raw <= 1.0:
            purity_pct = purity_raw * 100.0
        elif purity_raw > 100.0:
            purity_pct = purity_raw / 10.0
        else:
            purity_pct = purity_raw

    weight_g = max(weights) if weights else None
    pure_g = min(weights) if weights else None
    if weight_g and purity_pct:
        pure_g = weight_g * purity_pct / 100.0

    # Fallback weight and purity from known coin database and name regex
    matched_known = False
    for pat, k_pur, k_gross, k_pure in KNOWN_COIN_DATA:
        if re.search(pat, name_low):
            matched_known = True
            if purity_pct is None or purity_pct < 1.0 or purity_pct > 100.0:
                purity_pct = k_pur
            if weight_g is None or weight_g <= 0:
                weight_g = k_gross
            # Fix 1 Ducat bug or bogus pure_g
            if pure_g is None or pure_g < 0.1 or ("ducat" in name_low):
                pure_g = k_pure
            break

    if not matched_known:
        # Check fractional ounce pattern in name
        for pat, oz_wt in FRACTIONAL_OUNCES:
            if re.search(pat, name_low):
                if pure_g is None or pure_g <= 0:
                    pure_g = oz_wt
                if weight_g is None or weight_g <= 0:
                    weight_g = oz_wt
                if purity_pct is None:
                    purity_pct = 99.99
                break

        # Check grams pattern in name (e.g. '5 grams', '2 grams', '1 gr.')
        m_g = re.search(r"(\d+(?:[.,]\d+)?)\s*(?:g|gr|gram|gramme|grams|grammes)\b", name_low)
        if m_g:
            g_val = float(m_g.group(1).replace(",", "."))
            if weight_g is None or weight_g <= 0:
                weight_g = g_val
            if pure_g is None or pure_g <= 0:
                pure_g = g_val
            if purity_pct is None:
                purity_pct = 99.99 if category == "bar" else 90.0

    if category == "bar" and purity_pct is None:
        purity_pct = 99.99
    if pure_g is None and weight_g is not None and purity_pct is not None:
        pure_g = weight_g * purity_pct / 100.0

    country, flag = None, None
    for li in soup.select("#tab-features li"):
        lab = li.find("label")
        if lab and "country" in lab.get_text(strip=True).lower():
            sp = li.select_one(".fvalue span.ml-2") or li.select_one(".fvalue")
            country = sp.get_text(" ", strip=True) if sp else None
            im = li.select_one(".fvalue img")
            src = (im.get("src") or "") if im else ""
            if im and (not src or src.startswith("data:")):
                src = im.get("data-src") or im.get("data-original") or ""
            flag = urljoin(url, src) if src and not src.startswith("data:") else None
            break

    cot = soup.select_one("[data-refresh-common-property=gold_cotation]")
    m = re.search(r"(\d{4}-\d{2}-\d{2})\D+(\d{2}:\d{2}:\d{2})", cot.get_text() if cot else "")
    quote_iso = None
    if m:
        try:
            if BRUSSELS_TZ:
                dt = datetime.strptime(f"{m.group(1)} {m.group(2)}", "%Y-%m-%d %H:%M:%S").replace(tzinfo=BRUSSELS_TZ)
                quote_iso = dt.isoformat()
            else:
                quote_iso = f"{m.group(1)}T{m.group(2)}+01:00"
        except Exception:
            quote_iso = f"{m.group(1)}T{m.group(2)}+01:00"

    img, img_full = parse_images(soup)

    if not country:
        for k, c, f in COUNTRY_HINTS:
            if k in name_low:
                country = c
                if not flag and f:
                    flag = f
                break

    return {
        "name": name,
        "category": category,
        "url": url,
        "image": proxied(img),
        "image_full": proxied(img_full),
        "country": country or None,
        "flag": proxied(flag),
        "weight_g": round(weight_g, 4) if weight_g else None,
        "purity_pct": round(purity_pct, 2) if purity_pct else None,
        "pure_g": round(pure_g, 4) if pure_g else None,
        "shop_sells": price(sell_el),
        "shop_buys": price(buy_el),
        "premium_pay_pct": pct(prop("sell_bonus_final")),
        "premium_receive_pct": pct(prop("buy_bonus_final")),
        "in_stock": in_stock,
        "quote_time": quote_iso,
    }


def add_derived(row: dict, spot_per_g: float | None = None) -> dict:
    s, b, pure, prem = row.get("shop_sells"), row.get("shop_buys"), row.get("pure_g"), row.get("premium_pay_pct")
    row["spread_pct"] = round((s - b) / s * 100, 2) if s and b else None
    row["loss_eur"] = round(s - b, 2) if s and b else None
    row["breakeven_pct"] = round((s / b - 1) * 100, 2) if s and b else None
    row["sell_per_pure_g"] = round(s / pure, 2) if s and pure else None
    row["buy_per_pure_g"] = round(b / pure, 2) if b and pure else None
    row["implied_spot_per_g"] = round(s / (1 + prem / 100) / pure, 2) if s and pure and prem is not None else None
    pur = row.get("purity_pct")
    row["karat"] = round(pur / 100 * 24, 1) if pur else None
    row["breakeven_spot_per_g"] = round(row["implied_spot_per_g"] * (s / b), 2) if row.get("implied_spot_per_g") and s and b else None
    row["melt_spot_per_g"] = round(s / pure, 2) if s and pure else None
    row["is_collector"] = bool(prem is not None and prem >= 20.0)

    # Sanity check: if sell_per_pure_g / spot_per_g is outside [0.5, 3.0], flag as suspect
    check_spot = spot_per_g or row.get("implied_spot_per_g")
    row["suspect"] = False
    if row.get("sell_per_pure_g") and check_spot and check_spot > 0:
        ratio = row["sell_per_pure_g"] / check_spot
        if ratio < 0.5 or ratio > 3.0:
            row["suspect"] = True

    return row


def http_task(url: str) -> dict:
    last: Exception | None = None
    for attempt in range(1, HTTP_RETRIES + 1):
        try:
            r = get_session().get(url, timeout=HTTP_TIMEOUT)
            if r.status_code in (403, 429, 503):
                raise BlockedError(f"HTTP {r.status_code}")
            r.raise_for_status()
            row = parse_product(r.text, url)
            row["via"] = "http"
            return row
        except (BlockedError, ParseError):
            raise
        except Exception as exc:
            last = exc
            time.sleep(0.6 * attempt)
    raise last or RuntimeError("http failed")


def browser_task(url: str, p: BrowserPool = default_pool) -> dict:
    from selenium.common.exceptions import TimeoutException
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support import expected_conditions as EC
    from selenium.webdriver.support.ui import WebDriverWait

    with p.borrow() as drv:
        drv.get(url)
        try:
            WebDriverWait(drv, BROWSER_TIMEOUT, poll_frequency=0.2).until(
                EC.presence_of_element_located((By.CSS_SELECTOR, PRICE_SELECTOR)))
        except TimeoutException:
            low = (drv.page_source or "").lower()[:20000]
            if any(k in low for k in ("verify you are human", "just a moment", "cf-challenge", "captcha")):
                raise BlockedError("bot check page - untick Silent browsing in Settings, solve it once in the Chrome window, then refresh")
            raise ParseError("price element did not appear")
        row = parse_product(drv.page_source, url)
        row["via"] = "browser"
        return row


def run_parallel(fn, urls: list[str], workers: int):
    ok, bad = {}, {}
    with ThreadPoolExecutor(max_workers=max(1, min(workers, len(urls)))) as ex:
        futs = {ex.submit(fn, u): u for u in urls}
        for f in as_completed(futs):
            u = futs[f]
            try:
                ok[u] = f.result()
            except Exception as exc:
                bad[u] = f"{type(exc).__name__}: {str(exc)[:160]}"
    return ok, bad


def get_percentile(arr: list[float], p: float) -> float:
    """Calculate p-th percentile (0 to 100) using linear interpolation."""
    if not arr:
        return 0.0
    s = sorted(arr)
    idx = (len(s) - 1) * (p / 100.0)
    low = int(idx)
    high = min(low + 1, len(s) - 1)
    weight = idx - low
    return s[low] * (1.0 - weight) + s[high] * weight


def compute_backend_deal_scores(rows: list[dict]):
    """Calculate default composite deal score (0-100) combining loss %, spot premium % and pure gram cost.
    Normalizes over in-stock, non-suspect rows using 5th-95th percentile bounds to prevent compression."""
    all_valid = [r for r in rows if r.get("status") == "ok" and not r.get("suspect")
                 and r.get("spread_pct") is not None and r.get("sell_per_pure_g") is not None]
    if not all_valid:
        for r in rows:
            r["deal_score"] = None
        return

    # Prefer in-stock items for bounds so unavailable items don't distort scale
    in_stock_valid = [r for r in all_valid if r.get("in_stock")]
    base = in_stock_valid if len(in_stock_valid) >= 3 else all_valid

    losses = [r["spread_pct"] for r in base]
    p5_loss, p95_loss = get_percentile(losses, 5), get_percentile(losses, 95)

    prems = [r["premium_pay_pct"] for r in base if r.get("premium_pay_pct") is not None]
    p5_prem = get_percentile(prems, 5) if prems else 0.0
    p95_prem = get_percentile(prems, 95) if prems else 100.0

    pures = [r["sell_per_pure_g"] for r in base]
    p5_pure, p95_pure = get_percentile(pures, 5), get_percentile(pures, 95)

    for r in rows:
        if r.get("status") != "ok" or r.get("suspect") or r.get("spread_pct") is None or r.get("sell_per_pure_g") is None:
            r["deal_score"] = None
            continue

        v_loss = max(p5_loss, min(p95_loss, r["spread_pct"]))
        s_loss = 1.0 if p95_loss <= p5_loss else 1.0 - (v_loss - p5_loss) / max(0.001, p95_loss - p5_loss)

        prem = r.get("premium_pay_pct") if r.get("premium_pay_pct") is not None else p95_prem
        v_prem = max(p5_prem, min(p95_prem, prem))
        s_prem = 1.0 if p95_prem <= p5_prem else 1.0 - (v_prem - p5_prem) / max(0.001, p95_prem - p5_prem)

        v_pure = max(p5_pure, min(p95_pure, r["sell_per_pure_g"]))
        s_pure = 1.0 if p95_pure <= p5_pure else 1.0 - (v_pure - p5_pure) / max(0.001, p95_pure - p5_pure)

        score = round((45 * s_loss + 35 * s_prem + 20 * s_pure))
        r["deal_score"] = max(1, min(100, score))


def calc_historical_spread_stats(pid: str) -> dict | None:
    """Read cached chart history for product and calculate 52-week spread range and percentile."""
    chart_path = CHART_DIR / f"{pid}.json"
    if not chart_path.exists():
        return None
    try:
        d = json.loads(chart_path.read_text(encoding="utf-8"))
        buy = {p["time"]: p["value"] for p in d.get("buy", [])}
        sell = {p["time"]: p["value"] for p in d.get("sell", [])}
        times = sorted(set(buy.keys()) & set(sell.keys()))
        if not times:
            return None
        last_t = times[-1]
        yr_times = [t for t in times if t >= last_t - 365 * 86400]
        spreads = [(buy[t] - sell[t]) / buy[t] * 100 for t in yr_times if buy[t] > 0]
        if not spreads:
            return None
        cur = round(spreads[-1], 2)
        mn = round(min(spreads), 2)
        mx = round(max(spreads), 2)
        avg = round(sum(spreads) / len(spreads), 2)
        pct = round((cur - mn) / (mx - mn) * 100, 1) if mx > mn else 50.0
        cheaper_than = round(max(0.0, min(100.0, 100.0 - pct)), 1)
        if pct <= 25.0:
            status = "bargain"
            badge = "🔥 52W Bargain"
        elif pct <= 65.0:
            status = "fair"
            badge = "⚖️ Fair Spread"
        else:
            status = "high"
            badge = "⚠️ High Spread"
        return {
            "current_loss": cur,
            "min_52w": mn,
            "max_52w": mx,
            "avg_52w": avg,
            "percentile": pct,
            "cheaper_than_pct": cheaper_than,
            "status": status,
            "badge": badge,
        }
    except Exception:
        return None


def make_transparent_png(in_path: Path, out_path: Path, thresh: int = 45) -> bool:
    """If image has near-white / light background at corners, floodfill to transparent RGBA PNG."""
    try:
        from PIL import Image, ImageDraw
        orig = Image.open(in_path).convert("RGB")
        w, h = orig.size
        if w < 60 or h < 60:
            return False
        corners = [orig.getpixel((0, 0)), orig.getpixel((w - 1, 0)), orig.getpixel((0, h - 1)), orig.getpixel((w - 1, h - 1))]
        light_corners = [c for c in corners if c[0] >= 210 and c[1] >= 210 and c[2] >= 210]
        if len(light_corners) >= 3:
            gray = orig.convert("L")
            for pt in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]:
                c = orig.getpixel(pt)
                if c[0] >= 200 and c[1] >= 200 and c[2] >= 200:
                    ImageDraw.floodfill(gray, pt, 0, thresh=thresh)
            alpha = gray.point(lambda p: 0 if p == 0 else 255, mode="L")
            rgba = orig.convert("RGBA")
            rgba.putalpha(alpha)
            out_path.parent.mkdir(parents=True, exist_ok=True)
            rgba.save(out_path, format="PNG")
            return True
    except Exception:
        pass
    return False


_discovery_lock = threading.Lock()
_discovery_in_progress = False


def trigger_background_discovery(p: BrowserPool = default_pool):
    global _discovery_in_progress
    with _discovery_lock:
        if _discovery_in_progress:
            return
        _discovery_in_progress = True

    def _run():
        global _discovery_in_progress
        try:
            get_products(refresh=True, p=p)
        finally:
            _discovery_in_progress = False

    threading.Thread(target=_run, daemon=True).start()


def get_products(refresh: bool = False, p: BrowserPool = default_pool) -> dict:
    cached = None
    if config.PRODUCTS_FILE.exists():
        try:
            cached = json.loads(config.PRODUCTS_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            cached = None

    if cached and not refresh:
        set_products(cached["urls"])
        try:
            if time.time() - config.PRODUCTS_FILE.stat().st_mtime >= config.PRODUCTS_TTL:
                trigger_background_discovery(p)
        except OSError:
            pass
        return {**cached, "source": "cache"}

    try:
        urls = discover_urls(p)
        data = {"urls": urls, "filter": config.LISTING_FILTER, "fetched_at": datetime.now().isoformat(timespec="seconds")}
        config.atomic_write_json(config.PRODUCTS_FILE, data)
        set_products(urls)
        return {**data, "source": "site"}
    except Exception as exc:
        err = f"{type(exc).__name__}: {str(exc)[:160]}"
        if cached:
            set_products(cached["urls"])
            return {**cached, "source": "stale cache", "error": err}
        set_products(FALLBACK_URLS)
        return {"urls": list(FALLBACK_URLS), "source": "fallback", "error": err}


def read_cache() -> dict | None:
    if not config.CACHE_FILE.exists():
        return None
    try:
        return json.loads(config.CACHE_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def is_likely_over_max_price(url: str, cached_rows: list[dict] | None = None) -> bool:
    """Identify bullion products known or guaranteed to exceed MAX_PRICE."""
    # 1. Primary check: check cached price if known
    if cached_rows:
        for r in cached_rows:
            if r.get("url") == url and r.get("shop_sells") is not None:
                return r["shop_sells"] >= config.MAX_PRICE

    # 2. Regex on URL slug for heavy bullion (> 10g or full 1 oz)
    slug = url.rsplit("/", 1)[-1].lower()
    # Bars >= 10g or 1kg
    if re.search(r"(?:^|[-_])(1[-_]?kilo|500[-_]?gr?|250[-_]?gr?|100[-_]?gr?|50[-_]?gr?|20[-_]?gr?|10[-_]?gr?)(?:[-_.]|$)", slug):
        return True
    # Full 1 oz coin / bar (excluding 1/4 or 1/10 oz or 1/2)
    if re.search(r"(?:^|[-_])(1[-_]?(?:ounce|oz))(?:[-_.]|$)", slug):
        if not re.search(r"(?:1[-_]?[24]|1[-_]?10|quarter|tenth|half)", slug):
            return True
    if re.search(r"(?:^|[-_])(50x1g|maplegram25)(?:[-_.]|$)", slug):
        return True

    return False


def scrape_all(p: BrowserPool = default_pool) -> dict:
    t0 = time.time()
    prod = get_products(refresh=False, p=p)
    cached_data = read_cache()
    cached_rows = cached_data.get("rows", []) if cached_data else []

    rows_by_url: dict[str, dict] = {}
    errors: dict[str, str] = {}

    # Only scrape items under MAX_PRICE (low than 1000 EUR)
    candidate_urls = [u for u in config.PRODUCT_URLS if not is_likely_over_max_price(u, cached_rows)]
    pending = list(candidate_urls)

    if config.MODE in ("http", "auto"):
        ok, bad = run_parallel(http_task, pending, config.WORKERS)
        rows_by_url.update(ok)
        pending, errors = list(bad), bad
    if pending and config.MODE in ("browser", "auto"):
        try:
            p.ensure(min(config.WORKERS, len(pending)))
            ok, bad = run_parallel(lambda u: browser_task(u, p), pending, min(config.WORKERS, len(pending)))
            rows_by_url.update(ok)
            for u in ok:
                errors.pop(u, None)
            errors.update(bad)
        except Exception as exc:
            for u in pending:
                errors[u] = f"{errors.get(u, '')} | browser fallback unavailable: {type(exc).__name__}: {str(exc)[:100]}"

    # Get current spot for derived metrics sanity check
    current_spot = None
    try:
        from spot import get_spot
        s_info = get_spot(refresh=False, p=p)
        if s_info and s_info.get("eur_per_g"):
            current_spot = float(s_info["eur_per_g"])
    except Exception:
        pass

    rows = []
    for url in candidate_urls:
        pid = re.search(r"-(\d+)\.html", url).group(1)
        if url in rows_by_url:
            row = add_derived(rows_by_url[url], spot_per_g=current_spot)
            # Exclude products that cost MAX_PRICE or more
            if row.get("shop_sells") is not None and row["shop_sells"] >= config.MAX_PRICE:
                continue
            row["status"] = "ok"
        else:
            slug = url.rsplit("/", 1)[-1].replace(".html", "")
            row = {"name": slug, "url": url, "category": "bar" if "bar" in slug or "combi" in slug else "coin",
                   "status": "failed", "error": errors.get(url, "unknown error"), "in_stock": None}
        row["pid"] = pid
        row["has_chart"] = (CHART_DIR / f"{pid}.json").exists()
        rows.append(row)

    # Strictly retain only products lower than MAX_PRICE (1,000 EUR)
    rows = [r for r in rows if r.get("shop_sells") is None or r.get("shop_sells") < config.MAX_PRICE]

    compute_backend_deal_scores(rows)

    for r in rows:
        if r.get("has_chart"):
            r["history_stats"] = calc_historical_spread_stats(r["pid"])

    scraped_iso = datetime.now(BRUSSELS_TZ).isoformat(timespec="seconds") if BRUSSELS_TZ else datetime.now().isoformat(timespec="seconds")

    result = {
        "scraped_at": scraped_iso,
        "elapsed_s": round(time.time() - t0, 2), "mode": config.MODE, "workers": config.WORKERS,
        "max_price": config.MAX_PRICE,
        "count": len(rows), "ok": sum(r["status"] == "ok" for r in rows),
        "via": {v: sum(r.get("via") == v for r in rows) for v in ("http", "browser")},
        "products": {"count": len(candidate_urls), "source": prod.get("source"), "error": prod.get("error")},
        "rows": rows,
    }
    config.atomic_write_json(config.CACHE_FILE, result)
    return result


BULLIONBYPOST_BENCHMARKS = [
    {
        "name": "Britannia 1 oz",
        "category": "coin",
        "url": "https://www.bullionbypost.eu/gold-coins/britannia-1oz-gold-coin/",
        "match_keywords": ["britannia", "1 ounce britannia", "1 oz britannia"],
        "weight_g": 31.1035,
        "pure_g": 31.1035,
    },
    {
        "name": "Full Sovereign",
        "category": "coin",
        "url": "https://www.bullionbypost.eu/gold-coins/full-sovereign-gold-coin/",
        "match_keywords": ["sovereign", "1 sovereign", "full sovereign"],
        "weight_g": 7.988,
        "pure_g": 7.3224,
    },
    {
        "name": "1 oz Gold Bar",
        "category": "bar",
        "url": "https://www.bullionbypost.eu/gold-bars/1-ounce-gold-bar/",
        "match_keywords": ["1 ounce", "1 oz", "ounce gold ingot"],
        "weight_g": 31.1035,
        "pure_g": 31.1035,
    },
    {
        "name": "10g Gold Bar",
        "category": "bar",
        "url": "https://www.bullionbypost.eu/gold-bars/10-gram-gold-bar/",
        "match_keywords": ["10-gr", "10 gr", "10g", "10 gram"],
        "weight_g": 10.0,
        "pure_g": 10.0,
    },
    {
        "name": "5g Gold Bar",
        "category": "bar",
        "url": "https://www.bullionbypost.eu/gold-bars/5-gram-gold-bar/",
        "match_keywords": ["5-gr", "5 gr", "5g", "5 gram"],
        "weight_g": 5.0,
        "pure_g": 5.0,
    },
    {
        "name": "1g Gold Bar",
        "category": "bar",
        "url": "https://www.bullionbypost.eu/gold-bars/1-gram-gold-bar/",
        "match_keywords": ["1-gr", "1 gr", "1g", "1 gram"],
        "weight_g": 1.0,
        "pure_g": 1.0,
    },
]


def fetch_competitor_benchmarks(refresh: bool = False) -> dict:
    if not refresh and config.COMPETITORS_FILE.exists():
        try:
            cached = json.loads(config.COMPETITORS_FILE.read_text(encoding="utf-8"))
            if time.time() - cached.get("timestamp", 0) < 3600:
                return cached
        except (json.JSONDecodeError, OSError):
            pass

    cached_scrape = read_cache() or {"rows": []}
    gf_rows = [r for r in cached_scrape.get("rows", []) if r.get("status") == "ok" and r.get("shop_sells")]

    approx_spot = 113.0
    try:
        from spot import get_spot
        s_data = get_spot(False)
        if s_data and s_data.get("eur_per_g"):
            approx_spot = float(s_data["eur_per_g"])
    except Exception:
        pass

    results = []
    sess = get_session()
    for bm in BULLIONBYPOST_BENCHMARKS:
        # Match primarily on pure_g within 2% AND category (coin vs bar)
        candidates = [
            r for r in gf_rows
            if r.get("category") == bm["category"]
            and r.get("pure_g")
            and abs(r["pure_g"] - bm["pure_g"]) / bm["pure_g"] <= 0.02
        ]
        gf_match = None
        if candidates:
            def match_score(r):
                nl = r["name"].lower()
                kw_hits = sum(1 for kw in bm.get("match_keywords", []) if kw in nl)
                diff = abs(r["pure_g"] - bm["pure_g"])
                return (-kw_hits, diff)
            candidates.sort(key=match_score)
            gf_match = candidates[0]

        bbp_price = None
        try:
            resp = sess.get(bm["url"], timeout=7)
            if resp.status_code == 200:
                soup = BeautifulSoup(resp.text, "lxml")
                candidates = []
                for p_el in soup.select(".table-pricing td, .price-container .price, .main-price, span.price"):
                    txt = p_el.get_text(strip=True)
                    if "€" in txt or "EUR" in txt:
                        p_val = parse_money(txt)
                        if p_val and p_val > 10:
                            candidates.append(p_val)

                # Filter candidate prices to single item range (exclude 10-packs or 100-pack monster boxes)
                approx_metal = bm["pure_g"] * approx_spot
                valid_candidates = [p for p in candidates if 0.65 * approx_metal <= p <= 2.2 * approx_metal]
                if valid_candidates:
                    bbp_price = min(valid_candidates)
                elif candidates:
                    bbp_price = candidates[0]
        except Exception:
            pass

        gf_price = gf_match.get("shop_sells") if gf_match else None
        diff_eur = None
        diff_pct = None
        cheaper = None

        if gf_price and bbp_price:
            diff_eur = round(abs(gf_price - bbp_price), 2)
            cheaper = "goldforex" if gf_price < bbp_price else ("bullionbypost" if bbp_price < gf_price else "equal")
            base = min(gf_price, bbp_price)
            diff_pct = round((diff_eur / base) * 100, 2)

        results.append({
            "name": bm["name"],
            "category": bm["category"],
            "weight_g": bm["weight_g"],
            "pure_g": bm["pure_g"],
            "bbp_url": bm["url"],
            "bbp_price": bbp_price,
            "gf_name": gf_match.get("name") if gf_match else None,
            "gf_url": gf_match.get("url") if gf_match else None,
            "gf_price": gf_price,
            "gf_image": gf_match.get("image") if gf_match else None,
            "diff_eur": diff_eur,
            "diff_pct": diff_pct,
            "cheaper": cheaper,
        })

    data = {
        "timestamp": time.time(),
        "fetched_at": datetime.now(BRUSSELS_TZ).isoformat(timespec="seconds") if BRUSSELS_TZ else datetime.now().isoformat(timespec="seconds"),
        "benchmarks": results,
    }
    config.atomic_write_json(config.COMPETITORS_FILE, data)
    return data


