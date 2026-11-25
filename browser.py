"""
Chrome / Selenium automation, driver pool management, Highcharts scrapers, and listing discovery.
"""
from __future__ import annotations

import atexit
import json
import queue
import re
import threading
import time
from contextlib import contextmanager
from datetime import datetime

from bs4 import BeautifulSoup

import config
from config import (
    CHART_DIR,
    CHART_TIMEOUT,
    CHART_TTL,
    LISTING_PAGES,
    LISTING_URL,
    PID_URL,
    BlockedError,
    ParseError,
)

# --------------------------------------------------------------------------- Browser Pool
class BrowserPool:
    """N Chrome windows kept open between scrapes; worker threads borrow one at a time."""

    def __init__(self):
        self.q: queue.Queue = queue.Queue()
        self.all: list = []
        self._create_lock = threading.Lock()
        self.gen = 0

    def _make(self):
        if config.USE_UC:
            import undetected_chromedriver as uc
            opts = uc.ChromeOptions()
            if config.HEADLESS:
                opts.add_argument("--headless=new")
            opts.page_load_strategy = "eager"
            drv = uc.Chrome(options=opts)
        else:
            from selenium import webdriver
            opts = webdriver.ChromeOptions()
            if config.HEADLESS:
                opts.add_argument("--headless=new")
            opts.page_load_strategy = "eager"
            for a in ("--window-size=1280,900", "--lang=en-US", "--disable-blink-features=AutomationControlled"):
                opts.add_argument(a)
            opts.add_experimental_option("excludeSwitches", ["enable-automation"])
            opts.add_experimental_option("useAutomationExtension", False)
            opts.add_experimental_option("prefs", {"profile.managed_default_content_settings.images": 2})
            drv = webdriver.Chrome(options=opts)

        # Set timeouts on the driver to prevent hung page loads
        try:
            drv.set_page_load_timeout(30)
            drv.set_script_timeout(30)
        except Exception:
            pass

        try:
            drv.execute_cdp_cmd("Network.enable", {})
            drv.execute_cdp_cmd("Network.setBlockedURLs", {"urls": [
                "*.png", "*.jpg", "*.jpeg", "*.gif", "*.webp", "*.woff", "*.woff2", "*.ttf",
                "*.mp4", "*google-analytics*", "*googletagmanager*", "*doubleclick*", "*facebook*", "*hotjar*"]})
        except Exception:
            pass
        if config.HEADLESS:
            try:
                ua = drv.execute_cdp_cmd("Browser.getVersion", {})["userAgent"].replace("HeadlessChrome", "Chrome")
                drv.execute_cdp_cmd("Network.setUserAgentOverride", {"userAgent": ua})
            except Exception:
                pass
        drv._gen = self.gen
        return drv

    def reset(self):
        """Close every idle Chrome window; new ones start on demand."""
        with self._create_lock:
            self.gen += 1
            while True:
                try:
                    d = self.q.get_nowait()
                except queue.Empty:
                    break
                try:
                    d.quit()
                except Exception:
                    pass
            self.all.clear()

    def ensure(self, n: int):
        with self._create_lock:
            while len(self.all) < n:
                d = self._make()
                self.all.append(d)
                self.q.put(d)

    def replace(self, dead):
        with self._create_lock:
            try:
                dead.quit()
            except Exception:
                pass
            if dead in self.all:
                self.all.remove(dead)
            d = self._make()
            self.all.append(d)
            return d

    @contextmanager
    def borrow(self):
        """Lend out a driver; swap in a fresh one if it crashed."""
        try:
            drv = self.q.get(timeout=60)
        except queue.Empty:
            raise TimeoutError("No available Chrome browser in pool within 60s")

        try:
            yield drv
        except (BlockedError, ParseError):
            raise
        except Exception:
            try:
                drv = self.replace(drv)
            except Exception:
                # If replace fails, do not put dead driver back in the queue
                drv = None
            raise
        finally:
            if drv is not None:
                if getattr(drv, "_gen", self.gen) != self.gen:
                    try:
                        drv.quit()
                    except Exception:
                        pass
                else:
                    self.q.put(drv)

    def close(self):
        for d in self.all:
            try:
                d.quit()
            except Exception:
                pass
        self.all.clear()


pool = BrowserPool()
atexit.register(pool.close)

# --------------------------------------------------------------------------- Highcharts Extraction Scripts
CHART_READY_JS = """
return !!(window.Highcharts && Highcharts.charts &&
  Highcharts.charts.filter(Boolean).filter(function(c){
    var s=c.series&&c.series[0];
    return s && (((s.options.data||[]).length) || ((s.xData||[]).length));
  }).length>=2);
"""

CHART_JS = """
var out={}; var charts=(window.Highcharts&&Highcharts.charts||[]).filter(Boolean);
charts.forEach(function(c,idx){
  var id=(c.renderTo&&c.renderTo.id)||('chart'+idx); var s=c.series&&c.series[0]; if(!s) return;
  var pts=[]; var d=s.options.data;
  if(d&&d.length){
    if(typeof d[0]==='number'){var st=s.options.pointStart||0, iv=s.options.pointInterval||86400000;
      pts=d.map(function(y,i){return [st+i*iv,y];});}
    else if(Array.isArray(d[0])) pts=d.map(function(p){return [p[0],p[1]];});
    else pts=d.map(function(p){return [p.x,p.y];});
  } else if(s.xData&&s.xData.length){ pts=Array.prototype.map.call(s.xData,function(x,i){return [x,s.yData[i]];}); }
  out[id]=pts;
});
var res=[]; try{ res=performance.getEntriesByType('resource')
  .filter(function(e){return ['xmlhttprequest','fetch'].indexOf(e.initiatorType)>=0;})
  .map(function(e){return e.name;}); }catch(e){}
return {series:out, requests:res};
"""


