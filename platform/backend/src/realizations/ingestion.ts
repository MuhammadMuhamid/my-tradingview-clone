import { createHash } from "node:crypto";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import {
  canonicalJson, platformWebhookIdentity, type RealizationBatchV1, type RealizationEventV1,
} from "../contract/realizationEventContract";
import { decryptSecret } from "../security/secrets";

export class RealizationIntegrityConflict extends Error {}
export class RealizationCorrelationError extends Error {}

export interface RealizationDbClient {
  query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
}

interface CorrelationSource {
  id: string | number;
  deployment_id: string;
  dedupe_key: string;
  action: string;
  symbol: string;
  delivery: string;
  alert_id: string | number | null;
  encrypted_secret: string | null;
}

async function resolveCorrelation(
  client: RealizationDbClient, event: RealizationEventV1
): Promise<CorrelationSource> {
  const direct = event.platformDeploymentId !== null && event.platformOrderIntentId !== null;
  const candidates = direct
    ? await client.query<CorrelationSource>(
      `SELECT oi.id, oi.deployment_id, oi.dedupe_key, oi.action, oi.alert_id,
              d.symbol, d.delivery, d.secret AS encrypted_secret
         FROM order_intents oi
         JOIN deployments d ON d.id = oi.deployment_id
        WHERE oi.id = $1 AND oi.deployment_id = $2
        FOR SHARE`,
      [event.platformOrderIntentId, event.platformDeploymentId]
    )
    : await client.query<CorrelationSource>(
      `SELECT oi.id, oi.deployment_id, oi.dedupe_key, oi.action, oi.alert_id,
              d.symbol, d.delivery, d.secret AS encrypted_secret
         FROM order_intents oi
         JOIN deployments d ON d.id = oi.deployment_id
        WHERE oi.dedupe_key = $1 AND oi.action = 'sell' AND d.delivery = 'custom'
        FOR SHARE`,
      [event.platformDedupeKey]
    );
  const credentialMatches = candidates.rows.filter((source) => {
    try {
      const secret = decryptSecret(source.encrypted_secret);
      return secret !== null && platformWebhookIdentity(secret) === event.platformWebhookIdentity;
    } catch { return false; }
  });
  if (credentialMatches.length !== 1) {
    throw new RealizationCorrelationError(`unresolved realization provenance: ${event.eventId}`);
  }
  const source = credentialMatches[0]!;
  if ((direct && (String(source.id) !== event.platformOrderIntentId
        || source.deployment_id !== event.platformDeploymentId))
      || source.dedupe_key !== event.platformDedupeKey || source.action !== "sell"
      || source.delivery !== "custom" || source.symbol.toUpperCase() !== event.symbol) {
    throw new RealizationCorrelationError(`unresolved realization provenance: ${event.eventId}`);
  }
  return source;
}

export async function ingestRealizationBatch(
  client: RealizationDbClient,
  batch: RealizationBatchV1
): Promise<string[]> {
  const accepted: string[] = [];
  for (const event of batch.events) {
    const payloadSha256 = createHash("sha256").update(canonicalJson(event)).digest("hex");
    const existing = await client.query<{ source_payload_sha256: string }>(
      "SELECT source_payload_sha256 FROM realised_pnl WHERE source_system = 'BOT_CUSTOM_V1' AND source_event_id = $1",
      [event.eventId]
    );
    if (existing.rows[0]) {
      if (existing.rows[0].source_payload_sha256 !== payloadSha256) {
        throw new RealizationIntegrityConflict(`conflicting immutable realization event: ${event.eventId}`);
      }
      accepted.push(event.eventId);
      continue;
    }

    const source = await resolveCorrelation(client, event);

    const inserted = await client.query(
        `INSERT INTO realised_pnl
           (deployment_id, alert_id, closed_at, pnl_quote, exit_price, quantity, reason,
            source_system, source_event_id, realization_kind,
            source_strategy_order_intent_id, source_exchange_order_id,
            source_platform_order_intent_id, accounting_basis, fee_model,
            quote_currency, exit_revenue_quote, source_payload_sha256, received_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'BOT_CUSTOM_V1',$8,$9,$10,$11,$12,
                 'modeled_fee_adjusted','fixed_0.1pct_each_side_not_exchange_observed',
                 'USDT',$13,$14,now())
         ON CONFLICT (source_system, source_event_id) WHERE source_event_id IS NOT NULL
         DO NOTHING
         RETURNING id`,
        [source.deployment_id, source.alert_id, event.realizedAt,
          event.realizedPnlQuote, event.exitPrice, event.realizedQuantity,
          event.exitLeg ?? event.kind, event.eventId, event.kind,
          event.strategyOrderIntentId, event.exchangeOrderId,
          String(source.id), event.exitRevenueQuote, payloadSha256]
      );
    if (inserted.rowCount === 0) {
      // A concurrent exact retry may win after our initial read. Compare the
      // immutable hash; never overwrite economics.
      const raced = await client.query<{ source_payload_sha256: string }>(
        "SELECT source_payload_sha256 FROM realised_pnl WHERE source_system = 'BOT_CUSTOM_V1' AND source_event_id = $1",
        [event.eventId]
      );
      if (raced.rows[0]?.source_payload_sha256 !== payloadSha256) {
        throw new RealizationIntegrityConflict(`conflicting immutable realization event: ${event.eventId}`);
      }
    }
    accepted.push(event.eventId);
  }
  return accepted;
}

export async function reserveRealizationNonce(
  client: RealizationDbClient, nonce: string, expiresAt: Date
): Promise<boolean> {
  await client.query("DELETE FROM realization_ingest_nonces WHERE expires_at < now()");
  const result = await client.query(
    "INSERT INTO realization_ingest_nonces (nonce, expires_at) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING nonce",
    [nonce, expiresAt]
  );
  return result.rowCount === 1;
}

export type PlatformPoolClient = PoolClient;
