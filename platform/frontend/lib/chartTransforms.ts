/**
 * Chart-only transforms: Heikin Ashi and Renko.
 *
 * ── The boundary this file sits on ─────────────────────────────────────────
 *
 * Everything here is a *display* transform. It reads canonical exchange OHLC
 * and returns bars that are drawn on a chart and nowhere else. No value
 * produced by this module may reach an order price, a bid/ask, a balance, an
 * alert, a strategy signal, a backtest, or a persisted/scientific candle
 * payload — those all continue to read the canonical candles the transform was
 * given. The transform is a leaf: it has no dependencies, and nothing depends
 * on it except the renderer and these tests.
 *
 *      canonical candles ──┬──> strategy / alerts / trading / science (unchanged)
 *                          └──> transform (here) ──> pixels
 *
 * ── Why the engines are written as folds ───────────────────────────────────
 *
 * Both transforms are recursive: a bar's shape depends on every canonical bar
 * before it. A live chart cannot afford to recompute ten thousand bars for
 * each incoming tick, and a chart that computes the tail *differently* from
 * the whole is a chart that quietly disagrees with itself.
 *
 * So there is exactly one implementation — `transformStep`, a pure function of
 * (cursor, one canonical bar) — and `transformAll` is a fold of it. The
 * renderer keeps a cursor over "every bar but the forming one" and re-steps
 * only the forming bar. Incremental output is therefore equal to a clean
 * recomputation by construction, not by coincidence, and the tests pin it.
 *
 * Forward-only folding also gives the two safety properties for free:
 *
 *   no look-ahead     a step sees one bar and the state before it, so bar i
 *                     cannot be influenced by bar i+1;
 *   replay clipping   the result for a clipped prefix is the prefix of the
 *                     result for the whole, because nothing is revisited.
 *
 * Source bars are never mutated: every step reads its input and returns new
 * objects.
 */

