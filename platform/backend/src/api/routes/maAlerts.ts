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
  FILTER_TIMEFRAMES, MAX_ALERT_FILTERS,
  CONDITION_KINDS, MA_ALERT_MODES, MA_LENGTHS, MA_TYPES, PRICE_DIRECTIONS,
  BULK_ALERT_ACTIONS, isBulkAlertAction, isConditionKind,
} from "../../types/maAlerts";
import type { ConditionKind, MaAlertRow } from "../../types/maAlerts";
import { bad, readCondition, toColumns } from "../../alerts/alertRequest";
import {
  COMMON_EDITABLE_FIELDS, EDITABLE_CONDITION_FIELDS, INTERNAL_ALERT_FIELDS,
  mergeConditionRequest, referenceChanged,
} from "../../alerts/alertEdit";
import {
  ALERT_FREQUENCIES, DEFAULT_ALERT_FREQUENCY, INTRABAR_WARNING,
  describeFrequency, explainFrequency, isAlertFrequency, isIntrabar,
} from "../../alerts/alertFrequency";
import { FILTER_KINDS, validateCondition } from "../../alerts/alertConditions";

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
/**
 * What a patch would DO to one row, without doing it.
 *
 * Extracted so the bulk editor can apply the single-alert rules to every
 * selected row rather than growing a second, looser copy of them. The bulk
 * path validates EVERY row through this before writing ANY row, which is what
 * lets it refuse a whole request instead of leaving a hundred alerts edited
 * and sixty-four not.
 *
 * Pure: it reads a row and a body and returns a patch or a refusal. Every rule
 * the single-alert route enforced still lives here, in one copy.
 */
export function planAlertPatch(
  row: MaAlertRow, b: Record<string, unknown>
): { patch: maAlertRepo.MaAlertPatch } | { error: string } {
  // An alert's family is fixed. Converting one would keep the id and the event
  // log while making every historical entry describe something the alert no
  // longer is, and the per-kind unique indexes would change meaning underneath
  // a live row.
  if (b.conditionKind !== undefined && String(b.conditionKind) !== row.conditionKind) {
    return { error:
      `an alert's type cannot be changed (this one is ${row.conditionKind}); ` +
      "delete it and create the alert you want instead" };
  }
  const internal = INTERNAL_ALERT_FIELDS.filter(
    (field) => field !== "conditionKind" && b[field] !== undefined
  );
  if (internal.length > 0) {
    return { error:
      `${internal.join(", ")} ${internal.length === 1 ? "is" : "are"} maintained by the ` +
      "alert runner and cannot be edited" };
  }

  const known = new Set<string>([
    ...COMMON_EDITABLE_FIELDS,
    ...EDITABLE_CONDITION_FIELDS[row.conditionKind],
    "conditionKind",
  ]);
  // A field that belongs to a DIFFERENT family is refused rather than dropped:
  // silently ignoring `rsiLevel` on a MACD alert is how a UI ends up showing a
  // saved value the server never stored.
  const foreign = Object.keys(b).filter((key) => !known.has(key));
  if (foreign.length > 0) {
    return { error:
      `${foreign.join(", ")} ${foreign.length === 1 ? "is" : "are"} not editable on a ` +
      `${row.conditionKind} alert` };
  }

  const patch: maAlertRepo.MaAlertPatch = {};

  if (b.symbol !== undefined) {
    // Same choke point every market-data call uses: the symbol is
    // interpolated into a Binance stream name.
    try {
      patch.symbol = assertSymbol(String(b.symbol));
    } catch {
      return { error: "symbol must be 2-24 uppercase letters or digits" };
    }
  }
  if (b.timeframe !== undefined) {
    const tf = String(b.timeframe);
    if (!isInterval(tf)) return { error: "invalid timeframe" };
    patch.timeframe = tf;
  }
  if (b.frequency !== undefined) {
    const f = String(b.frequency);
    if (!isAlertFrequency(f)) {
      return { error: `frequency must be one of ${ALERT_FREQUENCIES.join(", ")}` };
    }
    patch.frequency = f;
  }
  if (b.cooldownMin !== undefined) {
    const cooldownMin = Number(b.cooldownMin);
    if (!Number.isInteger(cooldownMin) || cooldownMin < 0) {
      return { error: "cooldownMin must be a non-negative integer" };
    }
    patch.cooldownMin = cooldownMin;
  }
  if (b.enabled !== undefined) patch.enabled = Boolean(b.enabled);
  if (b.note !== undefined) {
    const note = readNote(b.note);
    if ("error" in note) return { error: note.error };
    patch.note = note.value;
  }

  const merged = mergeConditionRequest(row, b);
  let columns: ReturnType<typeof toColumns> | null = null;
  if (merged) {
    const read = readCondition(row.conditionKind, merged);
    if ("error" in read) return { error: read.error };
    const invalid = validateCondition(read.condition);
    if (invalid) return { error: invalid };
    columns = toColumns(read.condition);
    // Everything the condition owns is written together, including the columns
    // the edit did not name — they came out of the row itself, so this
    // restates them rather than resetting them.
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

  return { patch };
}


/**
 * Group planned edits by the unique key their rows would have AFTER the patch.
 *
 * The key columns are read from `CONFLICT_TARGET` — the same list Postgres
 * infers its arbiter index from — and converted from the SQL spelling to the
 * row's. That conversion is uniform (`stoch_k_length` -> `stochKLength`), so
 * there is no per-column table to keep in step.
 */
function groupByConflictKey(
  planned: Array<{ id: string; patch: maAlertRepo.MaAlertPatch }>,
  rows: Map<string, MaAlertRow>
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const { id, patch } of planned) {
    const row = rows.get(id)!;
    const fields = conflictKeyFields(row.conditionKind);
    const merged = { ...row, ...patch } as Record<string, unknown>;
    const key = row.conditionKind + "|" + JSON.stringify(fields.map((f) => merged[f] ?? null));
    out.set(key, [...(out.get(key) ?? []), id]);
  }
  return out;
}

