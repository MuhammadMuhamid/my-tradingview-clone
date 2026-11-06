/**
 * Two-factor sign-in: TOTP (RFC 6238), recovery codes, and the short-lived proof
 * that the first factor passed.
 *
 * Written on `node:crypto` because the algorithm is a dozen lines and every
 * authenticator app implements the same defaults: SHA-1, 30 seconds, 6 digits.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { safeEqual } from "./session";

const STEP_SECONDS = 30;
const DIGITS = 6;
/** One step either side, for a phone clock that has drifted. */
const WINDOW = 1;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generateTotpSecret(): string {
  let out = "";
  for (const byte of randomBytes(32)) out += BASE32[byte % 32];
  return out;
}

function decodeBase32(secret: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of secret) {
    const index = BASE32.indexOf(ch);
    if (index < 0) throw new Error("invalid TOTP secret");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", decodeBase32(secret)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

export const totpStepAt = (nowMs: number): number => Math.floor(nowMs / 1000 / STEP_SECONDS);

/**
 * The step a code matches, newer than the last one used, or null. The caller
 * records the step atomically, which is what makes a code single-use.
 */
export function matchTotpStep(secret: string, code: string, lastStep: number, nowMs = Date.now()): number | null {
  if (!/^[0-9]{6}$/.test(code)) return null;
  const current = totpStepAt(nowMs);
  let found: number | null = null;
  // Every candidate is compared, so timing doesn't reveal which one matched.
  for (let step = current - WINDOW; step <= current + WINDOW; step++) {
    if (safeEqual(totpCode(secret, step), code) && step > lastStep) found = step;
  }
  return found;
}

export function totpUrl(secret: string, label: string, issuer: string): string {
  const params = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?${params.toString()}`;
}

/** Ten codes of 50 random bits, enough that a fast hash is safe to store. */
export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    let raw = "";
    for (const byte of randomBytes(10)) raw += BASE32[byte % 32];
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(code.trim().toUpperCase().replace(/[^A-Z2-7]/g, "")).digest("hex");
}

// ── the first factor passed ─────────────────────────────────────────────────

export const PENDING_COOKIE = "srtrend_2fa";
const PENDING_TTL_MS = 5 * 60 * 1000;
const PENDING_PATH = "/api/auth/2fa";

export type SignInMethod = "password" | "google" | "github";

export interface PendingSignIn {
  userId: string;
  version: number;
  method: SignInMethod;
  exp: number;
}

export function sealPendingSignIn(
  input: { userId: string; version: number; method: SignInMethod }, secret: string, now = Date.now(),
): string {
  const body = Buffer.from(JSON.stringify({ ...input, exp: now + PENDING_TTL_MS }), "utf8").toString("base64url");
  const mac = createHmac("sha256", secret).update(`2fa.${body}`).digest("base64url");
  return `${body}.${mac}`;
}

export function openPendingSignIn(sealed: string | null, secret: string, now = Date.now()): PendingSignIn | null {
  if (!sealed) return null;
  const [body, mac] = sealed.split(".");
  if (!body || !mac) return null;
  if (!safeEqual(mac, createHmac("sha256", secret).update(`2fa.${body}`).digest("base64url"))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as PendingSignIn;
    return parsed.exp > now && typeof parsed.userId === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export function pendingCookie(value: string, secure: boolean): string {
  const attrs = [`${PENDING_COOKIE}=${value}`, `Path=${PENDING_PATH}`, "HttpOnly", "SameSite=Lax",
    `Max-Age=${Math.floor(PENDING_TTL_MS / 1000)}`];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function clearPendingCookie(secure: boolean): string {
  const attrs = [`${PENDING_COOKIE}=`, `Path=${PENDING_PATH}`, "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}
