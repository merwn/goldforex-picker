# Changelog: GoldForex Picker Refactor & Upgrade

## Overview
Comprehensive overhaul covering backend stability, data parsing and scoring correctness, dashboard reorganization into 3 intuitive tabs, and client modularization into ES modules.

---

## Phase 1: Critical Backend Bugs & Stability

- **1.1 Dynamic Configuration Access (CLI flags & Settings persistence)**
  - Replaced copy-by-value imports (`from config import MODE, WORKERS...`) in `scraper.py`, `browser.py`, and `spot.py` with dynamic `import config` reads at call-time.
  - Reordered initialization in `main.py`: `config.load_settings()` loads saved user preferences first, CLI arguments override them, and FastAPI `app` imports dynamic config variables safely.
  - Added security warning when launching with `--phone` or `0.0.0.0` alerting that the server has no authentication.

- **1.2 `/api/prices` Resilient Error Handling**
  - Wrapped `scrape_all()` in `app.py` in a try/except block returning status 502 with JSON error messages.
  - Returns stale cached data with `"stale": true` and error details if the shop cannot be reached, preventing blank screens.
  - Updated frontend `load()` to handle HTTP errors cleanly with optional chaining (`d.via?.http ?? 0`).

- **1.3 Selenium BrowserPool Hang Prevention**
  - Added strict queue borrow timeout (`q.get(timeout=60)`).
  - Configured driver page-load and script timeouts (`drv.set_page_load_timeout(30)`, `drv.set_script_timeout(30)`).
  - Fixed `borrow()` error handling so dead Chrome drivers that fail `replace()` are discarded rather than returning to the pool.

- **1.4 Non-Blocking Product Listing Discovery**
  - Moved PrestaShop layered navigation discovery to an asynchronous background worker (`trigger_background_discovery()`).
  - Cached `products.json` is served immediately so page load requests never block on 30s+ Chrome discovery.

- **1.5 Atomic Cache Writes**
  - Implemented `atomic_write_json(path, data)` helper writing to temporary files (`.tmp`) before atomic `os.replace()`, preventing corrupt/half-written reads across processes and threads on Windows.
  - Applied to `last_scrape.json`, `products.json`, `competitors.json`, `settings.json`, and chart JSON caches.

- **1.6 Rate Limiting & Auto-Refresh Safeguards**
  - Increased `CACHE_TTL` to 300 seconds (5 minutes) and enforced rate limiting on forced refresh.
  - Changed auto-refresh (60 s) to read cached data and spot market only (`load(false)` and `loadSpot(false)`), protecting against shop blocking.

- **1.7 Endpoint Methods & CSV Export with UTF-8 BOM**
  - Converted state-changing endpoints `/api/settings` and `/api/charts/refresh` to `POST`.
  - Updated `/api/export.csv`: added `?locale=eu` support (semicolon `;` delimiter with comma `,` decimals) and prepended `utf-8-sig` BOM for seamless opening in European Microsoft Excel.

---

## Phase 2: Data Correctness & Scoring

- **2.1 Deal Score Normalization & Outlier Resistance**
  - Redesigned Deal Score normalization in both Python (`scraper.py`) and JavaScript (`scoring.js`):
    - Normalizes only over in-stock, status-ok, non-suspect items.
    - Implemented 5th-95th percentile clipping (`get_percentile`) to prevent single outliers or collector coins from crushing the 0–100 score distribution.
    - Fixed weight slider parsing (`Number.isFinite(+v) ? +v : fallback`) allowing 0% weights without falling back to defaults.

- **2.2 Purity Parsing, 1 Ducat Bug & Missing Pure Gold Fixes**
  - Corrected Austrian 1 Ducat (pid 343) bug: purity was previously interpreted as a fraction `< 1.0` and divided by 100 twice, yielding `0.0345g` instead of `3.44g`.
  - Added known bullion coin reference table (`KNOWN_COIN_DATA`) covering Ducat, Krugerrand, Sovereign, Maple Leaf, Eagle, Philharmonic, Britannia, Panda, Vreneli, Napoleon/20 Francs, 20 Lires, 20 Mark, 10 Mark, and Mexican Pesos.
  - Added fallback regex parsing for fractional ounces (`1/10 oz`, `1/4 oz`, `1/2 oz`, `1 oz`) and gram weights.
  - Added sanity check: items with `sell_per_pure_g / spot_per_g` outside `[0.5, 3.0]` are marked `suspect: true` and display a warning badge.

