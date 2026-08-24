#!/usr/bin/env python3
"""Incremental, low-memory result index and CLI shared by all optimizers."""
from __future__ import annotations

import glob
import hashlib
import json
import os
import sqlite3
from collections import Counter
import subprocess
import sys
from datetime import datetime

G, R, Y, C, B, DIM, END = "\033[92m", "\033[91m", "\033[93m", "\033[96m", "\033[1m", "\033[2m", "\033[0m"

PROFILES = {
    "optimizer1y15m": ("ONE-YEAR 15-MINUTE OPTIMIZER", "optyear-results", "optyear-apply", "com.alphaweb.ma-1y15m"),
    "optimizer1y1h": ("ONE-YEAR 1-HOUR OPTIMIZER", "opt1hyear-results", "opt1hyear-apply", "com.alphaweb.ma-1y1h"),
    "optimizer1y5m": ("ONE-YEAR MTF CONFLUENCE LEAN 5-MINUTE OPTIMIZER", "lean5m-results", "lean5m-apply", "com.alphaweb.lean-1y5m"),
    "lean_optimizer15m": ("ONE-YEAR MTF CONFLUENCE LEAN 15-MINUTE OPTIMIZER", "lean15m-results", "lean15m-apply", "com.alphaweb.lean-1y15m"),
    "optimizer1y5m_ma": ("ONE-YEAR MA + R:R 5-MINUTE OPTIMIZER", "ma5m-results", "ma5m-apply", "com.alphaweb.ma-1y5m"),
}


