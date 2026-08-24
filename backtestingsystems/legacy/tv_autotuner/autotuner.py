#!/usr/bin/env python3
"""
TV AUTOTUNER — standalone TradingView input-optimization bot
============================================================
Continuously backtests "MA + R:R Strategy v5" on TradingView Desktop with
different input combinations per coin, scores every run, and keeps the best
inputs + results in best/<coin>.json. No AI, no cloud — just this script and
your TradingView Desktop app.

How it talks to TradingView: Chrome DevTools Protocol on port 9222 (the bot
launches TradingView with that port itself if it isn't running). All input
changes go through TradingView's own study API (setInputValues) — the same
mechanism the settings dialog uses.

MODES
  python3 autotuner.py --batch 60          one pass: 60 backtests per coin, then
                                           writes a summary report and restores
                                           your original inputs. Run overnight.
  python3 autotuner.py --daemon            runs forever, rotating coins in rounds
                                           of --round evals; Ctrl-C stops it
                                           cleanly and restores your inputs.
  python3 autotuner.py --verify            checks TV connection, study, and the
                                           input-id map. Run this first.
  python3 autotuner.py --apply-best COIN   loads best/<COIN>.json inputs onto the
                                           chart (so you can eyeball the result).
  python3 autotuner.py --restore           restores the input snapshot taken at
                                           the start of the last run.

FILES (all inside this folder)
  params.json            search space + objective weights — edit freely
  results/<coin>.jsonl   every evaluation ever run (resume-safe, append-only)
  best/<coin>.json       best config found so far + its full metrics
  backup_inputs.json     snapshot of your chart inputs taken at startup
  autotuner.log          rolling log

HONEST LIMITS
  * ~10-25 s per backtest → a few thousand evals/day. The GA spends them well,
    but this is not an exhaustive search.
  * Scores come from ONE historical window (whatever the chart loads). High
    scores can be luck. The objective penalizes overtrading and drawdown and
    rejects tiny samples, but ALWAYS eyeball the equity curve of a "best"
    config before trading it.
  * If TradingView updates and the results panel changes layout, the scraper
    regexes in JS_SCRAPE may need a small fix.
"""

from __future__ import annotations

import argparse
import hashlib
import itertools
import json
import logging
import random
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests
import websocket  # websocket-client

HERE = Path(__file__).resolve().parent
RESULTS = HERE / "results"
BEST = HERE / "best"
BACKUP = HERE / "backup_inputs.json"
LOG = HERE / "autotuner.log"

CDP_PORT = 9222
TV_BINARY = "/Applications/TradingView.app/Contents/MacOS/TradingView"
STUDY_TITLE_RE = "R:R"          # how we find the strategy study on the chart
TIMEFRAME = "15"                 # chart timeframe the bot enforces