/** The subset of a canonical candle a transform reads. `openTime` is in ms. */
export interface OhlcBar {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** Wilder ATR period for Renko V1. */
export const DEFAULT_RENKO_ATR_PERIOD = 14;

export interface RenkoParams {
  /** Wilder ATR period that sets the brick size. */
  atrPeriod: number;
}

export type TransformKind = "heikinAshi" | "renko";

// ── Heikin Ashi ────────────────────────────────────────────────────────────

/**
 * The two values the next Heikin-Ashi bar needs from this one.
 *
 * Only open and close: the high and low are derived from the source bar and
 * this bar's own open/close, never from the previous bar's extremes.
 */
export interface HeikinAshiState {
  open: number;
  close: number;
}

/**
 * One Heikin-Ashi bar.
 *
 *   haClose = (open + high + low + close) / 4
 *   haOpen  = (open + close) / 2                    for the first source bar
 *           = (prevHaOpen + prevHaClose) / 2        afterwards
 *   haHigh  = max(high, haOpen, haClose)
 *   haLow   = min(low,  haOpen, haClose)
 *
 * The source timestamp is preserved exactly: Heikin Ashi re-shapes bars, it
 * does not re-time them, so one HA bar corresponds to one canonical bar and
 * everything else on the chart still lines up with it.
 */
export function heikinAshiBar(previous: HeikinAshiState | null, bar: OhlcBar): OhlcBar {
  const close = (bar.open + bar.high + bar.low + bar.close) / 4;
  const open = previous === null
    ? (bar.open + bar.close) / 2
    : (previous.open + previous.close) / 2;
  return {
    openTime: bar.openTime,
    open,
    high: Math.max(bar.high, open, close),
    low: Math.min(bar.low, open, close),
    close,
  };
}

export function heikinAshiBars(bars: readonly OhlcBar[]): OhlcBar[] {
  const out: OhlcBar[] = [];
  let previous: HeikinAshiState | null = null;
  for (const bar of bars) {
    const ha = heikinAshiBar(previous, bar);
    out.push(ha);
    previous = { open: ha.open, close: ha.close };
  }
  return out;
}

// ── Renko V1 ───────────────────────────────────────────────────────────────

/**
 * A stop that exists only so a pathological brick size cannot hang the tab.
 *
 * At ATR-sized bricks a single source bar moving five hundred average ranges
 * is not market data, it is corrupt input. The cap is a termination guard, not
 * a modelling choice, and it is deterministic like everything else here.
 */
const MAX_BRICKS_PER_BAR = 512;

/** Wilder ATR, folded one bar at a time. Uses only bars already seen. */
interface AtrState {
  /** Canonical bars folded so far. */
  count: number;
  /** Sum of the true ranges seen while seeding the first average. */
  seedSum: number;
  /** Null until `atrPeriod` bars have been folded. */
  value: number | null;
  /** Previous bar's close, for the true range. Null on the first bar. */
  previousClose: number | null;
}

export interface RenkoState {
  atr: AtrState;
  /** Set once ATR is available and the first reference price has been taken. */
  anchored: boolean;
  /** Open of the most recent brick — or the anchor price, before any brick. */
  brickOpen: number;
  /** Close of the most recent brick — or the anchor price, before any brick. */
  brickClose: number;
  /** 0 until the first brick fixes a direction. */
  direction: 1 | -1 | 0;
  /** Open time (ms) of the most recent brick; 0 before any. */
  lastTime: number;
}

/**
 * One Renko brick.
 *
 * `openTime` is a *rendering* time, not an exchange timestamp — see
 * `brickTime` below. `sourceOpenTime` is the canonical bar whose close
 * completed the brick and is the only timestamp that means anything outside
 * the chart.
 */
export interface RenkoBrick extends OhlcBar {
  direction: 1 | -1;
  sourceOpenTime: number;
  /** The ATR value used as the brick size, for disclosure and tests. */
  size: number;
}

export function createRenkoState(): RenkoState {
  return {
    atr: { count: 0, seedSum: 0, value: null, previousClose: null },
    anchored: false,
    brickOpen: 0,
    brickClose: 0,
    direction: 0,
    lastTime: 0,
  };
}

/** True range against the previous close; the first bar has only its own range. */
function trueRange(bar: OhlcBar, previousClose: number | null): number {
  if (previousClose === null) return bar.high - bar.low;
  return Math.max(
    bar.high - bar.low,
    Math.abs(bar.high - previousClose),
    Math.abs(bar.low - previousClose)
  );
}

/**
 * Wilder ATR after folding `bar`.
 *
 * Seeded as the simple mean of the first `period` true ranges and smoothed as
 * `(prev * (period - 1) + tr) / period` thereafter. Before the seed completes
 * the value is null, which is what makes "insufficient history produces no
 * brick" a property of the data rather than a special case in the caller.
 */
function foldAtr(state: AtrState, bar: OhlcBar, period: number): AtrState {
  const tr = trueRange(bar, state.previousClose);
  const count = state.count + 1;
  let value = state.value;
  let seedSum = state.seedSum;
  if (value === null) {
    seedSum += tr;
    if (count >= period) value = seedSum / period;
  } else {
    value = (value * (period - 1) + tr) / period;
  }
  return { count, seedSum, value, previousClose: bar.close };
}

/**
 * Bricks share their source bar's open time, and step forward one second each
 * when a single bar completes several.
 *
 * A Renko chart has no time axis of its own; anchoring bricks to the bar that
 * produced them keeps them roughly where that move happened, so canonical-time
 * markers and drawings still land in the right neighbourhood. The +1s spacing
 * is the minimum that keeps the series strictly increasing, which the renderer
 * requires and which no honest alternative avoids.
 */
function brickTime(sourceOpenTime: number, lastTime: number): number {
  return Math.max(sourceOpenTime, lastTime + 1000);
}

/**
 * Fold one canonical bar into the Renko state, emitting whatever bricks its
 * close completes.
 *
 * ── The exact V1 rule ──────────────────────────────────────────────────────
 *
 * Close-based, ATR-sized, with the conventional two-brick reversal:
 *
 *  1. ATR(period) is updated from this bar and every bar before it. No brick is
 *     emitted while ATR is still seeding.
 *  2. The first bar at which ATR exists sets the anchor price (its close) and
 *     emits nothing — there is no brick without a prior reference.
 *  3. `size` is the ATR value *at this bar*. Every brick this bar completes
 *     uses that one size, so a bar's output does not depend on where inside it
 *     the loop happens to be.
 *  4. Continuation: while the close has moved a full `size` beyond the last
 *     brick's close in the current direction, emit another brick in that
 *     direction, each spanning exactly one `size`.
 *  5. Reversal: while the close has moved a full `size` beyond the last
 *     brick's *open* against the current direction — two sizes from its close,
 *     the classic Renko reversal — emit one brick the other way, spanning from
 *     that open. Direction then flips and rule 4 applies again.
 *  6. Before any direction exists, either side may open with a single `size`
 *     move from the anchor.
 *
 * A large move therefore produces as many whole bricks as it contains, in
 * order, and a move smaller than the threshold produces none.
 */
export function foldRenko(
  state: RenkoState, bar: OhlcBar, params: RenkoParams
): { state: RenkoState; bricks: RenkoBrick[] } {
  const period = Math.max(1, Math.floor(params.atrPeriod));
  const atr = foldAtr(state.atr, bar, period);
  const size = atr.value;

  if (size === null || !Number.isFinite(size) || size <= 0) {
    // No usable brick size yet (or a degenerate one): carry the ATR forward and
    // fabricate nothing. An unanchored state stays unanchored, so the first
    // real brick still gets a reference price it did not invent.
    return { state: { ...state, atr }, bricks: [] };
  }
  if (!state.anchored) {
    return {
      state: {
        ...state, atr, anchored: true,
        brickOpen: bar.close, brickClose: bar.close, direction: 0,
      },
      bricks: [],
    };
  }

  const close = bar.close;
  let { brickOpen, brickClose, direction, lastTime } = state;
  const bricks: RenkoBrick[] = [];

  for (let n = 0; n < MAX_BRICKS_PER_BAR; n++) {
    let open: number;
    let next: number;
    let dir: 1 | -1;
    if (direction !== -1 && close >= brickClose + size) {
      // Up continuation — and, while no direction is fixed, the opening move.
      open = brickClose; next = brickClose + size; dir = 1;
    } else if (direction !== 1 && close <= brickClose - size) {
      open = brickClose; next = brickClose - size; dir = -1;
    } else if (direction === 1 && close <= brickOpen - size) {
      open = brickOpen; next = brickOpen - size; dir = -1;      // reversal down
    } else if (direction === -1 && close >= brickOpen + size) {
      open = brickOpen; next = brickOpen + size; dir = 1;       // reversal up
    } else {
      break;
    }
    const time = brickTime(bar.openTime, lastTime);
    bricks.push({
      openTime: time,
      open,
      close: next,
      high: Math.max(open, next),
      low: Math.min(open, next),
      direction: dir,
      sourceOpenTime: bar.openTime,
      size,
    });
    brickOpen = open;
    brickClose = next;
    direction = dir;
    lastTime = time;
  }

  return {
    state: { ...state, atr, anchored: true, brickOpen, brickClose, direction, lastTime },
    bricks,
  };
}

export function renkoBricks(
  bars: readonly OhlcBar[], params: RenkoParams
): RenkoBrick[] {
  let state = createRenkoState();
  const out: RenkoBrick[] = [];
  for (const bar of bars) {
    const stepped = foldRenko(state, bar, params);
    state = stepped.state;
    out.push(...stepped.bricks);
  }
  return out;
}

// ── One cursor for both transforms ─────────────────────────────────────────

/**
 * Everything a transform needs to continue from where it stopped.
 *
 * Held by value and replaced rather than mutated, so the renderer can keep a
 * cursor over the closed bars and re-step the forming one as often as a tick
 * arrives without the closed history ever drifting.
 */
export interface TransformCursor {
  kind: TransformKind;
  params: RenkoParams;
  /** Canonical bars folded into this cursor. */
  bars: number;
  ha: HeikinAshiState | null;
  renko: RenkoState;
}

export function createTransformCursor(
  kind: TransformKind, params: RenkoParams = { atrPeriod: DEFAULT_RENKO_ATR_PERIOD }
): TransformCursor {
  return { kind, params, bars: 0, ha: null, renko: createRenkoState() };
}

/** Fold one canonical bar. Pure: the cursor passed in is left untouched. */
export function transformStep(
  cursor: TransformCursor, bar: OhlcBar
): { cursor: TransformCursor; emitted: OhlcBar[] } {
  if (cursor.kind === "heikinAshi") {
    const ha = heikinAshiBar(cursor.ha, bar);
    return {
      cursor: { ...cursor, bars: cursor.bars + 1, ha: { open: ha.open, close: ha.close } },
      emitted: [ha],
    };
  }
  const stepped = foldRenko(cursor.renko, bar, cursor.params);
  return {
    cursor: { ...cursor, bars: cursor.bars + 1, renko: stepped.state },
    emitted: stepped.bricks,
  };
}

/** Fold a whole canonical series. Equal, by construction, to stepping it. */
export function transformAll(
  kind: TransformKind, bars: readonly OhlcBar[], params?: RenkoParams
): { cursor: TransformCursor; output: OhlcBar[] } {
  let cursor = createTransformCursor(kind, params);
  const output: OhlcBar[] = [];
  for (const bar of bars) {
    const stepped = transformStep(cursor, bar);
    cursor = stepped.cursor;
    output.push(...stepped.emitted);
  }
  return { cursor, output };
}

// ── Reading a display bar back ─────────────────────────────────────────────

/**
 * Whether a drawn bar is a Renko brick.
 *
 * `transformStep` is typed as emitting `OhlcBar`, which is what every consumer
 * that only draws them needs. A brick carries three more fields — its
 * direction, the ATR size that set it, and the canonical bar that completed it
 * — and the two places that must not treat a brick as a time candle (the OHLC
 * legend, and the crosshair time published to other panes) ask here first.
 */
export function isRenkoBrick(bar: OhlcBar): bar is RenkoBrick {
  const candidate = bar as Partial<RenkoBrick>;
  return typeof candidate.sourceOpenTime === "number"
    && typeof candidate.size === "number"
    && (candidate.direction === 1 || candidate.direction === -1);
}

/**
 * The canonical exchange timestamp a drawn bar stands for, in milliseconds.
 *
 * For a canonical candle and for a Heikin-Ashi bar this is simply its own open
 * time: Heikin Ashi re-shapes bars without re-timing them. For a Renko brick
 * it is `sourceOpenTime` — the bar whose close completed the brick — because
 * the brick's own `openTime` is a rendering position that may have been
 * stepped forward a second at a time to keep the series strictly increasing.
 *
 * This is THE function that keeps a synthetic display time from escaping the
 * chart it was invented for. Anything leaving the renderer — a crosshair time
 * published to another pane, a legend timestamp — goes through it.
 */
export function canonicalOpenTime(bar: OhlcBar): number {
  return isRenkoBrick(bar) ? bar.sourceOpenTime : bar.openTime;
}