class ResultIndex:
    def __init__(self, here: str):
        self.here = here
        self.results = os.path.join(here, "results")
        self.index_dir = os.path.join(here, "index")
        os.makedirs(self.index_dir, exist_ok=True)
        self.db_path = os.path.join(self.index_dir, "leaderboard.sqlite3")
        self.db = sqlite3.connect(self.db_path, timeout=60)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=NORMAL")
        self.db.execute("PRAGMA temp_store=FILE")
        self.db.executescript("""
          CREATE TABLE IF NOT EXISTS meta (
            coin TEXT PRIMARY KEY, file_size INTEGER NOT NULL DEFAULT 0,
            line_count INTEGER NOT NULL DEFAULT 0
          );
          CREATE TABLE IF NOT EXISTS results (
            coin TEXT NOT NULL, genome BLOB NOT NULL, file_offset INTEGER NOT NULL,
            score REAL NOT NULL, net REAL, dd REAL, wr REAL, trades INTEGER, pf REAL,
            onet REAL, odd REAL, owr REAL, otr INTEGER, opf REAL,
                slr REAL, oslr REAL, slp REAL,
            PRIMARY KEY (coin, genome)
          ) WITHOUT ROWID;
          CREATE INDEX IF NOT EXISTS ix_score ON results(coin, score DESC, file_offset ASC);
        """)
        # The index is only a cache of results/*.jsonl. If it predates the
        # out-of-sample columns, drop it so the next sync rebuilds with them.
        cols = {r[1] for r in self.db.execute("PRAGMA table_info(results)")}
        if not {"onet", "odd", "owr", "otr", "opf", "slr", "oslr", "slp"} <= cols:
            self.db.executescript("DROP TABLE results; DROP TABLE IF EXISTS meta;")
            self.db.executescript("""
              CREATE TABLE meta (coin TEXT PRIMARY KEY, file_size INTEGER NOT NULL DEFAULT 0,
                                 line_count INTEGER NOT NULL DEFAULT 0);
              CREATE TABLE results (
                coin TEXT NOT NULL, genome BLOB NOT NULL, file_offset INTEGER NOT NULL,
                score REAL NOT NULL, net REAL, dd REAL, wr REAL, trades INTEGER, pf REAL,
                onet REAL, odd REAL, owr REAL, otr INTEGER, opf REAL,
                slr REAL, oslr REAL, slp REAL,
                PRIMARY KEY (coin, genome)
              ) WITHOUT ROWID;
              CREATE INDEX ix_score ON results(coin, score DESC, file_offset ASC);
            """)
            self.db.commit()

    def coins(self):
        return [os.path.basename(p)[:-6] for p in sorted(glob.glob(os.path.join(self.results, "*.jsonl")))]

    def sync(self, coin: str):
        coin = coin.upper().split(":")[-1]
        path = os.path.join(self.results, coin + ".jsonl")
        if not os.path.exists(path):
            return 0
        size = os.path.getsize(path)
        row = self.db.execute("SELECT file_size,line_count FROM meta WHERE coin=?", (coin,)).fetchone()
        start, lines = row if row else (0, 0)
        if size < start:
            self.db.execute("DELETE FROM results WHERE coin=?", (coin,))
            start, lines = 0, 0
        if size == start:
            return self.count(coin)

        with open(path, "rb") as fh:
            fh.seek(start)
            if start and start > 0:
                fh.seek(start - 1)
                if fh.read(1) != b"\n":
                    fh.readline()
                start = fh.tell()
            batch = []
            while True:
                offset = fh.tell()
                raw = fh.readline()
                if not raw:
                    break
                if not raw.endswith(b"\n"):
                    break  # writer is still completing this record
                lines += 1
                try:
                    rec = json.loads(raw)
                    score = rec.get("score")
                    genome = rec.get("genome") or []
                    if score is None or not genome:
                        continue
                    m = rec.get("metrics") or {}
                    genome_key = hashlib.blake2b(",".join(map(str, genome)).encode(), digest_size=16).digest()
                    batch.append((coin, genome_key, offset, float(score),
                                  m.get("net_pct"), m.get("dd_pct"), m.get("win_rate"),
                                  m.get("trades"), m.get("profit_factor"),
                                  m.get("oos_net_pct"), m.get("oos_dd_pct"),
                                  m.get("oos_win_rate"), m.get("oos_trades"),
                                  m.get("oos_profit_factor"),
                                  m.get("sl_loss_rate"), m.get("oos_sl_loss_rate"), m.get("sl_profit_rate")))
                except (json.JSONDecodeError, TypeError, ValueError):
                    continue
                if len(batch) >= 5000:
                    self.db.executemany("INSERT OR IGNORE INTO results VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", batch)
                    self.db.commit()
                    batch.clear()
            if batch:
                self.db.executemany("INSERT OR IGNORE INTO results VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", batch)
            end = fh.tell()
        self.db.execute("INSERT INTO meta(coin,file_size,line_count) VALUES(?,?,?) "
                        "ON CONFLICT(coin) DO UPDATE SET file_size=excluded.file_size,line_count=excluded.line_count",
                        (coin, end, lines))
        self.db.commit()
        return self.count(coin)

    def count(self, coin: str):
        return self.db.execute("SELECT count(*) FROM results WHERE coin=?", (coin,)).fetchone()[0]

    def raw_count(self, coin: str):
        row = self.db.execute("SELECT line_count FROM meta WHERE coin=?", (coin,)).fetchone()
        return row[0] if row else 0

    def read_record(self, coin: str, offset: int):
        with open(os.path.join(self.results, coin + ".jsonl"), "rb") as fh:
            fh.seek(offset)
            return json.loads(fh.readline())

    def ranked(self, coin: str, limit=10, offset=0, order="score DESC, file_offset ASC"):
        return self.db.execute(
            f"SELECT file_offset,score,net,dd,wr,trades,pf,slr,onet,odd,owr,otr,opf,oslr FROM results WHERE coin=? ORDER BY {order} LIMIT ? OFFSET ?",
            (coin, limit, offset)).fetchall()

    def original_rank(self, coin: str, score: float, offset: int):
        return self.db.execute(
            "SELECT 1+count(*) FROM results WHERE coin=? AND (score>? OR (score=? AND file_offset<?))",
            (coin, score, score, offset)).fetchone()[0]


def color_net(v):
    if v is None: return "     —"
    s = f"{v:+8.1f}%"
    return (G if v > 0 else R) + s + END


def verdict(net, onet):
    """Did the in-sample edge survive on data the optimiser never saw?"""
    if onet is None: return f"{DIM}  n/a{END}"
    if (net or 0) > 0 and onet > 0: return f"{G}  HELD{END}"
    if (net or 0) > 0 >= onet:      return f"{R}FAILED{END}"
    return f"{Y}  weak{END}"


def oos_cells(onet, odd, owr, otr, oslr=None):
    if onet is None:
        return f"  {'—':>9}  {'—':>7}  {'—':>6}  {'—':>6}  {'—':>6}"
    sl = f"{oslr:5.1f}%" if oslr is not None else f"{'—':>6}"
    return f"  {color_net(onet)}  {odd or 0:6.1f}%  {owr or 0:5.1f}%  {otr or 0:6}  {sl}"


