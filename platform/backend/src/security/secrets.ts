import crypto from "node:crypto";
import { config } from "../config";

const key = crypto.createHash("sha256").update(config.alertEncryptionKey).digest();

export function encryptSecret(value: string): string {
  if (!value) return value;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `enc:${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64")}`;
}

export function decryptSecret(value: string | null): string | null {
  if (!value || !value.startsWith("enc:")) return value;
  const raw = Buffer.from(value.slice(4), "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}

export function redactPayload<T extends Record<string, unknown>>(payload: T): T {
  const redact = (value: unknown, key?: string): unknown => {
    if (key === "secret" || key === "bot_uuid") return "[REDACTED]";
    if (Array.isArray(value)) return value.map((item) => redact(item));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
    }
    return value;
  };
  return redact(payload) as T;
}

/**
 * Scrub a receiver response body before it is stored or served.
 *
 * The outbound payload is redacted on the way in (`redactPayload`), but the
 * response half was stored verbatim and served back through
 * `GET /api/deployments/:id/alerts`. A receiver that echoes the request — or
 * names a bot uuid, or includes an exchange error carrying account detail — put
 * that straight into the alert feed.
 *
 * This is a defensive scrub over free text, not a parser: it redacts anything
 * shaped like a secret, then truncates. Bodies are diagnostic, so losing a few
 * characters of an unusual one is the right trade.
 */
export const MAX_RESPONSE_BODY_CHARS = 1000;

const SECRET_SHAPES: RegExp[] = [
  // JSON field named secret/token/key/password, quoted or not.
  /("?(?:secret|webhook_secret|api_?secret|api_?key|token|password|passphrase|bot_uuid)"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}&]+)/gi,
  // A bare 32+ character hex or base64url run: the shape of every credential here.
  /\b[0-9a-fA-F]{32,}\b/g,
  /\b[A-Za-z0-9_-]{40,}\b/g,
];

export function redactResponseBody(body: string | null | undefined): string | null {
  if (body == null) return null;
  let out = body;
  out = out.replace(SECRET_SHAPES[0]!, (_m, prefix: string) => `${prefix}"[REDACTED]"`);
  out = out.replace(SECRET_SHAPES[1]!, "[REDACTED]");
  out = out.replace(SECRET_SHAPES[2]!, "[REDACTED]");
  return out.slice(0, MAX_RESPONSE_BODY_CHARS);
}
