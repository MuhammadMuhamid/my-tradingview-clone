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
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import * as maAlertRepo from "../../repositories/maAlerts";
import { AlertConflictError } from "../../repositories/maAlerts";
import { assertSymbol } from "../../data/binanceRest";
import { isInterval } from "../../types/market";
import {
  CONDITION_KINDS, MA_ALERT_MODES, MA_LENGTHS, MA_TYPES, PRICE_DIRECTIONS,
  BULK_ALERT_ACTIONS, isBulkAlertAction, isConditionKind,
} from "../../types/maAlerts";
import type { MaAlertRow } from "../../types/maAlerts";
import { bad, readCondition, toColumns } from "../../alerts/alertRequest";
import {
  COMMON_EDITABLE_FIELDS, EDITABLE_CONDITION_FIELDS, INTERNAL_ALERT_FIELDS,
  mergeConditionRequest, referenceChanged,
} from "../../alerts/alertEdit";
import {
  ALERT_FREQUENCIES, DEFAULT_ALERT_FREQUENCY, INTRABAR_WARNING,
  describeFrequency, explainFrequency, isAlertFrequency, isIntrabar,
} from "../../alerts/alertFrequency";
import { validateCondition } from "../../alerts/alertConditions";

export const MAX_BULK_ALERTS = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type BulkExecutor = typeof maAlertRepo.bulkActAlerts;

/** Exported so the HTTP contract can be tested with a local repository fake. */
export function bulkAlertHandler(execute: BulkExecutor = maAlertRepo.bulkActAlerts) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const action = String(body.action ?? "");
    if (!isBulkAlertAction(action)) {
      return reply.code(400).send(bad(
        `action must be one of ${BULK_ALERT_ACTIONS.join(", ")}`
      ));
    }
    if (!Array.isArray(body.ids)) {
      return reply.code(400).send(bad("ids must be a non-empty array"));
    }
    const rawIds = body.ids;
    if (rawIds.length === 0) {
      return reply.code(400).send(bad("ids must not be empty"));
    }
    if (rawIds.length > MAX_BULK_ALERTS) {
      return reply.code(400).send(bad(`at most ${MAX_BULK_ALERTS} alert IDs may be changed at once`));
    }
    if (rawIds.some((id) => typeof id !== "string" || !UUID.test(id))) {
      return reply.code(400).send(bad("every id must be a UUID"));
    }

    const ids = [...new Set(rawIds as string[])];
    const result = await execute(ids, action);
    if (result.missingIds.length > 0) {
      return reply.code(409).send({
        error: "one or more alerts no longer exist in the current admin scope",
        ...result,
      });
    }
    return result;
  };
}

export interface AlertPatchDeps {
  getAlert: (id: string) => Promise<MaAlertRow | null>;
  updateAlert: (
    id: string, patch: maAlertRepo.MaAlertPatch
  ) => Promise<MaAlertRow | null>;
}

/**
 * Edit one alert in place.
 *
 * ── Why this is one endpoint and not two ───────────────────────────────────
 *
 * A body that names no condition field — `{ enabled: false }`, the pause
 * button — takes the narrow path and writes only what it named. A body that
 * names any condition field is re-read through the SAME functions creation
 * uses: the row is turned back into the request it would have been created
 * from, the client's keys are overlaid, and the result goes through
 * `readCondition` → `validateCondition` → `toColumns`. That is what makes an
 * edit unable to store a configuration the create route would have refused,
 * and what stops an unmentioned field being reset to a default.
 *
 * The alert's FAMILY is fixed, and its runtime and delivery state belong to the
 * runner — both are refused rather than ignored, because a UI that believes it
 * changed one of them is worse off than one told it cannot.
 *
 * Exported with injectable dependencies so the whole accept/reject matrix is
 * testable without a database.
 */