def sl_cell(v):
    """Share of entries stopped out AT A LOSS — not merely 'the stop filled'."""
    return f"{v:7.1f}%" if v is not None else f"{'—':>8}"


def print_record(coin, rec, title, capital=None):
    m = rec.get("metrics") or {}
    print(f"\n{B}{C}  ══════ {coin} — {title} ══════{END}")
    print(f"   Found:        {DIM}{rec.get('ts','?')}{END}")
    cap = f"${capital:,.0f}" if capital else "the configured capital"
    print(f"   Profit:       {color_net(m.get('net_pct'))}   (${m.get('net_usdt','?')} on {cap})")
    print(f"   Max drawdown: {m.get('dd_pct','?')}%")
    print(f"   Win rate:     {m.get('win_rate','?')}% over {m.get('trades','?')} trades")
    if m.get("sl_loss_rate") is not None:
        print(f"   Stopped @loss:{m.get('sl_loss_rate')}% of entries ({m.get('sl_loss','?')} of {m.get('trades','?')})")
        print(f"   Stopped @gain:{m.get('sl_profit_rate')}% ({m.get('sl_profit','?')}) {DIM}trailing/BE stop locking in profit{END}")
        print(f"   Hit a TP:     {m.get('tp_hit','?')} entries")
    print(f"   Profit factor:{m.get('profit_factor','?')}   Score: {rec.get('score','?')}")
    onet = m.get("oos_net_pct")
    if onet is not None:
        print(f"\n{B}   OUT-OF-SAMPLE{END} {DIM}(never seen by the optimiser){END}   {verdict(m.get('net_pct'), onet)}")
        print(f"   Profit:       {color_net(onet)}")
        print(f"   Max drawdown: {m.get('oos_dd_pct','?')}%")
        print(f"   Win rate:     {m.get('oos_win_rate','?')}% over {m.get('oos_trades','?')} trades")
        if m.get("oos_sl_loss_rate") is not None:
            print(f"   Stopped @loss:{m.get('oos_sl_loss_rate')}% of entries ({m.get('oos_sl_loss','?')} of {m.get('oos_trades','?')})")
            print(f"   Stopped @gain:{m.get('oos_sl_profit_rate')}% ({m.get('oos_sl_profit','?')})")
            print(f"   Hit a TP:     {m.get('oos_tp_hit','?')} entries")
        print(f"   Profit factor:{m.get('oos_profit_factor','?')}")
    print()
    print(f"{B}   INPUTS:{END}")
    for k, v in (rec.get("params") or {}).items():
        print(f"     {k:<24} = {v}")
    print()


def total_raw_backtests(results_dir: str) -> int:
    """Exact cached newline count; after first run only appended bytes are read."""
    files = sorted(glob.glob(os.path.join(results_dir, "*.jsonl")))
    if not files:
        return 0
    cache_path = os.path.join(os.path.dirname(results_dir), "index", "raw_counts.json")
    try: cache = json.load(open(cache_path))
    except (OSError, json.JSONDecodeError): cache = {}
    live = {}
    total = 0
    for path in files:
        name, size = os.path.basename(path), os.path.getsize(path)
        prior = cache.get(name) or {}
        old_size, count = int(prior.get("size", 0)), int(prior.get("count", 0))
        if size < old_size:
            old_size, count = 0, 0
        if size > old_size:
            with open(path, "rb") as fh:
                fh.seek(old_size)
                count += sum(chunk.count(b"\n") for chunk in iter(lambda: fh.read(8 * 1024 * 1024), b""))
        live[name] = {"size": size, "count": count}
        total += count
    os.makedirs(os.path.dirname(cache_path), exist_ok=True)
    tmp = cache_path + ".tmp"
    with open(tmp, "w") as fh: json.dump(live, fh, separators=(",", ":"))
    os.replace(tmp, cache_path)
    return total


