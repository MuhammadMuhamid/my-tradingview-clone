#!/usr/bin/env python3
"""
Approach B v2 — TradingView UI Optimization Pipeline (multi-symbol, heuristic search)
=====================================================================================
Upgrades over tv_optimizer.py (v1):

  1. LABEL-BASED input targeting     — inputs are found by their dialog label text,
                                       not positional index (survives input reordering).
  2. LOADER-LINKED explicit waits    — after applying settings we fingerprint the
                                       Performance Summary DOM text and poll until it
                                       MUTATES (or times out), instead of sleeping a
                                       fixed 4 s. Typical wait drops to 1-2 s.
  3. SEARCH HEURISTICS               — grid / random / genetic-algorithm drivers with
                                       a shared ask/tell interface and an eval cache.
  4. MULTI-SYMBOL CONCURRENCY        — one tab per symbol inside a single logged-in
                                       browser context, bounded by --max-tabs.
  5. JSON EXPORT LAYER               — per-symbol results JSONL (resume-safe) plus
                                       best_<symbol>.json with the top-K configs and
                                       the 3Commas alert payload template merged in.

Honest constraints (do not skip):
  * TradingView's ToS does not sanction automated UI access. Run this against YOUR
    OWN account, at human-ish pacing (this script serializes settings changes per
    tab and adds jitter). You accept the account risk.
  * Throughput ceiling is ~10-25 s per (symbol, config). A 4-param grid explodes
    past what UI automation can cover. Use the local vectorized optimizer
    (../backtest-spot/) for broad search and THIS pipeline only to validate the
    top-K candidates on TradingView's authoritative broker emulator.
  * DOM selectors drift with TV deployments. Everything lives in SEL below.
  * Backtest window = whatever the chart's loaded history is. Pin the same
    date range / "Recalculate after order is filled" properties you tuned with.

Usage:
  pip install -r requirements.txt && playwright install chromium
  export TV_USERNAME=... TV_PASSWORD=...
  python tv_optimizer_v2.py \
      --chart-url https://www.tradingview.com/chart/XXXX/ \
      --symbols BINANCE:APTUSDT,BINANCE:NEARUSDT,BINANCE:SOLUSDT \
      --mode ga --budget 80 --max-tabs 2 --session tv_session.json
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import itertools
import json
import os
import random
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from dotenv import load_dotenv
from playwright.async_api import (
    Browser,
    BrowserContext,
    Locator,
    Page,
    TimeoutError as PWTimeout,
    async_playwright,
)

load_dotenv()

HERE = Path(__file__).resolve().parent
RESULTS_DIR = HERE / "results"
THREE_COMMAS_TEMPLATE = HERE.parent / "3commas_alert_message_template.json"


# ─────────────────────────────────────────────────────────────────────────────
# 1) Parameter space — labels must match the strategy's input dialog EXACTLY.
#    kind: "float" | "int" | "bool". values = the discrete grid searched.
#    These defaults target the R:R execution layer of ma_riskreward_strategy.pine.
# ─────────────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class ParamSpec:
    label: str          # exact label text in the Inputs tab
    key: str            # short machine name used in results/JSON
    kind: str           # float | int | bool
    values: tuple       # discrete candidate values


PARAM_SPACE: list[ParamSpec] = [
    ParamSpec("Reward : Risk ratio (TP)",                 "rrRatio",   "float", (1.5, 2.0, 2.5, 3.0)),
    ParamSpec("Swing low lookback (bars)",                "rrSwingLb", "int",   (6, 10, 14, 20)),
    ParamSpec("SL buffer below swing low (× ATR)",        "rrBufAtr",  "float", (0.0, 0.1, 0.3)),
    ParamSpec("Trailing stop distance (%)",               "rrTrailPct","float", (2.0, 3.0, 4.0)),
    ParamSpec("Pause duration (bars) after max losses hit","choppyPauseBars", "int", (20, 48)),
    # bool example — checkbox labels work too:
    # ParamSpec("R:R: trailing stop (%)", "rrUseTrailSl", "bool", (True, False)),
]


# ─────────────────────────────────────────────────────────────────────────────
# 2) Objective — scalar score maximized by every search driver.
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class Objective:
    dd_weight: float = 1.5      # score = net% − dd_weight × maxDD%
    min_trades: int = 8         # fewer trades ⇒ statistically meaningless ⇒ score −inf
    min_profit_factor: float = 0.0

    def score(self, m: dict[str, float]) -> float:
        if m.get("total_trades", 0) < self.min_trades:
            return float("-inf")
        if m.get("profit_factor", 0.0) < self.min_profit_factor:
            return float("-inf")
        return m.get("net_profit_pct", float("-inf")) - self.dd_weight * abs(m.get("max_drawdown_pct", 100.0))


NUM_RE = re.compile(r"-?\d[\d,]*\.?\d*")


def parse_metric(text: str) -> float:
    """'+1,234.56 USDT' / '−12.34%' / '2.41' → float. Returns nan on failure."""
    if not text:
        return float("nan")
    t = text.replace("−", "-").replace("−", "-")
    neg = "-" in t.split(".")[0]
    m = NUM_RE.search(t)
    if not m:
        return float("nan")
    v = float(m.group(0).replace(",", ""))
    return -abs(v) if neg and v > 0 else v


# ─────────────────────────────────────────────────────────────────────────────
# 3) DOM selectors — single point of maintenance.
# ─────────────────────────────────────────────────────────────────────────────

SEL = {
    "user_menu_avatar":  '[data-name="header-user-menu-button"]',
    "sign_in_btn":       'button[data-name="header-user-menu-sign-in"]',
    "email_tab":         '[data-tab="Email"]',
    "username_input":    'input[name="username"]',
    "password_input":    'input[name="password"]',
    "login_submit":      'button[type="submit"]',

    "symbol_search_btn": '#header-toolbar-symbol-search',
    "symbol_input":      '[data-name="symbol-search-items-dialog"] input',

    "bottom_panel_open": 'button[data-name="toggle-visibility-button"]',
    "backtesting_tab":   '[data-id="backtesting"]',
    "perf_summary_tab":  '[data-value="performance-summary"], #Performance',
    "report_container":  '[data-name="backtesting"] table, .backtesting-content-wrapper, [class*="reportContainer"]',

    "legend_gear":       '[data-name="legend-settings-action"]',
    "legend_title":      '[data-name="legend-source-title"]',
    "settings_dialog":   '[data-name="indicator-properties-dialog"]',
    "inputs_tab":        '[data-value="inputs"], [data-id="inputs"]',
    "ok_button":         'button[data-name="submit-button"]',

    # Performance Summary rows (label cell → value read from sibling cells)
    "row_net_profit":    'tr:has(td:text-is("Net Profit")), tr:has-text("Net profit")',
    "row_max_drawdown":  'tr:has(td:text-is("Max Drawdown")), tr:has-text("Max equity drawdown")',
    "row_win_rate":      'tr:has(td:text-is("Percent Profitable")), tr:has-text("Percent profitable")',
    "row_profit_factor": 'tr:has(td:text-is("Profit Factor")), tr:has-text("Profit factor")',
    "row_total_trades":  'tr:has(td:text-is("Total Closed Trades")), tr:has-text("Total trades")',
}

METRIC_ROWS = {
    "net_profit_pct":   ("row_net_profit",    2),   # cell idx 2 = All-trades % column
    "max_drawdown_pct": ("row_max_drawdown",  2),
    "win_rate_pct":     ("row_win_rate",      1),
    "profit_factor":    ("row_profit_factor", 1),
    "total_trades":     ("row_total_trades",  1),
}


# ─────────────────────────────────────────────────────────────────────────────
# 4) Search drivers — shared ask/tell interface, dedup via eval cache.
# ─────────────────────────────────────────────────────────────────────────────

Genome = tuple[int, ...]   # index into each ParamSpec.values


def genome_to_params(space: list[ParamSpec], g: Genome) -> dict[str, Any]:
    return {p.key: p.values[i] for p, i in zip(space, g)}


class BaseDriver:
    def __init__(self, space: list[ParamSpec], budget: int, seed: int = 7):
        self.space = space
        self.budget = budget
        self.rng = random.Random(seed)
        self.seen: dict[Genome, float] = {}

    def ask(self) -> Genome | None: ...
    def tell(self, g: Genome, score: float) -> None:
        self.seen[g] = score


class GridDriver(BaseDriver):
    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self._it = iter(itertools.product(*[range(len(p.values)) for p in self.space]))

    def ask(self) -> Genome | None:
        if len(self.seen) >= self.budget:
            return None
        for g in self._it:
            if g not in self.seen:
                return g
        return None


class RandomDriver(BaseDriver):
    def ask(self) -> Genome | None:
        if len(self.seen) >= self.budget:
            return None
        total = 1
        for p in self.space:
            total *= len(p.values)
        if len(self.seen) >= total:
            return None
        for _ in range(500):
            g = tuple(self.rng.randrange(len(p.values)) for p in self.space)
            if g not in self.seen:
                return g
        return None


class GADriver(BaseDriver):
    """Steady-state GA: seed random population, then tournament-select parents,
    uniform-crossover, per-gene mutation. Dedup against the eval cache."""

    def __init__(self, *a, pop_size: int = 12, mut_rate: float = 0.15, **kw):
        super().__init__(*a, **kw)
        self.pop_size = pop_size
        self.mut_rate = mut_rate

    def _random_genome(self) -> Genome:
        return tuple(self.rng.randrange(len(p.values)) for p in self.space)

    def _tournament(self, k: int = 3) -> Genome:
        pool = self.rng.sample(list(self.seen.items()), min(k, len(self.seen)))
        return max(pool, key=lambda kv: kv[1])[0]

    def ask(self) -> Genome | None:
        if len(self.seen) >= self.budget:
            return None
        if len(self.seen) < self.pop_size:               # seeding phase
            for _ in range(500):
                g = self._random_genome()
                if g not in self.seen:
                    return g
            return None
        for _ in range(500):                             # breeding phase
            a, b = self._tournament(), self._tournament()
            child = tuple(
                (self.rng.randrange(len(p.values))
                 if self.rng.random() < self.mut_rate
                 else (ai if self.rng.random() < 0.5 else bi))
                for p, ai, bi in zip(self.space, a, b))
            if child not in self.seen:
                return child
        return None


def make_driver(mode: str, space: list[ParamSpec], budget: int, seed: int) -> BaseDriver:
    return {"grid": GridDriver, "random": RandomDriver, "ga": GADriver}[mode](space, budget, seed=seed)


# ─────────────────────────────────────────────────────────────────────────────
# 5) TradingView page automation
# ─────────────────────────────────────────────────────────────────────────────

async def login_if_needed(page: Page, username: str, password: str) -> None:
    try:
        await page.wait_for_selector(SEL["user_menu_avatar"], timeout=6_000)
        return
    except PWTimeout:
        pass
    await page.click(SEL["sign_in_btn"])
    await page.click(SEL["email_tab"])
    await page.fill(SEL["username_input"], username)
    await page.fill(SEL["password_input"], password)
    await page.click(SEL["login_submit"])
    await page.wait_for_selector(SEL["user_menu_avatar"], timeout=45_000)


async def set_symbol(page: Page, symbol: str) -> None:
    await page.click(SEL["symbol_search_btn"])
    inp = page.locator(SEL["symbol_input"]).first
    await inp.fill(symbol)
    await page.keyboard.press("Enter")
    await page.wait_for_timeout(1_500)   # chart swap kick-off; report wait handles the rest


async def ensure_tester_open(page: Page) -> None:
    try:
        await page.wait_for_selector(SEL["backtesting_tab"], timeout=4_000)
    except PWTimeout:
        await page.click(SEL["bottom_panel_open"])
        await page.wait_for_selector(SEL["backtesting_tab"], timeout=15_000)
    await page.click(SEL["backtesting_tab"])
    try:
        await page.click(SEL["perf_summary_tab"], timeout=4_000)
    except PWTimeout:
        pass  # some layouts land on summary by default


async def open_settings(page: Page) -> Locator:
    title = page.locator(SEL["legend_title"]).first
    await title.hover()
    try:
        await page.click(SEL["legend_gear"], timeout=4_000)
    except PWTimeout:
        await title.dblclick()   # fallback: double-click legend opens settings
    dlg = page.locator(SEL["settings_dialog"])
    await dlg.wait_for(timeout=10_000)
    try:
        await page.click(SEL["inputs_tab"], timeout=3_000)
    except PWTimeout:
        pass
    return dlg


async def set_input_by_label(dlg: Locator, spec: ParamSpec, value: Any) -> None:
    """Find the label cell by exact text, then drive the control in the sibling cell."""
    cell = dlg.get_by_text(spec.label, exact=True).first
    await cell.wait_for(timeout=8_000)
    await cell.scroll_into_view_if_needed()

    if spec.kind == "bool":
        # checkbox lives inside/adjacent to the label element
        box = cell.locator("xpath=ancestor-or-self::label//input[@type='checkbox']").first
        if await box.count() == 0:
            box = cell.locator("xpath=ancestor::div[1]//input[@type='checkbox']").first
        checked = await box.is_checked()
        if checked != bool(value):
            await box.click(force=True)
        return

    # numeric input in the value cell that follows the label cell
    inp = cell.locator(
        "xpath=ancestor::div[contains(@class,'cell')][1]"
        "/following-sibling::div[1]//input").first
    if await inp.count() == 0:  # fallback: nearest input within the same row container
        inp = cell.locator("xpath=ancestor::div[2]//input").first
    await inp.click(click_count=3)          # select-all
    await inp.fill(str(value))
    await inp.press("Tab")                  # commit the field


async def report_fingerprint(page: Page) -> str:
    try:
        txt = await page.locator(SEL["report_container"]).first.inner_text(timeout=4_000)
    except (PWTimeout, Exception):
        txt = ""
    return hashlib.md5(txt.encode()).hexdigest()


async def wait_for_report_update(page: Page, prev_fp: str, timeout_s: float = 25.0) -> bool:
    """Explicit wait: poll the Performance Summary DOM until its text mutates.
    Returns False on timeout (params may have produced an identical report —
    caller decides whether to trust the read)."""
    deadline = asyncio.get_event_loop().time() + timeout_s
    while asyncio.get_event_loop().time() < deadline:
        await page.wait_for_timeout(300)
        if await report_fingerprint(page) != prev_fp:
            await page.wait_for_timeout(400)   # let the table finish rendering
            return True
    return False


async def read_metrics(page: Page) -> dict[str, float]:
    out: dict[str, float] = {}
    for key, (row_key, cell_idx) in METRIC_ROWS.items():
        try:
            row = page.locator(SEL[row_key]).first
            cells = row.locator("td")
            n = await cells.count()
            idx = min(cell_idx, max(0, n - 1))
            out[key] = parse_metric((await cells.nth(idx).inner_text(timeout=4_000)).strip())
        except (PWTimeout, Exception):
            out[key] = float("nan")
    if out.get("total_trades") == out.get("total_trades"):  # not nan
        out["total_trades"] = int(out["total_trades"])
    return out


async def evaluate_config(page: Page, space: list[ParamSpec], params: dict[str, Any]) -> dict[str, float]:
    dlg = await open_settings(page)
    for spec in space:
        await set_input_by_label(dlg, spec, params[spec.key])
    fp = await report_fingerprint(page)
    await page.click(SEL["ok_button"])
    updated = await wait_for_report_update(page, fp)
    metrics = await read_metrics(page)
    metrics["report_updated"] = 1.0 if updated else 0.0
    return metrics


# ─────────────────────────────────────────────────────────────────────────────
# 6) Per-symbol worker + persistence
# ─────────────────────────────────────────────────────────────────────────────

def results_path(symbol: str) -> Path:
    return RESULTS_DIR / f"runs_{symbol.replace(':', '_')}.jsonl"


def load_cache(symbol: str, space: list[ParamSpec]) -> dict[Genome, dict]:
    cache: dict[Genome, dict] = {}
    p = results_path(symbol)
    if not p.exists():
        return cache
    key_order = [s.key for s in space]
    for line in p.read_text().splitlines():
        try:
            rec = json.loads(line)
            g = tuple(rec["genome"])
            if list(rec.get("keys", [])) == key_order:
                cache[g] = rec
        except (json.JSONDecodeError, KeyError):
            continue
    return cache


def append_result(symbol: str, rec: dict) -> None:
    RESULTS_DIR.mkdir(exist_ok=True)
    with results_path(symbol).open("a") as f:
        f.write(json.dumps(rec) + "\n")


def export_best(symbol: str, space: list[ParamSpec], obj: Objective,
                cache: dict[Genome, dict], top_k: int = 5) -> Path:
    ranked = sorted(cache.values(), key=lambda r: r.get("score", float("-inf")), reverse=True)
    top = ranked[:top_k]
    template = {}
    if THREE_COMMAS_TEMPLATE.exists():
        try:
            template = json.loads(THREE_COMMAS_TEMPLATE.read_text())
        except json.JSONDecodeError:
            template = {"error": "template unparseable"}
    out = {
        "symbol": symbol,
        "generated_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "objective": {"dd_weight": obj.dd_weight, "min_trades": obj.min_trades},
        "param_keys": [s.key for s in space],
        "param_labels": {s.key: s.label for s in space},
        "top_configs": top,
        "three_commas_template": template,
        "note": "Apply top_configs[0]['params'] to the strategy inputs on this symbol, "
                "re-verify in the Strategy Tester, then attach the 3Commas alert.",
    }
    path = RESULTS_DIR / f"best_{symbol.replace(':', '_')}.json"
    path.write_text(json.dumps(out, indent=2))
    return path


async def run_symbol(ctx: BrowserContext, chart_url: str, symbol: str,
                     space: list[ParamSpec], mode: str, budget: int,
                     obj: Objective, sem: asyncio.Semaphore, seed: int) -> None:
    async with sem:
        page = await ctx.new_page()
        try:
            await page.goto(chart_url, wait_until="domcontentloaded", timeout=90_000)
            await page.wait_for_timeout(4_000)
            await set_symbol(page, symbol)
            await ensure_tester_open(page)

            driver = make_driver(mode, space, budget, seed)
            cache = load_cache(symbol, space)
            for g, rec in cache.items():          # warm-start the driver
                driver.tell(g, rec.get("score", float("-inf")))
            print(f"[{symbol}] resume: {len(cache)} cached evals; mode={mode} budget={budget}")

            while (g := driver.ask()) is not None:
                params = genome_to_params(space, g)
                try:
                    metrics = await evaluate_config(page, space, params)
                except (PWTimeout, Exception) as e:
                    print(f"[{symbol}] EVAL ERROR {params}: {type(e).__name__}: {e}")
                    driver.tell(g, float("-inf"))
                    continue
                score = obj.score(metrics)
                driver.tell(g, score)
                rec = {
                    "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                    "symbol": symbol, "genome": list(g),
                    "keys": [s.key for s in space],
                    "params": params, "metrics": metrics, "score": score,
                }
                cache[g] = rec
                append_result(symbol, rec)
                print(f"[{symbol}] {len(driver.seen):>3}/{budget}  "
                      f"net={metrics.get('net_profit_pct'):>7.2f}%  "
                      f"dd={metrics.get('max_drawdown_pct'):>6.2f}%  "
                      f"pf={metrics.get('profit_factor'):>5.2f}  "
                      f"score={score:>8.2f}  {params}")
                await page.wait_for_timeout(random.randint(400, 1_400))  # pacing jitter

            path = export_best(symbol, space, obj, cache)
            print(f"[{symbol}] DONE → {path}")
        finally:
            await page.close()


# ─────────────────────────────────────────────────────────────────────────────
# 7) Entry point
# ─────────────────────────────────────────────────────────────────────────────

async def amain(args: argparse.Namespace) -> None:
    symbols = [s.strip() for s in args.symbols.split(",") if s.strip()]
    obj = Objective(dd_weight=args.dd_weight, min_trades=args.min_trades)
    username = os.getenv("TV_USERNAME", "")
    password = os.getenv("TV_PASSWORD", "")

    async with async_playwright() as pw:
        browser: Browser = await pw.chromium.launch(headless=args.headless, slow_mo=60)
        if args.session and Path(args.session).exists():
            ctx = await browser.new_context(storage_state=args.session)
        else:
            ctx = await browser.new_context()
            boot = await ctx.new_page()
            await boot.goto(args.chart_url, wait_until="domcontentloaded", timeout=90_000)
            if not (username and password):
                raise SystemExit("Set TV_USERNAME / TV_PASSWORD or pass --session with saved state.")
            await login_if_needed(boot, username, password)
            if args.session:
                await ctx.storage_state(path=args.session)
            await boot.close()

        sem = asyncio.Semaphore(args.max_tabs)
        await asyncio.gather(*[
            run_symbol(ctx, args.chart_url, sym, PARAM_SPACE, args.mode,
                       args.budget, obj, sem, seed=17 + i)
            for i, sym in enumerate(symbols)
        ])
        await browser.close()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--chart-url", required=True, help="Your TradingView chart URL (strategy already on it)")
    ap.add_argument("--symbols", required=True, help="Comma-separated, e.g. BINANCE:APTUSDT,BINANCE:SOLUSDT")
    ap.add_argument("--mode", choices=["grid", "random", "ga"], default="ga")
    ap.add_argument("--budget", type=int, default=60, help="Max evaluations per symbol")
    ap.add_argument("--max-tabs", type=int, default=2, help="Concurrent symbol tabs")
    ap.add_argument("--dd-weight", type=float, default=1.5)
    ap.add_argument("--min-trades", type=int, default=8)
    ap.add_argument("--session", default="tv_session.json", help="Playwright storage-state file")
    ap.add_argument("--headless", action="store_true")
    args = ap.parse_args()
    asyncio.run(amain(args))


if __name__ == "__main__":
    main()
