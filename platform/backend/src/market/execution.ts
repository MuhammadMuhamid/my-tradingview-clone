import { binanceSpotAdapter } from "./binanceSpotAdapter";
import type { ExecutionCapabilities } from "./model";
import { resolveInstrument } from "../types/instrument";

export interface ExecutionIntent {
  side?: unknown;
  positionDirection?: unknown;
  environment?: unknown;
  leverage?: unknown;
  marginMode?: unknown;
  reduceOnly?: unknown;
  positionMode?: unknown;
  orderType?: unknown;
  timeInForce?: unknown;
  extendedHours?: unknown;
}

export interface ExecutionTarget {
  providerId: string;
  venueId: string;
  instrumentType: string;
  capabilities: ExecutionCapabilities;
  marketState?: {
    kind: "calendar";
    phase: "pre" | "regular" | "after" | "closed";
    listingStatus: "active" | "halted" | "delisted" | "unknown";
    observedAt: string;
  };
}

export class UnsupportedExecutionError extends Error {
  readonly status = 422;
}

/** Compatibility resolver: every legacy bare symbol still means Binance Spot. */
export function defaultExecutionTarget(raw: string): ExecutionTarget {
  const legacy = resolveInstrument(raw);
  return {
    providerId: binanceSpotAdapter.id,
    venueId: legacy.venue,
    instrumentType: "spot",
    capabilities: binanceSpotAdapter.execution,
  };
}

function requestedBoolean(value: unknown): boolean {
  return value === true || value === "true";
}

/** Pure pre-Bot gate. The Bot is never contacted after one of these refusals. */
export function assertExecutionSupported(target: ExecutionTarget, intent: ExecutionIntent): void {
  const cap = target.capabilities;
  const environment = intent.environment ?? "live";
  if (environment !== "paper" && environment !== "testnet" && environment !== "live") {
    throw new UnsupportedExecutionError(`unsupported execution environment: ${String(environment)}`);
  }
  if (!cap.availability[environment]) {
    throw new UnsupportedExecutionError(`${target.providerId} does not support ${environment} execution`);
  }
  if (target.marketState) {
    if (target.marketState.listingStatus !== "active") {
      throw new UnsupportedExecutionError(`listing is ${target.marketState.listingStatus}; order was not sent to Bot`);
    }
    if (target.marketState.phase === "closed") {
      throw new UnsupportedExecutionError("US equity session is closed; queuing is disabled and order was not sent to Bot");
    }
    if (target.marketState.phase !== "regular") {
      if (!requestedBoolean(intent.extendedHours)) {
        throw new UnsupportedExecutionError(`${target.marketState.phase}-market order requires explicit extendedHours=true`);
      }
      const type = String(intent.orderType ?? "").toUpperCase();
      const tif = String(intent.timeInForce ?? "DAY").toUpperCase();
      if (type !== "LIMIT" || (tif !== "DAY" && tif !== "GTC")) {
        throw new UnsupportedExecutionError("extended-hours equities require a LIMIT order with DAY or GTC time in force");
      }
    }
  }
  const direction = intent.positionDirection ?? "long";
  if (direction !== "long" && direction !== "short") {
    throw new UnsupportedExecutionError(`unsupported position direction: ${String(direction)}`);
  }
  if (!cap.directions[direction]) {
    throw new UnsupportedExecutionError(`${target.providerId} ${target.instrumentType} does not support ${direction} positions`);
  }
  if (direction === "short" && cap.shortSale.support === "unsupported") {
    throw new UnsupportedExecutionError(cap.shortSale.reason);
  }
  if (intent.leverage !== undefined) {
    const leverage = Number(intent.leverage);
    if (cap.leverage.support === "unsupported") throw new UnsupportedExecutionError(cap.leverage.reason);
    if (!Number.isFinite(leverage) || leverage < cap.leverage.minimum || leverage > cap.leverage.maximum) {
      throw new UnsupportedExecutionError(`leverage must be ${cap.leverage.minimum}..${cap.leverage.maximum}`);
    }
  }
  if (intent.marginMode !== undefined && !cap.marginModes.includes(intent.marginMode as never)) {
    throw new UnsupportedExecutionError(`unsupported margin mode: ${String(intent.marginMode)}`);
  }
  if (requestedBoolean(intent.reduceOnly) && !cap.reduceOnly) {
    throw new UnsupportedExecutionError(`${target.providerId} ${target.instrumentType} does not support reduce-only orders`);
  }
  if (intent.positionMode !== undefined && !cap.positionModes.includes(intent.positionMode as never)) {
    throw new UnsupportedExecutionError(`unsupported position mode: ${String(intent.positionMode)}`);
  }
}
