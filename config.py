"""
Configuration, constants, file paths, and settings for the GoldForex application.
"""
from __future__ import annotations

import json
from pathlib import Path
from urllib.parse import quote
import re
import threading

try:
    from curl_cffi import requests as cffi_requests
except ImportError:
    cffi_requests = None

# --------------------------------------------------------------------------- Paths
BASE_DIR = Path(__file__).resolve().parent
CACHE_DIR = BASE_DIR / "cache"
IMG_DIR = CACHE_DIR / "img"
CHART_DIR = CACHE_DIR / "charts"
DEBUG_DIR = BASE_DIR / "debug"
TEMPLATES_DIR = BASE_DIR / "templates"
STATIC_DIR = BASE_DIR / "static"

CACHE_FILE = BASE_DIR / "last_scrape.json"
PRODUCTS_FILE = CACHE_DIR / "products.json"
SETTINGS_FILE = CACHE_DIR / "settings.json"
COMPETITORS_FILE = CACHE_DIR / "competitors.json"

LWC_VERSION = "4.2.0"
LWC_URL = f"https://cdn.jsdelivr.net/npm/lightweight-charts@{LWC_VERSION}/dist/lightweight-charts.standalone.production.js"
LWC_FILE = CACHE_DIR / f"lightweight-charts-{LWC_VERSION}.js"

# --------------------------------------------------------------------------- Site URLs
G = "https://www.goldforex.be/en/"
LISTING_URL = "https://www.goldforex.be/en/buy-gold"
LISTING_FILTER = "type_of_metals-gold"
LISTING_PAGES = 7

PRODUCT_URLS = [
    G + "the-numismatic-corner/1-2-napoleon-or-617.html",
    G + "the-numismatic-corner/1-2-napoleon-or-265.html",
    G + "gold-rates-price-live-coins-ingots/20-fr-franc-napoleon-france-229.html",
    G + "gold-rates-price-live-coins-ingots/1-gr-gold-bar-216.html",
    G + "gold-rates-price-live-coins-ingots/2-gr-gold-bar-duo-598.html",
    G + "gold-rates-price-live-coins-ingots/5-gr-gold-bar-215.html",
    G + "gold-rates-price-live-coins-ingots/10-gr-gold-bar-214.html",
    G + "gold-rates-price-live-coins-ingots/combi-gfi-10-x-1g-616.html",
    G + "the-numismatic-corner/maplegram25-242.html",
    G + "gold-rates-price-live-coins-ingots/combibar-valcambi-50x1g-217.html",
]

FALLBACK_URLS = list(PRODUCT_URLS)
PID_URL = {re.search(r"-(\d+)\.html", u).group(1): u for u in PRODUCT_URLS}

SPOT_URL = "https://www.bullionbypost.eu/gold-price/gold-price-per-gram/"
YAHOO_GOLD_URL = "https://query1.finance.yahoo.com/v8/finance/chart/GC=F"
YAHOO_FX_URL = "https://query1.finance.yahoo.com/v8/finance/chart/EURUSD=X"

# --------------------------------------------------------------------------- Operational parameters
MAX_PRICE = 1000.0         # Only scrape and show coins and bars under 1,000 EUR
MODE = "auto"              # auto | http | browser (how prices are scraped)
WORKERS = 5
HEADLESS = True            # Silent browsing: Chrome windows are hidden
USE_UC = False
HTTP_TIMEOUT = 20
HTTP_RETRIES = 2
BROWSER_TIMEOUT = 20       # Seconds to wait for price element in browser
CHART_TIMEOUT = 30         # Seconds to wait for Highcharts data
CACHE_TTL = 60             # Seconds cached price scrape is reused
CHART_TTL = 6 * 3600       # Seconds cached chart history is reused
PRODUCTS_TTL = 12 * 3600   # Seconds before product list is re-read from site
SPOT_TTL = 60              # Seconds cached spot price is reused

PRICE_SELECTOR = '[data-refresh-property="sell_price"]'

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}