- **2.3 Accurate Competitor Benchmarks Matching**
  - Updated BullionByPost benchmark matching to match primarily on `pure_g` within 2% and product category (`coin` vs `bar`), with keyword overlap as a secondary tiebreaker.
  - Avoids comparing 1 oz benchmark items to 1/10 oz items.
  - Replaced hardcoded spot price with live `get_spot()` rate.

- **2.4 Timezone Awareness (Europe/Brussels)**
  - Attached explicit `Europe/Brussels` (`ZoneInfo`) timezone to `quote_time` and `scraped_at`.
  - Clamped relative age calculation in frontend so "X minutes ago" never displays negative values.

---

## Phase 3: Dashboard Reorganization & Modularization

- **3.1 Three Main Tabs with Hash Routing**
  - 🪙 **Market** (`#market`): Primary price browser, cards/table view, filters, search, and top deals.
  - 💼 **Wallet** (`#wallet`): Full portfolio management, holding liquidation value, net win/loss tracking, backup/restore.
  - 🛠️ **Tools** (`#tools`): Interactive sub-tools:
    - 📈 Sweet Spot Chart (Resale Loss % vs Weight SVG scatter plot)
    - 🧺 Budget Basket Optimizer
    - 🏪 Dealer Compare (BullionByPost benchmarks)
    - ⚖️ Side-by-Side Product Comparison

- **3.2 Primary Toolbar & Secondary Filters Panel**
  - Streamlined top bar with category buttons (`All` | `Bars` | `Coins`), `Favourites` toggle, `In stock only` toggle, Search input, Sort dropdown, View toggle, `Filters ⚙️` drawer, `Refresh 🔄`, and `⋯ More` popover.
  - Collapsible Filters Panel with realistic weight brackets: `≤ 2g`, `2–5g`, `5–10g`, `10–20g`, `> 20g`, Country, Karat, and Budget range.

- **3.3 Compact Sticky Status Line**
  - Shows live gold spot price, quote freshness age badge, and active filter clear chips.
  - Collapsible `▼ Spot Details` showing median shop-implied gold, USD/GBP rates, and 24h change.

- **3.4 Card Simplification with Details Accordion**
  - Cards highlight key decision metrics: country flag, transparent coin photo, large You Pay & You Receive prices, resale loss meter, and pure gold grams.
  - Expandable `▼ Details` accordion reveals market gold comparison, break-even gold price, pay/receive per pure gram, and karat details.

- **3.5 Table View Refinement & Column Picker**
  - 8 core columns by default for clean reading.
  - Interactive Column Picker popover allowing toggling of 52W Timing, Country, Karat, Break-even spot, Premium %, Pay/pure g, and Market value (persisted in `localStorage.gf_table_cols`).

- **3.6 3 Best Picks Chips**
  - Top Deal Score, Lowest Resale Loss, and Cheapest Pure Gold chips at the top of Market view.
  - Clicking any chip smoothly scrolls to and pulses the target product card.

- **3.7 UI Polish & Zoom Capability**
  - Viewport meta updated to permit pinch-to-zoom (`width=device-width, initial-scale=1`).
  - Purged legacy `vault` references in favor of `wallet` (with automatic backward compatibility migration).

- **3.8 ES Modules Client Architecture**
  - Split monolith into 10 clean, focused ES modules in `static/js/`:
    - `main.js`: Router, event delegation, app bootstrap.
    - `state.js`: Global reactive state and storage persistence.
    - `format.js`: Number, currency, date, and badge formatting.
    - `api.js`: Fetch endpoints wrapper.
    - `scoring.js`: Deal score calculations and percentiles.
    - `market.js`: Cards, table, picks, filtering, sorting.
    - `wallet.js`: Portfolio KPIs, holdings table, add/edit modal.
    - `tools.js`: Scatter plot, basket optimizer, competitor & side-by-side comparison.
    - `alerts.js`: Web Audio API synthesised chime and alert manager.
    - `charts.js`: Lightweight Charts modal wrapper.

- **3.9 Service Worker v2**
  - Upgraded to `goldforex-v2`.
  - Implemented network-first strategy for `/`, HTML, CSS, and JS files to eliminate stale caching while retaining full offline capabilities.

---

## Phase 4: Test Verification

- `tests/test_phase2.py`: Validates 1 Ducat pure gold (3.44g), zero null pure gold items, smooth deal score distribution, and competitor matching.
- `tests/test_integration.py`: Validates live server boot, `/` routing, `/api/prices`, `/api/export.csv?locale=eu` (UTF-8 BOM), and `/api/settings` GET/POST.
