import { query } from "../db/pool";

export async function getSetting<T>(key: string): Promise<T | null> {
  const { rows } = await query<{ value: T }>(
    "SELECT value FROM app_settings WHERE key = $1",
    [key]
  );
  return rows[0]?.value ?? null;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)]
  );
}

/**
 * Read-or-create, racing safely against a second process booting at the same
 * time: the loser of the INSERT re-reads the winner's value rather than
 * overwriting it, which for the VAPID keypair is the difference between
 * "works" and "every existing subscription is silently invalidated".
 */
export async function getOrCreateSetting<T>(
  key: string,
  create: () => T
): Promise<T> {
  const existing = await getSetting<T>(key);
  if (existing) return existing;
  const { rows } = await query<{ value: T }>(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET key = app_settings.key
     RETURNING value`,
    [key, JSON.stringify(create())]
  );
  return rows[0]!.value;
}
