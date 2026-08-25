/**
 * Turning an alert request body into a condition, and a condition back into the
 * columns that store it.
 *
 * Separated from the route so the accept/reject matrix — which is where every
 * 400 an alert client can see is decided — is testable as pure functions,
 * without a Fastify instance or a database connection.
 */
import {
  MA_ALERT_MODES, PRICE_DIRECTIONS,
  isMaAlertMode, isMaType, isPriceDirection,
  type ConditionKind, type MaAlertMode, type MaType, type PriceDirection,
} from "../types/maAlerts";
import type { AlertCondition } from "./alertConditions";

/** Shared 400 shape, so every rejection reads the same way in the UI. */
export type Rejection = { error: string };
export const bad = (error: string): Rejection => ({ error });

/**
 * Build the condition a request describes, or the reason it cannot be built.
 *
 * The per-kind field checks and `validateCondition` are deliberately both here:
 * this one turns "you sent the wrong type" into a message, and that one owns the
 * rules a condition must satisfy to be evaluable at all. Keeping the second in
 * the domain module is what stops the API and the database from drifting into
 * two different ideas of a valid alert.
 */
export function readCondition(
  kind: ConditionKind, b: Record<string, unknown>
): { condition: AlertCondition } | Rejection {
  const nearMinPct = b.nearMinPct === undefined ? 0.2 : Number(b.nearMinPct);
  const nearMaxPct = b.nearMaxPct === undefined ? 0.5 : Number(b.nearMaxPct);

  if (kind === "price") {
    const targetPrice = Number(b.targetPrice);
    const direction = String(b.priceDirection ?? "either");
    if (!Number.isFinite(targetPrice)) return bad("targetPrice must be a number");
    if (!isPriceDirection(direction)) {
      return bad(`priceDirection must be one of ${PRICE_DIRECTIONS.join(", ")}`);
    }
    return { condition: { kind: "price", targetPrice, direction } };
  }

  const maType = String(b.maType ?? "");
  const maLength = Number(b.maLength);
  const mode = String(b.mode ?? "");
  if (!isMaType(maType)) return bad("maType must be sma or ema");
  if (!Number.isInteger(maLength)) return bad("maLength must be an integer 1..1000");

  if (kind === "ma") {
    if (!isMaAlertMode(mode)) return bad(`mode must be one of ${MA_ALERT_MODES.join(", ")}`);
    return { condition: { kind: "ma", maType, maLength, mode, nearMinPct, nearMaxPct } };
  }

  const ma2Type = String(b.ma2Type ?? "");
  const ma2Length = Number(b.ma2Length);
  if (!isMaType(ma2Type)) return bad("ma2Type must be sma or ema");
  if (!Number.isInteger(ma2Length)) return bad("ma2Length must be an integer 1..1000");
  if (mode !== "cross_up" && mode !== "cross_down") {
    return bad("mode must be cross_up or cross_down for an MA-versus-MA alert");
  }
  return { condition: { kind: "ma_vs_ma", maType, maLength, ma2Type, ma2Length, mode } };
}

/** Flatten a condition back into the column shape the repository writes. */
export function toColumns(condition: AlertCondition): {
  conditionKind: ConditionKind;
  maType: MaType | null; maLength: number | null; mode: MaAlertMode | null;
  ma2Type: MaType | null; ma2Length: number | null;
  targetPrice: number | null; priceDirection: PriceDirection | null;
  nearMinPct: number; nearMaxPct: number;
} {
  switch (condition.kind) {
    case "price":
      return {
        conditionKind: "price",
        maType: null, maLength: null, mode: null, ma2Type: null, ma2Length: null,
        targetPrice: condition.targetPrice, priceDirection: condition.direction,
        nearMinPct: 0.2, nearMaxPct: 0.5,
      };
    case "ma":
      return {
        conditionKind: "ma",
        maType: condition.maType, maLength: condition.maLength, mode: condition.mode,
        ma2Type: null, ma2Length: null, targetPrice: null, priceDirection: null,
        nearMinPct: condition.nearMinPct, nearMaxPct: condition.nearMaxPct,
      };
    case "ma_vs_ma":
      return {
        conditionKind: "ma_vs_ma",
        maType: condition.maType, maLength: condition.maLength, mode: condition.mode,
        ma2Type: condition.ma2Type, ma2Length: condition.ma2Length,
        targetPrice: null, priceDirection: null,
        nearMinPct: 0.2, nearMaxPct: 0.5,
      };
  }
}

