# 🪙 GoldForex Picker & Precious Metals Arbitrage Dashboard

A modern, full-stack precious metals intelligence dashboard and portfolio tracker designed for gold coins and bars from [GoldForex.be](https://www.goldforex.be), benchmarked live against [BullionByPost.eu](https://www.bullionbypost.eu) and international market spot prices.

---

## ✨ Features

- **🎯 Curated `< 1,000 €` Filter**: Streamlined scraping and filtering focused on fractional bullion coins (Sovereigns, Napoleons, Vrenelis, Ducats, Pesos, 1/10 oz, 1/4 oz) and 1g–5g bars.
- **💼 Live Investment Wallet**:
  - Log your physical gold purchases with **exact date and minute timestamp** (`datetime-local`).
  - Track **real-time win/loss** if liquidated today directly against live GoldForex buyback prices (`shop_buys`).
  - Portfolio KPIs: Total Invested, Current Cash-In Value, Net Win/Loss (€ and %), Pure Gold (g and oz), and Portfolio Break-Even spot price.
  - 1-click **+ Add to Wallet** from any product card.
  - Export and restore portfolio backups via JSON.
- **⭐ Composite Deal Score (0–100)**: Evaluates every coin and bar by combining resale spread, spot markup, and cost per pure gram. Weights are customizable in the UI.
- **📈 Premium Sweet Spot Chart**: Interactive scatter plot of resale loss % against item weight, showing where exit spreads flatten out.
- **🧺 Budget Basket Optimizer**: Finds mathematically optimal mixes of bullion coins and bars for your exact budget (maximizing pure gold or minimizing resale loss).
- **🏪 Dealer Compare**: Side-by-side price comparison benchmarked against BullionByPost.eu.
- **🔔 Price & Stock Alerts**: In-browser audio chimes and system notifications when an item drops below target price or comes back in stock.
- **✨ Studio Photo Transparency**: Automatic corner floodfill processing that renders white/studio backgrounds into transparent PNGs for seamless dark-mode display.
- **📱 PWA Ready**: Installable as a progressive web app on desktop and mobile with offline caching.

---

## 🚀 Quick Start

### Windows (1-Click Launch)
Simply double-click:
```bat
run.bat
```
The batch script automatically detects Python (`py.exe` or `python.exe`) and launches the web application.

### Manual Setup
1. Clone the repository:
   ```bash
   git clone https://github.com/merwn/goldforex-picker.git
   cd goldforex-picker
   ```
2. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```
3. Start the application:
   ```bash
   python main.py
   ```
4. Open your browser at:
   ```
   http://localhost:8000
   ```

---

## 🛠️ Project Structure

```
├── app.py                # FastAPI routes, image proxy with transparency & API endpoints
├── browser.py            # Headless Chrome pool, Highcharts extraction & product discovery
├── config.py             # Constants, URLs, country flags, and operational parameters
├── main.py               # Application entrypoint (starts server and opens browser)
├── run.bat               # Windows 1-click batch launcher
├── scraper.py            # HTTP/browser parallel scrapers, metrics, and deal scores
├── spot.py               # Live market gold spot price scrapers (BullionByPost + Yahoo Finance)
├── requirements.txt      # Python package dependencies
├── templates/
│   └── index.html        # Clean, modular dashboard UI template
└── static/
    ├── css/style.css     # Dark-mode gold glassmorphism styles
    ├── js/app.js         # Reactive frontend state, wallet tracking & TradingView charts
    ├── icon.svg          # Gold bullion PWA application icon
    ├── manifest.json     # Progressive Web App manifest
    └── sw.js             # Service worker for offline asset caching
```

---

## 📜 License
MIT License. Open for educational and personal precious metals portfolio management.
