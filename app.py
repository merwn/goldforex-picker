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
from fastapi import FastAPI
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


@app.get("/")
def index():
    return FileResponse(config.TEMPLATES_DIR / "index.html")


@app.get("/api/prices")
def api_prices(refresh: int = 0):
    with _lock:
        cached = read_cache()
        if not refresh and cached and time.time() - config.CACHE_FILE.stat().st_mtime < config.CACHE_TTL:
            cached_rows = [r for r in cached.get("rows", []) if r.get("shop_sells") is None or r.get("shop_sells") < config.MAX_PRICE]
            cached["rows"] = cached_rows
            cached["count"] = len(cached_rows)
            for r in cached["rows"]:
                r["has_chart"] = (config.CHART_DIR / f"{r['pid']}.json").exists()
                if r["has_chart"]:
                    r["history_stats"] = calc_historical_spread_stats(r["pid"])
            return JSONResponse(cached)
        return JSONResponse(scrape_all(pool))


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
def api_settings(silent: int = -1):
    """Read (no argument) or change (?silent=1/0) the Silent browsing setting; open Chrome windows are closed so it applies at once."""
    if silent in (0, 1):
        changed = bool(silent) != config.HEADLESS
        config.HEADLESS = bool(silent)
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


@app.get("/api/charts/refresh")
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
def api_csv():
    data = read_cache() or {"rows": []}
    cols = [
        "name", "category", "in_stock", "weight_g", "purity_pct", "karat", "country", "pure_g", "shop_sells", "shop_buys",
        "spread_pct", "loss_eur", "deal_score", "breakeven_pct", "breakeven_spot_per_g", "melt_spot_per_g", "is_collector",
        "premium_pay_pct", "premium_receive_pct",
        "sell_per_pure_g", "buy_per_pure_g", "implied_spot_per_g", "quote_time", "status", "url",
    ]
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=cols, extrasaction="ignore")
    w.writeheader()
    w.writerows(data.get("rows", []))
    return PlainTextResponse(buf.getvalue(), media_type="text/csv",
                             headers={"Content-Disposition": "attachment; filename=goldforex.csv"})

