"use client";
/**
 * Support & Resistance (MTF) | Flux Charts — a line-for-line port of the
 * published Pine v6 script (S&R V2.12), as a built-in study.
 *
 * ── Why a port and not the Pine engine ─────────────────────────────────────
 *
 * The script's multi-timeframe half asks `request.security` for an ARRAY OF
 * USER-DEFINED OBJECTS (`allSRInfoList`) on another timeframe, then reconciles
 * those objects against chart-timeframe state every bar. That is outside what
 * the platform's Pine engine evaluates, and a study that ran on some
 * timeframes and errored on others would be worse than none. The arithmetic is
 * small; the behaviour is in the ORDER things happen, and that is kept here
 * exactly, including the script's own quirks (the resistance "too close" check
 * compares against `pivotLow`, as the published script does).
 *
 * ── What "the same as TradingView" rests on ────────────────────────────────
 *
 *  - Every bar runs, in order: detect pivots → breaks/strength/retests on the
 *    context's own list → (chart only, last 4000 bars) reconcile each enabled
 *    timeframe's list into the chart's objects → render pass → chart-level
 *    retests. The drawings TradingView shows are the LAST render pass's, so
 *    passes before it only advance state; only the last is turned into
 *    drawings.
 *  - Another timeframe's list is read as `request.security` with
 *    `lookahead_off` reads it on history: the state after the most recent
 *    higher-timeframe bar that had CLOSED by the chart bar's close. Its bars
 *    are folded from the chart's own candles.
 *  - A forming bar is not confirmed: no detection, no reconciliation, no
 *    render on it, exactly as `barstate.isconfirmed` gates the script.
 */
import { atr as atrSeries, FluxSrContext, FLUX_SR, type FluxSrInfo } from "@/lib/ta/core";
import type { PineDrawings } from "@/lib/api";
import type { Candle } from "@/lib/types";
import { resolutionMs, type Resolution } from "@/lib/resolution";
import type { NativeStudyDef } from "@/lib/native/registry";
import { bool, num, quotedDecimals, str } from "@/lib/native/shared";

const MAX_BAR_INFO = 3000;
const MAX_DISTANCE_TO_LAST_BAR = FLUX_SR.maxDistanceToLastBar;
const MIN_SR_SIZE = 5;
const RETEST_LABEL_COOLDOWN = 3;
const TOO_CLOSE_ATR = FLUX_SR.tooCloseAtr;
const LABEL_OFFSET_BARS = 20;
const ATR_LEN = FLUX_SR.atrLength;

export interface FluxSrOptions {
  pivotLength: number;
  strength: number;
  invalidation: "Wick" | "Close";
  expand: "All" | "Only Valid" | "None";
  showInvalidated: boolean;
  /** Pine timeframe strings; "" is the chart's own. */
  timeframes: { enabled: boolean; tf: string }[];
  showBreaks: boolean;
  showRetests: boolean;
  avoidFalseBreaks: boolean;
  breakVolumeThreshold: number;
  inverseBrokenLineColor: boolean;
  styleMode: "Lines" | "Zones";
  lineStyle: "____" | "----" | "....";
  lineWidth: number;
  zoneSize: number;
  supportColor: string;
  resistanceColor: string;
  breakColor: string;
  textColor: string;
}

/** One level; the engine lives in `ta/core` so the S/R touch alert reads the same list. */
type SrInfo = FluxSrInfo;

interface SrObj {
  info: SrInfo;
  startFixed: boolean;
  breakFixed: boolean;
  rendered: boolean;
  combined: string | null;
  /** x of the newest retest label ever created for this object (`retestLabels.get(0)`). */
  lastRetestLabelX: number | null;
}

interface BarInfo { t: number; c: number; h: number; l: number }

interface Bar { time: number; closeTime: number; open: number; high: number; low: number; close: number; volume: number }

const copyInfo = (i: SrInfo): SrInfo => ({ ...i, retestTimes: [...i.retestTimes] });

// ── timeframes ──────────────────────────────────────────────────────────────

