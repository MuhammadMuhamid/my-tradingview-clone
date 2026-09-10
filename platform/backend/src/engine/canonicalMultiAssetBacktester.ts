import { createHash } from "node:crypto";
import { correctionsFingerprint, ACTIVE_CORRECTIONS, assertCorrectedEngine } from "./corrections";
import type { CanonicalInstrument } from "../market/model";
import { canonicalInstrumentId, effectiveListingStatus } from "../market/model";
import { cmeGlobexSessionOpen, oandaFxSessionOpen } from "../market/traditionalMarkets";
import type { EquityAdjustmentMode, EquitySessionMode } from "../market/provider";

export const CANONICAL_BACKTEST_INPUT_VERSION = "canonical-backtest-input.v1" as const;
export const CANONICAL_BACKTEST_RESULT_VERSION = "canonical-backtest-result.v1" as const;
export const CANONICAL_MULTI_ASSET_ENGINE_VERSION = "canonical-multiasset.v1" as const;

export class CanonicalBacktestSemanticError extends Error {
  readonly status = 422;
}

export interface CanonicalBacktestBar {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** FX executable sides. Both are required when execution is bid/ask. */
  bidOpen?: number;
  askOpen?: number;
  /** Derivative valuation/funding price. */
  markClose?: number;
  /** Derived and source bars must explicitly attest completeness. */
  complete: boolean;
}

export interface EquitySessionWindow {
  open: number;
  close: number;
  phase: "regular" | "extended";
}

export interface CanonicalBacktestOrder {
  id: string;
  /** Decision instant. Market execution is strictly on a later eligible bar open. */
  decisionTime: number;
  side: "BUY" | "SELL";
  effect: "OPEN" | "REDUCE" | "CLOSE";
  quantity?: number;
  reduceOnly?: boolean;
}

export type CanonicalBacktestEvent =
  | { id: string; kind: "funding"; at: number; rate: number; markPrice: number }
  | { id: string; kind: "fx_rollover"; at: number; amount: number }
  | { id: string; kind: "split"; at: number; ratio: number }
  | { id: string; kind: "dividend"; at: number; cashPerShare: number }
  | { id: string; kind: "roll"; at: number; fromInstrumentId: string; toInstrument: CanonicalInstrument;
      fromPrice: number; toPrice: number }
  | { id: string; kind: "expiry"; at: number; instrumentId: string; settlementPrice: number };

export interface CanonicalBacktestMethodology {
  intervalMs: number;
  price: {
    execution: "last" | "bid_ask";
    valuation: "last" | "mid" | "mark";
  };
  session: {
    mode: "continuous" | "provider_hours" | EquitySessionMode;
    /** Required for cash equities; authoritative exact provider-calendar windows. */
    windows?: readonly EquitySessionWindow[];
  };
  adjustment: EquityAdjustmentMode | "not_applicable";
  costs: {
    commissionRate: number;
    commissionFixed: number;
    slippageTicks: number;
  };
  margin: { model: "cash" | "notional_leverage"; leverage: number; mode: "cash" | "cross" | "isolated";
    positionMode: "one_way" | "hedge" };
  funding: { mode: "not_applicable" } | {
    mode: "historical_events";
    boundaryOrder: "events_before_fills_at_same_timestamp";
  };
  rollover: { mode: "not_applicable" | "none" | "historical_events"; boundary?: string; timezone?: string };
  roll: { mode: "not_applicable" | "hold_to_expiry" | "calendar"; methodologyId?: string };
  expiry: { mode: "not_applicable" | "explicit_settlement" };
  shorting: { allowed: boolean; borrowAssumption: "not_applicable" | "available" };
}

export interface CanonicalBacktestInput {
  schemaVersion: typeof CANONICAL_BACKTEST_INPUT_VERSION;
  instrument: CanonicalInstrument;
  bars: readonly CanonicalBacktestBar[];
  orders: readonly CanonicalBacktestOrder[];
  events: readonly CanonicalBacktestEvent[];
  methodology: CanonicalBacktestMethodology;
  initialCapital: number;
  feed: { providerId: string; feedId: string; datasetId: string };
  /** Optional continuous research source for signals; never treated as executable. */
  signalSource?: { canonicalInstrumentId: string; methodologyId: string; adjustment: string };
}

export interface CanonicalFill {
  id: string;
  orderId: string | null;
  time: number;
  canonicalInstrumentId: string;
  side: "BUY" | "SELL";
  effect: "OPEN" | "REDUCE" | "CLOSE";
  quantity: number;
  price: number;
  priceRole: "last" | "bid" | "ask" | "roll" | "settlement";
  notional: number;
  fee: number;
}

export interface CanonicalClosedTrade {
  entryTime: number;
  exitTime: number;
  canonicalInstrumentId: string;
  direction: "long" | "short";
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  grossPnl: number;
  fees: number;
  netPnl: number;
  exitReason: "order" | "roll" | "expiry";
}

