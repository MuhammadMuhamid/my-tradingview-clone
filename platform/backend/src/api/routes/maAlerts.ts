/**
 * Alert CRUD.
 *
 * One row arms ONE condition on one symbol + timeframe, which is what lets the
 * UI put an independent bell on the 200 SMA, the 15 EMA and a price level of
 * the same chart.
 *
 * The route is still `/api/ma-alerts` and the MA request shape is unchanged:
 * a body without `conditionKind` is a moving-average alert, exactly as before,
 * and a body without `frequency` gets `once_per_bar_close`, which is what every
 * alert did before frequencies existed. Nothing an existing client sends
 * changes meaning.
 */
import type { FastifyInstance } from "fastify";
import * as maAlertRepo from "../../repositories/maAlerts";
import { assertSymbol } from "../../data/binanceRest";
import { isInterval } from "../../types/market";
import {
  CONDITION_KINDS, MA_ALERT_MODES, MA_LENGTHS, MA_TYPES, PRICE_DIRECTIONS,
  isConditionKind, isMaAlertMode, isPriceDirection,
} from "../../types/maAlerts";
import { bad, readCondition, toColumns } from "../../alerts/alertRequest";
import {
  ALERT_FREQUENCIES, DEFAULT_ALERT_FREQUENCY, INTRABAR_WARNING,
  describeFrequency, explainFrequency, isAlertFrequency, isIntrabar,
} from "../../alerts/alertFrequency";
import { validateCondition } from "../../alerts/alertConditions";

