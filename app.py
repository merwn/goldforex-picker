"""
FastAPI application setup, static files mounting, and API route handlers.
"""
from __future__ import annotations

import csv
import hashlib
import io
import mimetypes
from pathlib import Path
import threading
import time
from urllib.parse import urlparse

import requests
from fastapi import FastAPI, Request, Response
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

import config
from browser import get_chart, pool
from scraper import (
    calc_historical_spread_stats,
    fetch_competitor_benchmarks,
    get_products,
    make_transparent_png,
    read_cache,
    run_parallel,
    scrape_all,
)
from spot import get_spot

app = FastAPI(title="GoldForex picker")
app.mount("/static", StaticFiles(directory=str(config.STATIC_DIR)), name="static")

_lock = threading.Lock()
_last_scrape_time = 0.0


def _prepare_cached_rows(cached: dict) -> dict:
    cached_rows = [r for r in cached.get("rows", []) if r.get("shop_sells") is None or r.get("shop_sells") < config.MAX_PRICE]
    cached["rows"] = cached_rows
    cached["count"] = len(cached_rows)
    for r in cached["rows"]:
        r["has_chart"] = (config.CHART_DIR / f"{r['pid']}.json").exists()
        if r["has_chart"]:
            r["history_stats"] = calc_historical_spread_stats(r["pid"])
    return cached


@app.get("/")
def index():
    return FileResponse(config.TEMPLATES_DIR / "index.html")


@app.get("/api/prices")
def api_prices(refresh: int = 0):
    global _last_scrape_time
    with _lock:
        cached = read_cache()
        now = time.time()
        is_fresh = cached and (now - config.CACHE_FILE.stat().st_mtime < config.CACHE_TTL)

        if not refresh and is_fresh:
            return JSONResponse(_prepare_cached_rows(cached))

        # Enforce minimum 5 minutes (300s) between forced full scrapes
        if refresh and cached and (now - _last_scrape_time < 300):
            res = _prepare_cached_rows(cached)
            res["rate_limited"] = True
            return JSONResponse(res)

        try:
            data = scrape_all(pool)
            _last_scrape_time = now
            return JSONResponse(data)
        except Exception as exc:
            err_msg = f"{type(exc).__name__}: {str(exc)[:200]}"
            if cached:
                res = _prepare_cached_rows(cached)
                res["stale"] = True
                res["error"] = err_msg
                return JSONResponse(res, status_code=502)
            return JSONResponse({"error": err_msg}, status_code=502)


@app.get("/manifest.json")
def manifest():
    return FileResponse(config.STATIC_DIR / "manifest.json", media_type="application/manifest+json")


@app.get("/sw.js")
def service_worker():
    return FileResponse(config.STATIC_DIR / "sw.js", media_type="application/javascript",
                        headers={"Service-Worker-Allowed": "/"})


@app.get("/api/competitor")
def api_competitor(refresh: int = 0):
    """Live comparison with BullionByPost benchmark bullion prices."""
    try:
        return JSONResponse(fetch_competitor_benchmarks(bool(refresh)))
    except Exception as exc:
        return JSONResponse({"error": f"{type(exc).__name__}: {str(exc)[:200]}"}, status_code=502)


@app.get("/api/chart/{pid}")
def api_chart(pid: str, refresh: int = 0):
    try:
        return JSONResponse(get_chart(pid, bool(refresh), pool))
    except KeyError:
        return JSONResponse({"error": "unknown product"}, status_code=404)
    except ImportError:
        return JSONResponse({"error": "Selenium is not installed: pip install selenium"}, status_code=500)
    except Exception as exc:
        return JSONResponse({"error": f"{type(exc).__name__}: {str(exc)[:200]}"}, status_code=502)


@app.get("/api/settings")
def api_settings_get():
    """Read current Silent browsing setting."""
    return {"silent": config.HEADLESS}


@app.post("/api/settings")
async def api_settings_post(request: Request, silent: int = -1):
    """Change the Silent browsing setting; open Chrome windows are closed so it applies at once."""
    val = silent
    if val not in (0, 1):
        try:
            body = await request.json()
            if "silent" in body:
                val = 1 if body["silent"] else 0
        except Exception:
            pass

    if val in (0, 1):
        target = bool(val)
        changed = target != config.HEADLESS
        config.HEADLESS = target
        config.save_settings()
        if changed:
            pool.reset()
    return {"silent": config.HEADLESS}


@app.get("/api/products")
def api_products(refresh: int = 0):
    """The product URLs read from the buy-gold listing (refresh=1 re-reads all pages with Chrome)."""
    with _lock:
        try:
            return JSONResponse(get_products(bool(refresh), pool))
        except ImportError:
            return JSONResponse({"error": "Selenium is not installed: pip install selenium", "urls": config.PRODUCT_URLS}, status_code=500)


