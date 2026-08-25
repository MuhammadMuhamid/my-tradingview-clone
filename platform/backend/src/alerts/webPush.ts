/**
 * Web Push delivery — the mobile notification path for MA alerts.
 *
 * The VAPID keypair is generated once and kept in app_settings (see
 * getOrCreateSetting). It can be overridden with VAPID_PUBLIC_KEY /
 * VAPID_PRIVATE_KEY when a deployment wants to pin its own keys; both must be
 * set together, since a mismatched pair fails every send.
 *
 * Push services answer 404/410 for an endpoint the browser has discarded
 * (permission revoked, app uninstalled, subscription rotated). Those are not
 * retryable, so the row is pruned instead — otherwise a stale device would
 * make every future fan-out look partially failed forever.
 */
import webpush from "web-push";
import { getOrCreateSetting } from "../repositories/appSettings";
import * as pushRepo from "../repositories/pushSubscriptions";

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export interface PushMessage {
  title: string;
  body: string;
  /** Collapses same-tag notifications on the device instead of stacking them. */
  tag?: string;
  /** Deep link opened when the notification is tapped. */
  url?: string;
}

let cached: VapidKeys | null = null;

export async function getVapidKeys(): Promise<VapidKeys> {
  if (cached) return cached;
  const envPublic = process.env.VAPID_PUBLIC_KEY?.trim();
  const envPrivate = process.env.VAPID_PRIVATE_KEY?.trim();
  if (envPublic && envPrivate) {
    cached = { publicKey: envPublic, privateKey: envPrivate };
  } else {
    cached = await getOrCreateSetting<VapidKeys>("vapid_keys", () =>
      webpush.generateVAPIDKeys()
    );
  }
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT ?? "mailto:alerts@localhost",
    cached.publicKey,
    cached.privateKey
  );
  return cached;
}

/**
 * 404/410 mean the push service has permanently discarded this endpoint
 * (permission revoked, app uninstalled, subscription rotated). Retrying is
 * pointless, so the row is pruned; every other status is a transient failure.
 */
export function isDiscardedSubscription(status: number | undefined): boolean {
  return status === 404 || status === 410;
}

/** Push services reject payloads over 4 KB after encryption padding. */
export const MAX_PUSH_PAYLOAD_BYTES = 4096;

export interface PushResult {
  sent: number;
  pruned: number;
  failed: number;
}

/** Fan a notification out to every registered device. */
export async function sendPush(
  message: PushMessage,
  log?: { warn: (o: unknown, m: string) => void }
): Promise<PushResult> {
  await getVapidKeys();
  const subs = await pushRepo.listSubscriptions();
  const payload = JSON.stringify(message);
  const result: PushResult = { sent: 0, pruned: 0, failed: 0 };

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          payload,
          { TTL: 3600 }
        );
        result.sent++;
        await pushRepo.markDelivered(sub.endpoint);
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (isDiscardedSubscription(status)) {
          await pushRepo.deleteByEndpoint(sub.endpoint);
          result.pruned++;
        } else {
          result.failed++;
          log?.warn(
            { endpoint: sub.endpoint.slice(0, 60), status, err: (err as Error).message },
            "web push delivery failed"
          );
        }
      }
    })
  );
  return result;
}
