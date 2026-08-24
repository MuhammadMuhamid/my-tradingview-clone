# SR+Trend local backtest (Binance Spot)

**Not Pine parity** — use TradingView Strategy Tester for authoritative results.

## Setup

```bash
cd "<checkout>/backtest-spot"
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

## 1) Download MORPHOUSDT (warmup + Apr 9–13 test window)

Warmup from **Mar 25** so 1m×200 / 1h×400 MAs have history before Apr 9:

```bash
python fetch_data.py --symbol MORPHOUSDT --start 2026-03-25 --end 2026-04-14 \
  --intervals 1m,5m,15m,1h,4h
```

CSV files land in `./data/`.

**Test window only** (if you already have warmup files):

```bash
python fetch_data.py --symbol MORPHOUSDT --start 2026-04-09 --end 2026-04-14 --intervals 5m
```

## 2) Full-parameter search (Apr 9 – May 14 2026)

**Important:** `--data-start` / `--data-end` must match your `fetch_data.py` filenames.

```bash
python optimize_morpho.py --symbol MORPHOUSDT \
  --data-start 2026-04-09 --data-end 2026-05-14 \
  --test-start 2026-04-09 --test-end 2026-05-14 \
  --samples 800
```

Outputs:
- `results/best_morpho.json` — full best config + top 15
- `results/best_morpho.pine.txt` — all Pine input names to copy

Single run with defaults:

```bash
python run_backtest.py --symbol MORPHOUSDT \
  --data-start 2026-04-09 --data-end 2026-05-14 \
  --test-start 2026-04-09 --test-end 2026-05-14
```

## 3) TradingView (truth test)

- Chart: **BINANCE:MORPHOUSDT**, **5m**
- Strategy: **SR+Trend v5** (`SR_Uptrend_Strategy.pine`)
- Date range: **2026-04-09 → 2026-04-13**
- Properties: capital **1000**, order **930 USDT**, commission **0.05%**