export function alertPatchHandler(deps: AlertPatchDeps = {
  getAlert: maAlertRepo.getAlert,
  updateAlert: maAlertRepo.updateAlert,
}) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send(bad("id must be a UUID"));
    const b = (req.body ?? {}) as Record<string, unknown>;

    const row = await deps.getAlert(id);
    if (!row) return reply.code(404).send(bad("alert not found"));

    // An alert's family is fixed. Converting one would keep the id and the
    // event log while making every historical entry describe something the
    // alert no longer is, and the per-kind unique indexes would change meaning
    // underneath a live row.
    if (b.conditionKind !== undefined && String(b.conditionKind) !== row.conditionKind) {
      return reply.code(400).send(bad(
        `an alert's type cannot be changed (this one is ${row.conditionKind}); ` +
        "delete it and create the alert you want instead"
      ));
    }
    const internal = INTERNAL_ALERT_FIELDS.filter(
      (field) => field !== "conditionKind" && b[field] !== undefined
    );
    if (internal.length > 0) {
      return reply.code(400).send(bad(
        `${internal.join(", ")} ${internal.length === 1 ? "is" : "are"} maintained by the ` +
        "alert runner and cannot be edited"
      ));
    }

    const known = new Set<string>([
      ...COMMON_EDITABLE_FIELDS,
      ...EDITABLE_CONDITION_FIELDS[row.conditionKind],
      "conditionKind",
    ]);
    // A field that belongs to a DIFFERENT family is refused rather than
    // dropped: silently ignoring `rsiLevel` on a MACD alert is how a UI ends up
    // showing a saved value the server never stored.
    const foreign = Object.keys(b).filter((key) => !known.has(key));
    if (foreign.length > 0) {
      return reply.code(400).send(bad(
        `${foreign.join(", ")} ${foreign.length === 1 ? "is" : "are"} not editable on a ` +
        `${row.conditionKind} alert`
      ));
    }

    const patch: maAlertRepo.MaAlertPatch = {};

    if (b.symbol !== undefined) {
      // Same choke point every market-data call uses: the symbol is
      // interpolated into a Binance stream name.
      try {
        patch.symbol = assertSymbol(String(b.symbol));
      } catch {
        return reply.code(400).send(bad("symbol must be 2-24 uppercase letters or digits"));
      }
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
    if (b.cooldownMin !== undefined) {
      const cooldownMin = Number(b.cooldownMin);
      if (!Number.isInteger(cooldownMin) || cooldownMin < 0) {
        return reply.code(400).send(bad("cooldownMin must be a non-negative integer"));
      }
      patch.cooldownMin = cooldownMin;
    }
    if (b.enabled !== undefined) patch.enabled = Boolean(b.enabled);
    if (b.note !== undefined) {
      const note = readNote(b.note);
      if ("error" in note) return reply.code(400).send(note);
      patch.note = note.value;
    }

    const merged = mergeConditionRequest(row, b);
    let columns: ReturnType<typeof toColumns> | null = null;
    if (merged) {
      const read = readCondition(row.conditionKind, merged);
      if ("error" in read) return reply.code(400).send(read);
      const invalid = validateCondition(read.condition);
      if (invalid) return reply.code(400).send(bad(invalid));
      columns = toColumns(read.condition);
      // Everything the condition owns is written together, including the
      // columns the edit did not name — they came out of the row itself, so
      // this restates them rather than resetting them.
      const { conditionKind: _kind, ...conditionColumns } = columns;
      Object.assign(patch, conditionColumns);
    }

    // The cross memory is only cleared when the thing it was recorded against
    // moved. A different symbol or timeframe is a different series; a different
    // reference is a different comparison. A new mode or cadence is neither.
    patch.resetLastSide =
      (patch.symbol !== undefined && patch.symbol !== row.symbol) ||
      (patch.timeframe !== undefined && patch.timeframe !== row.timeframe) ||
      (columns !== null && referenceChanged(row.conditionKind, row, columns));

    let updated: MaAlertRow | null;
    try {
      updated = await deps.updateAlert(id, patch);
    } catch (error) {
      if (error instanceof AlertConflictError) {
        return reply.code(409).send(bad(error.message));
      }
      throw error;
    }
    if (!updated) return reply.code(404).send(bad("alert not found"));
    return { ...updated, warning: isIntrabar(updated.frequency) ? INTRABAR_WARNING : null };
  };
}

/**
 * The longest note that can ride along in a notification.
 *
 * A Web Push payload is capped at 4 KB and a phone renders roughly two lines,
 * so the limit is about what a reader can actually see rather than about
 * storage. Mirrored by `ma_alerts_note_len_ck`, so a client that bypasses this
 * route meets the same rule instead of a 500.
 */
const NOTE_MAX_LENGTH = 280;

/**
 * The user's own reason for arming an alert.
 *
 * Trimmed, and an all-whitespace note becomes null rather than an empty string:
 * the notification formatter would otherwise append a bare separator to the
 * body for a note that says nothing.
 */
function readNote(value: unknown): { value: string | null } | { error: string } {
  if (value === undefined || value === null) return { value: null };
  const note = String(value).trim();
  if (note.length === 0) return { value: null };
  if (note.length > NOTE_MAX_LENGTH) {
    return { error: `note must be ${NOTE_MAX_LENGTH} characters or fewer` };
  }
  return { value: note };
}

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
    noteMaxLength: NOTE_MAX_LENGTH,
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
    const { limit, symbol, timeframe } = req.query as {
      limit?: string; symbol?: string; timeframe?: string;
    };
    /*
     * `symbol` and `timeframe` together scope this to one chart.
     *
     * Both or neither: a symbol without a timeframe would return a 1h alert's
     * events to a 1m chart, and the caller that wants everything is the alerts
     * page, which wants exactly that. The chart passes both, so "the newest
     * 200 for this chart" is true — without it, a user with busy alerts
     * elsewhere pushed this chart's events out of the window and the chart
     * concluded that none had fired.
     */
    const scope = symbol && timeframe
      ? { symbol: String(symbol), timeframe: String(timeframe) }
      : undefined;
    return maAlertRepo.listEvents(Number(limit ?? 100) || 100, scope);
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

    const note = readNote(b.note);
    if ("error" in note) return reply.code(400).send(note);

    const row = await maAlertRepo.upsertAlert({
      symbol, timeframe, frequency, cooldownMin,
      ...toColumns(read.condition),
      enabled: b.enabled === undefined ? true : Boolean(b.enabled),
      note: note.value,
    });
    return reply.code(201).send({
      ...row,
      // The UI must show this beside an intrabar alert; serving it with the row
      // means it cannot be forgotten in one of the places alerts are listed.
      warning: isIntrabar(row.frequency) ? INTRABAR_WARNING : null,
    });
  });

  app.post("/api/ma-alerts/bulk", bulkAlertHandler());

  app.patch("/api/ma-alerts/:id", alertPatchHandler());

  app.delete("/api/ma-alerts/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = await maAlertRepo.deleteAlert(id);
    if (!ok) return reply.code(404).send(bad("alert not found"));
    return reply.code(204).send();
  });
}