export async function maAlertRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Vocabulary for the alert dialog, so the UI never hardcodes it — including
   * the intrabar warning, which is served from the same constant the runner's
   * behaviour is defined by rather than retyped as UI copy.
   */
  app.get("/api/ma-alerts/options", async () => ({
    maTypes: MA_TYPES,
    maLengths: MA_LENGTHS,
    modes: MA_ALERT_MODES,
    conditionKinds: CONDITION_KINDS,
    priceDirections: PRICE_DIRECTIONS,
    defaultFrequency: DEFAULT_ALERT_FREQUENCY,
    intrabarWarning: INTRABAR_WARNING,
    frequencies: ALERT_FREQUENCIES.map((f) => ({
      value: f,
      label: describeFrequency(f),
      explanation: explainFrequency(f),
      intrabar: isIntrabar(f),
      warning: isIntrabar(f) ? INTRABAR_WARNING : null,
    })),
  }));

  app.get("/api/ma-alerts", async (req) => {
    const q = req.query as { symbol?: string; timeframe?: string; enabled?: string };
    return maAlertRepo.listAlerts({
      symbol: q.symbol ? assertSymbol(q.symbol) : undefined,
      timeframe: q.timeframe && isInterval(q.timeframe) ? q.timeframe : undefined,
      activeOnly: q.enabled === "true",
    });
  });

  app.get("/api/ma-alerts/events", async (req) => {
    const { limit } = req.query as { limit?: string };
    return maAlertRepo.listEvents(Number(limit ?? 100) || 100);
  });

  app.post("/api/ma-alerts", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    // An armed alert's symbol is interpolated straight into the Binance
    // websocket stream name, where a `/` would inject extra streams. This is
    // the same choke point every market-data call already uses.
    let symbol: string;
    try {
      symbol = assertSymbol(String(b?.symbol ?? ""));
    } catch {
      return reply.code(400).send(bad("symbol must be 2-24 uppercase letters or digits"));
    }

    const timeframe = String(b?.timeframe ?? "");
    if (!isInterval(timeframe)) {
      return reply.code(400).send(bad("timeframe is not a supported interval"));
    }

    // No `conditionKind` means a moving-average alert: the shape every client
    // written before price alerts existed still sends.
    const kind = b.conditionKind === undefined ? "ma" : String(b.conditionKind);
    if (!isConditionKind(kind)) {
      return reply.code(400).send(bad(`conditionKind must be one of ${CONDITION_KINDS.join(", ")}`));
    }

    const frequency = b.frequency === undefined ? DEFAULT_ALERT_FREQUENCY : String(b.frequency);
    if (!isAlertFrequency(frequency)) {
      return reply.code(400).send(bad(`frequency must be one of ${ALERT_FREQUENCIES.join(", ")}`));
    }

    const read = readCondition(kind, b);
    if ("error" in read) return reply.code(400).send(read);
    const invalid = validateCondition(read.condition);
    if (invalid) return reply.code(400).send(bad(invalid));

    const cooldownMin = b.cooldownMin === undefined ? 60 : Number(b.cooldownMin);
    if (!Number.isInteger(cooldownMin) || cooldownMin < 0) {
      return reply.code(400).send(bad("cooldownMin must be a non-negative integer"));
    }

    const row = await maAlertRepo.upsertAlert({
      symbol, timeframe, frequency, cooldownMin,
      ...toColumns(read.condition),
      enabled: b.enabled === undefined ? true : Boolean(b.enabled),
      note: b.note === undefined ? null : String(b.note),
    });
    return reply.code(201).send({
      ...row,
      // The UI must show this beside an intrabar alert; serving it with the row
      // means it cannot be forgotten in one of the places alerts are listed.
      warning: isIntrabar(row.frequency) ? INTRABAR_WARNING : null,
    });
  });

  app.patch("/api/ma-alerts/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as Record<string, unknown>;
    const patch: maAlertRepo.MaAlertPatch = {};
    if (b.enabled !== undefined) patch.enabled = Boolean(b.enabled);
    if (b.cooldownMin !== undefined) patch.cooldownMin = Number(b.cooldownMin);
    if (b.nearMinPct !== undefined) patch.nearMinPct = Number(b.nearMinPct);
    if (b.nearMaxPct !== undefined) patch.nearMaxPct = Number(b.nearMaxPct);
    if (b.note !== undefined) patch.note = b.note === null ? null : String(b.note);
    if (b.mode !== undefined) {
      const mode = String(b.mode);
      if (!isMaAlertMode(mode)) return reply.code(400).send(bad("invalid mode"));
      patch.mode = mode;
    }
    if (b.timeframe !== undefined) {
      const tf = String(b.timeframe);
      if (!isInterval(tf)) return reply.code(400).send(bad("invalid timeframe"));
      patch.timeframe = tf;
    }
    if (b.frequency !== undefined) {
      const f = String(b.frequency);
      if (!isAlertFrequency(f)) {
        return reply.code(400).send(bad(`frequency must be one of ${ALERT_FREQUENCIES.join(", ")}`));
      }
      patch.frequency = f;
    }
    if (b.targetPrice !== undefined) {
      const t = Number(b.targetPrice);
      if (!Number.isFinite(t) || t <= 0) {
        return reply.code(400).send(bad("targetPrice must be a positive number"));
      }
      patch.targetPrice = t;
    }
    if (b.priceDirection !== undefined) {
      const d = String(b.priceDirection);
      if (!isPriceDirection(d)) {
        return reply.code(400).send(bad(`priceDirection must be one of ${PRICE_DIRECTIONS.join(", ")}`));
      }
      patch.priceDirection = d;
    }
    if (patch.nearMinPct !== undefined && patch.nearMaxPct !== undefined &&
        patch.nearMaxPct <= patch.nearMinPct) {
      return reply.code(400).send(bad("nearMaxPct must be greater than nearMinPct"));
    }
    const row = await maAlertRepo.updateAlert(id, patch);
    if (!row) return reply.code(404).send(bad("alert not found"));
    return { ...row, warning: isIntrabar(row.frequency) ? INTRABAR_WARNING : null };
  });

  app.delete("/api/ma-alerts/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = await maAlertRepo.deleteAlert(id);
    if (!ok) return reply.code(404).send(bad("alert not found"));
    return reply.code(204).send();
  });
}
