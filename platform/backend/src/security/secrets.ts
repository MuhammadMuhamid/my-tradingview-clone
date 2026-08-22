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
