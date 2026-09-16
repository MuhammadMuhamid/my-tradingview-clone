"use client";
/**
 * The block under the watchlist: what the selected instrument IS, what it
 * costs, and what is known about it.
 *
 * ── Why this left `Watchlist.tsx` ──────────────────────────────────────────
 *
 * It is a different component with a different job. The list above it is a
 * dense table of one line per instrument; this is a single-subject panel with
 * a type scale of its own — a 28px price over a 16px change over 14px body —
 * and it was being written as eleven-pixel footnotes inside a bordered slab
 * because it shared a file with the table's density.
 *
 * ── The rule this file exists to keep ──────────────────────────────────────
 *
 * Everything here is measured from the provider. Empty news and statistic
 * rows are omitted: provider limitations are never primary product copy.
 *
 * Volume and turnover are NOT in that category any more: Binance's
 * `/api/v3/ticker/24hr` has always carried them and the backend used to drop
 * them on the way through (see `backend/src/data/binanceRest.ts`).
 */
import { useRef } from "react";
import type { WatchlistTicker } from "@/lib/useWatchlistTickers";
import { formatQuote } from "@/lib/format";
import { PERFORMANCE_PERIODS, type PerformancePeriod } from "@/lib/instrumentStats";

/**
 * The asset's mark.
 *
 * ── Why a monogram and not a logo ──────────────────────────────────────────
 *
 * The reference paints an 18px brand mark on every row, and TVP8's owner veto
 * OV-K is explicit that a brand mark we do not have the right to use is not an
 * option and a GUESSED one is worse: shipping an orange circle labelled `₿`
 * beside a token that is not Bitcoin is a factual error about money.
 *
 * So the mark is a deterministic two-letter monogram in a hue derived from the
 * base asset — never blank (a hole in the row's left rhythm is what the
 * reference does not have), never a claim about a brand. A vendored CC0 icon
 * set can replace it per-asset later without moving anything: the cell, its
 * size and its position are already the reference's.
 *
 * It is `aria-hidden` and, in a row, placed by grid rather than by DOM order,
 * so a screen reader and `textContent` both still read the ticker first.
 */
