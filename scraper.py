"""
Product page scrapers, parsing, derived investment metrics, and transparency floodfill.
"""
from __future__ import annotations

import json
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from urllib.parse import urljoin

from bs4 import BeautifulSoup

from browser import BrowserPool, discover_urls, pool as default_pool
from config import (
    BROWSER_TIMEOUT,
    CACHE_FILE,
    CHART_DIR,
    COMPETITORS_FILE,
    COUNTRY_HINTS,
    FALLBACK_URLS,
    HTTP_RETRIES,
    HTTP_TIMEOUT,
    LISTING_FILTER,
    MAX_PRICE,
    MODE,
    PRICE_SELECTOR,
    PRODUCT_URLS,
    PRODUCTS_FILE,
    PRODUCTS_TTL,
    WORKERS,
    BlockedError,
    ParseError,
    get_session,
    proxied,
    set_products,
)
from spot import parse_money


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

    feats = {}
    for li in soup.select("#tab-features li"):
        lab, val = li.find("label"), li.select_one(".fvalue")
        if lab and val:
            feats[lab.get_text(strip=True).lower()] = val.get_text(" ", strip=True)
    w1, w2 = first_number(feats.get("net weight", "")), first_number(feats.get("gross weight", ""))
    weights = [w for w in (w1, w2) if w]
    purity = first_number(feats.get("purity", ""))
    purity_pct = (purity / 10 if purity and purity > 100 else purity)
    weight_g = max(weights) if weights else None
    pure_g = min(weights) if weights else None
    if weight_g and purity_pct:
        pure_g = weight_g * purity_pct / 100

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
    h1 = soup.select_one("h1[itemprop=name] span") or soup.select_one("h1")
    name = h1.get_text(strip=True) if h1 else url.rsplit("/", 1)[-1]
    ptype = feats.get("type of products", "").strip().lower()
    img, img_full = parse_images(soup)

    if not country:
        low = name.lower()
        for k, c, f in COUNTRY_HINTS:
            if k in low:
                country = c
                if not flag and f:
                    flag = f
                break

    return {
        "name": name,
        "category": ptype if ptype in ("bar", "coin") else ("bar" if "bar" in url else "coin"),
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
        "quote_time": f"{m.group(1)} {m.group(2)}" if m else None,
    }


def add_derived(row: dict) -> dict:
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


def compute_backend_deal_scores(rows: list[dict]):
    """Calculate default composite deal score (0-100) combining loss %, spot premium % and pure gram cost."""
    valid = [r for r in rows if r.get("status") == "ok" and r.get("spread_pct") is not None and r.get("sell_per_pure_g") is not None]
    if not valid:
        return
    min_loss, max_loss = min(r["spread_pct"] for r in valid), max(r["spread_pct"] for r in valid)
    prems = [r["premium_pay_pct"] for r in valid if r.get("premium_pay_pct") is not None]
    min_prem, max_prem = (min(prems), max(prems)) if prems else (0.0, 100.0)
    pures = [r["sell_per_pure_g"] for r in valid if r.get("sell_per_pure_g") is not None]
    min_pure, max_pure = (min(pures), max(pures)) if pures else (0.0, 100.0)

    for r in rows:
        if r.get("status") != "ok" or r.get("spread_pct") is None:
            r["deal_score"] = None
            continue
        s_loss = 1.0 if max_loss == min_loss else 1.0 - (r["spread_pct"] - min_loss) / max(0.001, max_loss - min_loss)
        prem = r.get("premium_pay_pct") if r.get("premium_pay_pct") is not None else max_prem
        s_prem = 1.0 if max_prem == min_prem else 1.0 - (prem - min_prem) / max(0.001, max_prem - min_prem)
        pure = r.get("sell_per_pure_g") if r.get("sell_per_pure_g") is not None else max_pure
        s_pure = 1.0 if max_pure == min_pure else 1.0 - (pure - min_pure) / max(0.001, max_pure - min_pure)

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


def get_products(refresh: bool = False, p: BrowserPool = default_pool) -> dict:
    cached = None
    if PRODUCTS_FILE.exists():
        try:
            cached = json.loads(PRODUCTS_FILE.read_text(encoding="utf-8"))
        except Exception:
            cached = None
    fresh = cached and time.time() - PRODUCTS_FILE.stat().st_mtime < PRODUCTS_TTL
    if cached and (fresh and not refresh):
        set_products(cached["urls"])
        return {**cached, "source": "cache"}
    try:
        urls = discover_urls(p)
        data = {"urls": urls, "filter": LISTING_FILTER, "fetched_at": datetime.now().isoformat(timespec="seconds")}
        PRODUCTS_FILE.parent.mkdir(parents=True, exist_ok=True)
        PRODUCTS_FILE.write_text(json.dumps(data), encoding="utf-8")
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
    return json.loads(CACHE_FILE.read_text(encoding="utf-8")) if CACHE_FILE.exists() else None