# --------------------------------------------------------------------------- Country detection & flag hints
COUNTRY_HINTS = [
    ("krugerrand", "South Africa", "https://www.goldforex.be/img/co/icons/973.jpg"),
    ("maple leaf", "Canada", "https://www.goldforex.be/img/co/icons/352.jpg"),
    ("maplegram", "Canada", "https://www.goldforex.be/img/co/icons/352.jpg"),
    ("eagle", "USA", "https://www.goldforex.be/img/co/icons/356.jpg"),
    ("buffalo", "USA", "https://www.goldforex.be/img/co/icons/356.jpg"),
    ("dollar", "USA", "https://www.goldforex.be/img/co/icons/356.jpg"),
    ("liberty", "USA", "https://www.goldforex.be/img/co/icons/356.jpg"),
    ("indian", "USA", "https://www.goldforex.be/img/co/icons/356.jpg"),
    ("phillar", "Austria", "https://www.goldforex.be/img/co/icons/359.jpg"),
    ("panda", "China", "https://www.goldforex.be/img/co/icons/360.jpg"),
    ("deutsche mark", "Germany", "https://www.goldforex.be/img/co/icons/4068.jpg"),
    ("napoleon", "France", "https://www.goldforex.be/img/co/icons/34.jpg"),
    ("coq", "France", "https://www.goldforex.be/img/co/icons/34.jpg"),
    ("marianne", "France", "https://www.goldforex.be/img/co/icons/34.jpg"),
    ("pesos", "Mexique", "https://www.goldforex.be/img/co/icons/374.jpg"),
    ("lire", "Italia", "https://www.goldforex.be/img/co/icons/2109.jpg"),
    ("swiss", "Suisse", "https://www.goldforex.be/img/co/icons/376.jpg"),
    ("vreneli", "Suisse", "https://www.goldforex.be/img/co/icons/376.jpg"),
    ("valcambi", "Suisse", "https://www.goldforex.be/img/co/icons/376.jpg"),
    ("vera valor", "Suisse", "https://www.goldforex.be/img/co/icons/376.jpg"),
    ("sovereign", "United Kingdom", "https://www.goldforex.be/img/co/icons/364.jpg"),
    ("pond", "United Kingdom", "https://www.goldforex.be/img/co/icons/364.jpg"),
    ("britannia", "United Kingdom", "https://www.goldforex.be/img/co/icons/364.jpg"),
    ("tientje", "Pays-Bas", "https://www.goldforex.be/img/co/icons/378.jpg"),
    ("gulden", "Pays-Bas", "https://www.goldforex.be/img/co/icons/378.jpg"),
    ("crown", "Austria", "https://www.goldforex.be/img/co/icons/359.jpg"),
    ("dukat", "Austria", "https://www.goldforex.be/img/co/icons/359.jpg"),
    ("ducat", "Austria", "https://www.goldforex.be/img/co/icons/359.jpg"),
    ("kangaroo", "Australia", "https://www.goldforex.be/img/co/icons/358.jpg"),
    ("nugget", "Australia", "https://www.goldforex.be/img/co/icons/358.jpg"),
    ("leopold", "Belgium", "https://www.goldforex.be/img/co/icons/382.jpg"),
    ("ingot", "LBMA", "https://www.goldforex.be/img/co/icons/1563.jpg"),
    ("bullion", "LBMA", "https://www.goldforex.be/img/co/icons/1563.jpg"),
    ("bar", "LBMA", "https://www.goldforex.be/img/co/icons/1563.jpg"),
]


# --------------------------------------------------------------------------- Custom Exceptions
class ParseError(Exception):
    """Page loaded but expected block is missing (usually a bot-check / challenge page)."""


class BlockedError(Exception):
    """HTTP status indicates request was blocked (403 / 429 / 503)."""


# --------------------------------------------------------------------------- Helpers
_local = threading.local()


def get_session():
    """Return a thread-local HTTP session (curl_cffi impersonating Chrome if available, else requests)."""
    if not hasattr(_local, "s"):
        if cffi_requests:
            _local.s = cffi_requests.Session(impersonate="chrome")
        else:
            import requests
            _local.s = requests.Session()
            _local.s.headers.update(HEADERS)
    return _local.s


def proxied(url: str | None) -> str | None:
    return f"/api/img?u={quote(url, safe='')}" if url else None


def load_settings():
    global HEADLESS
    try:
        HEADLESS = bool(json.loads(SETTINGS_FILE.read_text(encoding="utf-8")).get("silent", True))
    except Exception:
        pass


def save_settings():
    try:
        SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
        SETTINGS_FILE.write_text(json.dumps({"silent": HEADLESS}), encoding="utf-8")
    except Exception:
        pass


def set_products(urls: list[str]):
    PRODUCT_URLS[:] = urls
    PID_URL.clear()
    PID_URL.update({re.search(r"-(\d+)\.html", u).group(1): u for u in urls})
