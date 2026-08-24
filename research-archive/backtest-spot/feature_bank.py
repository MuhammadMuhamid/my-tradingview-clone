"""
Precomputes all indicator columns once per unique parameter value.
Avoids recomputing slow operations (pivot scans, LinReg) for every random sample.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd

from strategy_sim import (
    StrategyParams,
    align_htf_to_5m,
    atr,
    ema,
    hh_structure_bool,
    last_pivot_high,
    last_pivot_low,
    linreg_series,
    sma,
    supertrend,
    vwma,
)


class FeatureBank:
    def __init__(
        self,
        frames: dict[str, pd.DataFrame],
        search: dict[str, list[Any]],
        fixed: StrategyParams | None = None,
    ) -> None:
        self.frames = frames
        self.df5   = frames["5m"]

        self.pivots:    dict[tuple[str, int], pd.Series] = {}
        self.mas:       dict[tuple[str, int], pd.Series] = {}
        self.vwmas:     dict[int, pd.Series]             = {}
        self.lrs:       dict[int, pd.Series]             = {}
        self.lrs_open:  dict[tuple[str, int], pd.Series] = {}      # open-based LinReg (for green-candle filter)
        self.sts:       dict[tuple[int, float], tuple]   = {}
        self.atrs:      dict[int, pd.Series]             = {}
        self.emas:      dict[int, pd.Series]             = {}      # NEW local EMAs on 5m
        self.vol_mas:   dict[int, pd.Series]             = {}      # NEW volume SMAs
        self.hh_structs:dict[int, pd.Series]             = {}      # NEW HH structure on 15m

        # ── Pivot lows ──────────────────────────────────────────────────────
        piv_keys: set[int] = set()
        for k in ("piv_len_5", "piv_len_15", "piv_len_60", "piv_len_240"):
            piv_keys.update(search.get(k, []))
        if fixed:
            piv_keys.update([
                fixed.piv_len_5, fixed.piv_len_15,
                fixed.piv_len_60, fixed.piv_len_240,
            ])
        for plen in piv_keys:
            self.pivots[("5m",  plen)] = last_pivot_low(self.df5,        plen, plen)
            self.pivots[("15m", plen)] = align_htf_to_5m(
                self.df5, frames["15m"].assign(s=last_pivot_low(frames["15m"], plen, plen)), "s")
            self.pivots[("1h",  plen)] = align_htf_to_5m(
                self.df5, frames["1h"].assign(s=last_pivot_low(frames["1h"],  plen, plen)), "s")
            self.pivots[("4h",  plen)] = align_htf_to_5m(
                self.df5, frames["4h"].assign(s=last_pivot_low(frames["4h"],  plen, plen)), "s")

        # ── SMAs (MA trend: 1m + 1h) ─────────────────────────────────────────
        # 1m data: shift lookup by 4 minutes so the 5m bar at 09:00 picks up
        # the 1m bar at 09:04 (the last bar before the 5m bar closes at 09:05).
        # This matches Pine's request.security() which delivers the 1m value that
        # was confirmed at the 5m bar close — not at the 5m bar open.
        _1m_close_offset = pd.Timedelta("4min")
        # 1h MA: shift 5m lookup back 1 minute so the 5m bar that OPENS at the same
        # time as a 1h bar picks up the PREVIOUS (confirmed) 1h bar's MA value, not
        # the just-opened 1h bar.  This matches Pine's barmerge.lookahead_off semantics:
        # the 1h bar at 09:00 only becomes visible on the 5m chart after 09:55 closes.
        _1h_prior_offset = pd.Timedelta("-1min")
        ma_lens: set[int] = set(search.get("ma1_len", [])) | set(search.get("ma3_len", []))
        if fixed:
            ma_lens |= {fixed.ma1_len, fixed.ma3_len}
        for mlen in ma_lens:
            self.mas[("1m", mlen)] = align_htf_to_5m(
                self.df5, frames["1m"].assign(m=sma(frames["1m"]["close"], mlen)), "m",
                close_offset=_1m_close_offset)
            self.mas[("1h", mlen)] = align_htf_to_5m(
                self.df5, frames["1h"].assign(m=sma(frames["1h"]["close"], mlen)), "m",
                close_offset=_1h_prior_offset)

        # ── VWMA (4h) ────────────────────────────────────────────────────────
        vw_lens: set[int] = set(search.get("vwma_len", []))
        if fixed:
            vw_lens.add(fixed.vwma_len)
        for vlen in vw_lens:
            self.vwmas[vlen] = align_htf_to_5m(
                self.df5,
                frames["4h"].assign(v=vwma(frames["4h"]["close"], frames["4h"]["volume"], vlen)),
                "v",
            )

        # ── LinReg ──────────────────────────────────────────────────────────
        lr_lens: set[int] = set(search.get("lr_len", []))
        if fixed:
            lr_lens.add(fixed.lr_len)
        lr_frame_1m = frames["1m"]
        lr_frame_5m = frames["5m"]
        for llen in lr_lens:
            # Close-based LinReg (for both TF options)
            # 1m: use close_offset=4min to match Pine's bar-close semantics
            self.lrs[("1m", llen)] = align_htf_to_5m(
                self.df5, lr_frame_1m.assign(lr=linreg_series(lr_frame_1m["close"], llen)), "lr",
                close_offset=_1m_close_offset)
            self.lrs[("5m", llen)] = align_htf_to_5m(
                self.df5, lr_frame_5m.assign(lr=linreg_series(lr_frame_5m["close"], llen)), "lr")
            # Open-based LinReg — needed for "Green candle" rule (lrC > lrO, matching Pine)
            self.lrs_open[("1m", llen)] = align_htf_to_5m(
                self.df5, lr_frame_1m.assign(lro=linreg_series(lr_frame_1m["open"], llen)), "lro",
                close_offset=_1m_close_offset)
            self.lrs_open[("5m", llen)] = align_htf_to_5m(
                self.df5, lr_frame_5m.assign(lro=linreg_series(lr_frame_5m["open"], llen)), "lro")

        # ── ATR (5m) ─────────────────────────────────────────────────────────
        for alen in set(search.get("atr_len", [])):
            self.atrs[alen] = atr(self.df5, alen)
        if fixed and fixed.atr_len not in self.atrs:
            self.atrs[fixed.atr_len] = atr(self.df5, fixed.atr_len)

        # ── SuperTrend (5m) ──────────────────────────────────────────────────
        self.st_lines: dict[tuple[int, float], pd.Series] = {}
        st_atrs  = set(search.get("st_atr_len", []))
        st_mults = set(search.get("st_mult", []))
        if fixed:
            st_atrs.add(fixed.st_atr_len)
            st_mults.add(fixed.st_mult)
        for alen in st_atrs:
            for sm in st_mults:
                st_line_s, tr = supertrend(self.df5, alen, sm)
                self.sts[(alen, sm)]      = tr
                self.st_lines[(alen, sm)] = st_line_s

        # ── 1h → 5m event mapping helper ──────────────────────────────────────
        # A 1h bar (open-time T) closes at T+59:59.  On a 5m chart the bar that
        # is confirmed simultaneously is the 5m bar whose open is T+55min.
        # We therefore shift 1h event timestamps by +55 minutes before intersecting
        # with the 5m index, matching Pine's "HTF candle close" semantics.
        _1h_to_5m_offset = pd.Timedelta(minutes=55)

        # ── Exit MA trigger: 1h×100 VWMA crossunder (Pine: exitMaTf=60, exitMaLen=100, VWMA) ──
        # Fired at the last 5m bar of the hour in which the crossunder occurred,
        # matching Pine's ta.crossunder evaluated on confirmed 1h bar close.
        _c1h     = frames["1h"]["close"]
        _v1h     = frames["1h"]["volume"]
        _vwma1h  = vwma(_c1h, _v1h, 100)
        _cross1h = (_c1h.shift(1) > _vwma1h.shift(1)) & (_c1h < _vwma1h)
        _cross1h_shifted = _cross1h[_cross1h].copy()
        _cross1h_shifted.index = _cross1h_shifted.index + _1h_to_5m_offset
        _exit5m  = pd.Series(False, index=self.df5.index)
        _exit5m.loc[_cross1h_shifted.index.intersection(self.df5.index)] = True
        self.exit_ma_trigger: pd.Series = _exit5m

        # ── HTF break trail trigger (1h close > 1h pivot high + buf×ATR) ─────────
        # Fires at the LAST 5m bar of the 1h bar in which the break occurred (i.e.
        # the 5m bar at hour_open + 55min), matching Pine's "HTF candle close" mode.
        # ATR length matches entry ATR (Pine: atrLenExit = atr_len = 7).
        _df1h         = frames["1h"]
        _htf_piv_len  = fixed.htf_res_pivot_len if fixed else 9
        _htf_buf      = fixed.htf_break_buf_atr  if fixed else 0.25
        _htf_atr_len  = fixed.atr_len            if fixed else 7
        _piv_high_1h  = last_pivot_high(_df1h, _htf_piv_len, _htf_piv_len)
        _atr_1h       = atr(_df1h, _htf_atr_len)
        _htf_break    = _df1h["close"] > _piv_high_1h + _htf_buf * _atr_1h
        _htf_break_shifted = _htf_break[_htf_break].copy()
        _htf_break_shifted.index = _htf_break_shifted.index + _1h_to_5m_offset
        _htf_break_5m = pd.Series(False, index=self.df5.index)
        _htf_break_5m.loc[_htf_break_shifted.index.intersection(self.df5.index)] = True
        self.htf_break_trigger: pd.Series = _htf_break_5m

        # ── NEW: Local 5m EMAs ────────────────────────────────────────────────
        ema_lens: set[int] = (
            set(search.get("local_ema_fast", []))
            | set(search.get("local_ema_slow", []))
        )
        if fixed:
            ema_lens |= {fixed.local_ema_fast, fixed.local_ema_slow}
        for elen in ema_lens:
            self.emas[elen] = ema(self.df5["close"], elen)

        # ── NEW: Volume SMA ───────────────────────────────────────────────────
        vol_lens: set[int] = set(search.get("vol_ma_len", []))
        if fixed:
            vol_lens.add(fixed.vol_ma_len)
        for vlen in vol_lens:
            self.vol_mas[vlen] = self.df5["volume"].rolling(vlen, min_periods=vlen).mean()

        # ── NEW: Higher-high structure on 15m ─────────────────────────────────
        hh_lens: set[int] = set(search.get("hh_pivot_len", []))
        if fixed:
            hh_lens.add(fixed.hh_pivot_len)
        for hlen in hh_lens:
            hh_bool = hh_structure_bool(frames["15m"], hlen, hlen)
            self.hh_structs[hlen] = align_htf_to_5m(
                self.df5, frames["15m"].assign(hh=hh_bool.astype(float)), "hh"
            ).fillna(0).astype(bool)

    def build_frame(self, p: StrategyParams) -> pd.DataFrame:
        """Assemble all indicator columns needed by simulate() for params p."""
        d = self.df5.copy()

        # ATR
        d["atr"]    = self.atrs[p.atr_len]

        # Pivot supports
        d["sup5"]   = self.pivots[("5m",  p.piv_len_5)]
        d["sup15"]  = self.pivots[("15m", p.piv_len_15)]
        d["sup60"]  = self.pivots[("1h",  p.piv_len_60)]
        d["sup240"] = self.pivots[("4h",  p.piv_len_240)]

        # MA trend
        d["ma1"]    = self.mas[("1m", p.ma1_len)]
        d["ma3"]    = self.mas[("1h", p.ma3_len)]

        # VWMA
        d["vw"]     = self.vwmas.get(p.vwma_len, pd.Series(np.nan, index=d.index))

        # LinReg (choose TF) — close and open series for "Green candle" rule
        tf_str = "5m" if p.lr_tf in ("5", "5m") else "1m"
        d["lr"]      = self.lrs.get((tf_str, p.lr_len),      pd.Series(np.nan, index=d.index))
        d["lr_open"] = self.lrs_open.get((tf_str, p.lr_len), pd.Series(np.nan, index=d.index))

        # SuperTrend — direction flag (1/−1) and actual line value for soft-exit check
        d["st_tr"]   = self.sts.get((p.st_atr_len, p.st_mult), pd.Series(1, index=d.index))
        d["st_line"] = self.st_lines.get((p.st_atr_len, p.st_mult), pd.Series(np.nan, index=d.index))

        # Exit MA trigger (1h×100 VWMA crossunder)
        d["exit_ma_x"] = self.exit_ma_trigger

        # HTF break trail trigger (1h pivot high breakout)
        d["htf_break"] = self.htf_break_trigger

        # NEW: local EMA stack
        d["local_ema_fast"] = self.emas.get(p.local_ema_fast, pd.Series(np.nan, index=d.index))
        d["local_ema_slow"] = self.emas.get(p.local_ema_slow, pd.Series(np.nan, index=d.index))

        # NEW: volume MA
        d["vol_ma"] = self.vol_mas.get(p.vol_ma_len, pd.Series(np.nan, index=d.index))

        # NEW: HH structure
        d["hh_struct"] = self.hh_structs.get(
            p.hh_pivot_len, pd.Series(True, index=d.index)
        ).astype(float)

        # Swing low for SL calculation (matches Pine ta.lowest(low, slSwingLb))
        d["swing_low"] = self.df5["low"].rolling(p.sl_swing_lb, min_periods=1).min()

        return d