def to_series(points) -> list[dict]:
    """[[ms, value], ...] -> ascending, de-duplicated [{time(s), value}] for Lightweight Charts."""
    d: dict[int, float] = {}
    for t, v in points or []:
        if t is None or v is None:
            continue
        t = t / 1000 if t > 1e11 else t
        d[int(t)] = float(v)
    return [{"time": t, "value": d[t]} for t in sorted(d)]


def fetch_chart(url: str, p: BrowserPool = pool) -> dict:
    from selenium.common.exceptions import TimeoutException
    from selenium.webdriver.support.ui import WebDriverWait

    p.ensure(1)
    with p.borrow() as drv:
        drv.get(url)
        try:
            WebDriverWait(drv, CHART_TIMEOUT, poll_frequency=0.3).until(lambda d: d.execute_script(CHART_READY_JS))
        except TimeoutException:
            raise ParseError("chart data did not appear (Highcharts not ready)")
        raw = drv.execute_script(CHART_JS)
    series = raw.get("series", {})
    pay = to_series(series.get("chart-buy"))        # Selling price = what you pay
    recv = to_series(series.get("chart-sell"))      # Buying price = what you receive
    if not pay or not recv:
        vals = [to_series(v) for v in series.values() if v]
        if len(vals) >= 2:
            pay, recv = vals[0], vals[1]
    if not pay or not recv:
        raise ParseError("chart series are empty")
    if pay[-1]["value"] < recv[-1]["value"]:
        pay, recv = recv, pay
    return {
        "buy": pay,
        "sell": recv,
        "fetched_at": datetime.now().isoformat(timespec="seconds"),
        "requests": raw.get("requests", [])[:20],
    }


_chart_locks: dict[str, threading.Lock] = {}
_chart_locks_guard = threading.Lock()


def get_chart(pid: str, refresh: bool = False, p: BrowserPool = pool) -> dict:
    url = PID_URL.get(pid)
    if not url:
        raise KeyError(pid)
    path = CHART_DIR / f"{pid}.json"

    def fresh() -> bool:
        return path.exists() and time.time() - path.stat().st_mtime < CHART_TTL

    if fresh() and not refresh:
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass

    with _chart_locks_guard:
        lock = _chart_locks.setdefault(pid, threading.Lock())
    with lock:
        if not refresh and fresh():
            try:
                return json.loads(path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                pass
        data = fetch_chart(url, p)
        data["pid"] = pid
        config.atomic_write_json(path, data)
        return data


# --------------------------------------------------------------------------- Product Listing Discovery
def listing_links(html: str) -> list[str]:
    soup = BeautifulSoup(html, "lxml")
    out: list[str] = []
    for a in soup.select(".products-list-layered a[href]"):
        href = a["href"].split("#")[0]
        if re.search(r"/en/[^/]+/[^/]*-\d+\.html$", href) and href not in out:
            out.append(href)
    return out


def listing_hash(page: int) -> str:
    parts = [config.LISTING_FILTER] if config.LISTING_FILTER else []
    if page > 1:
        parts.append(f"page-{page}")
    return "#/" + "/".join(parts) if parts else "#"


def discover_urls(p: BrowserPool = pool) -> list[str]:
    from selenium.common.exceptions import TimeoutException
    from selenium.webdriver.support.ui import WebDriverWait

    busy_js = "var l=document.getElementById('layered_ajax_loader'); return !!l && l.style.display!=='none';"
    filt_js = "return !!document.querySelector('#enabled_filters li');"
    pages_js = ("return Array.prototype.map.call(document.querySelectorAll('a[href*=\"page-\"]'),"
                "function(a){var m=/page-(\\d+)/.exec(a.href);return m?+m[1]:0;});")

    def wait_page(drv, prev: list[str]) -> list[str]:
        state = {"last": None}

        def ready(d):
            links = listing_links(d.page_source)
            ok = (links and links != prev and not d.execute_script(busy_js)
                  and (not config.LISTING_FILTER or d.execute_script(filt_js)))
            if ok and state["last"] == links:
                return links
            state["last"] = links if ok else None
            return False

        try:
            return WebDriverWait(drv, 30, poll_frequency=0.7).until(ready)
        except TimeoutException:
            return []

    p.ensure(1)
    found: list[str] = []
    with p.borrow() as drv:
        drv.get(LISTING_URL + listing_hash(1))
        pages, page, prev = LISTING_PAGES, 1, []
        while page <= min(pages, 40):
            if page > 1:
                drv.execute_script("window.location.hash = arguments[0];", listing_hash(page))
            links = wait_page(drv, prev)
            new = [u for u in links if u not in found]
            if not new:
                break
            found += new
            prev = links
            pages = max(pages, max(drv.execute_script(pages_js) or [0]))
            page += 1
    if len(found) < 5:
        raise ParseError(f"only {len(found)} products found on the listing (page changed or blocked?)")
    return found

