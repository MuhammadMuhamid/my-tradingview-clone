/**
 * Keeps cohorts moving without anyone pressing a button.
 *
 * Every tick, in this order:
 *   1. advance every cohort whose status may change: open to running at its
 *      start (or cancelled if no money was recorded), running to settling or
 *      settled at its end, and settling to settled once its last trade closes;
 *   2. keep each ACTIVE package two cohorts ahead, so members can always see
 *      the next term and its deposit deadline. A paused or closed package gets
 *      no new cohorts, but its existing ones still run to the end.
 *
 * It only calls the repository functions the administrator's buttons call, so
 * every rule (deadlines, fixed shares, carry) is the same either way. It moves
 * no money and places no orders.
 *
 * One scheduler at a time across Platform instances: a session advisory lock,
 * held for the tick. A failure on one cohort is logged and the rest go on.
 */
import { pool } from "../db/pool";
import * as packages from "../repositories/packages";

export const UPCOMING_COHORTS = 2;
const LOCK_KEY = "package_scheduler";

interface Log {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface TickResult { advanced: { cohortId: string; status: string }[]; scheduled: number; skipped?: "locked" }

export async function runPackageSchedulerOnce(log: Log, now = new Date()): Promise<TickResult> {
  const client = await pool.connect();
  try {
    const lock = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS ok", [LOCK_KEY]);
    if (!lock.rows[0]?.ok) return { advanced: [], scheduled: 0, skipped: "locked" };
    try {
      const advanced: TickResult["advanced"] = [];
      for (const cohortId of await packages.cohortsDueForAdvance(now)) {
        try {
          const status = await packages.advanceCohort(cohortId, now);
          advanced.push({ cohortId, status });
        } catch (error) {
          log.warn({ cohortId, err: (error as Error).message }, "package scheduler could not advance a cohort");
        }
      }
      let scheduled = 0;
      for (const { packageId, missing } of await packages.packagesShortOfCohorts(now, UPCOMING_COHORTS)) {
        for (let i = 0; i < missing; i++) {
          try {
            await packages.scheduleNextCohort(packageId, now);
            scheduled++;
          } catch (error) {
            log.warn({ packageId, err: (error as Error).message }, "package scheduler could not schedule a cohort");
            break;
          }
        }
      }
      const changed = advanced.filter((a) => a.status !== "settling");
      if (changed.length || scheduled) log.info({ advanced: changed, scheduled }, "package scheduler tick");
      return { advanced, scheduled };
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK_KEY]).catch(() => undefined);
    }
  } finally {
    client.release();
  }
}

/** The background loop: once a minute, never overlapping itself. */
export function startPackageScheduler(log: Log, intervalMs = 60_000): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await runPackageSchedulerOnce(log); }
    catch (error) { log.warn({ err: (error as Error).message }, "package scheduler tick failed"); }
    finally { running = false; }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