/** The chart's resolution in Pine's spelling: "60", "D", "W", "M". */
export function pineTimeframe(interval: Resolution): string {
  const minutes = Math.round(resolutionMs(interval) / 60_000);
  if (minutes >= 43_200) return "M";
  if (minutes >= 10_080) return "W";
  if (minutes >= 1_440) return "D";
  return String(minutes);
}

/** `timeframe.in_seconds`. */
export function tfSeconds(tf: string): number {
  const t = tf.trim().toUpperCase();
  const m = /^(\d*)([DWM]?)$/.exec(t);
  if (!m) return 60;
  const n = m[1] ? Number(m[1]) : 1;
  if (m[2] === "D") return n * 86_400;
  if (m[2] === "W") return n * 604_800;
  if (m[2] === "M") return n * 2_628_003;
  return n * 60;
}

/** `formatTimeframeString`: "1 Hour", "4 Hours", "15 Min", "1D", "1W". */
export function formatTimeframe(tf: string, chartTf: string): string {
  const f = tf === "" ? chartTf : tf;
  if (/[DWSM]/.test(f)) {
    const s = tfSeconds(f);
    if (s % 2_628_003 === 0) return `${s / 2_628_003}M`;
    if (s % 604_800 === 0) return `${s / 604_800}W`;
    if (s % 86_400 === 0) return `${s / 86_400}D`;
    return f;
  }
  const seconds = tfSeconds(f);
  if (seconds >= 3600) {
    const hours = Math.floor(seconds / 3600);
    return `${hours} Hour${hours > 1 ? "s" : ""}`;
  }
  return `${f} Min`;
}