DEFAULT_COINS = [
    "BINANCE:DEXEUSDT", "BINANCE:MORPHOUSDT", "BINANCE:INJUSDT",
    "BINANCE:NEARUSDT", "BINANCE:JTOUSDT", "BINANCE:ZECUSDT",
    "BINANCE:PUMPUSDT", "BINANCE:APTUSDT", "BINANCE:ARBUSDT",
    "BINANCE:PYTHUSDT",
]

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[logging.FileHandler(LOG), logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("autotuner")


# ═════════════════════════════════════════════════════════════════════════════
# CDP client — one websocket to the TradingView page, Runtime.evaluate only.
# ═════════════════════════════════════════════════════════════════════════════

class TVConnection:
    def __init__(self, port: int = CDP_PORT):
        self.port = port
        self.ws: websocket.WebSocket | None = None
        self._id = 0

    # ── lifecycle ────────────────────────────────────────────────────────────
    def targets(self) -> list[dict]:
        r = requests.get(f"http://localhost:{self.port}/json", timeout=5)
        return r.json()

    def connect(self) -> None:
        pages = [t for t in self.targets()
                 if t.get("type") == "page" and "tradingview" in t.get("url", "")]
        if not pages:
            raise ConnectionError("No TradingView page target found on CDP")
        self.ws = websocket.create_connection(
            pages[0]["webSocketDebuggerUrl"], timeout=30,
            suppress_origin=True, max_size=50 * 1024 * 1024)
        log.info("CDP connected: %s", pages[0].get("title", "?")[:60])

    def close(self) -> None:
        if self.ws:
            try: self.ws.close()
            except Exception: pass
            self.ws = None

    def ensure_tv_running(self) -> None:
        """Connect; if TradingView isn't up with CDP, (re)launch it and wait."""
        try:
            self.connect()
            return
        except Exception:
            pass
        log.warning("TradingView not reachable — launching with CDP enabled …")
        subprocess.run(["pkill", "-x", "TradingView"], capture_output=True)
        time.sleep(3)
        subprocess.Popen([TV_BINARY, f"--remote-debugging-port={self.port}"],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(60):
            time.sleep(2)
            try:
                self.connect()
                time.sleep(8)   # let the chart layout finish loading
                return
            except Exception:
                continue
        raise ConnectionError("Could not launch/attach to TradingView Desktop")

    # ── evaluate ─────────────────────────────────────────────────────────────
    def eval(self, expression: str, timeout: float = 30.0):
        """Runtime.evaluate with returnByValue. Reconnects once on failure."""
        for attempt in (1, 2):
            try:
                if not self.ws:
                    self.connect()
                self._id += 1
                self.ws.settimeout(timeout)
                self.ws.send(json.dumps({
                    "id": self._id, "method": "Runtime.evaluate",
                    "params": {"expression": expression, "returnByValue": True},
                }))
                while True:                       # skip event frames
                    msg = json.loads(self.ws.recv())
                    if msg.get("id") == self._id:
                        break
                res = msg.get("result", {}).get("result", {})
                if msg.get("result", {}).get("exceptionDetails"):
                    raise RuntimeError(str(msg["result"]["exceptionDetails"])[:300])
                return res.get("value")
            except (websocket.WebSocketException, ConnectionError, OSError) as e:
                log.warning("CDP eval failed (attempt %d): %s", attempt, e)
                self.close()
                if attempt == 2:
                    raise
                self.ensure_tv_running()


# ═════════════════════════════════════════════════════════════════════════════
# JS bridge — everything the bot does inside TradingView.
# ═════════════════════════════════════════════════════════════════════════════

JS_FIND_STUDY = f"""
(() => {{
  const c = window.TradingViewApi.activeChart();
  const s = c.getAllStudies().find(s => /{STUDY_TITLE_RE}/i.test(s.name));
  return s ? s.id : null;
}})()
"""

def js_inputs_info(study_id: str) -> str:
    return f"""
(() => {{
  const st = window.TradingViewApi.activeChart().getStudyById({study_id!r});
  return st.getInputsInfo().filter(i => /^in_/.test(i.id))
           .map(i => [i.id, i.name || '', i.type]);
}})()
"""

def js_get_inputs(study_id: str) -> str:
    return f"""
(() => {{
  const st = window.TradingViewApi.activeChart().getStudyById({study_id!r});
  return st.getInputValues().map(v => [v.id, v.value]);
}})()
"""

def js_set_inputs(study_id: str, pairs: dict) -> str:
    arr = json.dumps([{"id": k, "value": v} for k, v in pairs.items()])
    return f"""
(() => {{
  const st = window.TradingViewApi.activeChart().getStudyById({study_id!r});
  st.setInputValues({arr});
  return true;
}})()
"""

JS_SYMBOL = """
(() => { try { return window.TradingViewApi.activeChart().symbol(); } catch(e) { return null; } })()
"""

def js_set_symbol(symbol: str) -> str:
    return f"""
(() => {{ window.TradingViewApi.activeChart().setSymbol({symbol!r}); return true; }})()
"""

def js_set_resolution(res: str) -> str:
    return f"""
(() => {{ window.TradingViewApi.activeChart().setResolution({res!r}); return true; }})()
"""

def js_scrape(study_id: str) -> str:
    return f"""
(() => {{
  const el = document.querySelector('.backtesting');
  if (!el) return {{ok:false, err:'no tester panel'}};
  const t = (el.innerText||'').replace(/\\u2212/g,'-').replace(/\\u00a0|\\u202f/g,' ');
  const num = s => s ? parseFloat(s.replace(/[,+]/g,'')) : null;
  const m = {{}};
  let x = t.match(/Total PnL\\s*\\n([+-]?[\\d,.]+)\\s*\\nUSDT\\s*\\n([+-]?[\\d,.]+)%/);
  if (x) {{ m.net_usdt = num(x[1]); m.net_pct = num(x[2]); }}
  x = t.match(/Max drawdown\\s*\\n([+-]?[\\d,.]+)\\s*\\nUSDT\\s*\\n([+-]?[\\d,.]+)%/);
  if (x) {{ m.dd_pct = num(x[2]); }}
  x = t.match(/Profitable trades\\s*\\n([+-]?[\\d,.]+)%\\s*\\n(\\d+)\\/(\\d+)/);
  if (x) {{ m.win_rate = num(x[1]); m.trades = +x[3]; }}
  x = t.match(/Profit factor\\s*\\n([+-]?[\\d,.]+)/);
  if (x) m.profit_factor = num(x[1]);
  x = t.match(/Sharpe ratio\\s*\\n([+-]?[\\d,.]+)/);
  if (x) m.sharpe = num(x[1]);
  m.fingerprint = t.length + ':' + (m.net_usdt ?? '?') + ':' + (m.trades ?? '?');
  let loading = true, err = false;
  try {{
    const st = window.TradingViewApi.activeChart().getStudyById({study_id!r});
    loading = st.isLoading(); err = st.hasError();
  }} catch(e) {{}}
  m.ok = true; m.loading = loading; m.studyError = err;
  try {{ m.symbol = window.TradingViewApi.activeChart().symbol(); }} catch(e) {{}}
  return m;
}})()
"""


# ═════════════════════════════════════════════════════════════════════════════
# Search driver — genetic algorithm (with random + grid fallbacks).
# ═════════════════════════════════════════════════════════════════════════════

class Driver:
    def __init__(self, space: list[dict], cfg: dict, seed: int):
        self.space = space
        self.rng = random.Random(seed)
        self.seen: dict[tuple, float] = {}
        self.algo = cfg.get("algorithm", "ga")
        self.pop = int(cfg.get("ga_population", 14))
        self.mut = float(cfg.get("ga_mutation_rate", 0.18))
        self._grid = itertools.product(*[range(len(p["values"])) for p in space]) \
            if self.algo == "grid" else None

    def genome_to_params(self, g: tuple) -> dict:
        return {p["name"]: p["values"][i] for p, i in zip(self.space, g)}

    def genome_to_inputs(self, g: tuple) -> dict:
        return {p["id"]: p["values"][i] for p, i in zip(self.space, g)}

    def _rand(self) -> tuple:
        return tuple(self.rng.randrange(len(p["values"])) for p in self.space)

    def _tournament(self, k: int = 3) -> tuple:
        pool = self.rng.sample(list(self.seen.items()), min(k, len(self.seen)))
        return max(pool, key=lambda kv: kv[1])[0]

    def ask(self) -> tuple | None:
        if self.algo == "grid":
            for g in self._grid:
                if g not in self.seen:
                    return g
            return None
        if self.algo == "random" or len(self.seen) < self.pop:
            for _ in range(800):
                g = self._rand()
                if g not in self.seen:
                    return g
            return None
        for _ in range(800):                      # GA breeding
            a, b = self._tournament(), self._tournament()
            child = tuple(
                (self.rng.randrange(len(p["values"]))
                 if self.rng.random() < self.mut
                 else (ai if self.rng.random() < 0.5 else bi))
                for p, ai, bi in zip(self.space, a, b))
            if child not in self.seen:
                return child
        return None

    def tell(self, g: tuple, score: float) -> None:
        # None = rejected config persisted from disk; treat as -inf so
        # comparisons in tournament selection never see a None.
        self.seen[g] = float("-inf") if score is None else score


def score_metrics(m: dict, obj: dict) -> float:
    trades = m.get("trades") or 0
    net = m.get("net_pct")
    dd = abs(m.get("dd_pct") or 100.0)
    pf = m.get("profit_factor") or 0.0
    if net is None or trades < obj.get("min_trades", 30):
        return float("-inf")
    if pf < obj.get("min_profit_factor", 0.0):
        return float("-inf")
    s = net - obj.get("dd_weight", 1.0) * dd
    over = max(0, trades - obj.get("overtrade_cap", 600))
    s -= obj.get("overtrade_penalty", 0.05) * over
    return s


# ═════════════════════════════════════════════════════════════════════════════
# The bot
# ═════════════════════════════════════════════════════════════════════════════

class AutoTuner:
    def __init__(self, coins: list[str]):
        self.cfg = json.loads((HERE / "params.json").read_text())
        self.space = self.cfg["parameters"]
        self.obj = self.cfg["objective"]
        self.coins = coins
        self.tv = TVConnection()
        self.study_id: str | None = None
        self.drivers: dict[str, Driver] = {}
        self._stop = False
        RESULTS.mkdir(exist_ok=True)
        BEST.mkdir(exist_ok=True)
        signal.signal(signal.SIGINT, self._sig)
        signal.signal(signal.SIGTERM, self._sig)

    def _sig(self, *_):
        log.info("Stop requested — finishing current eval then restoring inputs …")
        self._stop = True

    # ── setup / safety ───────────────────────────────────────────────────────
    def attach(self) -> None:
        self.tv.ensure_tv_running()
        for _ in range(30):
            sid = self.tv.eval(JS_FIND_STUDY)
            if sid:
                self.study_id = sid
                log.info("Strategy study found: %s", sid)
                return
            time.sleep(2)
        raise RuntimeError("Strategy study not found on chart — add 'MA + R:R Strategy v5' to the active chart")

    def verify_map(self) -> None:
        info = {i[0]: i[1] for i in self.tv.eval(js_inputs_info(self.study_id))}
        bad = []
        for iid, prefix in self.cfg.get("verify_map", {}).items():
            if iid.startswith("_"):
                continue
            live = info.get(iid)
            if live is None or (prefix and not live.startswith(prefix)):
                bad.append(f"{iid}: expected '{prefix}…' got '{live}'")
        for p in self.space:
            if p["id"] not in info:
                bad.append(f"{p['name']}: id {p['id']} not present in study")
        if bad:
            raise RuntimeError("INPUT MAP MISMATCH (Pine inputs changed?):\n  " + "\n  ".join(bad))
        log.info("Input map verified: %d tunable parameters OK", len(self.space))

    def snapshot(self) -> None:
        vals = self.tv.eval(js_get_inputs(self.study_id))
        BACKUP.write_text(json.dumps({"taken": datetime.now(timezone.utc).isoformat(),
                                      "inputs": vals}, indent=1))
        log.info("Input snapshot saved → %s", BACKUP.name)

    def restore(self) -> None:
        if not BACKUP.exists():
            log.warning("No backup snapshot to restore")
            return
        vals = json.loads(BACKUP.read_text())["inputs"]
        pairs = {k: v for k, v in vals if str(k).startswith("in_")}
        self.tv.eval(js_set_inputs(self.study_id, pairs))
        log.info("Original inputs restored (%d values)", len(pairs))

    # ── core evaluation ──────────────────────────────────────────────────────
    def set_symbol(self, symbol: str) -> bool:
        cur = self.tv.eval(JS_SYMBOL)
        if cur == symbol:
            return True
        self.tv.eval(js_set_symbol(symbol))
        for _ in range(30):
            time.sleep(1)
            if self.tv.eval(JS_SYMBOL) == symbol:
                self.tv.eval(js_set_resolution(TIMEFRAME))
                time.sleep(2)
                return True
        log.error("Symbol %s did not resolve — skipping this coin", symbol)
        return False

    def evaluate(self, inputs: dict, prev_fp: str | None) -> dict | None:
        self.tv.eval(js_set_inputs(self.study_id, inputs))
        t_start = time.time()
        deadline = t_start + 90
        settled_since = None
        last_fp = None
        while time.time() < deadline:
            time.sleep(1.5)
            m = self.tv.eval(js_scrape(self.study_id))
            if not m or not m.get("ok"):
                continue
            if m.get("studyError"):
                log.warning("Study error state — skipping config")
                return None
            changed = (prev_fp is None) or (m.get("fingerprint") != prev_fp)
            ready = (not m.get("loading") and changed
                     and m.get("net_usdt") is not None
                     and time.time() - t_start >= 5.0)   # floor: let recalc actually start
            if ready:
                fp = m.get("fingerprint")
                if settled_since is None or fp != last_fp:
                    settled_since = time.time()
                    last_fp = fp
                elif time.time() - settled_since >= 2.5:
                    return m                       # unchanged for 2.5s → settled
        log.warning("Recalc wait timed out (report may be unchanged) — accepting current read")
        m = self.tv.eval(js_scrape(self.study_id))
        return m if m and m.get("ok") and m.get("net_usdt") is not None else None

    # ── persistence ──────────────────────────────────────────────────────────
    @staticmethod
    def _coin_key(symbol: str) -> str:
        return symbol.split(":")[-1]

    def load_driver(self, symbol: str) -> Driver:
        key = self._coin_key(symbol)
        if key in self.drivers:
            return self.drivers[key]
        d = Driver(self.space, self.cfg.get("search", {}),
                   seed=int(self.cfg.get("search", {}).get("random_seed", 42)) + hash(key) % 1000)
        f = RESULTS / f"{key}.jsonl"
        if f.exists():
            n = 0
            for line in f.read_text().splitlines():
                try:
                    rec = json.loads(line)
                    s = rec.get("score")
                    d.tell(tuple(rec["genome"]), float("-inf") if s is None else s)
                    n += 1
                except Exception:
                    continue
            log.info("[%s] resumed %d prior evaluations", key, n)
        self.drivers[key] = d
        return d

    def record(self, symbol: str, genome: tuple, params: dict, metrics: dict, score: float,
               extra: dict | None = None) -> None:
        key = self._coin_key(symbol)
        rec = {"ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
               "symbol": symbol, "genome": list(genome), "params": params,
               "metrics": {k: metrics.get(k) for k in
                           ("net_pct", "net_usdt", "dd_pct", "win_rate", "trades",
                            "profit_factor", "sharpe")},
               "score": round(score, 3) if score != float("-inf") else None}
        if extra:
            rec.update(extra)
        with (RESULTS / f"{key}.jsonl").open("a") as f:
            f.write(json.dumps(rec) + "\n")
        best_f = BEST / f"{key}.json"
        cur_best = None
        if best_f.exists():
            try:
                cur_best = json.loads(best_f.read_text())
            except Exception:
                cur_best = None
        if score != float("-inf") and (cur_best is None or score > cur_best.get("score", -1e18)):
            rec["inputs_to_apply"] = {p["id"]: params[p["name"]] for p in self.space}
            best_f.write_text(json.dumps(rec, indent=1))
            log.info("[%s] ★ NEW BEST  score=%.2f  net=%.2f%%  dd=%.2f%%  pf=%s  trades=%s",
                     key, score, metrics.get("net_pct") or 0, metrics.get("dd_pct") or 0,
                     metrics.get("profit_factor"), metrics.get("trades"))

    # ── seed queue: hand-picked configs tested before GA guesses ────────────
    def seed_genomes(self, symbol: str, d: Driver) -> list[tuple]:
        """Read seeds.json and convert this coin's queued configs to genomes.
        Values are snapped to the nearest allowed value in params.json;
        missing params fall back to the coin's current best (else first value)."""
        f = HERE / "seeds.json"
        if not f.exists():
            return []
        try:
            seeds_all = json.loads(f.read_text())
        except json.JSONDecodeError:
            log.warning("seeds.json is not valid JSON — ignoring it")
            return []
        key = self._coin_key(symbol)
        entries = seeds_all.get(key) or seeds_all.get(symbol) or []
        if not entries:
            return []
        best_f = BEST / f"{key}.json"
        fallback = {}
        if best_f.exists():
            try:
                fallback = json.loads(best_f.read_text()).get("params") or {}
            except Exception:
                fallback = {}
        # genome+context pairs already recorded — a context seed only needs one
        # measurement, its static surroundings never change between rounds
        done_ctx = set()
        rf = RESULTS / f"{key}.jsonl"
        if rf.exists():
            for line in rf.read_text().splitlines():
                try:
                    rec = json.loads(line)
                    done_ctx.add((tuple(rec["genome"]),
                                  json.dumps(rec.get("context") or {}, sort_keys=True)))
                except Exception:
                    continue
        genomes = []
        seen_g = set()
        for e in entries:
            p_in = e.get("params", e) if isinstance(e, dict) else {}
            ctx = e.get("context") or {} if isinstance(e, dict) else {}
            g = []
            for p in self.space:
                v = p_in.get(p["name"], fallback.get(p["name"], p["values"][0]))
                if p["type"] == "bool":
                    idx = p["values"].index(bool(v)) if bool(v) in p["values"] else 0
                else:
                    idx = min(range(len(p["values"])),
                              key=lambda i: abs(float(p["values"][i]) - float(v)))
                    if float(p["values"][idx]) != float(v):
                        log.info("[%s] seed: %s=%s snapped to %s (nearest allowed)",
                                 key, p["name"], v, p["values"][idx])
                g.append(idx)
            g = tuple(g)
            # plain seeds dedupe against GA history; context seeds dedupe against
            # recorded genome+context pairs
            ctx_key = (g, json.dumps(ctx, sort_keys=True))
            if g in seen_g or (not ctx and g in d.seen) or (ctx and ctx_key in done_ctx):
                continue
            seen_g.add(g)
            genomes.append({"genome": g, "context": ctx,
                            "note": e.get("note", "") if isinstance(e, dict) else ""})
        if genomes:
            log.info("[%s] %d untested seed config(s) queued — testing them first", key, len(genomes))
        return genomes

    # ── run loops ────────────────────────────────────────────────────────────
    def run_coin(self, symbol: str, budget: int, prev_fp: str | None = None) -> None:
        if not self.set_symbol(symbol):
            return
        d = self.load_driver(symbol)
        key = self._coin_key(symbol)
        pending_seeds = self.seed_genomes(symbol, d)
        done = 0
        while done < budget and not self._stop:
            seed_info = None
            if pending_seeds:
                seed_info = pending_seeds.pop(0)
                g = seed_info["genome"]
            else:
                g = d.ask()
            if g is None:
                log.info("[%s] search space exhausted", key)
                return
            params = d.genome_to_params(g)
            inputs = d.genome_to_inputs(g)
            ctx = (seed_info or {}).get("context") or {}
            saved_ctx = {}
            t0 = time.time()
            try:
                if ctx:
                    cur = dict(self.tv.eval(js_get_inputs(self.study_id)))
                    saved_ctx = {k: cur.get(k) for k in ctx}
                    log.info("[%s] seed context override: %s", key, ctx)
                    self.tv.eval(js_set_inputs(self.study_id, ctx))
                m = self.evaluate(inputs, prev_fp)
            except Exception as e:
                log.error("[%s] eval crashed: %s — reattaching", key, e)
                self.attach()
                if not self.set_symbol(symbol):
                    return
                continue
            finally:
                if saved_ctx:
                    try:
                        self.tv.eval(js_set_inputs(self.study_id, saved_ctx))
                        prev_fp = None      # context revert changes the report again
                    except Exception as e:
                        log.error("[%s] FAILED to revert seed context: %s", key, e)
            extra = {}
            if seed_info is not None:
                extra = {"seed": True, "note": seed_info.get("note", "")}
                if ctx:
                    extra["context"] = ctx
            if m is None:
                d.tell(g, float("-inf"))
                self.record(symbol, g, params, {}, float("-inf"), extra)
                done += 1
                continue
            if not ctx:
                prev_fp = m.get("fingerprint")
            s = score_metrics(m, self.obj)
            d.tell(g, s)
            self.record(symbol, g, params, m, s, extra)
            done += 1
            log.info("[%s] %d/%d  %.0fs  net=%7.2f%%  dd=%6.2f%%  pf=%5s  tr=%5s  score=%s",
                     key, done, budget, time.time() - t0,
                     m.get("net_pct") or 0, m.get("dd_pct") or 0,
                     m.get("profit_factor"), m.get("trades"),
                     "REJ" if s == float("-inf") else f"{s:.1f}")

    def run_batch(self, budget: int) -> None:
        self.attach(); self.verify_map(); self.snapshot()
        try:
            for sym in self.coins:
                if self._stop:
                    break
                log.info("══════ BATCH %s (%d evals) ══════", sym, budget)
                self.run_coin(sym, budget)
        finally:
            self.write_summary()
            self.restore()

    def restart_tv(self) -> None:
        """Periodic TradingView restart — reclaims Electron memory so eval
        speed doesn't degrade over long daemon sessions."""
        log.info("Auto-refresh: restarting TradingView to keep evals fast …")
        self.tv.close()
        subprocess.run(["pkill", "-x", "TradingView"], capture_output=True)
        time.sleep(5)
        self.tv.ensure_tv_running()
        self.attach()
        log.info("Auto-refresh complete — TradingView fresh, study reattached")

    def run_daemon(self, round_size: int, refresh_every: int = 5) -> None:
        self.attach(); self.verify_map(); self.snapshot()
        try:
            rnd = 0
            while not self._stop:
                rnd += 1
                log.info("══════ DAEMON round %d (%d evals/coin) ══════", rnd, round_size)
                for sym in self.coins:
                    if self._stop:
                        break
                    self.run_coin(sym, round_size)
                self.write_summary()
                if not self._stop and refresh_every > 0 and rnd % refresh_every == 0:
                    self.restart_tv()
        finally:
            self.write_summary()
            self.restore()

    def write_summary(self) -> None:
        rows = []
        for sym in self.coins:
            f = BEST / f"{self._coin_key(sym)}.json"
            if f.exists():
                b = json.loads(f.read_text())
                rows.append({"symbol": sym, "score": b.get("score"),
                             **(b.get("metrics") or {}), "params": b.get("params")})
        out = {"generated_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
               "timeframe": TIMEFRAME, "leaderboard": sorted(
                   rows, key=lambda r: (r.get("score") if r.get("score") is not None else -1e18),
                   reverse=True)}
        (HERE / "SUMMARY.json").write_text(json.dumps(out, indent=1))
        log.info("Summary written → SUMMARY.json (%d coins with results)", len(rows))

    def apply_best(self, spec: str) -> None:
        """spec = 'DEXEUSDT' (best) or 'DEXEUSDT:3' (rank 3 from ranked history)."""
        rank = None
        if ":" in spec and spec.rsplit(":", 1)[-1].isdigit():
            spec, r = spec.rsplit(":", 1)
            rank = int(r)
        key = spec.split(":")[-1].upper()

        if rank is None:
            f = BEST / f"{key}.json"
            if not f.exists():
                raise SystemExit(f"No best config yet for {key} ({f} missing)")
            b = json.loads(f.read_text())
        else:
            rf = RESULTS / f"{key}.jsonl"
            if not rf.exists():
                raise SystemExit(f"No results history for {key}")
            seen, recs = set(), []
            for line in rf.read_text().splitlines():
                try:
                    r = json.loads(line)
                except json.JSONDecodeError:
                    continue
                g = tuple(r.get("genome") or [])
                if g in seen or r.get("score") is None:
                    continue
                seen.add(g)
                recs.append(r)
            recs.sort(key=lambda r: r["score"], reverse=True)
            if not (1 <= rank <= len(recs)):
                raise SystemExit(f"{key} has {len(recs)} ranked results — pick 1..{len(recs)}")
            b = recs[rank - 1]
            b["inputs_to_apply"] = {p["id"]: b["params"][p["name"]] for p in self.space}

        self.attach()
        sym = b["symbol"]
        if not self.set_symbol(sym):
            raise SystemExit(f"Could not switch chart to {sym}")
        if "inputs_to_apply" not in b:
            b["inputs_to_apply"] = {p["id"]: b["params"][p["name"]] for p in self.space}
        to_apply = dict(b["inputs_to_apply"])
        to_apply.update(b.get("context") or {})   # seed context TFs must come along
        self.tv.eval(js_set_inputs(self.study_id, to_apply))
        log.info("Applied %s inputs for %s (score=%s, net=%s%%)%s. Check the chart.",
                 "best" if rank is None else f"rank-{rank}", key,
                 b.get("score"), (b.get("metrics") or {}).get("net_pct"),
                 " incl. context TFs" if b.get("context") else "")


# ═════════════════════════════════════════════════════════════════════════════

def main() -> None:
    ap = argparse.ArgumentParser(description="TradingView input autotuner (standalone)")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--batch", type=int, metavar="N", help="N evaluations per coin, then stop + restore")
    g.add_argument("--daemon", action="store_true", help="run forever, rotating coins")
    g.add_argument("--verify", action="store_true", help="check connection + input map, then exit")
    g.add_argument("--apply-best", metavar="COIN", help="apply best/<COIN>.json inputs to the chart")
    g.add_argument("--restore", action="store_true", help="restore snapshot from backup_inputs.json")
    ap.add_argument("--round", type=int, default=10, help="daemon: evals per coin per rotation (default 10)")
    ap.add_argument("--coins", default=None,
                    help="comma-separated symbols (default: coins.txt, else built-in list)")
    args = ap.parse_args()

    if args.coins:
        raw = args.coins.split(",")
    elif (HERE / "coins.txt").exists():
        raw = [ln.split("#")[0].strip() for ln in (HERE / "coins.txt").read_text().splitlines()]
    else:
        raw = DEFAULT_COINS
    coins = [c.strip() if ":" in c.strip() else f"BINANCE:{c.strip().upper()}" for c in raw if c.strip()]
    bot = AutoTuner(coins)

    if args.verify:
        bot.attach(); bot.verify_map()
        info = bot.tv.eval(js_scrape(bot.study_id))
        log.info("Live read OK: %s net=%s%% trades=%s", info.get("symbol"),
                 info.get("net_pct"), info.get("trades"))
        print("\nVERIFY PASSED — bot is ready. Try:  python3 autotuner.py --batch 40")
    elif args.restore:
        bot.attach(); bot.restore()
    elif args.apply_best:
        bot.apply_best(args.apply_best)
    elif args.batch:
        bot.run_batch(args.batch)
    elif args.daemon:
        bot.run_daemon(args.round)


if __name__ == "__main__":
    main()