export function AssetMark({ asset, size, className = "" }: {
  asset: string; size: number; className?: string;
}) {
  const key = asset.toUpperCase();
  let hue = 0;
  for (const c of key) hue = (hue * 31 + c.charCodeAt(0)) % 360;
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold leading-none ${className}`}
      style={{
        width: size, height: size, fontSize: Math.round(size * 0.4),
        // Data-derived, not a palette entry: the hue IS the identity, which is
        // why it is computed rather than chosen from the product's tokens.
        backgroundColor: `hsl(${hue} 42% 30%)`,
        color: `hsl(${hue} 78% 84%)`,
      }}
    >
      {key.slice(0, 2)}
    </span>
  );
}

export interface MarketLine {
  label: string;
  /** `open` is the reference's teal; the rest are the product's own tones. */
  tone: "open" | "caution" | "negative";
  detail: string;
}

/** What `lib/instrumentStats` made of the instrument's daily bars. */
export interface DailyStats {
  averageVolume30D: number | null;
  performance: Record<PerformancePeriod, number | null> | null;
  /** Set when the series could not be read; shown as the `—`'s reason. */
  unavailable: string | null;
}

export interface WatchlistDetailsProps {
  /** The storage key, for the accessible name only. */
  qualifiedName: string;
  /** `Bitcoin / TetherUS` where the catalogue knows both legs (R7b-10). */
  longName: string;
  ticker_: string;
  base: string;
  quote: string;
  venue: string;
  /** "Spot • Crypto" — the two halves, already sentence-cased. */
  typeLabel: string;
  classLabel: string;
  quote24h: WatchlistTicker | null;
  market: MarketLine;
  /** The instrument's tick, so price and change are shown to ITS precision. */
  priceTick: number | null;
  daily: DailyStats;
  /** Opens the existing alert composer for this instrument. */
  onEdit: () => void;
  /** Opens the same action list the row's right-click offers. */
  onMenu: (at: { x: number; y: number }) => void;
}

const POSITIVE_STRONG = "var(--ts-positive-strong)";

/** `191.37 M` — compact magnitude with the reference's separating space. */
function metric(value: number): string {
  const units = [
    { floor: 1_000_000_000, suffix: "B" },
    { floor: 1_000_000, suffix: "M" },
    { floor: 1_000, suffix: "K" },
  ] as const;
  const unit = units.find((candidate) => Math.abs(value) >= candidate.floor);
  if (!unit) return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return `${(value / unit.floor).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${unit.suffix}`;
}

export function WatchlistDetails({
  qualifiedName, longName, ticker_, base, quote, venue, typeLabel, classLabel,
  quote24h, market, priceTick, daily, onEdit, onMenu,
}: WatchlistDetailsProps) {
  const statsRef = useRef<HTMLHeadingElement>(null);
  const formatPrice = (value: number): string => formatQuote(value, priceTick);
  const changeKnown = quote24h !== null && quote24h.changeKnown !== false;
  const up = (quote24h?.chgPct ?? 0) >= 0;
  const directionClass = changeKnown ? (up ? "text-up" : "text-down") : "text-ink-faint";
  const marketColour = market.tone === "open" ? undefined
    : market.tone === "caution" ? "text-warn" : "text-down";

  const stats: Array<{ label: string; value: string | null }> = [
    {
      label: "Volume",
      value: quote24h?.volume !== undefined ? metric(quote24h.volume) : null,
    },
    {
      label: "Turnover",
      value: quote24h?.quoteVolume !== undefined ? metric(quote24h.quoteVolume) : null,
    },
    {
      /* Computed from daily bars; omitted until those bars are available. */
      label: "Average Volume (30D)",
      value: daily.averageVolume30D === null
        ? null : metric(daily.averageVolume30D),
    },
  ].filter((row) => row.value !== null);

  return (
    <section
      data-watchlist-details
      /* R7b-09: a name, not a storage identity. `qualifiedName` stays as the
         `<h2>`'s tooltip, where the exact key is occasionally what a reader
         wants. */
      aria-label={`Details for ${longName}`}
      className="shrink-0 border-t border-border bg-surface px-4 pb-3 pt-3"
    >
      <div className="flex items-center gap-2">
        <AssetMark asset={base} size={24} />
        <h2 className="min-w-0 flex-1 truncate text-[16px] font-semibold leading-none text-ink"
          title={qualifiedName}>
          {ticker_}
        </h2>
        <button
          aria-label="Show key stats"
          title="Key stats"
          onClick={() => statsRef.current?.scrollIntoView?.({ block: "nearest" })}
          className="tvc-control flex h-7 w-7 items-center justify-center text-ink"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
            <rect x="4" y="4" width="6" height="6" /><rect x="14" y="4" width="6" height="6" />
            <rect x="4" y="14" width="6" height="6" /><rect x="14" y="14" width="6" height="6" />
          </svg>
        </button>
        <button
          aria-label={`Create alert for ${ticker_}`}
          title="Create alert"
          onClick={onEdit}
          className="tvc-control flex h-7 w-7 items-center justify-center text-ink"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
            <path d="M5 19h4l10-10-4-4L5 15v4Z" /><path d="m13.5 6.5 4 4" />
          </svg>
        </button>
        <button
          aria-label={`Actions for ${ticker_}`}
          title="More"
          onClick={(e) => {
            const box = e.currentTarget.getBoundingClientRect();
            onMenu({ x: box.right, y: box.bottom });
          }}
          className="tvc-control flex h-7 w-7 items-center justify-center text-ink"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" />
          </svg>
        </button>
      </div>

      {/*
        R7b-10: the catalogue DOES hold the name.

        This line said `BTC / USDT • BINANCE` under a comment claiming
        "`Bitcoin / TetherUS` would be a name we do not hold" — while
        `lib/instrument.ts`'s `displayName()` produced exactly that string and
        `PaneLegend` painted it a thousand pixels to the left on the same
        screen. Where the catalogue does NOT name both legs, `displayName`
        returns the ticker and the pair form is still the honest fallback.
      */}
      <p className="mt-2 truncate text-[14px] leading-tight text-ink">
        {longName !== ticker_ ? longName : `${base} / ${quote}`} • {venue}
      </p>
      <p className="mt-1 truncate text-[14px] leading-tight text-ink-faint">
        {typeLabel} • {classLabel}
      </p>

      <p className="mt-3 flex items-baseline gap-1.5 leading-none">
        <span className="tabular text-[28px] font-semibold text-ink">
          {quote24h ? formatPrice(quote24h.last) : "—"}
        </span>
        <span className="text-[14px] text-ink-faint">{quote}</span>
      </p>
      <p className={`mt-1.5 tabular text-[16px] leading-none ${directionClass}`}>
        {changeKnown && quote24h
          ? `${up ? "+" : ""}${formatPrice(quote24h.chg)} ${up ? "+" : ""}${quote24h.chgPct.toFixed(2)}%`
          : "—"}
      </p>
      <p className={`mt-2 flex items-center gap-1.5 text-[14px] leading-none ${marketColour ?? ""}`}
        style={market.tone === "open" ? { color: POSITIVE_STRONG } : undefined}
        title={market.detail}>
        <span aria-hidden="true">●</span>{market.label}
      </p>

      {stats.length > 0 && <>
      <h3 ref={statsRef} className="mt-4 scroll-mt-2 text-[14px] font-semibold leading-none text-ink">Key stats</h3>
      <dl className="mt-1" data-key-stats>
        {stats.map((row) => (
          <div key={row.label} className="flex h-[25px] items-center justify-between gap-2">
            <dt className="truncate text-[14px] text-ink">{row.label}</dt>
            <dd className="shrink-0 tabular text-[14px] font-semibold text-ink">
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
      </>}

      <h3 className="mt-4 text-[14px] font-semibold leading-none text-ink">Performance</h3>
      {/*
        R7b-11: six tiles, 2x3, measured on `tv-shell-1920x1080-dark.png` —
        three columns about 82 wide with a 10px gap, two rows about 42 tall,
        the value 14px/600 in the direction colour on a ~12% tint of it, the
        period label 11px muted under it, radius 6.

        A period the series cannot support keeps the `—`: `instrumentStats`
        returns `null` rather than reaching for the oldest bar it happens to
        have and labelling the answer "1Y".
      */}
      {daily.performance === null ? (
        <p className="mt-1.5 text-[14px] leading-snug text-ink-faint">
          {daily.unavailable ?? "Reading this instrument\u2019s daily bars\u2026"}
        </p>
      ) : (
        <div className="mt-2 grid grid-cols-3 gap-2">
          {PERFORMANCE_PERIODS.map((period) => {
            const value = daily.performance![period];
            const up = (value ?? 0) >= 0;
            return (
              <div key={period} data-performance={period}
                className="flex h-[42px] flex-col items-center justify-center rounded-md"
                style={{ backgroundColor: value === null ? "var(--ts-surface-2)"
                  : `rgb(var(--ts-${up ? "positive" : "negative"}-rgb) / 0.12)` }}>
                <span className={`tabular text-[14px] font-semibold leading-none ${
                  value === null ? "text-ink-faint" : up ? "text-up" : "text-down"}`}>
                  {value === null ? "\u2014" : `${value.toFixed(2)}%`}
                </span>
                <span className="mt-1 text-[11px] leading-none text-ink-faint">{period}</span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