export interface CanonicalLedgerEvent {
  id: string;
  kind: CanonicalBacktestEvent["kind"];
  at: number;
  amount: number;
  canonicalInstrumentId: string;
}

export interface CanonicalBacktestProvenance {
  engineVersion: typeof CANONICAL_MULTI_ASSET_ENGINE_VERSION;
  engineFingerprint: string;
  correctedV2Base: string;
  canonicalInstrument: string;
  tradedInstruments: string[];
  assetClass: CanonicalInstrument["identity"]["assetClass"];
  providerId: string;
  feedId: string;
  datasetId: string;
  priceBasis: CanonicalBacktestMethodology["price"];
  sessionMode: CanonicalBacktestMethodology["session"]["mode"];
  adjustmentMode: CanonicalBacktestMethodology["adjustment"];
  costs: CanonicalBacktestMethodology["costs"];
  fundingMethodology: CanonicalBacktestMethodology["funding"];
  rolloverMethodology: CanonicalBacktestMethodology["rollover"];
  rollMethodology: CanonicalBacktestMethodology["roll"];
  expiryMethodology: CanonicalBacktestMethodology["expiry"];
  margin: CanonicalBacktestMethodology["margin"];
  inputHash: string;
  signalSource: CanonicalBacktestInput["signalSource"] | null;
  timelineOrdering: "events_before_fills_at_same_timestamp;stable_input_order_within_kind";
  dataCompleteness: "all_bars_complete;open_session_gaps_rejected";
}

export interface CanonicalBacktestResult {
  schemaVersion: typeof CANONICAL_BACKTEST_RESULT_VERSION;
  provenance: CanonicalBacktestProvenance;
  fills: CanonicalFill[];
  trades: CanonicalClosedTrade[];
  ledger: CanonicalLedgerEvent[];
  initialCapital: number;
  endingEquity: number;
  realizedPnl: number;
  unrealizedPnl: number;
  feesPaid: number;
  fundingPnl: number;
  rolloverPnl: number;
  dividendPnl: number;
  netPnl: number;
  openPosition: null | {
    canonicalInstrumentId: string;
    direction: "long" | "short";
    quantity: number;
    entryPrice: number;
    markPrice: number;
    initialMargin: number;
  };
}

interface Position {
  quantity: number; // signed
  entryPrice: number;
  entryTime: number;
  entryFeeRemaining: number;
  instrument: CanonicalInstrument;
  initialMargin: number;
}

const fail = (message: string): never => { throw new CanonicalBacktestSemanticError(message); };
const finitePositive = (value: number, label: string): void => {
  if (!Number.isFinite(value) || value <= 0) fail(`${label} must be a positive finite number`);
};
const approxInteger = (value: number): boolean => Math.abs(value - Math.round(value)) <= 1e-9;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

export function canonicalMultiAssetEngineFingerprint(): string {
  return `engine:${CANONICAL_MULTI_ASSET_ENGINE_VERSION}:corrected-v2=${sha256(correctionsFingerprint(ACTIVE_CORRECTIONS)).slice(0, 16)}`;
}

function equityPhase(input: CanonicalBacktestInput, at: number): "regular" | "extended" | "closed" {
  for (const window of input.methodology.session.windows ?? []) {
    if (at >= window.open && at < window.close) return window.phase;
  }
  return "closed";
}

function isEligibleSession(input: CanonicalBacktestInput, instrument: CanonicalInstrument, at: number): boolean {
  if (instrument.identity.assetClass === "equity") {
    const phase = equityPhase(input, at);
    const mode = input.methodology.session.mode;
    return phase !== "closed" && (mode === "all" || mode === phase || (mode === "extended" && phase === "extended"));
  }
  if (instrument.identity.assetClass === "fx") return oandaFxSessionOpen(at);
  if (instrument.identity.instrumentType === "future" && instrument.futures) return cmeGlobexSessionOpen(at);
  return true;
}