@app.get("/api/spot")
def api_spot(refresh: int = 0):
    """Live gold price per gram (EUR) from bullionbypost.eu with fallbacks."""
    try:
        return JSONResponse(get_spot(bool(refresh), pool))
    except ImportError:
        return JSONResponse({"error": "Selenium is not installed: pip install selenium"}, status_code=500)
    except Exception as exc:
        return JSONResponse({"error": f"{type(exc).__name__}: {str(exc)[:200]}"}, status_code=502)


@app.post("/api/charts/refresh")
def api_charts_refresh():
    """Load every product's history in parallel (one Chrome window per worker)."""
    try:
        pool.ensure(min(config.WORKERS, len(config.PID_URL)))
    except Exception as exc:
        return JSONResponse({"error": f"{type(exc).__name__}: {str(exc)[:200]}"}, status_code=500)
    ok, bad = run_parallel(lambda p: get_chart(p, False, pool), list(config.PID_URL), min(config.WORKERS, len(config.PID_URL)))
    return {"ok": sorted(ok), "failed": bad}


@app.get("/api/img")
def api_img(u: str, v: str = ""):
    """Image proxy + disk cache with automatic transparency for white-bg coin & bar images."""
    host = (urlparse(u).hostname or "").lower()
    if not (host == "goldforex.be" or host.endswith(".goldforex.be")):
        return PlainTextResponse("host not allowed", status_code=400)
    config.IMG_DIR.mkdir(parents=True, exist_ok=True)
    ext = Path(urlparse(u).path).suffix or ".jpg"
    stem = hashlib.sha1(u.encode()).hexdigest()
    path = config.IMG_DIR / (stem + ext)
    nobg_path = config.IMG_DIR / (stem + "_nobg.png")

    # Don't strip background from flags / icons (keep original flag colors/stripes)
    is_icon = "/co/icons/" in u or "/co/" in u

    if not path.exists():
        try:
            r = config.get_session().get(u, timeout=config.HTTP_TIMEOUT, headers={"Referer": config.G})
            r.raise_for_status()
            path.write_bytes(r.content)
        except Exception as exc:
            return PlainTextResponse(f"image fetch failed: {exc}", status_code=502)

    if not is_icon:
        if nobg_path.exists():
            return FileResponse(nobg_path, media_type="image/png",
                                headers={"Cache-Control": "public, max-age=86400"})
        if make_transparent_png(path, nobg_path):
            return FileResponse(nobg_path, media_type="image/png",
                                headers={"Cache-Control": "public, max-age=86400"})

    return FileResponse(path, media_type=mimetypes.guess_type(path.name)[0] or "image/jpeg",
                        headers={"Cache-Control": "public, max-age=86400"})


@app.get("/lwc.js")
def lwc_js():
    """TradingView Lightweight Charts - downloaded once, then served locally (CDN redirect as fallback)."""
    if not config.LWC_FILE.exists():
        try:
            r = requests.get(config.LWC_URL, timeout=20)
            r.raise_for_status()
            config.LWC_FILE.parent.mkdir(parents=True, exist_ok=True)
            config.LWC_FILE.write_bytes(r.content)
        except Exception:
            return RedirectResponse(config.LWC_URL)
    return FileResponse(config.LWC_FILE, media_type="application/javascript")


@app.get("/api/export.csv")
def api_csv(locale: str = "us"):
    data = read_cache() or {"rows": []}
    cols = [
        "name", "category", "in_stock", "weight_g", "purity_pct", "karat", "country", "pure_g", "shop_sells", "shop_buys",
        "spread_pct", "loss_eur", "deal_score", "breakeven_pct", "breakeven_spot_per_g", "melt_spot_per_g", "is_collector",
        "premium_pay_pct", "premium_receive_pct",
        "sell_per_pure_g", "buy_per_pure_g", "implied_spot_per_g", "quote_time", "status", "url",
    ]
    is_eu = locale.lower() == "eu"
    delimiter = ";" if is_eu else ","
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=cols, extrasaction="ignore", delimiter=delimiter)
    w.writeheader()
    rows = data.get("rows", [])
    if is_eu:
        formatted_rows = []
        for r in rows:
            new_r = {}
            for k in cols:
                v = r.get(k, "")
                if isinstance(v, float):
                    new_r[k] = str(v).replace(".", ",")
                else:
                    new_r[k] = "" if v is None else v
            formatted_rows.append(new_r)
        w.writerows(formatted_rows)
    else:
        formatted_rows = []
        for r in rows:
            formatted_rows.append({k: ("" if r.get(k) is None else r.get(k)) for k in cols})
        w.writerows(formatted_rows)
    csv_bytes = buf.getvalue().encode("utf-8-sig")
    return Response(content=csv_bytes, media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": "attachment; filename=goldforex.csv"})

