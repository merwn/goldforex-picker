"""
Live gold spot price scraper and multi-tier fallbacks:
1. bullionbypost.eu (plain HTTP)
2. Yahoo Finance live futures (GC=F) & EUR/USD rate (EURUSD=X)
3. bullionbypost.eu via Selenium Chrome
4. GoldForex shop implied median spot benchmark from cache
"""
from __future__ import annotations

import json
import re
import threading
import time
from datetime import datetime

from bs4 import BeautifulSoup

from browser import BrowserPool, pool as default_pool
import config
from config import (
    YAHOO_FX_URL,
    YAHOO_GOLD_URL,
    ParseError,
    get_session,
)


def parse_money(raw: str) -> float | None:
    """'1 116,00 EUR' / '3.827,47' / '1200.00' -> float"""
    s = re.sub(r"[^\d,.\s\u00a0]", "", raw).replace("\u00a0", "").replace(" ", "")
    if not s:
        return None
    if "," in s and "." in s:
        dec = "," if s.rfind(",") > s.rfind(".") else "."
        s = s.replace("." if dec == "," else ",", "").replace(dec, ".")
    elif "," in s:
        head, _, tail = s.rpartition(",")
        s = f"{head.replace(',', '')}.{tail}" if len(tail) <= 2 else s.replace(",", "")
    elif "." in s:
        head, _, tail = s.rpartition(".")
        if len(tail) == 3 and head:
            s = s.replace(".", "")
    try:
        return float(s)
    except ValueError:
        return None


def parse_spot(html: str) -> dict | None:
    """Extract EUR per gram from bullionbypost page text."""
    text = BeautifulSoup(html, "lxml").get_text(" ", strip=True)
    m = re.search(r"Current Price\s*([\d][\d\s.,\u00a0]*?)\s*(?:\u20ac|EUR)", text, re.I)
    val = parse_money(m.group(1)) if m else None
    if not val or not (5 < val < 2000):
        return None
    out = {"eur_per_g": val}
    for key, label in (("week_high", "Week high"), ("week_low", "Week low")):
        mm = re.search(label + r"\s*([\d][\d\s.,\u00a0]*?)\s*(?:\u20ac|EUR)", text, re.I)
        out[key] = parse_money(mm.group(1)) if mm else None
    return out


def fetch_yahoo_spot() -> dict | None:
    """Fast fallback market gold spot from Yahoo Finance GC=F (futures) and EURUSD=X rate."""
    try:
        s = get_session()
        r1 = s.get(YAHOO_GOLD_URL, timeout=8)
        d1 = r1.json()["chart"]["result"][0]["meta"]
        gold_usd = d1.get("regularMarketPrice")

        r2 = s.get(YAHOO_FX_URL, timeout=8)
        d2 = r2.json()["chart"]["result"][0]["meta"]
        eurusd = d2.get("regularMarketPrice")

        if gold_usd and eurusd and (100 < gold_usd < 20000) and (0.3 < eurusd < 3.0):
            eur_per_g = round((gold_usd / eurusd) / 31.1034768, 2)
            hi_usd = d1.get("regularMarketDayHigh")
            lo_usd = d1.get("regularMarketDayLow")
            return {
                "eur_per_g": eur_per_g,
                "week_high": round((hi_usd / eurusd) / 31.1034768, 2) if hi_usd else None,
                "week_low": round((lo_usd / eurusd) / 31.1034768, 2) if lo_usd else None,
                "source": "Yahoo Finance (GC=F)",
                "url": "https://finance.yahoo.com/quote/GC=F",
                "via": "http",
            }
    except Exception:
        pass
    return None


def fetch_spot(p: BrowserPool = default_pool) -> dict:
    last: Exception | None = None
    # 1) Try bullionbypost via plain HTTP
    try:
        r = get_session().get(config.SPOT_URL, timeout=config.HTTP_TIMEOUT)
        r.raise_for_status()
        d = parse_spot(r.text)
        if d:
            d["via"] = "http"
            d["source"] = "bullionbypost.eu"
            d["url"] = config.SPOT_URL
            return d
        last = ParseError("price not found in the bullionbypost page")
    except Exception as exc:
        last = exc

    # 2) Fallback to Yahoo Finance live market data
    y_spot = fetch_yahoo_spot()
    if y_spot:
        return y_spot

    # 3) Chrome fallback for bullionbypost
    try:
        from selenium.webdriver.support.ui import WebDriverWait
        p.ensure(1)
        with p.borrow() as drv:
            drv.get(config.SPOT_URL)
            WebDriverWait(drv, 10, poll_frequency=0.4).until(lambda d: parse_spot(d.page_source) is not None)
            d = parse_spot(drv.page_source)
        if d:
            d["via"] = "browser"
            d["source"] = "bullionbypost.eu (browser)"
            d["url"] = config.SPOT_URL
            return d
    except Exception as exc:
        last = exc

    # 4) Fallback to shop implied spot from last scrape cache
    try:
        if config.CACHE_FILE.exists():
            cached = json.loads(config.CACHE_FILE.read_text(encoding="utf-8"))
            if cached and cached.get("rows"):
                meds = [r.get("implied_spot_per_g") for r in cached["rows"] if r.get("implied_spot_per_g")]
                if meds:
                    meds.sort()
                    med_val = meds[len(meds) // 2]
                    return {
                        "eur_per_g": med_val,
                        "source": "GoldForex benchmark (implied)",
                        "url": "https://www.goldforex.be",
                        "via": "cache",
                    }
    except Exception:
        pass

    raise ParseError(f"gold price not found ({last})")


_spot_cache: dict = {}
_spot_lock = threading.Lock()


def get_spot(refresh: bool = False, p: BrowserPool = default_pool) -> dict:
    with _spot_lock:
        c = _spot_cache.get("v")
        if c and not refresh and time.time() - c["_t"] < config.SPOT_TTL:
            return c["data"]
        data = fetch_spot(p)
        if "source" not in data:
            data["source"] = "bullionbypost.eu"
        if "url" not in data:
            data["url"] = config.SPOT_URL
        data["fetched_at"] = datetime.now().isoformat(timespec="seconds")
        _spot_cache["v"] = {"_t": time.time(), "data": data}
        return data

