/**
 * Moving-average alert CRUD. Each row arms ONE MA line on one symbol +
 * timeframe, which is what lets the UI put an independent bell on the 200 SMA
 * and the 15 EMA of the same chart.
 */
import type { FastifyInstance } from "fastify";
import * as maAlertRepo from "../../repositories/maAlerts";
import { isInterval } from "../../types/market";
import {
  isMaType, isMaAlertMode, isTriggerMode,
  MA_ALERT_MODES, MA_LENGTHS, MA_TYPES, TRIGGER_MODES,
} from "../../types/maAlerts";

export async function maAlertRoutes(app: FastifyInstance): Promise<void> {
  /** Vocabulary for the alert dialog, so the UI never hardcodes it. */
  app.get("/api/ma-alerts/options", async () => ({
    maTypes: MA_TYPES,
    maLengths: MA_LENGTHS,
    modes: MA_ALERT_MODES,
    triggers: TRIGGER_MODES,
  }));

  app.get("/api/ma-alerts", async (req) => {
    const q = req.query as { symbol?: string; timeframe?: string; enabled?: string };
    return maAlertRepo.listAlerts({
      symbol: q.symbol,
      timeframe: q.timeframe && isInterval(q.timeframe) ? q.timeframe : undefined,
      enabledOnly: q.enabled === "true",
    });
  });

  app.get("/api/ma-alerts/events", async (req) => {
    const { limit } = req.query as { limit?: string };
    return maAlertRepo.listEvents(Number(limit ?? 100) || 100);
  });

  app.post("/api/ma-alerts", async (req, reply) => {
    const b = req.body as Record<string, unknown>;
    const symbol = String(b?.symbol ?? "").toUpperCase();
    const timeframe = String(b?.timeframe ?? "");
    const maType = String(b?.maType ?? "");
    const mode = String(b?.mode ?? "");
    const maLength = Number(b?.maLength);

    if (!symbol) return reply.code(400).send({ error: "symbol is required" });
    if (!isInterval(timeframe)) return reply.code(400).send({ error: "timeframe is not a supported interval" });
    if (!isMaType(maType)) return reply.code(400).send({ error: "maType must be sma or ema" });
    if (!isMaAlertMode(mode)) return reply.code(400).send({ error: `mode must be one of ${MA_ALERT_MODES.join(", ")}` });
    if (!Number.isInteger(maLength) || maLength < 1 || maLength > 1000) {
      return reply.code(400).send({ error: "maLength must be an integer 1..1000" });
    }

    const nearMinPct = b.nearMinPct === undefined ? 0.2 : Number(b.nearMinPct);
    const nearMaxPct = b.nearMaxPct === undefined ? 0.5 : Number(b.nearMaxPct);
    if (mode.startsWith("near")) {
      if (!Number.isFinite(nearMinPct) || !Number.isFinite(nearMaxPct) || nearMinPct < 0) {
        return reply.code(400).send({ error: "nearMinPct/nearMaxPct must be non-negative numbers" });
      }
      if (nearMaxPct <= nearMinPct) {
        return reply.code(400).send({ error: "nearMaxPct must be greater than nearMinPct" });
      }
    }
    const trigger = b.trigger === undefined ? "once_per_bar_close" : String(b.trigger);
    if (!isTriggerMode(trigger)) {
      return reply.code(400).send({ error: `trigger must be one of ${TRIGGER_MODES.join(", ")}` });
    }
    const cooldownMin = b.cooldownMin === undefined ? 60 : Number(b.cooldownMin);
    if (!Number.isInteger(cooldownMin) || cooldownMin < 0) {
      return reply.code(400).send({ error: "cooldownMin must be a non-negative integer" });
    }

    const row = await maAlertRepo.upsertAlert({
      symbol, timeframe, maType, maLength, mode,
      nearMinPct, nearMaxPct, cooldownMin, trigger,
      enabled: b.enabled === undefined ? true : Boolean(b.enabled),
      note: b.note === undefined ? null : String(b.note),
    });
    return reply.code(201).send(row);
  });

  app.patch("/api/ma-alerts/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as Record<string, unknown>;
    const patch: Parameters<typeof maAlertRepo.updateAlert>[1] = {};
    if (b.enabled !== undefined) patch.enabled = Boolean(b.enabled);
    if (b.cooldownMin !== undefined) patch.cooldownMin = Number(b.cooldownMin);
    if (b.nearMinPct !== undefined) patch.nearMinPct = Number(b.nearMinPct);
    if (b.nearMaxPct !== undefined) patch.nearMaxPct = Number(b.nearMaxPct);
    if (b.note !== undefined) patch.note = b.note === null ? null : String(b.note);
    if (b.mode !== undefined) {
      const mode = String(b.mode);
      if (!isMaAlertMode(mode)) return reply.code(400).send({ error: "invalid mode" });
      patch.mode = mode;
    }
    if (b.trigger !== undefined) {
      const t = String(b.trigger);
      if (!isTriggerMode(t)) return reply.code(400).send({ error: "invalid trigger" });
      patch.trigger = t;
    }
    if (b.timeframe !== undefined) {
      const tf = String(b.timeframe);
      if (!isInterval(tf)) return reply.code(400).send({ error: "invalid timeframe" });
      patch.timeframe = tf;
    }
    if (patch.nearMinPct !== undefined && patch.nearMaxPct !== undefined &&
        patch.nearMaxPct <= patch.nearMinPct) {
      return reply.code(400).send({ error: "nearMaxPct must be greater than nearMinPct" });
    }
    const row = await maAlertRepo.updateAlert(id, patch);
    if (!row) return reply.code(404).send({ error: "alert not found" });
    return row;
  });

  app.delete("/api/ma-alerts/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = await maAlertRepo.deleteAlert(id);
    if (!ok) return reply.code(404).send({ error: "alert not found" });
    return reply.code(204).send();
  });
}