const camel = (column: string): string =>
  column.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());

function conflictKeyFields(kind: ConditionKind): string[] {
  const spec = maAlertRepo.CONFLICT_TARGET[kind];
  const inside = spec.slice(spec.indexOf("(") + 1, spec.lastIndexOf(")"));
  return inside.split(",").map((c: string) => camel(c.trim())).filter(Boolean);
}

export interface BulkEditDeps extends AlertPatchDeps {
  listAlertsByIds: (ids: string[]) => Promise<MaAlertRow[]>;
}

/**
 * Apply ONE set of changes to many alerts.
 *
 * "Edit every 15m support alert at once" — add a MACD gate to all of them,
 * change their cadence, put the same note on each.
 *
 * ── Validate everything, then write anything ──────────────────────────────
 *
 * Every selected row is planned through `planAlertPatch` BEFORE a single write
 * happens, and any refusal fails the whole request. The alternative — write
 * until something breaks — leaves the user with a set that is half edited and
 * no way to tell which half without reading 164 rows. When a bulk edit is
 * refused, nothing moved, and the response names the alerts that refused it.
 *
 * This is not a database transaction: the writes that follow are per row, and
 * one can still fail on a unique-index conflict that only exists once earlier
 * rows have moved. That case is reported as a partial with the ids that landed
 * — it cannot be prevented here, but it can be made legible. What validation
 * ordering buys is that the COMMON failures (a bad field, a foreign field, an
 * unsatisfiable condition) cost nothing.
 *
 * The family is never part of a bulk patch for the same reason it is never
 * part of a single one, and `planAlertPatch` refuses a field that does not
 * belong to a row's family — so a mixed selection simply cannot be given a
 * family-specific field. That is the rule that makes "select all shown" safe
 * when the filter spans types.
 */
