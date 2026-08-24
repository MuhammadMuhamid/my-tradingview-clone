# TV Autotuner — standalone input-optimization bot

Continuously backtests **MA + R:R Strategy v5** on TradingView Desktop with
different inputs per coin, scores every run, and saves the best inputs +
results per coin. Runs entirely on your Mac — no AI, no cloud, no login
scraping. ~8–10 s per backtest.

## One-time setup
```bash
cd tv_autotuner
pip3 install -r requirements.txt
```
TradingView Desktop must have the chart layout with "MA + R:R Strategy v5"
on it. The bot launches/relaunches TradingView itself when needed.

## Run styles

**Option A — overnight batch (recommended to start):**
```bash
python3 autotuner.py --batch 60
```
60 backtests per coin across the 10 configured coins (~90 min at current
speed), then writes `SUMMARY.json` and **restores your original inputs**.

**Option B — always-on daemon:**
```bash
python3 autotuner.py --daemon --round 10
```
Rotates through the coins forever, 10 evals per coin per round, updating
`best/` and `SUMMARY.json` after every round. Stop anytime with Ctrl-C —
it finishes the current backtest and restores your inputs. To keep it
running after closing the terminal:
```bash
nohup python3 autotuner.py --daemon --round 10 > /dev/null 2>&1 &
```

## Everyday commands
```bash
python3 autotuner.py --verify              # health check (run after TV updates)
python3 autotuner.py --apply-best INJUSDT  # put a coin's best inputs on the chart
python3 autotuner.py --restore             # bring back your snapshotted inputs
python3 autotuner.py --batch 40 --coins BINANCE:APTUSDT,BINANCE:ZECUSDT
```

## Where results live
- `best/<coin>.json` — best inputs found so far + full metrics (`inputs_to_apply`
  is what `--apply-best` loads onto the chart)
- `SUMMARY.json` — leaderboard across all coins
- `results/<coin>.jsonl` — every evaluation ever (the bot resumes from these,
  so stopping/restarting never loses work)
- `backup_inputs.json` — snapshot of your chart inputs, taken at each start

## Tuning the search — edit `params.json`
- `parameters`: add/remove/change candidate values freely. Smaller lists =
  faster convergence.
- `objective`: scoring. Default: `net% − 1.0×maxDD% − 0.05×(trades−600 if over)`.
  Configs with < 30 trades are rejected outright (too little evidence).
- `search.algorithm`: `ga` (default, smart), `random`, or `grid` (exhaustive —
  only sane if you shrink the parameter lists a lot).

## Warnings (read once, seriously)
1. **A high score is evidence, not proof.** Everything is fitted to one
   historical window. Before trading a "best" config: apply it with
   `--apply-best`, eyeball the equity curve, and ideally re-check it weeks
   later on the data that has arrived since (`--batch 1` re-runs it fresh).
2. The Mac must stay awake (System Settings → prevent sleep, or `caffeinate`).
3. If TradingView ships a UI update and `--verify` fails on the results
   panel, the regexes in `JS_SCRAPE` (autotuner.py) need a small update to
   match the new labels.
4. If you edit the Pine script's **inputs** (add/remove/reorder), the
   `in_XX` ids shift — `--verify` will catch it and refuse to run.