/** Fold chart candles into another timeframe's bars, UTC-aligned as Binance stamps them. */
function foldBars(candles: readonly Candle[], tf: string): Bar[] {
  const t = tf.toUpperCase();
  const keyOf = (ms: number): number => {
    const d = new Date(ms);
    if (t.endsWith("M") && !/^\d+$/.test(t)) {
      const n = Number(t.slice(0, -1) || 1);
      const month = d.getUTCFullYear() * 12 + d.getUTCMonth();
      const start = month - (month % n);
      return Date.UTC(Math.floor(start / 12), start % 12, 1);
    }
    if (t.endsWith("W")) {
      const day = (d.getUTCDay() + 6) % 7; // ISO weeks start Monday
      return Math.floor((ms - day * 86_400_000) / 86_400_000) * 86_400_000;
    }
    const size = tfSeconds(tf) * 1000;
    return Math.floor(ms / size) * size;
  };
  const out: Bar[] = [];
  let key = NaN;
  for (const c of candles) {
    const k = keyOf(c.openTime);
    const last = out[out.length - 1];
    if (last && k === key) {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
      last.volume += c.volume;
      last.closeTime = c.closeTime;
      continue;
    }
    key = k;
    out.push({ time: k, closeTime: c.closeTime, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
  }
  return out;
}

// ── one timeframe's own list (`allSRInfoList`): `FluxSrContext` in ta/core ──

// ── the chart ───────────────────────────────────────────────────────────────

/** `findValRtnTime`: oldest to newest over the chart's remembered bars. */
function findValRtnTime(
  bars: readonly BarInfo[], val: number, toSearch: "Low" | "High" | "Close",
  mode: "Nearest" | "Higher" | "Lower", minTime: number, maxTime: number, def: number,
): number {
  let rtn = def;
  let minDiff = NaN;
  for (let i = bars.length - 1; i >= 0; i--) {
    const bi = bars[i]!;
    if (bi.t < minTime || bi.t >= maxTime) continue;
    const look = toSearch === "Low" ? bi.l : toSearch === "High" ? bi.h : bi.c;
    if (mode === "Nearest") {
      const diff = Math.abs(val - look);
      if (Number.isNaN(minDiff) || diff <= minDiff) { rtn = bi.t; minDiff = diff; }
    } else if (mode === "Higher") {
      if (look >= val) { rtn = bi.t; break; }
    } else if (look <= val) {
      rtn = bi.t;
      break;
    }
  }
  return rtn;
}

export function computeFluxSr(
  candles: readonly Candle[], interval: Resolution, opts: FluxSrOptions, decimals: number,
  now: number = Date.now(),
): PineDrawings {
  const out: PineDrawings = { lines: [], boxes: [], labels: [], tables: [] };
  const n = candles.length;
  if (n === 0) return out;
  const chartTf = pineTimeframe(interval);
  const chartSec = tfSeconds(chartTf);
  const curTfMs = chartSec * 1000;

  const bars: Bar[] = candles.map((c) => ({
    time: c.openTime, closeTime: c.closeTime, open: c.open, high: c.high, low: c.low,
    close: c.close, volume: c.volume,
  }));
  const chartAtr = atrSeries(bars.map((b) => b.high), bars.map((b) => b.low), bars.map((b) => b.close), ATR_LEN);
  const confirmedAt = (i: number): boolean => i < n - 1 || candles[i]!.closeTime < now;

  // Each enabled timeframe: the chart's own context, or a folded one read at
  // its last CLOSED bar.
  const chartCtx = new FluxSrContext(bars, opts, chartTf);
  const sources = opts.timeframes.filter((t) => t.enabled).map((t) => {
    const coarser = t.tf !== "" && tfSeconds(t.tf) > chartSec;
    if (!coarser) return { kind: "chart" as const, tf: t.tf === "" ? chartTf : t.tf };
    const htf = foldBars(candles, t.tf);
    // Snapshots of the list after each higher-timeframe bar.
    const ctx = new FluxSrContext(htf, opts, t.tf);
    const snaps: SrInfo[][] = [];
    for (let k = 0; k < htf.length; k++) {
      const complete = k < htf.length - 1 || htf[k]!.closeTime < now;
      ctx.step(k, complete);
      snaps.push(ctx.list.map(copyInfo));
    }
    return { kind: "htf" as const, tf: t.tf, htf, snaps };
  });
  const all: SrObj[] = [];
  const barInfo: BarInfo[] = [];
  const htfCursor = new Map<string, number>();

  let lastPass: { time: number; atr: number; objs: SrObj[]; retests: Map<SrObj, number[]> } | null = null;

  const fix = (sr: SrObj): void => {
    const srMs = Math.max(tfSeconds(sr.info.tf), chartSec) * 1000;
    if (!sr.startFixed) {
      if (!sr.info.ephemeral) {
        sr.info.startTime = findValRtnTime(barInfo, sr.info.price,
          sr.info.srType === "Resistance" ? "High" : "Low", "Nearest",
          sr.info.startTime - srMs, sr.info.startTime + srMs, sr.info.startTime);
        sr.startFixed = true;
      } else {
        for (const cur of all) {
          if (!cur.info.ephemeral && !Number.isNaN(cur.info.breakTime) && cur.info.price === sr.info.price
            && cur.info.srType !== sr.info.srType) {
            if (cur.breakFixed) {
              sr.info.startTime = cur.info.breakTime;
              sr.startFixed = true;
            }
            break;
          }
        }
      }
    }
    if (!Number.isNaN(sr.info.breakTime) && !sr.breakFixed) {
      const res = sr.info.srType === "Resistance";
      sr.info.breakTime = findValRtnTime(barInfo, sr.info.price,
        opts.invalidation === "Wick" ? (res ? "High" : "Low") : "Close",
        res ? "Higher" : "Lower", sr.info.breakTime - srMs, sr.info.breakTime + srMs, sr.info.breakTime);
      sr.breakFixed = true;
    }
  };

  const handleList = (list: readonly SrInfo[]): void => {
    for (const src of list) {
      const cur = copyInfo(src);
      const same = all.find((o) => o.info.price === cur.price && o.info.ephemeral === cur.ephemeral
        && o.info.srType === cur.srType && o.info.tf === cur.tf);
      if (same) {
        if (same.startFixed) cur.startTime = same.info.startTime;
        if (same.breakFixed) cur.breakTime = same.info.breakTime;
        cur.retestTimes = same.info.retestTimes;
        same.info = cur;
        if (!same.breakFixed) fix(same);
      } else {
        cur.retestTimes = [];
        const obj: SrObj = {
          info: cur, startFixed: false, breakFixed: false, rendered: false, combined: null,
          lastRetestLabelX: null,
        };
        fix(obj);
        all.unshift(obj);
      }
    }
  };

  for (let i = 0; i < n; i++) {
    const b = bars[i]!;
    const confirmed = confirmedAt(i);
    barInfo.unshift({ t: b.time, c: b.close, h: b.high, l: b.low });
    if (barInfo.length > MAX_BAR_INFO) barInfo.pop();
    chartCtx.step(i, confirmed);

    if (i > n - 1 - MAX_DISTANCE_TO_LAST_BAR * 8 && confirmed) {
      for (const source of sources) {
        if (source.kind === "chart") {
          // The chart's list carries the chart's own timeframe name.
          handleList(chartCtx.list.map((x) => ({ ...x, tf: source.tf })));
          continue;
        }
        let k = htfCursor.get(source.tf) ?? -1;
        while (k + 1 < source.htf.length && source.htf[k + 1]!.closeTime <= b.closeTime) k++;
        htfCursor.set(source.tf, k);
        if (k >= 0) handleList(source.snaps[k]!);
      }

      // The render pass. Its drawings are thrown away every bar; only the
      // last pass's survive, so only that one is kept.
      const atr = chartAtr[i]!;
      const rendered: SrObj[] = [];
      const retests = new Map<SrObj, number[]>();
      for (const obj of all) {
        obj.rendered = false;
        let tooClose = false;
        for (const close of all) {
          if (close.rendered && Math.abs(close.info.price - obj.info.price) <= TOO_CLOSE_ATR * atr
            && close.info.srType === obj.info.srType && close.info.ephemeral === obj.info.ephemeral) {
            tooClose = true;
            const closeStr = close.combined ?? formatTimeframe(close.info.tf, chartTf);
            const mine = formatTimeframe(obj.info.tf, chartTf);
            if (!closeStr.includes(mine)) {
              close.combined = (close.combined ?? formatTimeframe(close.info.tf, chartTf)) + " & " + mine;
            }
            break;
          }
        }
        const sizeOk = Number.isNaN(obj.info.breakTime)
          || obj.info.breakTime - obj.info.startTime >= MIN_SR_SIZE * curTfMs;
        if (obj.info.strength >= opts.strength && sizeOk && !tooClose) {
          if (Number.isNaN(obj.info.breakTime) || opts.showInvalidated) {
            obj.rendered = true;
            rendered.push(obj);
            if (opts.showRetests && obj.info.retestTimes.length > 0) {
              const made: number[] = [];
              for (let k = obj.info.retestTimes.length - 1; k >= 0; k--) {
                const t = obj.info.retestTimes[k]!;
                const cooldownOk = obj.lastRetestLabelX === null
                  || Math.abs(obj.lastRetestLabelX - t) >= curTfMs * RETEST_LABEL_COOLDOWN;
                if (cooldownOk && t >= obj.info.startTime
                  && (Number.isNaN(obj.info.breakTime) || t < obj.info.breakTime)) {
                  obj.lastRetestLabelX = t;
                  made.push(t);
                }
              }
              retests.set(obj, made);
            }
          }
        }
      }
      // A snapshot: later bars go on mutating the live objects.
      const objs = rendered.map((o) => ({ ...o, info: { ...o.info } }));
      lastPass = {
        time: b.time, atr, objs,
        retests: new Map(rendered.map((o, k) => [objs[k]!, retests.get(o) ?? []])),
      };
    }

    // Current-timeframe retests, recorded after the render.
    if (all.length > 0 && confirmed) {
      for (const sr of all) {
        if (!Number.isNaN(sr.info.breakTime) || !(b.time > sr.info.startTime)) continue;
        const touches = sr.info.srType === "Resistance"
          ? b.high >= sr.info.price && b.close <= sr.info.price
          : b.low <= sr.info.price && b.close >= sr.info.price;
        if (touches && (sr.info.retestTimes[0] ?? 0) !== b.time) sr.info.retestTimes.unshift(b.time);
      }
    }
  }

  if (!lastPass) return out;
  return renderPass(lastPass, candles, opts, chartTf, curTfMs, decimals);
}

function renderPass(
  pass: { time: number; atr: number; objs: SrObj[]; retests: Map<SrObj, number[]> },
  candles: readonly Candle[], opts: FluxSrOptions, chartTf: string, curTfMs: number, decimals: number,
): PineDrawings {
  const out: PineDrawings = { lines: [], boxes: [], labels: [], tables: [] };
  const sec = (ms: number): number => Math.round(ms / 1000);
  const barAt = (t: number): Candle | null => {
    let lo = 0, hi = candles.length - 1;
    if (hi < 0 || t < candles[0]!.openTime) return null;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (candles[mid]!.openTime <= t) lo = mid; else hi = mid - 1;
    }
    return candles[lo]!;
  };
  const opaque = (c: string): string => (c.length === 9 ? c.slice(0, 7) : c);
  const dash = opts.lineStyle === "----" ? "dashed" : opts.lineStyle === "...." ? "dotted" : "solid";
  const zoneHalf = pass.atr * opts.zoneSize * 0.075;

  // Pine draws boxes, then lines, then labels in creation order; the layer
  // paints by kind, which gives the same stacking.
  for (const sr of pass.objs) {
    const { info } = sr;
    const broken = !Number.isNaN(info.breakTime);
    let endTime = broken ? info.breakTime : pass.time + curTfMs * LABEL_OFFSET_BARS;
    let extend = "none";
    if (!broken) extend = "right";
    if (opts.expand === "Only Valid" && !broken) extend = "both";
    else if (opts.expand === "All") {
      extend = "both";
      endTime = pass.time + curTfMs * LABEL_OFFSET_BARS;
    }
    const title = `${sr.combined ?? formatTimeframe(info.tf, chartTf)} | ${info.price.toFixed(decimals)}`;
    const color = info.srType === "Resistance" ? opts.resistanceColor : opts.supportColor;

    if (opts.styleMode === "Lines") {
      out.lines.push({
        x1: sec(info.startTime), y1: info.price, x2: sec(endTime), y2: info.price,
        color, width: opts.lineWidth, style: dash, extend,
      });
      out.labels.push({
        x: sec(extend === "none" ? (info.startTime + endTime) / 2 : endTime), y: info.price,
        text: title, color: "", textColor: opts.textColor, style: "style_none", size: "normal",
      });
    } else {
      out.boxes.push({
        left: sec(info.startTime), top: info.price + zoneHalf,
        right: sec(endTime), bottom: info.price - zoneHalf,
        borderColor: "", borderWidth: 0, borderStyle: "solid", bgColor: color,
        text: title, textColor: opts.textColor,
        textHalign: extend !== "none" ? "right" : "center", textValign: "center",
        textSize: "normal", extend,
      });
    }

    if (opts.showBreaks && broken) {
      const bar = barAt(info.breakTime);
      const res = info.srType === "Resistance";
      out.labels.push({
        x: sec(info.breakTime), y: bar ? (res ? bar.low : bar.high) : info.price, text: "B",
        color: opts.breakColor, textColor: opaque(opts.textColor),
        style: res ? "style_label_up" : "style_label_down", size: "small",
        yloc: res ? "belowbar" : "abovebar",
      });
    }
    for (const t of pass.retests.get(sr) ?? []) {
      const bar = barAt(t);
      const res = info.srType === "Resistance";
      out.labels.push({
        x: sec(t), y: bar ? (res ? bar.high : bar.low) : info.price, text: "R",
        color, textColor: opaque(opts.textColor),
        style: res ? "style_label_down" : "style_label_up", size: "small",
        yloc: res ? "abovebar" : "belowbar",
      });
    }
  }
  return out;
}

// ── the study ───────────────────────────────────────────────────────────────

const TIMEFRAME_OPTIONS = [
  { value: "", label: "Chart" },
  { value: "15", label: "15 minutes" },
  { value: "30", label: "30 minutes" },
  { value: "60", label: "1 hour" },
  { value: "120", label: "2 hours" },
  { value: "240", label: "4 hours" },
  { value: "D", label: "1 day" },
  { value: "W", label: "1 week" },
  { value: "M", label: "1 month" },
] as const;

const G_GENERAL = "General Configuration";
const G_TIMEFRAMES = "Timeframes";
const G_BREAKS = "Breaks & Retests";
const G_STYLE = "Style";

/**
 * The defaults are the ones on the user's own TradingView chart (2026-10-29:
 * Lines, zone width 1, chart timeframe only), which are also the script's
 * published defaults.
 */
export const fluxSrStudy: NativeStudyDef = {
  id: "flux_sr_mtf",
  name: "Support & Resistance (MTF) | Flux Charts",
  aliases: ["support resistance mtf", "flux", "flux charts", "s&r", "sr mtf", "support and resistance"],
  category: "levels",
  overlay: true,
  description: "Pivot support and resistance zones from up to three timeframes, with breaks and retests.",
  inputs: [
    { kind: "number", key: "pivotLength", title: "Pivot Length", defval: 15, min: 3, max: 50, integer: true, group: G_GENERAL },
    {
      kind: "select", key: "strength", title: "Strength", defval: "1", group: G_GENERAL,
      options: [{ value: "1", label: "1" }, { value: "2", label: "2" }, { value: "3", label: "3" }],
    },
    {
      kind: "select", key: "invalidation", title: "Invalidation", defval: "Close", group: G_GENERAL,
      options: [{ value: "Wick", label: "Wick" }, { value: "Close", label: "Close" }],
    },
    {
      kind: "select", key: "expand", title: "Expand Lines & Zones", defval: "Only Valid", group: G_GENERAL,
      options: [{ value: "All", label: "All" }, { value: "Only Valid", label: "Only Valid" }, { value: "None", label: "None" }],
    },
    { kind: "boolean", key: "showInvalidated", title: "Show Invalidated", defval: true, group: G_GENERAL },
    { kind: "boolean", key: "tf1On", title: "Timeframe 1", defval: true, group: G_TIMEFRAMES },
    { kind: "select", key: "tf1", title: "Timeframe 1 resolution", defval: "", options: TIMEFRAME_OPTIONS, group: G_TIMEFRAMES },
    { kind: "boolean", key: "tf2On", title: "Timeframe 2", defval: false, group: G_TIMEFRAMES },
    { kind: "select", key: "tf2", title: "Timeframe 2 resolution", defval: "D", options: TIMEFRAME_OPTIONS, group: G_TIMEFRAMES },
    { kind: "boolean", key: "tf3On", title: "Timeframe 3", defval: false, group: G_TIMEFRAMES },
    { kind: "select", key: "tf3", title: "Timeframe 3 resolution", defval: "W", options: TIMEFRAME_OPTIONS, group: G_TIMEFRAMES },
    { kind: "boolean", key: "showBreaks", title: "Show Breaks", defval: true, group: G_BREAKS },
    { kind: "boolean", key: "showRetests", title: "Show Retests", defval: true, group: G_BREAKS },
    { kind: "boolean", key: "avoidFalseBreaks", title: "Avoid False Breaks", defval: false, group: G_BREAKS },
    {
      kind: "number", key: "breakVolumeThreshold", title: "Break Volume Threshold", defval: 0.3,
      min: 0.1, max: 2, step: 0.1, integer: false, group: G_BREAKS,
      tooltip: "Only taken into account if Avoid False Breaks is enabled. Higher values mean it's less likely to be a break.",
    },
    { kind: "boolean", key: "inverseBrokenLineColor", title: "Inverse Color After Broken", defval: false, group: G_BREAKS },
    {
      kind: "select", key: "styleMode", title: "Style", defval: "Lines", group: G_STYLE,
      options: [{ value: "Lines", label: "Lines" }, { value: "Zones", label: "Zones" }],
    },
    {
      kind: "select", key: "lineStyle", title: "Line Style", defval: "____", group: G_STYLE,
      options: [{ value: "____", label: "____" }, { value: "----", label: "----" }, { value: "....", label: "...." }],
    },
    { kind: "number", key: "lineWidth", title: "Line Width", defval: 2, min: 1, max: 10, integer: true, group: G_STYLE },
    { kind: "number", key: "zoneSize", title: "Zone Width", defval: 1, min: 0.1, max: 10, step: 0.1, integer: false, group: G_STYLE },
    { kind: "color", key: "supportColor", title: "Support Color", defval: "#08998180", group: G_STYLE },
    { kind: "color", key: "resistanceColor", title: "Resistance Color", defval: "#f2364580", group: G_STYLE },
    { kind: "color", key: "breakColor", title: "Break Color", defval: "#2196f3", group: G_STYLE },
    { kind: "color", key: "textColor", title: "Text Color", defval: "#ffffff80", group: G_STYLE },
  ],
  plots: [],
  precision: null,
  warmup: () => 0,
  unbounded: true,
  compute: ({ candles, params, interval }) => {
    const opts: FluxSrOptions = {
      pivotLength: Math.round(num(params, "pivotLength", 15)),
      strength: Number(str(params, "strength", "1")) || 1,
      invalidation: str(params, "invalidation", "Close") === "Wick" ? "Wick" : "Close",
      expand: (["All", "Only Valid", "None"] as const).find((v) => v === str(params, "expand", "Only Valid")) ?? "Only Valid",
      showInvalidated: bool(params, "showInvalidated", true),
      timeframes: [
        { enabled: bool(params, "tf1On", true), tf: str(params, "tf1", "") },
        { enabled: bool(params, "tf2On", false), tf: str(params, "tf2", "D") },
        { enabled: bool(params, "tf3On", false), tf: str(params, "tf3", "W") },
      ],
      showBreaks: bool(params, "showBreaks", true),
      showRetests: bool(params, "showRetests", true),
      avoidFalseBreaks: bool(params, "avoidFalseBreaks", false),
      breakVolumeThreshold: num(params, "breakVolumeThreshold", 0.3),
      inverseBrokenLineColor: bool(params, "inverseBrokenLineColor", false),
      styleMode: str(params, "styleMode", "Lines") === "Zones" ? "Zones" : "Lines",
      lineStyle: (["____", "----", "...."] as const).find((v) => v === str(params, "lineStyle", "____")) ?? "____",
      lineWidth: Math.round(num(params, "lineWidth", 2)),
      zoneSize: num(params, "zoneSize", 1),
      supportColor: str(params, "supportColor", "#08998180"),
      resistanceColor: str(params, "resistanceColor", "#f2364580"),
      breakColor: str(params, "breakColor", "#2196f3"),
      textColor: str(params, "textColor", "#ffffff80"),
    };
    return { plots: {}, drawings: cachedFluxSr(candles, interval, opts) };
  },
};

/**
 * The last answer, reused while nothing it depends on changed.
 *
 * A live chart recomputes every study on every tick, and this one replays
 * thousands of bars. Only CONFIRMED bars move its state (and, with Wick
 * invalidation, the forming bar's extremes), so a tick that only revises the
 * forming candle's close gets the previous drawings back.
 */
let memo: { key: string; drawings: PineDrawings } | null = null;

function cachedFluxSr(candles: readonly Candle[], interval: Resolution, opts: FluxSrOptions): PineDrawings {
  const n = candles.length;
  const now = Date.now();
  const last = candles[n - 1];
  const forming = !!last && last.closeTime >= now;
  const lastConfirmed = forming ? candles[n - 2] : last;
  const key = [
    JSON.stringify(opts), interval, n, candles[0]?.openTime, lastConfirmed?.openTime, lastConfirmed?.close,
    forming && opts.invalidation === "Wick" ? `${last!.high}/${last!.low}` : "",
  ].join("|");
  if (memo && memo.key === key) return memo.drawings;
  const drawings = computeFluxSr(candles, interval, opts, quotedDecimals(candles), now);
  memo = { key, drawings };
  return drawings;
}