function assertCanonicalIdentity(instrument: CanonicalInstrument): void {
  if (instrument.contractVersion !== "market.v1") fail("canonical instrument must use market.v1");
  let expectedCanonicalId = "";
  try {
    expectedCanonicalId = canonicalInstrumentId({
      venueId: instrument.identity.venueId,
      instrumentType: instrument.identity.instrumentType,
      baseAsset: instrument.identity.baseAsset,
      quoteAsset: instrument.identity.quoteAsset,
      settlementAsset: instrument.identity.settlementAsset,
      series: instrument.identity.series,
    });
  } catch (error) {
    fail(`invalid canonical instrument identity: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (instrument.identity.canonicalId !== expectedCanonicalId) fail("canonical instrument id does not match its economic identity");
}

function validateInstrument(input: CanonicalBacktestInput): void {
  const { instrument, methodology } = input;
  assertCanonicalIdentity(instrument);
  if (instrument.derivative.kind === "continuous_series") {
    fail("continuous futures are signal/research series only; execution requires specific tradable contracts");
  }
  if (instrument.referenceIndex) fail("reference indices are non-tradable and cannot be backtested as execution instruments");
  if (instrument.listing.providerId !== input.feed.providerId) fail("feed providerId does not match the canonical listing");
  if (effectiveListingStatus(instrument, input.bars[0]?.openTime ?? Date.now()) !== "active") {
    fail("canonical instrument is not active at the start of the test");
  }
  if (instrument.identity.assetClass === "equity") {
    if (!["raw", "split", "dividend", "all"].includes(methodology.adjustment)) fail("equity adjustment mode must be explicit");
    if (!["regular", "extended", "all"].includes(methodology.session.mode)) fail("equity session mode must be regular, extended, or all");
    if (!methodology.session.windows?.length) fail("equity tests require exact provider-calendar session windows");
    if ((methodology.session.mode === "extended" || methodology.session.mode === "all") &&
        instrument.equity?.marketData.extendedHours.support !== "supported") {
      fail("selected equity extended-hours mode is unsupported by the canonical instrument");
    }
  } else if (methodology.adjustment !== "not_applicable") {
    fail("non-equity adjustment mode must be not_applicable");
  }
  if (instrument.identity.assetClass === "fx") {
    if (methodology.price.execution !== "bid_ask" || methodology.price.valuation !== "mid") {
      fail("FX requires bid_ask execution and explicit mid valuation");
    }
    if (methodology.rollover.mode === "not_applicable") fail("FX rollover assumption must be explicit");
    if (instrument.sessions.calendarId !== "oanda-fx") fail("canonical-multiasset.v1 supports only the implemented OANDA FX calendar");
    if (methodology.session.mode !== "provider_hours") fail("FX requires provider-hours session semantics");
    if (methodology.margin.model !== "notional_leverage") fail("FX requires an explicit notional-leverage margin assumption");
  } else if (methodology.price.execution !== "last") {
    fail("only FX may use bid_ask execution");
  }
  const derivative = instrument.derivative.kind === "contract";
  const perpetual = instrument.derivative.kind === "contract" && instrument.derivative.maturity.kind === "perpetual";
  if (perpetual && (methodology.funding.mode !== "historical_events" ||
      methodology.funding.boundaryOrder !== "events_before_fills_at_same_timestamp")) {
    fail("perpetual tests require historical funding events and an explicit boundary ordering");
  }
  if (perpetual && (instrument.events.funding.support !== "supported" || !instrument.events.funding.historical)) {
    fail("perpetual backtests require supported historical funding capability");
  }
  if (!perpetual && methodology.funding.mode !== "not_applicable") fail("funding applies only to perpetual contracts");
  if (derivative && methodology.margin.model !== "notional_leverage") fail("derivatives require an explicit notional-leverage margin assumption");
  if (instrument.derivative.kind === "contract") {
    finitePositive(instrument.derivative.contractSize.value, "derivative contract size");
    finitePositive(instrument.derivative.multiplier, "derivative multiplier");
    if (instrument.derivative.settlement === "inverse" && instrument.derivative.contractSize.unit !== "quote") {
      fail("inverse contracts require quote-denominated contract size");
    }
  }
  if (derivative && instrument.identity.assetClass === "crypto" && methodology.price.valuation !== "mark") {
    fail("crypto derivative valuation requires the canonical mark price role");
  }
  if (derivative && instrument.identity.assetClass === "crypto" && instrument.prices.mark.support !== "supported") {
    fail("crypto derivative backtests require supported mark prices");
  }
  if (!derivative && !["fx"].includes(instrument.identity.assetClass) &&
      (methodology.margin.model !== "cash" || methodology.margin.leverage !== 1)) {
    fail("cash instruments require cash margin with leverage 1");
  }
  finitePositive(methodology.margin.leverage, "leverage");
  if (!instrument.execution.marginModes.includes(methodology.margin.mode)) {
    fail(`margin mode ${methodology.margin.mode} is unsupported by the canonical instrument`);
  }
  if (!instrument.execution.positionModes.includes(methodology.margin.positionMode)) {
    fail(`position mode ${methodology.margin.positionMode} is unsupported by the canonical instrument`);
  }
  if (methodology.margin.positionMode !== "one_way") {
    fail("hedge position mode is unsupported by canonical-multiasset.v1; choose one_way explicitly");
  }
  if (instrument.execution.leverage.support === "supported" && methodology.margin.leverage > instrument.execution.leverage.maximum) {
    fail(`leverage exceeds instrument maximum ${instrument.execution.leverage.maximum}`);
  }
  if (instrument.execution.leverage.support === "supported" && methodology.margin.leverage < instrument.execution.leverage.minimum) {
    fail(`leverage is below instrument minimum ${instrument.execution.leverage.minimum}`);
  }
  if (methodology.shorting.allowed) {
    if (!instrument.execution.directions.short || instrument.execution.shortSale.support !== "supported") {
      fail("shorting methodology is unsupported by the canonical instrument");
    }
    if (instrument.identity.assetClass === "equity" &&
        (methodology.shorting.borrowAssumption !== "available" || instrument.equity?.borrow.shortable !== "yes")) {
      fail("equity shorting methodology requires an affirmative borrow snapshot");
    }
    if (instrument.identity.assetClass !== "equity" && methodology.shorting.borrowAssumption !== "not_applicable") {
      fail("non-equity shorting must not claim an equity borrow assumption");
    }
  }
  if (instrument.identity.instrumentType === "future" && methodology.expiry.mode !== "explicit_settlement" &&
      methodology.roll.mode === "hold_to_expiry") fail("hold-to-expiry futures require explicit settlement methodology");
  if (instrument.identity.instrumentType === "future") {
    const futures = instrument.futures;
    if (!futures) {
      fail("specific futures require multiplier, tick and expiry metadata");
    } else {
      if (instrument.sessions.calendarId !== "cme-globex") fail("canonical-multiasset.v1 supports only the implemented CME Globex futures calendar");
      if (methodology.session.mode !== "provider_hours") fail("traditional futures require provider-hours session semantics");
      finitePositive(futures.multiplier, "futures multiplier");
      finitePositive(futures.tickSize, "futures tickSize");
      finitePositive(futures.tickValue, "futures tickValue");
      if (Math.abs(futures.tickSize * futures.multiplier - futures.tickValue) > 1e-9) {
        fail("futures tickValue must equal tickSize times multiplier");
      }
    }
  }
  if (input.signalSource) {
    if (!input.signalSource.canonicalInstrumentId.includes(":continuous_future:")) {
      fail("signalSource must identify a continuous futures research series");
    }
    if (!input.signalSource.methodologyId || !input.signalSource.adjustment) fail("continuous signal source requires roll methodology and adjustment");
  }
}

function validateBars(input: CanonicalBacktestInput): void {
  finitePositive(input.initialCapital, "initialCapital");
  finitePositive(input.methodology.intervalMs, "intervalMs");
  const { costs } = input.methodology;
  if (!Number.isFinite(costs.commissionRate) || costs.commissionRate < 0 || costs.commissionRate > 1) {
    fail("commissionRate must be finite and between 0 and 1");
  }
  if (!Number.isFinite(costs.commissionFixed) || costs.commissionFixed < 0) fail("commissionFixed must be finite and non-negative");
  if (!Number.isFinite(costs.slippageTicks) || costs.slippageTicks < 0) fail("slippageTicks must be finite and non-negative");
  if (input.bars.length === 0) fail("at least one complete bar is required");
  const seen = new Set<number>();
  let prior = -Infinity;
  for (const bar of input.bars) {
    if (!bar.complete) fail(`incomplete derived/source bar at ${bar.openTime}`);
    for (const [label, value] of Object.entries({ open: bar.open, high: bar.high, low: bar.low, close: bar.close })) {
      finitePositive(value, `${label} at ${bar.openTime}`);
    }
    if (!Number.isFinite(bar.volume) || bar.volume < 0) fail(`volume at ${bar.openTime} must be finite and non-negative`);
    if (bar.high < Math.max(bar.open, bar.close) || bar.low > Math.min(bar.open, bar.close) || bar.low > bar.high) {
      fail(`invalid OHLC geometry at ${bar.openTime}`);
    }
    if (bar.closeTime !== bar.openTime + input.methodology.intervalMs - 1) fail(`bar closeTime/interval mismatch at ${bar.openTime}`);
    if (bar.openTime <= prior || seen.has(bar.openTime)) fail("bars must be unique and strictly ordered");
    if (input.methodology.price.execution === "bid_ask") {
      finitePositive(bar.bidOpen ?? NaN, `bidOpen at ${bar.openTime}`);
      finitePositive(bar.askOpen ?? NaN, `askOpen at ${bar.openTime}`);
      if (bar.askOpen! <= bar.bidOpen!) fail(`FX ask must exceed bid at ${bar.openTime}`);
    }
    prior = bar.openTime; seen.add(bar.openTime);
  }
  const first = input.bars[0]!.openTime;
  const last = input.bars.at(-1)!.openTime;
  for (let expected = first; expected <= last; expected += input.methodology.intervalMs) {
    if (!seen.has(expected) && isEligibleSession(input, input.instrument, expected)) {
      fail(`missing bar inside selected open session at ${expected}`);
    }
  }
}

function validateOrdersAndEvents(input: CanonicalBacktestInput): void {
  const ids = new Set<string>();
  const firstTime = input.bars[0]!.openTime;
  const finalBoundary = input.bars.at(-1)!.closeTime + 1;
  for (const order of input.orders) {
    if (!order.id || ids.has(order.id)) fail(`order ids must be unique: ${order.id}`);
    ids.add(order.id);
    if (!Number.isFinite(order.decisionTime)) fail(`order ${order.id} has invalid decisionTime`);
    if (order.effect !== "CLOSE") finitePositive(order.quantity ?? NaN, `order ${order.id} quantity`);
    if (order.effect === "OPEN" && order.reduceOnly) fail(`order ${order.id}: reduce-only cannot open a position`);
  }
  for (const event of input.events) {
    if (!event.id || ids.has(event.id)) fail(`event/order ids must be globally unique: ${event.id}`);
    ids.add(event.id);
    if (!Number.isFinite(event.at)) fail(`event ${event.id} has invalid time`);
    if (event.at < firstTime || event.at > finalBoundary) fail(`event ${event.id} falls outside the tested data window`);
    const derivative = input.instrument.derivative;
    if (event.kind === "funding" &&
        (derivative.kind !== "contract" || derivative.maturity.kind !== "perpetual")) fail("funding events require a perpetual contract");
    if (event.kind === "fx_rollover" && input.instrument.identity.assetClass !== "fx") fail("rollover events require an FX instrument");
    if ((event.kind === "split" || event.kind === "dividend") && input.instrument.identity.assetClass !== "equity") {
      fail("corporate-action events require an equity/ETF instrument");
    }
    if ((event.kind === "roll" || event.kind === "expiry") &&
        (derivative.kind !== "contract" || derivative.maturity.kind !== "dated")) fail("roll/expiry events require a specific dated contract");
    if (event.kind === "funding") { finitePositive(event.markPrice, "funding markPrice"); if (!Number.isFinite(event.rate)) fail("funding rate must be finite"); }
    if (event.kind === "split") finitePositive(event.ratio, "split ratio");
    if (event.kind === "dividend" && (!Number.isFinite(event.cashPerShare) || event.cashPerShare < 0)) fail("dividend must be non-negative");
    if (event.kind === "fx_rollover" && !Number.isFinite(event.amount)) fail("FX rollover amount must be finite");
    if (event.kind === "roll") { finitePositive(event.fromPrice, "roll fromPrice"); finitePositive(event.toPrice, "roll toPrice"); }
    if (event.kind === "expiry") {
      finitePositive(event.settlementPrice, "expiry settlementPrice");
      if (!event.instrumentId) fail("expiry event must identify a specific contract");
    }
    if (event.kind === "roll" && derivative.kind === "contract" && derivative.maturity.kind === "dated" &&
        event.at >= Date.parse(derivative.maturity.expiresAt)) fail("contract roll must occur before expiry");
  }
  const adjustment = input.methodology.adjustment;
  if (input.instrument.identity.assetClass === "equity") {
    if ((adjustment === "split" || adjustment === "all") && input.events.some((event) => event.kind === "split")) {
      fail("split-adjusted bars cannot also replay split events");
    }
    if ((adjustment === "dividend" || adjustment === "all") && input.events.some((event) => event.kind === "dividend")) {
      fail("dividend-adjusted bars cannot also replay dividend events");
    }
    if (input.events.some((event) => event.kind === "split" || event.kind === "dividend") &&
        input.instrument.events.corporateActions.support !== "supported") {
      fail("corporate-action replay requires supported instrument event capability");
    }
  }
}

function multiplier(instrument: CanonicalInstrument): number {
  if (instrument.futures) return instrument.futures.multiplier;
  if (instrument.derivative.kind === "contract" && instrument.derivative.contractSize.unit === "base") {
    return instrument.derivative.contractSize.value;
  }
  return 1;
}

function pnl(instrument: CanonicalInstrument, signedQuantity: number, entry: number, exit: number): number {
  if (instrument.derivative.kind === "contract" && instrument.derivative.settlement === "inverse") {
    if (instrument.derivative.contractSize.unit !== "quote") fail("inverse contracts require quote-denominated contract size");
    return Math.sign(signedQuantity) * Math.abs(signedQuantity) * instrument.derivative.contractSize.value * (1 / entry - 1 / exit);
  }
  return signedQuantity * (exit - entry) * multiplier(instrument);
}

function notional(instrument: CanonicalInstrument, quantity: number, price: number): number {
  if (instrument.derivative.kind === "contract") {
    if (!approxInteger(quantity) && instrument.derivative.quantityUnit === "contracts") fail("contract quantity must be an integer");
    if (instrument.derivative.settlement === "inverse") return quantity * instrument.derivative.contractSize.value / price;
    if (instrument.derivative.contractSize.unit === "quote") return quantity * instrument.derivative.contractSize.value;
  }
  return quantity * price * multiplier(instrument);
}

function fillPrice(input: CanonicalBacktestInput, bar: CanonicalBacktestBar, side: "BUY" | "SELL",
  instrument: CanonicalInstrument): { price: number; role: CanonicalFill["priceRole"] } {
  const slip = input.methodology.costs.slippageTicks *
    (instrument.precision.priceTick.state === "known" ? instrument.precision.priceTick.value : 0);
  if (input.methodology.costs.slippageTicks > 0 && instrument.precision.priceTick.state !== "known") {
    fail("slippage ticks require a known canonical price tick");
  }
  const base = input.methodology.price.execution === "bid_ask"
    ? (side === "BUY" ? bar.askOpen! : bar.bidOpen!) : bar.open;
  return { price: base + (side === "BUY" ? slip : -slip),
    role: input.methodology.price.execution === "bid_ask" ? (side === "BUY" ? "ask" : "bid") : "last" };
}

function markPrice(input: CanonicalBacktestInput, bar: CanonicalBacktestBar): number {
  if (input.methodology.price.valuation === "mark") {
    finitePositive(bar.markClose ?? NaN, `markClose at ${bar.openTime}`); return bar.markClose!;
  }
  if (input.methodology.price.valuation === "mid") {
    finitePositive(bar.bidOpen ?? NaN, `bidOpen at ${bar.openTime}`);
    finitePositive(bar.askOpen ?? NaN, `askOpen at ${bar.openTime}`);
    return (bar.bidOpen! + bar.askOpen!) / 2;
  }
  return bar.close;
}

export function runCanonicalBacktest(input: CanonicalBacktestInput): CanonicalBacktestResult {
  assertCorrectedEngine(ACTIVE_CORRECTIONS);
  if (input.schemaVersion !== CANONICAL_BACKTEST_INPUT_VERSION) fail(`unsupported input schema ${String(input.schemaVersion)}`);
  validateInstrument(input); validateBars(input); validateOrdersAndEvents(input);

  let current = input.instrument;
  const state: { position: Position | null } = { position: null };
  let realizedPnl = 0; let feesPaid = 0; let fundingPnl = 0; let rolloverPnl = 0; let dividendPnl = 0;
  const fills: CanonicalFill[] = []; const trades: CanonicalClosedTrade[] = []; const ledger: CanonicalLedgerEvent[] = [];
  const traded = new Set<string>([current.identity.canonicalId]);

  const feeFor = (instrument: CanonicalInstrument, quantity: number, price: number): number =>
    notional(instrument, quantity, price) * input.methodology.costs.commissionRate + input.methodology.costs.commissionFixed;

  const assertOpenAllowed = (side: "BUY" | "SELL", quantity: number): void => {
    if (side === "BUY" && !current.execution.directions.long) fail("canonical instrument does not support long positions");
    if (side === "SELL") {
      if (!input.methodology.shorting.allowed || input.methodology.shorting.borrowAssumption !==
        (current.identity.assetClass === "equity" ? "available" : "not_applicable")) fail("short position requires explicit supported borrow/capability assumptions");
      if (!current.execution.directions.short || current.execution.shortSale.support !== "supported") fail("canonical instrument does not support short positions");
      if (current.identity.assetClass === "equity" && current.equity?.borrow.shortable !== "yes") {
        fail("equity short requires an affirmative instrument borrow snapshot");
      }
    }
    if (current.identity.instrumentType === "spot" && side === "SELL") fail("cash crypto spot remains long-only");
    if (current.derivative.kind === "contract" && current.derivative.quantityUnit === "contracts" && !approxInteger(quantity)) {
      fail("contract quantity must be an integer");
    }
  };

  const recordFill = (params: Omit<CanonicalFill, "id" | "notional" | "fee">): CanonicalFill => {
    const amount = notional(current, params.quantity, params.price);
    const fee = feeFor(current, params.quantity, params.price);
    feesPaid += fee;
    const fill = { ...params, id: `fill-${fills.length + 1}`, notional: amount, fee } satisfies CanonicalFill;
    fills.push(fill); return fill;
  };

  const open = (side: "BUY" | "SELL", quantity: number, price: number, time: number,
    orderId: string | null, role: CanonicalFill["priceRole"]): void => {
    if (state.position) fail(`cannot open ${orderId ?? "lifecycle position"}: pyramiding/reversal is unsupported; close first`);
    assertOpenAllowed(side, quantity);
    const fill = recordFill({ orderId, time, canonicalInstrumentId: current.identity.canonicalId,
      side, effect: "OPEN", quantity, price, priceRole: role });
    const margin = notional(current, quantity, price) / input.methodology.margin.leverage;
    const available = input.initialCapital + realizedPnl + fundingPnl + rolloverPnl + dividendPnl - feesPaid;
    if (margin > available + 1e-12) fail(`insufficient margin: required ${margin}, available ${available}`);
    state.position = { quantity: side === "BUY" ? quantity : -quantity, entryPrice: price,
      entryTime: time, entryFeeRemaining: fill.fee, instrument: current, initialMargin: margin };
  };

  const close = (quantity: number, price: number, time: number, orderId: string | null,
    role: CanonicalFill["priceRole"], reason: CanonicalClosedTrade["exitReason"]): void => {
    const active = state.position;
    if (!active) throw new CanonicalBacktestSemanticError(`cannot close ${orderId ?? reason}: no open position`);
    if (quantity > Math.abs(active.quantity) + 1e-12) fail(`reduce quantity exceeds the open position: ${quantity}`);
    const side = active.quantity > 0 ? "SELL" : "BUY";
    const before = Math.abs(active.quantity);
    const fill = recordFill({ orderId, time, canonicalInstrumentId: current.identity.canonicalId,
      side, effect: quantity === before ? "CLOSE" : "REDUCE", quantity, price, priceRole: role });
    const entryFee = active.entryFeeRemaining * (quantity / before);
    const gross = pnl(active.instrument, Math.sign(active.quantity) * quantity, active.entryPrice, price);
    realizedPnl += gross;
    trades.push({ entryTime: active.entryTime, exitTime: time, canonicalInstrumentId: active.instrument.identity.canonicalId,
      direction: active.quantity > 0 ? "long" : "short", quantity, entryPrice: active.entryPrice,
      exitPrice: price, grossPnl: gross, fees: entryFee + fill.fee, netPnl: gross - entryFee - fill.fee, exitReason: reason });
    active.entryFeeRemaining -= entryFee;
    active.quantity -= Math.sign(active.quantity) * quantity;
    active.initialMargin *= 1 - quantity / before;
    if (Math.abs(active.quantity) <= 1e-12) state.position = null;
  };

  const pending = input.orders.map((order, sequence) => {
    const bar = input.bars.find((candidate) => candidate.openTime > order.decisionTime && isEligibleSession(input, input.instrument, candidate.openTime))
      ?? fail(`order ${order.id} has no later eligible complete bar; same-bar/hindsight fills are forbidden`);
    return { kind: "order" as const, at: bar.openTime, order, bar, sequence };
  });
  const timeline = [...pending, ...input.events.map((event, sequence) => ({
    kind: "event" as const, at: event.at, event, sequence,
  }))].sort((a, b) => a.at - b.at || (a.kind === b.kind ? a.sequence - b.sequence : a.kind === "event" ? -1 : 1));

  for (const item of timeline) {
    if (item.kind === "order") {
      const { order, bar } = item;
      if (!isEligibleSession(input, current, bar.openTime)) fail(`order ${order.id} would fill in a closed session`);
      const maturity = current.derivative.kind === "contract" ? current.derivative.maturity : null;
      if (maturity?.kind === "dated" && bar.openTime >= Date.parse(maturity.expiresAt)) fail(`order ${order.id} would fill at/after expiry`);
      const priced = fillPrice(input, bar, order.side, current);
      if (order.effect === "OPEN") open(order.side, order.quantity!, priced.price, bar.openTime, order.id, priced.role);
      else {
        const active = state.position;
        if (!active) throw new CanonicalBacktestSemanticError(`order ${order.id} cannot reduce a flat position`);
        const expected = active.quantity > 0 ? "SELL" : "BUY";
        if (order.side !== expected) fail(`order ${order.id} does not reduce the current position`);
        if (!order.reduceOnly) fail(`order ${order.id} reduction must be explicitly reduce-only`);
        if (current.derivative.kind === "contract" && !current.execution.reduceOnly) {
          fail(`order ${order.id}: canonical derivative does not support reduce-only orders`);
        }
        close(order.effect === "CLOSE" ? Math.abs(active.quantity) : order.quantity!, priced.price,
          bar.openTime, order.id, priced.role, "order");
      }
      continue;
    }

    const event = item.event;
    if (event.kind === "funding") {
      if (input.methodology.funding.mode !== "historical_events") fail("funding event supplied without historical-events methodology");
      let amount = 0;
      const active = state.position;
      if (active) amount = -Math.sign(active.quantity) * notional(current, Math.abs(active.quantity), event.markPrice) * event.rate;
      fundingPnl += amount; ledger.push({ id: event.id, kind: event.kind, at: event.at, amount,
        canonicalInstrumentId: current.identity.canonicalId });
    } else if (event.kind === "fx_rollover") {
      if (input.methodology.rollover.mode !== "historical_events") fail("FX rollover event supplied without historical-events methodology");
      const amount = state.position ? event.amount : 0; rolloverPnl += amount;
      ledger.push({ id: event.id, kind: event.kind, at: event.at, amount, canonicalInstrumentId: current.identity.canonicalId });
    } else if (event.kind === "split") {
      if (state.position) { state.position.quantity *= event.ratio; state.position.entryPrice /= event.ratio; }
      ledger.push({ id: event.id, kind: event.kind, at: event.at, amount: 0, canonicalInstrumentId: current.identity.canonicalId });
    } else if (event.kind === "dividend") {
      const amount = state.position ? state.position.quantity * event.cashPerShare : 0; dividendPnl += amount;
      ledger.push({ id: event.id, kind: event.kind, at: event.at, amount, canonicalInstrumentId: current.identity.canonicalId });
    } else if (event.kind === "roll") {
      if (input.methodology.roll.mode !== "calendar" || !input.methodology.roll.methodologyId) fail("roll event requires explicit calendar methodology");
      if (event.fromInstrumentId !== current.identity.canonicalId) fail("roll fromInstrumentId is not the current tradable contract");
      if (event.toInstrument.derivative.kind !== "contract" || event.toInstrument.identity.instrumentType !== "future") fail("roll target must be a specific tradable futures contract");
      assertCanonicalIdentity(event.toInstrument);
      if (event.toInstrument.listing.providerId !== input.feed.providerId) fail("roll target must use the tested provider/feed");
      if (effectiveListingStatus(event.toInstrument, event.at) !== "active") fail("roll target is not active at the roll instant");
      const rollTargetFutures = event.toInstrument.futures;
      if (!rollTargetFutures || rollTargetFutures.root !== current.futures?.root) {
        fail("roll target must be a specific contract for the same futures root");
      } else {
        finitePositive(rollTargetFutures.multiplier, "roll target futures multiplier");
        finitePositive(rollTargetFutures.tickSize, "roll target futures tickSize");
        finitePositive(rollTargetFutures.tickValue, "roll target futures tickValue");
      }
      if (event.toInstrument.sessions.calendarId !== current.sessions.calendarId) fail("roll target must retain the same trading calendar");
      const direction = state.position ? (state.position.quantity > 0 ? "BUY" : "SELL") : null;
      const quantity = state.position ? Math.abs(state.position.quantity) : 0;
      if (state.position) close(quantity, event.fromPrice, event.at, null, "roll", "roll");
      current = event.toInstrument; traded.add(current.identity.canonicalId);
      if (direction) open(direction, quantity, event.toPrice, event.at, null, "roll");
      ledger.push({ id: event.id, kind: event.kind, at: event.at, amount: 0, canonicalInstrumentId: current.identity.canonicalId });
    } else {
      if (input.methodology.expiry.mode !== "explicit_settlement") fail("expiry event requires explicit-settlement methodology");
      if (event.instrumentId !== current.identity.canonicalId) fail("expiry event does not identify the current tradable contract");
      const currentMaturity = current.derivative.kind === "contract" ? current.derivative.maturity : null;
      if (currentMaturity?.kind !== "dated" || event.at !== Date.parse(currentMaturity.expiresAt)) {
        fail("expiry event must occur at the current contract's exact expiresAt instant");
      }
      if (state.position) close(Math.abs(state.position.quantity), event.settlementPrice, event.at, null, "settlement", "expiry");
      ledger.push({ id: event.id, kind: event.kind, at: event.at, amount: 0, canonicalInstrumentId: current.identity.canonicalId });
    }
  }

  const maturity = current.derivative.kind === "contract" ? current.derivative.maturity : null;
  if (state.position && maturity?.kind === "dated" && input.bars.at(-1)!.closeTime >= Date.parse(maturity.expiresAt)) {
    fail("open dated contract crosses expiry without an explicit roll or settlement event");
  }
  const last = input.bars.at(-1)!;
  const marked = markPrice(input, last);
  const openPosition = state.position;
  const unrealizedPnl = openPosition ? pnl(openPosition.instrument, openPosition.quantity, openPosition.entryPrice, marked) : 0;
  const netPnl = realizedPnl + unrealizedPnl + fundingPnl + rolloverPnl + dividendPnl - feesPaid;
  const correctedV2Base = correctionsFingerprint(ACTIVE_CORRECTIONS);
  return {
    schemaVersion: CANONICAL_BACKTEST_RESULT_VERSION,
    provenance: { engineVersion: CANONICAL_MULTI_ASSET_ENGINE_VERSION,
      engineFingerprint: canonicalMultiAssetEngineFingerprint(), correctedV2Base,
      canonicalInstrument: input.instrument.identity.canonicalId, tradedInstruments: [...traded],
      assetClass: input.instrument.identity.assetClass, providerId: input.feed.providerId,
      feedId: input.feed.feedId, datasetId: input.feed.datasetId, priceBasis: { ...input.methodology.price },
      sessionMode: input.methodology.session.mode, adjustmentMode: input.methodology.adjustment,
      costs: { ...input.methodology.costs }, fundingMethodology: { ...input.methodology.funding },
      rolloverMethodology: { ...input.methodology.rollover }, rollMethodology: { ...input.methodology.roll },
      expiryMethodology: { ...input.methodology.expiry }, margin: { ...input.methodology.margin },
      inputHash: sha256(input), signalSource: input.signalSource ? { ...input.signalSource } : null,
      timelineOrdering: "events_before_fills_at_same_timestamp;stable_input_order_within_kind",
      dataCompleteness: "all_bars_complete;open_session_gaps_rejected" },
    fills, trades, ledger, initialCapital: input.initialCapital,
    endingEquity: input.initialCapital + netPnl, realizedPnl, unrealizedPnl, feesPaid,
    fundingPnl, rolloverPnl, dividendPnl, netPnl,
    openPosition: openPosition ? { canonicalInstrumentId: current.identity.canonicalId,
      direction: openPosition.quantity > 0 ? "long" : "short", quantity: Math.abs(openPosition.quantity),
      entryPrice: openPosition.entryPrice, markPrice: marked, initialMargin: openPosition.initialMargin } : null,
  };
}
