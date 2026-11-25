import subprocess
import time
import urllib.request
import json
import sys

def run_integration():
    p = subprocess.Popen([sys.executable, '-u', 'main.py', '--no-open', '--port', '8022'],
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        time.sleep(2.5)

        # 1. Test homepage
        with urllib.request.urlopen('http://127.0.0.1:8022/') as r:
            assert r.status == 200
            html = r.read().decode('utf-8')
            assert 'main-tabs' in html
            assert 'main.js' in html
            print("Homepage test: OK")

        # 2. Test /api/prices
        with urllib.request.urlopen('http://127.0.0.1:8022/api/prices') as r:
            assert r.status == 200
            data = json.loads(r.read().decode('utf-8'))
            assert 'rows' in data
            assert len(data['rows']) > 0
            print(f"/api/prices test: OK ({len(data['rows'])} rows)")

        # 3. Test /api/export.csv?locale=eu
        with urllib.request.urlopen('http://127.0.0.1:8022/api/export.csv?locale=eu') as r:
            assert r.status == 200
            csv_bytes = r.read()
            assert csv_bytes.startswith(b'\xef\xbb\xbf'), "CSV must start with UTF-8 BOM"
            csv_text = csv_bytes.decode('utf-8-sig')
            assert ';' in csv_text
            print("CSV export test (EU delimiter ';' and UTF-8 BOM): OK")

        # 4. Test /api/settings GET and POST
        with urllib.request.urlopen('http://127.0.0.1:8022/api/settings') as r:
            assert r.status == 200
            s_data = json.loads(r.read().decode('utf-8'))
            assert 'silent' in s_data
            print(f"/api/settings GET test: OK (silent={s_data['silent']})")

        req = urllib.request.Request('http://127.0.0.1:8022/api/settings',
                                     data=json.dumps({"silent": 1}).encode('utf-8'),
                                     headers={'Content-Type': 'application/json'},
                                     method='POST')
        with urllib.request.urlopen(req) as r:
            assert r.status == 200
            post_data = json.loads(r.read().decode('utf-8'))
            assert post_data.get('silent') is True
            print("/api/settings POST test: OK")

        # 5. Test static JS module loading
        with urllib.request.urlopen('http://127.0.0.1:8022/static/js/main.js') as r:
            assert r.status == 200
            print("Static JS module main.js test: OK")

        print("\nAll integration checks passed successfully!")
    finally:
        p.terminate()
        p.wait()

if __name__ == '__main__':
    run_integration()
