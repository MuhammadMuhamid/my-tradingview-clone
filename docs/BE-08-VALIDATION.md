# BE-08 controlled MTF validation

**Verdict (2026-09-01): RESOLVED_AND_FIXED.** This validation covers historical,
confirmed 15-minute bars requesting 60-minute data with
`barmerge.gaps_off` and `barmerge.lookahead_off` on a 24/7 UTC market.
Realtime/developing HTF values are outside this result.

## Authority

TradingView's official Pine Script v6 page
[Other timeframes and data](https://www.tradingview.com/pine-script-docs/concepts/other-timeframes-and-data/)
states that:

- `gaps_off` fills historical gaps with the last confirmed requested value;
- a `lookahead_off` series has a new historical value at the **end** of each
  HTF period;
- realtime bars can instead contain developing, unconfirmed HTF values.

The first two statements resolve the boundary without a logged-in TradingView
observation: the 60m value is visible on the final constituent 15m bar, where
the two bars close together. This is the `chartClose` convention. A direct
TradingView UI observation was not performed.

## Current-HEAD reproduction before the fix

The deterministic fixture used hourly close values `100`, `101`, and `102` for
the hours beginning at 00:00, 01:00, and 02:00 UTC. `close` below is the
exclusive human-readable boundary; stored `closeTime` is one millisecond less.

| 15m open (UTC) | 15m close | completed 60m opens | request.security | built-in MTF |
|---|---|---|---:|---:|
| 2026-01-01 00:30 | 00:45 | none | null | null |
| 2026-01-01 00:45 | 01:00 | 00:00 | null | 100 |
| 2026-01-01 01:00 | 01:15 | 00:00 | 100 | 100 |
| 2026-01-01 01:45 | 02:00 | 00:00, 01:00 | 100 | 101 |
| 2026-01-01 02:00 | 02:15 | 00:00, 01:00 | 101 | 101 |
| 2026-01-01 02:45 | 03:00 | 00:00, 01:00, 02:00 | 101 | 102 |

The first mismatch was therefore the 15m bar opened at
`2026-01-01T00:45:00.000Z`, which closes at `01:00:00Z`.

## Resolution

Built-in MTF already used `feed.closeTime <= chart.closeTime`, matching the
documented boundary. The Pine interpreter used
`feed.closeTime <= chart.openTime`, delaying each new hourly value by one chart
bar. Its historical HTF alignment now uses the chart bar's close time.

The regression test checks the bar immediately before, the boundary-closing
bar, and the bar after three consecutive hourly boundaries. It also compares
request.security directly with `buildMergeIndex()` and proves every selected
HTF bar closed no later than the chart bar. `barmerge.lookahead_on` remains an
explicit unsupported error.