def is_likely_over_max_price(url: str, cached_rows: list[dict] | None = None) -> bool:
    """Identify bullion products guaranteed to exceed MAX_PRICE (e.g. 10g-1kg bars, 1 oz coins)."""
    low = url.lower()
    # Bullion keywords that are well over 1000 EUR at current market rates (~113 €/g)
    over_patterns = [
        "1-kilo", "500-gr", "250-gr", "100-gr", "50-gr", "20-gr", "10-gr",
        "1-ounce", "1-oz", "50x1g", "maplegram25", "10-x-1g"
    ]
    if any(p in low for p in over_patterns):
        # Exclude fractional coins like 1/4 or 1/10 oz
        if not any(frac in low for frac in ["1-4", "1-10", "quarter", "tenth", "1/4", "1/10"]):
            return True
    if cached_rows:
        for r in cached_rows:
            if r.get("url") == url and r.get("shop_sells") and r["shop_sells"] >= MAX_PRICE:
                return True
    return False


def scrape_all(p: BrowserPool = default_pool) -> dict:
    t0 = time.time()
    prod = get_products(p=p)
    cached_data = read_cache()
    cached_rows = cached_data.get("rows", []) if cached_data else []

    rows_by_url: dict[str, dict] = {}
    errors: dict[str, str] = {}

    # Only scrape items under MAX_PRICE (low than 1000 EUR)
    candidate_urls = [u for u in PRODUCT_URLS if not is_likely_over_max_price(u, cached_rows)]
    pending = list(candidate_urls)

    if MODE in ("http", "auto"):
        ok, bad = run_parallel(http_task, pending, WORKERS)
        rows_by_url.update(ok)
        pending, errors = list(bad), bad
    if pending and MODE in ("browser", "auto"):
        try:
            p.ensure(min(WORKERS, len(pending)))
            ok, bad = run_parallel(lambda u: browser_task(u, p), pending, min(WORKERS, len(pending)))
            rows_by_url.update(ok)
            for u in ok:
                errors.pop(u, None)
            errors.update(bad)
        except Exception as exc:
            for u in pending:
                errors[u] = f"{errors.get(u, '')} | browser fallback unavailable: {type(exc).__name__}: {str(exc)[:100]}"

    rows = []
    for url in candidate_urls:
        pid = re.search(r"-(\d+)\.html", url).group(1)
        if url in rows_by_url:
            row = add_derived(rows_by_url[url])
            # Exclude products that cost MAX_PRICE or more
            if row.get("shop_sells") is not None and row["shop_sells"] >= MAX_PRICE:
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
    rows = [r for r in rows if r.get("shop_sells") is None or r.get("shop_sells") < MAX_PRICE]

    compute_backend_deal_scores(rows)

    for r in rows:
        if r.get("has_chart"):
            r["history_stats"] = calc_historical_spread_stats(r["pid"])

    result = {
        "scraped_at": datetime.now().isoformat(timespec="seconds"),
        "elapsed_s": round(time.time() - t0, 2), "mode": MODE, "workers": WORKERS,
        "max_price": MAX_PRICE,
        "count": len(rows), "ok": sum(r["status"] == "ok" for r in rows),
        "via": {v: sum(r.get("via") == v for r in rows) for v in ("http", "browser")},
        "products": {"count": len(candidate_urls), "source": prod.get("source"), "error": prod.get("error")},
        "rows": rows,
    }
    CACHE_FILE.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
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
        "match_keywords": ["sovereign", "1 sovereign"],
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
    if not refresh and COMPETITORS_FILE.exists():
        try:
            cached = json.loads(COMPETITORS_FILE.read_text(encoding="utf-8"))
            if time.time() - cached.get("timestamp", 0) < 3600:
                return cached
        except Exception:
            pass

    cached_scrape = read_cache() or {"rows": []}
    gf_rows = [r for r in cached_scrape.get("rows", []) if r.get("status") == "ok" and r.get("shop_sells")]

    results = []
    sess = get_session()
    for bm in BULLIONBYPOST_BENCHMARKS:
        gf_match = None
        for r in gf_rows:
            name_low = r["name"].lower()
            if any(k in name_low for k in bm["match_keywords"]):
                if bm["category"] == r.get("category"):
                    gf_match = r
                    break
        if not gf_match:
            for r in gf_rows:
                if bm["category"] == r.get("category") and r.get("pure_g") and abs(r["pure_g"] - bm["pure_g"]) < 0.2:
                    gf_match = r
                    break

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
                approx_spot = 113.0
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
        "fetched_at": datetime.now().isoformat(timespec="seconds"),
        "benchmarks": results,
    }
    COMPETITORS_FILE.parent.mkdir(parents=True, exist_ok=True)
    COMPETITORS_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")
    return data


