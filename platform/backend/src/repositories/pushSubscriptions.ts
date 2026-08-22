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
export async function saveSubscription(input: {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string | null;
}): Promise<PushSubscriptionRow> {
  const { rows } = await query<DbRow>(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_agent)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (endpoint) DO UPDATE
       SET p256dh = EXCLUDED.p256dh,
           auth = EXCLUDED.auth,
           user_agent = EXCLUDED.user_agent
     RETURNING *`,
    [input.endpoint, input.p256dh, input.auth, input.userAgent ?? null]
  );
  return toRow(rows[0]!);
}

export async function listSubscriptions(): Promise<PushSubscriptionRow[]> {
  const { rows } = await query<DbRow>(
    "SELECT * FROM push_subscriptions ORDER BY created_at"
  );
  return rows.map(toRow);
}

export async function countSubscriptions(): Promise<number> {
  const { rows } = await query<{ n: number }>(
    "SELECT count(*)::int AS n FROM push_subscriptions"
  );
  return rows[0]?.n ?? 0;
}

export async function deleteByEndpoint(endpoint: string): Promise<void> {
  await query("DELETE FROM push_subscriptions WHERE endpoint = $1", [endpoint]);
}

export async function markDelivered(endpoint: string): Promise<void> {
  await query(
    "UPDATE push_subscriptions SET last_ok_at = now() WHERE endpoint = $1",
    [endpoint]
  );
}