def show_robust(idx, here, coin, command, apply_cmd, sample=40):
    """Is a coin's edge a broad plateau or a single lucky point?

    Takes the top `sample` configs that made money in BOTH windows and asks, for
    each parameter, whether the survivors agree on a value. Concentration is
    measured as a Z-SCORE against chance, not as a raw share: agreeing 95% of the
    time on a two-way switch and 55% of the time on a seven-way parameter are
    both strong signals, and only a significance test makes them comparable.
    z = (count - n*p0) / sqrt(n*p0*(1-p0)), with p0 = 1/number-of-options.

    A parameter the survivors agree on is a real effect. One they scatter across
    does not matter — and whatever value your chosen row happens to have for it
    is noise you should not read anything into.
    """
    rows = idx.db.execute("""
        SELECT file_offset, net, onet FROM results
        WHERE coin=? AND net>0 AND onet>0
        ORDER BY min(net,onet) DESC, score DESC LIMIT ?
    """, (coin, sample)).fetchall()
    if len(rows) < 8:
        print(f"\n  {coin}: only {len(rows)} configs held both windows — too few to judge robustness.")
        print(f"  {DIM}Let the optimiser run longer, or check '{command} {coin} held'.{END}\n")
        return
    try:
        space = {x["name"]: x["values"]
                 for x in json.load(open(os.path.join(here, "params.json")))["parameters"]}
    except (OSError, json.JSONDecodeError, KeyError):
        space = {}

    recs = [idx.read_record(coin, r[0]) for r in rows]
    n = len(recs)
    total = idx.db.execute("SELECT count(*) FROM results WHERE coin=? AND onet IS NOT NULL", (coin,)).fetchone()[0]
    held = idx.db.execute("SELECT count(*) FROM results WHERE coin=? AND net>0 AND onet>0", (coin,)).fetchone()[0]

    print(f"\n{B}{C}  ══════ {coin} — ROBUSTNESS OF THE TOP {n} SURVIVORS ══════{END}")
    print(f"   {held:,} of {total:,} configs held both windows ({100*held/max(total,1):.0f}%)")
    if total and held / total > 0.5:
        print(f"   {Y}note: a majority of configs pass, so HELD is weak evidence for this coin/period.{END}")
    print(f"   {DIM}z = how many standard deviations the survivors' agreement is above chance.{END}\n")
    print(f"{B}      {'PARAM':16s}{'MODAL':>8}{'SHARE':>8}{'z':>7}   {'':22s}VERDICT{END}")

    strong, leaning = {}, {}
    for name in [x["name"] for x in json.load(open(os.path.join(here, "params.json")))["parameters"]] if space else []:
        vals = [str(r["params"].get(name)) for r in recs]
        c = Counter(vals)
        top_val, top_n = c.most_common(1)[0]
        share = top_n / n
        k = max(len(space.get(name, [])), 2)
        p0 = 1.0 / k
        sd = (n * p0 * (1 - p0)) ** 0.5
        z = (top_n - n * p0) / sd if sd > 0 else 0.0
        bar = "#" * min(22, int(22 * min(z / 6.0, 1.0)))
        if z >= 3.0:
            tag, col = "STRONG", G; strong[name] = top_val
        elif z >= 1.8:
            tag, col = "leaning", Y; leaning[name] = top_val
        else:
            tag, col = "no signal", DIM
        print(f"      {name:16s}{top_val:>8}{share*100:>7.0f}%{z:>7.1f}   {bar:<22s}{col}{tag}{END}")

    print(f"\n{B}   PLATEAU CONFIG{END} {DIM}— modal value of every parameter the survivors agree on.{END}")
    print(f"   {DIM}Expect this to rank BELOW row #1; it is likelier to survive next month.{END}")
    for k_, v in {**strong, **leaning}.items():
        print(f"     {k_:16s} = {v}")
    undecided = [x["name"] for x in json.load(open(os.path.join(here, "params.json")))["parameters"]
                 if x["name"] not in strong and x["name"] not in leaning] if space else []
    if undecided:
        print(f"   {DIM}no signal (any value is fine, do not tune these): {', '.join(undecided)}{END}")
    print(f"\n   {DIM}Configs: {command} {coin} held   |   Apply one: {apply_cmd} {coin}:ORIG#{END}\n")


