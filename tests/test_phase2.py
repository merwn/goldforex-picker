import json
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

from scraper import fetch_competitor_benchmarks, read_cache

def test_phase2():
    d = read_cache()
    rows = d.get('rows', [])

    # 1. 1 Ducat check
    ducat = next(r for r in rows if 'ducat' in r['name'].lower())
    print(f"1 Ducat: pure_g={ducat.get('pure_g')}, score={ducat.get('deal_score')}, suspect={ducat.get('suspect')}")
    assert ducat['pure_g'] == 3.44, f"1 Ducat pure_g should be 3.44, got {ducat.get('pure_g')}"

    # 2. Fractional coins check
    null_pure = [r['name'] for r in rows if r.get('pure_g') is None]
    print(f"Rows with pure_g is None: {null_pure}")
    assert len(null_pure) == 0, f"No rows should have pure_g is None, found: {null_pure}"

    # 3. Deal score distribution
    scores = [r['deal_score'] for r in rows if r.get('deal_score') is not None]
    print(f"Min score: {min(scores)}, Max score: {max(scores)}, Total scored: {len(scores)}")
    assert min(scores) <= 10, "Scale should not be crushed to 90-100"
    assert max(scores) >= 95, "Top items should score near 100"

    # 4. Competitors
    comps = fetch_competitor_benchmarks(refresh=True)
    for bm in comps.get('benchmarks', []):
        print(f"Benchmark: {bm['name']:15} -> GF Match: {bm.get('gf_name')}, Diff: {bm.get('diff_eur')} EUR ({bm.get('diff_pct')}%)")
        if bm['name'] == 'Britannia 1 oz':
            assert bm.get('gf_name') is None, f"1 oz Britannia must not match 1/10 oz Britannia, got {bm.get('gf_name')}"

    print("Phase 2 verification passed!")

if __name__ == '__main__':
    test_phase2()
