"""
Main entry point and CLI runner for GoldForex Picker.
"""
from __future__ import annotations

import argparse
import socket
import threading
import webbrowser

import uvicorn

import config


def get_lan_ip() -> str:
    """Determine the LAN IP address of this machine for phone access."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def main():
    ap = argparse.ArgumentParser(description="GoldForex.be - gold picker and arbitrage finder")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8024)
    ap.add_argument("--phone", action="store_true", help="listen on 0.0.0.0 for phone/LAN access")
    ap.add_argument("--mode", choices=["auto", "http", "browser"], default="auto", help="scraping mode")
    ap.add_argument("--workers", type=int, default=5, help="parallel HTTP threads / Chrome windows")
    ap.add_argument("--headless", action="store_true", help="force hidden Chrome windows (default)")
    ap.add_argument("--show-browser", action="store_true", help="show Chrome windows (overrides saved Settings)")
    ap.add_argument("--uc", action="store_true", help="use undetected-chromedriver")
    ap.add_argument("--all-metals", action="store_true", help="also list silver / platinum (default: gold only)")
    ap.add_argument("--no-open", action="store_true", help="do not auto-open the browser on startup")
    args = ap.parse_args()

    # Load persistent settings first before applying CLI overrides
    config.load_settings()

    if args.phone:
        args.host = "0.0.0.0"

    config.MODE = args.mode
    config.WORKERS = args.workers
    config.USE_UC = args.uc

    if args.headless:
        config.HEADLESS = True
    elif args.show_browser:
        config.HEADLESS = False

    if args.all_metals:
        config.LISTING_FILTER = ""
        config.PRODUCTS_FILE.unlink(missing_ok=True)

    # Import app after configuration is initialized
    from app import app

    url = f"http://{'127.0.0.1' if args.host == '0.0.0.0' else args.host}:{args.port}"
    if not args.no_open:
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()

    lan_ip = get_lan_ip()
    print(f"GoldForex picker at {url}  (mode={config.MODE}, workers={config.WORKERS}, silent={config.HEADLESS}, "
          f"http client={'curl_cffi/chrome' if config.cffi_requests else 'requests'})", flush=True)
    if args.host in ("0.0.0.0", "127.0.0.1", "localhost"):
        print(f"  > Phone / LAN access: http://{lan_ip}:{args.port} (run with --phone or --host 0.0.0.0)", flush=True)
    if args.host == "0.0.0.0" or args.phone:
        print("  ! WARNING: Listening on 0.0.0.0 with no authentication. Anyone on your local network can access the dashboard.", flush=True)

    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()