def show(here: str):
    family = os.path.basename(here)
    try:
        _capital = json.load(open(os.path.join(here, "config.json"))).get("initialCapital")
    except (OSError, json.JSONDecodeError):
        _capital = None
    title, command, apply_cmd, service_label = PROFILES[family]
    idx = ResultIndex(here)
    args = sys.argv[1:]
    if not args:
        rows = []
        for best_path in sorted(glob.glob(os.path.join(here, "best", "*.json"))):
            coin = os.path.basename(best_path)[:-5]
            try:
                best = json.load(open(best_path))
                m = best.get("metrics") or {}
                oos = ((m.get("oos_net_pct"), m.get("oos_dd_pct"), m.get("oos_win_rate"),
                        m.get("oos_trades"), m.get("oos_sl_loss_rate"))
                       if m.get("oos_net_pct") is not None else None)
                rows.append((coin, best.get("score"), m.get("net_pct"), m.get("dd_pct"),
                             m.get("win_rate"), m.get("trades"), m.get("profit_factor"), idx.count(coin), oos,
                             m.get("sl_loss_rate")))
            except (OSError, json.JSONDecodeError):
                continue
        rows.sort(key=lambda r: r[1] if r[1] is not None else -1e18, reverse=True)
        running = subprocess.run(["launchctl", "print", f"gui/{os.getuid()}/{service_label}"],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
        total = total_raw_backtests(idx.results)
        print(f"\n{B}{C}  ══════ {title} — BEST RESULTS ══════{END}")
        print(f"   {DIM}left of the bar = IN-SAMPLE (what the GA optimised); right = OUT-OF-SAMPLE (never seen by the search){END}")
        print(f"   Bot: {(G+'● RUNNING' if running else R+'○ STOPPED')+END}   "
              f"Total backtests: {B}{total:,}{END}   Updated: {datetime.now():%b %d, %H:%M}")
        print(f"{B}      {'COIN':<13}{'PROFIT':>9}  {'MAX DD':>7}  {'WIN%':>6}  {'TRADES':>6}  {'PF':>5}"
              f"  {'SLloss%':>8}  {DIM}|{END}{B}  {'OOS NET':>9}  {'OOS DD':>7}  {'OOS WR':>6}  {'OOS TR':>6}  {'OOSSLl%':>8}  {'HOLD?':>6}{END}")
        for coin, score, net, dd, wr, trades, pf, unique, orow, slr in rows:
            onet, odd, owr, otr, oslr = (orow or (None, None, None, None, None))
            print(f"      {coin:<13}{color_net(net)}  {dd or 0:6.1f}%  {wr or 0:5.1f}%  {trades or 0:6}  {pf or 0:5.2f}"
                  f"  {sl_cell(slr)}  {DIM}|{END}{oos_cells(onet, odd, owr, otr, oslr)}  {verdict(net, onet)}")
        print()
        return

    coin = args[0].upper().split(":")[-1]
    idx.sync(coin)
    mode = args[1].lower() if len(args) > 1 else None
    count = idx.count(coin)
    if not count:
        print(f"No indexed results for {coin}.")
        return

    if mode and mode.isdigit():
        rank = int(mode)
        row = idx.ranked(coin, 1, rank - 1)
        if not row: print(f"{coin} has {count} ranked results — pick 1..{count}"); return
        print_record(coin, idx.read_record(coin, row[0][0]), f"RANK #{rank} RESULT", _capital)
        print(f"   {DIM}Apply: {apply_cmd} {coin}:{rank}{END}\n")
        return

    orders = {
        "dd": ("MAX DD (lowest first)", "dd IS NULL, dd ASC, score DESC, file_offset ASC"),
        "wr": ("WIN RATE (highest first)", "wr IS NULL, wr DESC, score DESC, file_offset ASC"),
        "pf": ("PROFIT FACTOR (highest first)", "pf IS NULL, pf DESC, score DESC, file_offset ASC"),
        "net": ("PROFIT (highest first)", "net IS NULL, net DESC, score DESC, file_offset ASC"),
        "trades": ("TRADES (most first)", "trades IS NULL, trades DESC, score DESC, file_offset ASC"),
        # Out-of-sample orderings — rank by how the config did on unseen data.
        "oos": ("OUT-OF-SAMPLE PROFIT (highest first)", "onet IS NULL, onet DESC, score DESC, file_offset ASC"),
        "oosdd": ("OUT-OF-SAMPLE MAX DD (lowest first)", "odd IS NULL, odd ASC, onet DESC, file_offset ASC"),
        "ooswr": ("OUT-OF-SAMPLE WIN RATE (highest first)", "owr IS NULL, owr DESC, onet DESC, file_offset ASC"),
        "sl": ("STOPPED-AT-A-LOSS RATE (lowest first)", "slr IS NULL, slr ASC, score DESC, file_offset ASC"),
        "oossl": ("OUT-OF-SAMPLE STOPPED-AT-A-LOSS RATE (lowest first)", "oslr IS NULL, oslr ASC, onet DESC, file_offset ASC"),
        "oospf": ("OUT-OF-SAMPLE PROFIT FACTOR (highest first)", "opf IS NULL, opf DESC, onet DESC, file_offset ASC"),
        "oostrades": ("OUT-OF-SAMPLE TRADES (most first)", "otr IS NULL, otr DESC, onet DESC, file_offset ASC"),
    }
    if mode == "robust":
        show_robust(idx, here, coin, command, apply_cmd,
                    int(args[2]) if len(args) > 2 and args[2].isdigit() else 40)
        return

    if mode == "held":
        # Only configs that made money BOTH in-sample and out-of-sample, ranked by
        # the weaker of the two profits — a config is worth no more than its worst half.
        rows = idx.db.execute("""
          WITH ranked AS (
            SELECT *, row_number() OVER (ORDER BY score DESC,file_offset ASC) AS orig
            FROM results WHERE coin=?
          ) SELECT file_offset,score,net,dd,wr,trades,pf,slr,onet,odd,owr,otr,opf,oslr,orig
            FROM ranked WHERE net>0 AND onet>0
            ORDER BY min(net,onet) DESC, score DESC LIMIT 500
        """, (coin,)).fetchall()
        label = "HELD OUT-OF-SAMPLE (ranked by weaker half)"
    elif mode in ("best", "balanced", "combo"):
        rows = idx.db.execute("""
          WITH ranked AS (
            SELECT *, row_number() OVER (ORDER BY score DESC,file_offset ASC) AS orig
            FROM results WHERE coin=?
          ), p AS (
            SELECT *,
              (1.0-percent_rank() OVER (ORDER BY dd ASC)) +
              percent_rank() OVER (ORDER BY net ASC) +
              percent_rank() OVER (ORDER BY wr ASC) +
              percent_rank() OVER (ORDER BY pf ASC) AS combo
            FROM ranked WHERE dd IS NOT NULL AND net IS NOT NULL AND wr IS NOT NULL AND pf IS NOT NULL
          ) SELECT file_offset,score,net,dd,wr,trades,pf,slr,onet,odd,owr,otr,opf,oslr,orig,combo FROM p ORDER BY combo DESC,score DESC LIMIT 500
        """, (coin,)).fetchall()
        label = "BALANCED (DD + NET + WR + PF)"
    elif mode in orders:
        label, order = orders[mode]
        rows = idx.db.execute(f"""
          WITH ranked AS (
            SELECT file_offset,score,net,dd,wr,trades,pf,slr,onet,odd,owr,otr,opf,oslr,
                   row_number() OVER (ORDER BY score DESC,file_offset ASC) AS orig
            FROM results WHERE coin=?
          ) SELECT * FROM ranked ORDER BY {order} LIMIT 500
        """, (coin,)).fetchall()
    else:
        label = "OVERALL SCORE"
        rows = [(*r, n) for n, r in enumerate(idx.ranked(coin, 10), 1)]

    print(f"\n{B}{C}  ══════ {coin} — TOP {len(rows)} BY {label} ══════{END}")
    print(f"   {DIM}left of the bar = IN-SAMPLE (what the GA optimised); right = OUT-OF-SAMPLE (never seen){END}")
    print(f"{B}      {'#':<6}{'ORIG#':<8}{'PROFIT':>9}  {'MAX DD':>7}  {'WIN%':>6}  {'TRADES':>6}  {'PF':>5}"
          f"  {'SLloss%':>8}  {DIM}|{END}{B}  {'OOS NET':>9}  {'OOS DD':>7}  {'OOS WR':>6}  {'OOS TR':>6}  {'OOSSLl%':>8}  {'HOLD?':>6}{END}")
    for n, row in enumerate(rows, 1):
        off, score, net, dd, wr, trades, pf, slr, onet, odd, owr, otr, opf, oslr, orig = row[:15]
        print(f"      {n:<6}{orig:<8}{color_net(net)}  {dd or 0:6.1f}%  {wr or 0:5.1f}%  {trades or 0:6}  {pf or 0:5.2f}"
              f"  {sl_cell(slr)}  {DIM}|{END}{oos_cells(onet, odd, owr, otr, oslr)}  {verdict(net, onet)}")
    print(f"\n   {DIM}{count} unique configs indexed from {idx.raw_count(coin)} preserved raw evaluations.{END}")
    print(f"   {DIM}Inputs: {command} {coin} ORIG#   |   Apply: {apply_cmd} {coin}:ORIG#{END}")
    print(f"   {DIM}Sort: net | dd | wr | pf | trades | best   ·   out-of-sample: oos | oosdd | ooswr | oospf | oostrades | sl | oossl | held | robust{END}\n")
