import { timingSafeEqual } from "node:crypto";
import { signManualCommand } from "../manualTrading/client";

export const REALIZATION_AUTH_FRESHNESS_MS = 60_000;

export type RealizationAuthResult =
  | { ok: true; nonce: string; requestId: string; expiresAt: Date }
  | { ok: false; error: string };

export function verifyRealizationRequest(input: {
  secret: string;
  method: string;
  path: string;
  body: unknown;
  timestamp?: string;
  nonce?: string;
  requestId?: string;
  signature?: string;
  now?: number;
}): RealizationAuthResult {
  const { timestamp, nonce, requestId, signature } = input;
  if (!timestamp || !nonce || !requestId || !signature
      || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce)
      || !/^[A-Za-z0-9_-]{16,128}$/.test(requestId)) {
    return { ok: false, error: "realization authentication required" };
  }
  const now = input.now ?? Date.now();
  const millis = Number(timestamp);
  if (!Number.isFinite(millis) || Math.abs(now - millis) > REALIZATION_AUTH_FRESHNESS_MS) {
    return { ok: false, error: "realization timestamp is outside the freshness window" };
  }
  const expected = signManualCommand({ method: input.method, path: input.path,
    timestamp, nonce, requestId, body: input.body }, input.secret);
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    return { ok: false, error: "invalid realization signature" };
  }
  return { ok: true, nonce, requestId,
    expiresAt: new Date(now + REALIZATION_AUTH_FRESHNESS_MS) };
}
