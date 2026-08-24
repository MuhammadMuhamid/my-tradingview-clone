#!/usr/bin/env python3
"""Build a local backtest spec + harness trade JSON from a tv_<SYM>_raw.json
capture (reportData settings/trades + full input id/value dump).

  python3 build_spec.py ZECUSDT
"""
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).parent

# in_XX → engine param name (MA + R:R Strategy v5 chart script, verified 2026-07-11)
IDMAP = {
    "in_0": "useBarConfirm", "in_1": "ordersOnConfirmedBar", "in_2": "cooldownBarsAfterExit",
    "in_3": "useChoppyFilter", "in_4": "maxConsecLoss", "in_5": "choppyPauseBars",
    "in_6": "useRunLimit", "in_7": "runLimTrades", "in_8": "runLimProfitPct", "in_9": "runLimPauseBars",
    "in_15": "useMaTrend", "in_16": "maPrimary", "in_17": "maBlockWhenNa", "in_19": "requireMaSlope",
    "in_20": "ma1_en", "in_21": "ma1_tf", "in_22": "ma1_len", "in_23": "ma1_type", "in_24": "ma1_src", "in_25": "ma1_slopeLb",
    "in_26": "ma2_en", "in_27": "ma2_tf", "in_28": "ma2_len", "in_29": "ma2_type", "in_30": "ma2_src", "in_31": "ma2_slopeLb",
    "in_32": "ma3_en", "in_33": "ma3_tf", "in_34": "ma3_len", "in_35": "ma3_type", "in_36": "ma3_src", "in_37": "ma3_slopeLb",
    "in_38": "ma4_en", "in_39": "ma4_tf", "in_40": "ma4_len", "in_41": "ma4_type", "in_42": "ma4_src", "in_43": "ma4_slopeLb",
    "in_44": "useSuperTrend", "in_45": "stTf", "in_46": "stAtrLen", "in_47": "stMult",
    "in_49": "useLinReg", "in_50": "lrTf", "in_51": "lrLen", "in_52": "sigLen", "in_53": "sigUseSma",
    "in_55": "useVwmaTrend", "in_56": "vwmaTf", "in_57": "vwmaLen",
    "in_59": "useLocalTrend", "in_60": "localTrendTf", "in_61": "localEmaFast", "in_62": "localEmaSlow", "in_63": "requireAboveFast",
    "in_65": "useVolumeFilter", "in_66": "volTf", "in_67": "volMaLen", "in_68": "volMultMin",
    "in_70": "useHhStructure", "in_71": "hhTf", "in_72": "hhPivotLen",
    "in_74": "long_en", "in_75": "lrLongRule", "in_76": "useBodyFilter", "in_77": "entryBodyAtrMult",
    "in_80": "atrLenExit",
    "in_81": "useRR", "in_82": "rrSwingLb", "in_83": "rrBufAtr", "in_84": "rrRatio", "in_85": "minSlDistAtr",
    "in_87": "rrUsePartialTp", "in_88": "rrTp1Pct", "in_89": "rrTp1Size", "in_90": "rrTp2Pct", "in_91": "rrTp2Size",
    "in_92": "rrUseTrailSl", "in_93": "rrTrailPct", "in_94": "rrTrailActPct",
    "in_95": "useExtFilter", "in_96": "extRefLen", "in_97": "extMode", "in_98": "extMaxAtr", "in_99": "extMaxPct",
    "in_100": "usePeakRun", "in_101": "runLb", "in_102": "runMode", "in_103": "runMaxPct", "in_104": "runMaxAtr",
    "in_105": "useAtrSpike", "in_106": "atrSpikeAvgLen", "in_107": "atrSpikeMaxMult",
    "in_108": "useWickFilter", "in_109": "wickMaxAtr",
    "in_111": "useOneTradePerSignal", "in_112": "minRForSoftExit",
    "in_113": "useExitLongMa", "in_115": "exitMaTf", "in_116": "exitMaLen", "in_117": "exitMaType", "in_118": "exitMaSrc",
    "in_120": "useExitBelowSt", "in_121": "useExitBelowMa1", "in_122": "useExitBelowLinReg",
    "in_123": "useHlBreakExit", "in_124": "hlBreakTf", "in_125": "hlBreakPivLen", "in_126": "hlBreakMinR",
    "in_127": "useRsiFilter", "in_128": "rsiLengthInput", "in_129": "rsiTf", "in_131": "rsiLongMin", "in_132": "rsiLongMax",
    "in_133": "useRsiExit", "in_134": "rsiExitLevel",
    "in_141": "rf_en", "in_142": "rf_primary", "in_144": "rf_per", "in_145": "rf_mult", "in_146": "rf_tf",
    "in_147": "rf_useExit", "in_148": "rf_exitTf",
    "in_150": "qt_en", "in_151": "qt_primary", "in_153": "qt_p", "in_154": "qt_atrP", "in_155": "qt_mult",
    "in_157": "at_en", "in_158": "at_primary", "in_159": "at_coeff", "in_160": "at_ap", "in_162": "at_novol",
    "in_163": "at_tf", "in_164": "at_useExit", "in_165": "at_exitTf",
    "in_167": "hac_en", "in_168": "hac_primary", "in_169": "hac_length", "in_170": "hac_emaLen", "in_171": "hac_csf",
    "in_172": "hac_tf", "in_173": "hac_useExit", "in_174": "hac_exitTf",
    "in_176": "ut_en", "in_177": "ut_primary", "in_178": "ut_key", "in_179": "ut_atrP", "in_180": "ut_heikin",
    "in_181": "ut_tf", "in_182": "ut_useExit", "in_183": "ut_exitTf",
}


