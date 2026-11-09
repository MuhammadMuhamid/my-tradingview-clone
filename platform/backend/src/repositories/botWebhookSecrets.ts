/**
 * The Bot's webhook secrets, held only by this Platform (migration 058).
 *
 * A secret arrives once, in the Bot's live answer to a create (C10) or a
 * rotation (C14), and is written here encrypted before the browser is
 * answered. It leaves only server-side, into `deployments.secret`, when a
 * deployment is linked to the bot. Nothing here returns it to a route.
 *
 * Rotation keeps linked deployments working: storing a new secret for a bot
 * also re-copies it into every deployment linked to that bot, in the same
 * transaction, so the Platform never signs a signal with a secret the Bot no
 * longer accepts.
 */
import { pool, query } from "../db/pool";
import { decryptSecret, encryptSecret } from "../security/secrets";

export interface StoredSecretStatus {
  stored: boolean;
  updatedAt: string | null;
}

export interface LinkedDeployment {
  id: string;
  symbol: string;
  timeframe: string;
  status: string;
  delivery: string;
}

/**
 * Store (or replace) a bot's secret and re-copy it into the deployments
 * linked to that bot. Returns how many linked deployments now carry it.
 */
export async function storeBotWebhookSecret(botId: string, secret: string): Promise<{ linkedDeploymentsUpdated: number }> {
  const enc = encryptSecret(secret);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO bot_webhook_secrets (bot_id, secret_enc, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (bot_id) DO UPDATE SET secret_enc = EXCLUDED.secret_enc, updated_at = now()`,
      [botId, enc]);
    const linked = await client.query(
      "UPDATE deployments SET secret = $2, updated_at = now() WHERE bot_id = $1", [botId, encryptSecret(secret)]);
    await client.query("COMMIT");
    return { linkedDeploymentsUpdated: linked.rowCount ?? 0 };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function botWebhookSecretStatus(botId: string): Promise<StoredSecretStatus> {
  const { rows } = await query<{ updated_at: Date }>(
    "SELECT updated_at FROM bot_webhook_secrets WHERE bot_id = $1", [botId]);
  return rows[0] ? { stored: true, updatedAt: rows[0].updated_at.toISOString() } : { stored: false, updatedAt: null };
}

/** A deleted bot's secret is of no further use; deployments keep their own copy (and their `bot_id`). */
export async function forgetBotWebhookSecret(botId: string): Promise<void> {
  await query("DELETE FROM bot_webhook_secrets WHERE bot_id = $1", [botId]);
}

export async function deploymentsLinkedTo(botId: string): Promise<LinkedDeployment[]> {
  const { rows } = await query<LinkedDeployment>(
    `SELECT id, symbol, timeframe, status, delivery FROM deployments WHERE bot_id = $1 ORDER BY created_at`, [botId]);
  return rows;
}

export type LinkOutcome =
  | { outcome: "linked"; deploymentId: string; botId: string; replaced: boolean }
  | { outcome: "deployment_not_found" }
  | { outcome: "delivery_not_custom"; delivery: string }
  | { outcome: "bot_secret_unknown" };

/**
 * Copy a bot's stored secret into a deployment, server-side, and remember the
 * link. Only a `custom` deployment (a webhook to the Bot) can be linked: a
 * 3Commas deployment's secret is 3Commas's, and `off`/`paper` send nothing.
 */
export async function linkDeploymentToBot(deploymentId: string, botId: string): Promise<LinkOutcome> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const deployment = await client.query<{ delivery: string; secret: string | null; bot_id: string | null }>(
      "SELECT delivery, secret, bot_id FROM deployments WHERE id = $1 FOR UPDATE", [deploymentId]);
    const row = deployment.rows[0];
    if (!row) { await client.query("ROLLBACK"); return { outcome: "deployment_not_found" }; }
    if (row.delivery !== "custom") { await client.query("ROLLBACK"); return { outcome: "delivery_not_custom", delivery: row.delivery }; }
    const stored = await client.query<{ secret_enc: string }>(
      "SELECT secret_enc FROM bot_webhook_secrets WHERE bot_id = $1", [botId]);
    const enc = stored.rows[0]?.secret_enc;
    const secret = enc ? decryptSecret(enc) : null;
    if (!secret) { await client.query("ROLLBACK"); return { outcome: "bot_secret_unknown" }; }
    await client.query(
      "UPDATE deployments SET secret = $2, bot_id = $3, updated_at = now() WHERE id = $1",
      [deploymentId, encryptSecret(secret), botId]);
    await client.query("COMMIT");
    return { outcome: "linked", deploymentId, botId, replaced: row.secret !== null };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