export function bulkEditHandler(deps: BulkEditDeps = {
  getAlert: maAlertRepo.getAlert,
  updateAlert: maAlertRepo.updateAlert,
  listAlertsByIds: maAlertRepo.listAlertsByIds,
}) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;

    if (!Array.isArray(body.ids)) {
      return reply.code(400).send(bad("ids must be a non-empty array"));
    }
    if (body.ids.length === 0) return reply.code(400).send(bad("ids must not be empty"));
    if (body.ids.length > MAX_BULK_ALERTS) {
      return reply.code(400).send(bad(
        `at most ${MAX_BULK_ALERTS} alert IDs may be changed at once`
      ));
    }
    if (body.ids.some((id) => typeof id !== "string" || !UUID.test(id))) {
      return reply.code(400).send(bad("every id must be a UUID"));
    }
    if (typeof body.patch !== "object" || body.patch === null || Array.isArray(body.patch)) {
      return reply.code(400).send(bad("patch must be an object"));
    }
    const patchBody = body.patch as Record<string, unknown>;
    // An empty patch is refused rather than treated as a no-op: it means the
    // dialog sent nothing, and reporting "164 alerts updated" for a request
    // that changed nothing is a lie the user would act on.
    if (Object.keys(patchBody).length === 0) {
      return reply.code(400).send(bad("patch must name at least one field to change"));
    }

    const ids = [...new Set(body.ids as string[])];
    const rows = await deps.listAlertsByIds(ids);
    const found = new Map(rows.map((row) => [row.id, row]));
    const missingIds = ids.filter((id) => !found.has(id));
    if (missingIds.length > 0) {
      return reply.code(409).send({
        error: "one or more alerts no longer exist in the current admin scope",
        missingIds, updatedIds: [],
      });
    }

    // ── the dry run ──────────────────────────────────────────────────────
    const planned: Array<{ id: string; patch: maAlertRepo.MaAlertPatch }> = [];
    const rejected: Array<{ id: string; symbol: string; kind: string; reason: string }> = [];
    for (const id of ids) {
      const row = found.get(id)!;
      const plan = planAlertPatch(row, patchBody);
      if ("error" in plan) {
        rejected.push({
          id, symbol: row.symbol, kind: row.conditionKind, reason: plan.error,
        });
      } else {
        planned.push({ id, patch: plan.patch });
      }
    }
    /*
     * Two selected alerts that would become THE SAME alert.
     *
     * The commonest way to hit it: a selection holding two alerts that differ
     * only by their gates, given one new set of gates. They collapse onto one
     * unique key, and the second write raises a conflict — after the first has
     * already been made. Caught here instead, from the same key Postgres uses,
     * so the whole request is refused with nothing written.
     *
     * The key columns come from `CONFLICT_TARGET`, which a test pins to the
     * indexes themselves, so this cannot drift away from what the database
     * will actually enforce.
     */
    for (const [key, group] of groupByConflictKey(planned, found)) {
      if (group.length > 1) {
        const rows = group.map((id) => found.get(id)!);
        rejected.push({
          id: group[1]!, symbol: rows[1]!.symbol, kind: rows[1]!.conditionKind,
          reason: `this change would make ${group.length} of the selected alerts identical `
            + `(${rows.map((r) => r.symbol).join(", ")} on ${rows[0]!.timeframe}) — `
            + "they currently differ only in what you are about to overwrite",
        });
        void key;
      }
    }

    if (rejected.length > 0) {
      return reply.code(400).send({
        error: rejected.length === ids.length
          ? `these changes do not apply to any of the ${ids.length} selected alerts`
          : `these changes do not apply to ${rejected.length} of the ${ids.length} ` +
            "selected alerts, so nothing was changed",
        rejected: rejected.slice(0, 20),
        rejectedCount: rejected.length,
        updatedIds: [],
      });
    }

    // ── the writes ───────────────────────────────────────────────────────
    const updatedIds: string[] = [];
    for (const { id, patch } of planned) {
      try {
        const updated = await deps.updateAlert(id, patch);
        if (updated) updatedIds.push(id);
        else {
          return reply.code(409).send({
            error: "an alert was deleted while the edit was being applied",
            updatedIds, failedId: id,
          });
        }
      } catch (error) {
        if (error instanceof AlertConflictError) {
          // Reported rather than swallowed: the rows already written STAYED
          // written, and a caller that believed the whole set moved would be
          // wrong about the ones that did not.
          return reply.code(409).send({
            error: `${error.message} (${updatedIds.length} of ${ids.length} alerts were ` +
              "already updated and were left as they are)",
            updatedIds, failedId: id,
          });
        }
        throw error;
      }
    }
    return { updatedIds, updated: updatedIds.length };
  };
}

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

    const planned = planAlertPatch(row, b);
    if ("error" in planned) return reply.code(400).send(bad(planned.error));

    let updated: MaAlertRow | null;
    try {
      updated = await deps.updateAlert(id, planned.patch);
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
 * The most symbols one request may arm.
 *
 * A bound rather than a guess: each symbol becomes a live websocket
 * subscription and a per-bar evaluation, so an unbounded watchlist would let
 * one click commit the runner to work it cannot keep up with.
 */
const MAX_BULK_SYMBOLS = 200;

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
    /*
     * The gate vocabulary, so the dialogs never hardcode it. `filterTimeframes`
     * is what a gate may be measured on; a gate that names none is measured on
     * the alert's own.
     */
    filterKinds: FILTER_KINDS,
    filterTimeframes: FILTER_TIMEFRAMES,
    maxFilters: MAX_ALERT_FILTERS,
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
    /*
     * One alert, or the same alert across many symbols.
     *
     * `symbols` exists so "arm this on every coin in my watchlist" is ONE
     * request. The client could loop, but a fifty-coin watchlist over four
     * timeframes is two hundred round trips, each re-validating the same
     * condition — and a failure halfway leaves the user with no idea which
     * half was armed.
     *
     * Every symbol is validated before anything is written, so a malformed one
     * refuses the whole request rather than arming an arbitrary prefix of it.
     * An armed symbol is interpolated straight into the Binance websocket
     * stream name, where a `/` would inject extra streams, so this is the same
     * choke point every market-data call already uses.
     */
    const bulk = b.symbols !== undefined;
    if (bulk && !Array.isArray(b.symbols)) {
      return reply.code(400).send(bad("symbols must be an array"));
    }
    const requested = bulk
      ? (b.symbols as unknown[]).map((x) => String(x))
      : [String(b?.symbol ?? "")];
    if (requested.length === 0) {
      return reply.code(400).send(bad("symbols must name at least one symbol"));
    }
    if (requested.length > MAX_BULK_SYMBOLS) {
      return reply.code(400).send(
        bad(`at most ${MAX_BULK_SYMBOLS} symbols may be armed in one request`)
      );
    }

    let symbols: string[];
    try {
      // Deduplicated: the same symbol twice would upsert onto itself and
      // report two creations for one alert.
      symbols = [...new Set(requested.map((x) => assertSymbol(x)))];
    } catch {
      return reply.code(400).send(bad("symbol must be 2-24 uppercase letters or digits"));
    }
    const symbol = symbols[0]!;

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

    const columns = {
      timeframe, frequency, cooldownMin,
      ...toColumns(read.condition),
      enabled: b.enabled === undefined ? true : Boolean(b.enabled),
      note: note.value,
    };

    if (bulk) {
      /*
       * Written one at a time, and reported per symbol. Not a transaction:
       * arming forty of forty-two coins is a useful outcome, and rolling all
       * of it back because one symbol's row failed would be worse than saying
       * which two did not take.
       */
      const created: MaAlertRow[] = [];
      const failed: { symbol: string; error: string }[] = [];
      for (const s of symbols) {
        try {
          created.push(await maAlertRepo.upsertAlert({ ...columns, symbol: s }));
        } catch (error) {
          failed.push({ symbol: s, error: (error as Error).message });
        }
      }
      return reply.code(201).send({
        alerts: created,
        created: created.length,
        failed,
        warning: isIntrabar(frequency) ? INTRABAR_WARNING : null,
      });
    }

    const row = await maAlertRepo.upsertAlert({ ...columns, symbol });
    return reply.code(201).send({
      ...row,
      // The UI must show this beside an intrabar alert; serving it with the row
      // means it cannot be forgotten in one of the places alerts are listed.
      warning: isIntrabar(row.frequency) ? INTRABAR_WARNING : null,
    });
  });

  app.post("/api/ma-alerts/bulk", bulkAlertHandler());
  app.post("/api/ma-alerts/bulk-edit", bulkEditHandler());

  app.patch("/api/ma-alerts/:id", alertPatchHandler());

  app.delete("/api/ma-alerts/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = await maAlertRepo.deleteAlert(id);
    if (!ok) return reply.code(404).send(bad("alert not found"));
    return reply.code(204).send();
  });
}
