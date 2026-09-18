/**
 * Waiting for the database to accept connections, at boot only.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * `cloud-deploy.sh` takes an RDS snapshot and then rolls the containers. The
 * backend can therefore start against a database that is briefly unresponsive,
 * and the runtime pool's `connectionTimeoutMillis` is deliberately 5 s so that
 * optimizer workers fail fast rather than blocking on a dead connection. Five
 * seconds is the right answer at runtime and the wrong one at boot: the
 * migration step got
 *
 *     Error: Connection terminated due to connection timeout
 *         at async migrate (/app/dist/db/migrate.js)
 *
 * crashed the process, and relied on Docker's restart policy to try again.
 * That turned a database that was slow for a minute into a deploy that was
 * down for twenty, because each restart re-ran the same 5 s gamble.
 *
 * Waiting is strictly better than crashing HERE, and only here: boot is the
 * one moment where there is nothing to serve yet, so a slow start costs
 * nothing a restart loop was not already costing.
 *
 * ── What it must NOT do ───────────────────────────────────────────────────
 *
 * Retry a real SQL error. A migration that fails because its SQL is wrong will
 * fail identically every time, and retrying it for two minutes would turn an
 * instant, legible failure into a slow, confusing one — and delay the crash
 * that tells an operator the deploy is bad. So the retry is gated on the error
 * being CONNECTION-shaped, and anything carrying a SQLSTATE is rethrown at
 * once.
 */
import { pool } from "./pool";

/**
 * Is this failure "the database is not reachable yet", or "the database
 * answered, and said no"?
 *
 * Postgres errors carry a five-character SQLSTATE in `code` — `23505` for a
 * unique violation, `42P10` for a bad ON CONFLICT. If one is present the
 * server received the statement and rejected it, so waiting cannot help.
 *
 * Node's socket errors populate `code` too, with names like `ECONNREFUSED`.
 * "Five characters" alone does NOT separate them: `EPIPE` is five characters
 * and all uppercase, and a first draft of this classified it as a SQLSTATE —
 * meaning a broken pipe, the most connection-shaped failure there is, would
 * have been rethrown instead of retried. A test caught it.
 *
 * Two signals are used instead:
 *
 *  - `severity` ("ERROR", "FATAL"…) is set by the driver only on a response
 *    PARSED FROM THE SERVER, so its presence is direct evidence the database
 *    answered.
 *  - failing that, a five-character code that does not begin with `E`. No
 *    SQLSTATE class starts with E (they run 00–0Z, 20–2F, 34–3F, 40–42, 44,
 *    53–58, 72, F0, HV, P0, XX), while every Node socket error code does.
 *
 * Message text is deliberately not matched on: it changes between driver
 * versions, and this decides whether an outage is twenty seconds or twenty
 * minutes.
 */
export function isConnectionError(error: unknown): boolean {
  const e = error as { code?: unknown; severity?: unknown } | null;
  if (typeof e?.severity === "string" && e.severity.length > 0) return false;
  const code = e?.code;
  if (typeof code === "string" && /^[0-9A-DF-Z][0-9A-Z]{4}$/.test(code)) return false;
  return true;
}

export interface WaitOptions {
  /** How many times to try before giving up. */
  attempts?: number;
  /** Delay before the second attempt; doubles each time, capped. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Injected for tests. */
  ping?: () => Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (info: { attempt: number; attempts: number; delayMs: number; error: Error }) => void;
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Block until the database answers a trivial query, or the budget runs out.
 *
 * Defaults to fifteen attempts, 500 ms doubling to a 10 s cap — about 105 s in
 * total, which covers the snapshot window that caused this without hiding a
 * database that is genuinely gone. (Ten attempts was the first guess and came
 * to 55 s; a test that asserted the TOTAL rather than the attempt count is
 * what showed the budget did not match the stated intent.)
 *
 * Exhausting it rethrows the LAST error, so the crash still says what actually
 * went wrong rather than "gave up".
 */
export async function waitForDatabase(options: WaitOptions = {}): Promise<void> {
  const {
    attempts = 15, baseDelayMs = 500, maxDelayMs = 10_000,
    ping = () => pool.query("SELECT 1"),
    sleep = wait,
    onRetry,
  } = options;

  let delay = baseDelayMs;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await ping();
      return;
    } catch (error) {
      // A database that REPLIED is not a database worth waiting for.
      if (!isConnectionError(error)) throw error;
      if (attempt === attempts) throw error;
      onRetry?.({ attempt, attempts, delayMs: delay, error: error as Error });
      await sleep(delay);
      delay = Math.min(delay * 2, maxDelayMs);
    }
  }
}