def iso(ms: float) -> str:
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def main() -> None:
    sym = sys.argv[1].upper()
    raw = json.load(open(HERE / f"tv_{sym}_raw.json"))
    vals = {x["id"]: x["value"] for x in raw["inputs"]}

    params = {IDMAP[k]: v for k, v in vals.items() if k in IDMAP}
    params["btcEnable"] = False
    params["qty_pct_equity"] = float(vals["in_187"]) if vals.get("in_186") == "percent_of_equity" else 0
    params["qty_cash"] = float(vals["in_187"]) if vals.get("in_186") != "percent_of_equity" else 930
    params["fill_bar_close"] = bool(vals.get("in_196", False))

    rng = raw["settings"]["dateRange"]["backtest"]
    spec = {
        "strategyKey": "ma_rr_v9",
        "symbol": sym,
        "timeframe": "15m",
        "startTime": iso(rng["from"]),
        "endTime": iso(rng["to"]),
        "initialCapital": float(vals["in_185"]),
        "commissionPct": float(vals["in_189"]),
        "slippageTicks": float(vals["in_190"]),
        "params": params,
    }
    json.dump(spec, open(HERE / f"spec_{sym}.json", "w"), indent=1)

    trades = []
    for t in raw["trades"]:
        x = t.get("x") or {}
        is_open = not x.get("c")
        trades.append({
            "entry_time": iso(t["e"]["tm"]),
            "entry_price": t["e"]["p"],
            "exit_time": None if is_open else iso(x["tm"]),
            "exit_price": None if is_open else x["p"],
            "contracts": t.get("q"),
            "profit": (t.get("tp") or {}).get("v"),
            "signal": x.get("c") or "OPEN",
        })
    json.dump(trades, open(HERE / f"tv_{sym}_trades.json", "w"), indent=1)
    print(f"spec_{sym}.json + tv_{sym}_trades.json written; "
          f"{len(trades)} trades; range {spec['startTime']} → {spec['endTime']}; "
          f"comm {spec['commissionPct']} slip {spec['slippageTicks']} "
          f"fill_close {params['fill_bar_close']} pct_eq {params['qty_pct_equity']}")


if __name__ == "__main__":
    main()
