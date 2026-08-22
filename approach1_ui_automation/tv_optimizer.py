#!/usr/bin/env python3
"""
Approach 1 — UI-Based TradingView Strategy Optimizer
=====================================================
Uses Playwright to drive the TradingView browser, cycle through parameter
combinations, and scrape the Strategy Tester performance summary tab.

Limitations vs. Approach 2:
  - ~15-30 s per parameter combination (browser waits, chart recalc)
  - TradingView DOM selectors drift with every TV deployment — update SELECTORS
  - Requires TradingView Pro/Premium account (Strategy Tester access)
  - Only tests the exact Pine strategy already loaded on your chart

Usage:
  # One-time setup
  pip install -r requirements.txt
  playwright install chromium

  # Run
  python tv_optimizer.py

  # Or with a saved session (avoids login every run):
  python tv_optimizer.py --session tv_session.json

Environment variables (or set directly in TVConfig below):
  TV_USERNAME   your TradingView username / email
  TV_PASSWORD   your TradingView password
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import itertools
import os
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from playwright.async_api import (
    Browser,
    Page,
    Playwright,
    TimeoutError as PWTimeout,
    async_playwright,
)

load_dotenv()


# ─────────────────────────────────────────────────────────────────────────────
# User configuration
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class TVConfig:
    # Chart URL — copy from your TradingView browser tab
    chart_url: str = "https://www.tradingview.com/chart/REPLACE_WITH_YOUR_CHART_ID/"

    # Credentials (prefer env vars TV_USERNAME / TV_PASSWORD over hardcoding)
    username: str = field(default_factory=lambda: os.getenv("TV_USERNAME", ""))
    password: str = field(default_factory=lambda: os.getenv("TV_PASSWORD", ""))

    symbol: str = "BTCUSDT"
    timeframe: str = "5"           # TradingView interval in minutes: "1","5","15","60","240"

    output_csv: str = "tv_results.csv"

    # Milliseconds to wait after clicking OK for the chart to recalculate.
    # Increase if your internet is slow or the strategy is complex.
    recalc_wait_ms: int = 4000

    headless: bool = False         # False = see the browser (easier to debug)
    slow_mo_ms: int = 80           # Slows every action slightly — helps stability


# ─────────────────────────────────────────────────────────────────────────────
# Parameter sweep definition
# ─────────────────────────────────────────────────────────────────────────────
# Each entry is (input_index_in_dialog, label, [values_to_test]).
# input_index is 0-based within the "Inputs" tab of the strategy settings dialog.
# Run with headless=False and inspect the settings dialog to find the correct indices.

PARAM_SWEEP = [
    # (dialog_input_index, human_label, list_of_values)
    (0,  "touch_atr_mult",       [0.50, 0.65, 0.85, 1.0]),
    (5,  "retest_confirm_bars",  [6, 10, 16, 25]),
    (9,  "sl_atr",               [0.6, 0.8, 1.0, 1.2]),
    (10, "tp_r",                 [1.75, 2.25, 3.0]),
    (11, "trail_trigger_r",      [0.5, 1.0, 1.5]),
]

# Total combinations = product of all value list lengths
# Above example: 4 × 4 × 4 × 3 × 3 = 576 combinations — expect ~4-5 hours runtime


# ─────────────────────────────────────────────────────────────────────────────
# TradingView DOM selectors
# UPDATE THESE if Playwright can't find elements after a TradingView deployment.
# Use Chrome DevTools (F12 → Inspector) to find current selectors.
# ─────────────────────────────────────────────────────────────────────────────

SEL = {
    # ── Login ──────────────────────────────────────────────────────────────────
    "sign_in_btn":       'button[data-name="header-user-menu-sign-in"]',
    "email_tab":         '[data-tab="Email"]',
    "username_input":    'input[name="username"]',
    "password_input":    'input[name="password"]',
    "login_submit":      'button[type="submit"]',
    "user_menu_avatar":  '[data-name="header-user-menu-button"]',  # confirms login

    # ── Bottom panel / Strategy Tester ────────────────────────────────────────
    "bottom_panel_open": 'button[data-name="toggle-visibility-button"]',
    "backtesting_tab":   '[data-id="backtesting"]',
    "perf_summary_tab":  '[data-value="performance-summary"]',

    # ── Strategy legend → Settings ───────────────────────────────────────────
    # The gear icon that appears on hover over the script name in the chart legend
    "legend_script":     '.chart-controls-bar .chart-markup-table .pane-legend-title',
    "legend_gear":       '[data-name="legend-settings-action"]',

    # ── Settings dialog ───────────────────────────────────────────────────────
    "settings_dialog":   '[data-name="indicator-properties-dialog"]',
    "inputs_tab":        '[data-value="inputs"]',
    "number_inputs":     'input[inputmode="numeric"], input[type="number"]',
    "ok_button":         'button[data-name="submit-button"]',

    # ── Results cells (Performance Summary table) ────────────────────────────
    # TradingView renders a two-column table: label | value.
    # These selectors grab the row, then we read the adjacent value cell.
    "row_net_profit":      'tr:has(td:text-is("Net Profit"))',
    "row_max_drawdown":    'tr:has(td:text-is("Max Drawdown"))',
    "row_win_rate":        'tr:has(td:text-is("Percent Profitable"))',
    "row_profit_factor":   'tr:has(td:text-is("Profit Factor"))',
}


# ─────────────────────────────────────────────────────────────────────────────
# Result dataclass
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class TVResult:
    timestamp: str
    params: dict[str, Any]
    net_profit_pct: str
    max_drawdown_pct: str
    win_rate_pct: str
    profit_factor: str
    error: str = ""


# ─────────────────────────────────────────────────────────────────────────────
# Core automation helpers
# ─────────────────────────────────────────────────────────────────────────────

async def login(page: Page, cfg: TVConfig) -> None:
    """Log in to TradingView. Skipped if already logged in."""
    try:
        await page.wait_for_selector(SEL["user_menu_avatar"], timeout=5_000)
        print("  Already logged in.")
        return
    except PWTimeout:
        pass

    print("  Logging in …")
    await page.click(SEL["sign_in_btn"])
    await page.click(SEL["email_tab"])
    await page.fill(SEL["username_input"], cfg.username)
    await page.fill(SEL["password_input"], cfg.password)
    await page.click(SEL["login_submit"])
    await page.wait_for_selector(SEL["user_menu_avatar"], timeout=30_000)
    print("  Login successful.")


async def ensure_strategy_tester_open(page: Page) -> None:
    """Open the bottom panel and navigate to the Strategy Tester tab."""
    try:
        await page.wait_for_selector(SEL["backtesting_tab"], timeout=3_000)
    except PWTimeout:
        await page.click(SEL["bottom_panel_open"])
        await page.wait_for_selector(SEL["backtesting_tab"], timeout=10_000)

    await page.click(SEL["backtesting_tab"])
    await page.click(SEL["perf_summary_tab"])


async def open_settings_dialog(page: Page) -> None:
    """Hover over the script legend and click the gear icon."""
    legend = page.locator(SEL["legend_script"]).first
    await legend.hover()
    await page.click(SEL["legend_gear"])
    await page.wait_for_selector(SEL["settings_dialog"], timeout=10_000)
    await page.click(SEL["inputs_tab"])


async def set_number_input(page: Page, index: int, value: float) -> None:
    """Set a numeric input field by its 0-based position in the Inputs tab."""
    inputs = page.locator(SEL["number_inputs"])
    count = await inputs.count()
    if index >= count:
        raise IndexError(f"Input index {index} out of range (dialog has {count} inputs)")
    inp = inputs.nth(index)
    await inp.triple_click()
    await inp.type(str(value))


async def apply_settings(page: Page, cfg: TVConfig) -> None:
    """Click OK and wait for the chart to recalculate."""
    await page.click(SEL["ok_button"])
    await page.wait_for_timeout(cfg.recalc_wait_ms)


async def _read_row_value(page: Page, row_selector: str) -> str:
    """Read the value cell text from a two-column result row."""
    try:
        row = page.locator(row_selector).first
        cells = row.locator("td")
        # Column layout: [label] [all_trades_value] [long_value] [short_value]
        # We want index 1 — All Trades column
        value = await cells.nth(1).inner_text(timeout=5_000)
        return value.strip()
    except PWTimeout:
        return "N/A"


async def read_results(page: Page) -> dict[str, str]:
    """Scrape the Performance Summary tab for the four key metrics."""
    # Ensure we are on the summary tab
    await page.click(SEL["perf_summary_tab"])
    await page.wait_for_timeout(500)

    return {
        "net_profit_pct":    await _read_row_value(page, SEL["row_net_profit"]),
        "max_drawdown_pct":  await _read_row_value(page, SEL["row_max_drawdown"]),
        "win_rate_pct":      await _read_row_value(page, SEL["row_win_rate"]),
        "profit_factor":     await _read_row_value(page, SEL["row_profit_factor"]),
    }


# ─────────────────────────────────────────────────────────────────────────────
# CSV writer
# ─────────────────────────────────────────────────────────────────────────────

def build_fieldnames(sweep: list[tuple]) -> list[str]:
    param_cols = [label for _, label, _ in sweep]
    return (
        ["timestamp"]
        + param_cols
        + ["net_profit_pct", "max_drawdown_pct", "win_rate_pct", "profit_factor", "error"]
    )


def write_result(csv_path: Path, fieldnames: list[str], result: TVResult) -> None:
    row = {"timestamp": result.timestamp, **result.params,
           "net_profit_pct": result.net_profit_pct,
           "max_drawdown_pct": result.max_drawdown_pct,
           "win_rate_pct": result.win_rate_pct,
           "profit_factor": result.profit_factor,
           "error": result.error}
    file_exists = csv_path.exists()
    with csv_path.open("a", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        if not file_exists:
            writer.writeheader()
        writer.writerow(row)


# ─────────────────────────────────────────────────────────────────────────────
# Main optimization loop
# ─────────────────────────────────────────────────────────────────────────────

async def run_optimization(cfg: TVConfig, sweep: list[tuple], session_file: str | None) -> None:
    fieldnames = build_fieldnames(sweep)
    csv_path   = Path(cfg.output_csv)

    # Build all combinations
    all_combos = list(itertools.product(*[values for _, _, values in sweep]))
    labels     = [label for _, label, _ in sweep]
    indices    = [idx for idx, _, _ in sweep]
    total      = len(all_combos)
    print(f"\nTotal combinations to test: {total}")
    print(f"Estimated runtime: {total * (cfg.recalc_wait_ms / 1000 + 20):.0f}s "
          f"(~{total * (cfg.recalc_wait_ms / 1000 + 20) / 3600:.1f}h)\n")

    # Resume: skip already-tested combos
    tested: set[tuple] = set()
    if csv_path.exists():
        import pandas as pd
        done = pd.read_csv(csv_path)
        for _, row in done.iterrows():
            tested.add(tuple(row[labels]))
        print(f"Resuming — {len(tested)} combinations already in {csv_path}")

    async with async_playwright() as pw:
        launch_opts: dict = {"headless": cfg.headless, "slow_mo": cfg.slow_mo_ms}
        browser: Browser = await pw.chromium.launch(**launch_opts)

        # Load saved session state if provided (avoids re-login)
        if session_file and Path(session_file).exists():
            ctx = await browser.new_context(storage_state=session_file)
        else:
            ctx = await browser.new_context()

        page: Page = await ctx.new_page()
        await page.goto(cfg.chart_url, wait_until="networkidle", timeout=60_000)

        if not session_file or not Path(session_file).exists():
            await login(page, cfg)
            if session_file:
                await ctx.storage_state(path=session_file)
                print(f"  Session saved to {session_file}")

        await ensure_strategy_tester_open(page)

        for n, combo in enumerate(all_combos, 1):
            param_dict = dict(zip(labels, combo))

            if combo in tested:
                print(f"[{n}/{total}] Skip (already tested): {param_dict}")
                continue

            print(f"[{n}/{total}] Testing: {param_dict}")
            error_msg = ""
            metrics   = {"net_profit_pct": "ERR", "max_drawdown_pct": "ERR",
                         "win_rate_pct": "ERR", "profit_factor": "ERR"}

            try:
                await open_settings_dialog(page)

                for idx, value in zip(indices, combo):
                    await set_number_input(page, idx, value)

                await apply_settings(page, cfg)
                metrics = await read_results(page)

                print(f"       → Net%={metrics['net_profit_pct']}  "
                      f"DD={metrics['max_drawdown_pct']}  "
                      f"WR={metrics['win_rate_pct']}  "
                      f"PF={metrics['profit_factor']}")

            except PWTimeout as e:
                error_msg = f"Timeout: {e}"
                print(f"       ! {error_msg}")
            except Exception as e:
                error_msg = f"{type(e).__name__}: {e}"
                print(f"       ! {error_msg}")

            result = TVResult(
                timestamp=datetime.utcnow().isoformat(timespec="seconds"),
                params=param_dict,
                error=error_msg,
                **metrics,
            )
            write_result(csv_path, fieldnames, result)

        await browser.close()

    print(f"\nDone. Results saved to {csv_path}")


# ─────────────────────────────────────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────────────────────────────────────

def main() -> None:
    ap = argparse.ArgumentParser(description="TradingView UI-based strategy optimizer")
    ap.add_argument("--session", default=None,
                    help="Path to a Playwright session JSON file (saves/loads login state)")
    ap.add_argument("--chart-url", default=None, help="Override TVConfig.chart_url")
    ap.add_argument("--headless",  action="store_true", help="Run browser headlessly")
    args = ap.parse_args()

    cfg = TVConfig()
    if args.chart_url:
        cfg.chart_url = args.chart_url
    if args.headless:
        cfg.headless = True

    if not cfg.username or not cfg.password:
        print("ERROR: Set TV_USERNAME and TV_PASSWORD env vars (or edit TVConfig).")
        return
    if "REPLACE_WITH" in cfg.chart_url:
        print("ERROR: Set chart_url in TVConfig to your actual TradingView chart URL.")
        return

    asyncio.run(run_optimization(cfg, PARAM_SWEEP, args.session))


if __name__ == "__main__":
    main()
