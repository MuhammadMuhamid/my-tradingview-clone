import { query } from "../db/pool";

/** A browser Web Push endpoint, exactly as PushSubscription.toJSON() serializes it. */
export interface PushSubscriptionRow {
  id: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent: string | null;
}

interface DbRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
}

const toRow = (r: DbRow): PushSubscriptionRow => ({
  id: r.id,
  endpoint: r.endpoint,
  keys: { p256dh: r.p256dh, auth: r.auth },
  userAgent: r.user_agent,
});

/**
 * Idempotent by endpoint — a browser re-registering its service worker hands
 * back the same endpoint, and must not accumulate duplicate rows that would
 * deliver the same notification several times.
 */
export async function saveSubscription(userId: string, input: {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string | null;
}): Promise<PushSubscriptionRow> {
  const { rows } = await query<DbRow>(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_agent, last_seen_at, user_id)
     VALUES ($1,$2,$3,$4, now(), $5)
     ON CONFLICT (user_id, endpoint) DO UPDATE
       SET p256dh = EXCLUDED.p256dh,
           auth = EXCLUDED.auth,
           user_agent = EXCLUDED.user_agent,
           -- Re-registering IS the liveness signal: only a browser that still
           -- holds this subscription can send it back.
           last_seen_at = now()
     RETURNING *`,
    [input.endpoint, input.p256dh, input.auth, input.userAgent ?? null, userId]
  );
  return toRow(rows[0]!);
}

/** One user's devices: an alert notifies its owner and nobody else. */
export async function listSubscriptions(userId: string): Promise<PushSubscriptionRow[]> {
  const { rows } = await query<DbRow>(
    "SELECT * FROM push_subscriptions WHERE user_id = $1 ORDER BY created_at", [userId]
  );
  return rows.map(toRow);
}

export async function countSubscriptions(userId: string): Promise<number> {
  const { rows } = await query<{ n: number }>(
    "SELECT count(*)::int AS n FROM push_subscriptions WHERE user_id = $1", [userId]
  );
  return rows[0]?.n ?? 0;
}

/** A user withdrawing one of their devices. */
export async function deleteUserEndpoint(userId: string, endpoint: string): Promise<void> {
  await query("DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2", [userId, endpoint]);
}

/**
 * The push service says this endpoint is gone. It is gone for every account
 * that registered it, because it is the BROWSER's subscription that died.
 */
export async function deleteByEndpoint(endpoint: string): Promise<void> {
  await query("DELETE FROM push_subscriptions WHERE endpoint = $1", [endpoint]);
}

/**
 * Forget devices that have not re-registered in `days`.
 *
 * `last_ok_at` is deliberately NOT the signal. It records that the push
 * SERVICE accepted a message, and Apple keeps accepting endpoints for apps
 * that were uninstalled long ago, so a table full of ghosts reports perfect
 * health: four dead subscriptions once showed a `last_ok_at` of minutes ago
 * while the phone received nothing, and every alert claimed four deliveries.
 *
 * Re-registration is the one thing a ghost cannot fake, so that is what ages
 * out here. The window is generous because the cost of being wrong is
 * asymmetric: pruning a live device silently stops its alerts until someone
 * notices, while keeping a dead one only inflates a counter.
 */
export async function pruneUnseen(days: number): Promise<number> {
  const { rowCount } = await query(
    `DELETE FROM push_subscriptions
      WHERE last_seen_at IS NOT NULL
        AND last_seen_at < now() - make_interval(days => $1)`,
    [days]
  );
  return rowCount ?? 0;
}

export async function markDelivered(endpoint: string): Promise<void> {
  await query(
    "UPDATE push_subscriptions SET last_ok_at = now() WHERE endpoint = $1",
    [endpoint]
  );
}
