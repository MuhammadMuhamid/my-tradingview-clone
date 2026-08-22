/**
 * Cookie session authentication.
 *
 * Replaces HTTP Basic Auth, which was the cause of the constant sign-outs:
 * browsers hold basic-auth credentials only for the lifetime of the browsing
 * session, drop them whenever the tab or app is closed, and on iOS re-prompt
 * unpredictably — and a PWA installed to the Home Screen, plus the service
 * worker that Web Push depends on, make that behaviour worse still.
 *
 * A signed, long-lived HttpOnly cookie survives restarts, works from the
 * installed app, and is sent with service-worker requests.
 *
 * No new dependency: HMAC and scrypt both come from node:crypto.
 */
import {
  createHmac, randomBytes, scryptSync, timingSafeEqual,
} from "node:crypto";
import bcrypt from "bcryptjs";

/** 90 days. Long enough that the user is never asked again in practice. */
export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const SESSION_COOKIE = "srtrend_session";

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 32 };

/** `scrypt$<saltHex>$<keyHex>` — the format stored in ADMIN_PASSWORD_HASH. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, SCRYPT_PARAMS.keylen, SCRYPT_PARAMS);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

/**
 * Accepts both hash formats.
 *
 * `$2a$`/`$2b$`/`$2y$` is bcrypt, the format Caddy's basic_auth used. Existing
 * deployments already have one of those in ADMIN_PASSWORD_HASH, and rejecting
 * it would lock the user out of their own app on the first deploy — so the old
 * password keeps working, and `hashPassword` emits scrypt for anything new.
 */
export function verifyPassword(password: string, stored: string): boolean {
  if (/^\$2[aby]?\$/.test(stored)) {
    try {
      return bcrypt.compareSync(password, stored);
    } catch {
      return false;
    }
  }
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  let salt: Buffer, expected: Buffer;
  try {
    salt = Buffer.from(parts[1]!, "hex");
    expected = Buffer.from(parts[2]!, "hex");
  } catch {
    return false;
  }
  if (expected.length !== SCRYPT_PARAMS.keylen) return false;
  const actual = scryptSync(password, salt, SCRYPT_PARAMS.keylen, SCRYPT_PARAMS);
  return timingSafeEqual(actual, expected);
}

/** Constant-time string compare that tolerates differing lengths. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    // Still do the work, so length is not leaked through timing.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** Token format: `<username>.<expiryMs>.<hmac>`, all base64url. */
export function signSession(username: string, secret: string, now = Date.now()): string {
  const expiry = now + SESSION_TTL_MS;
  const body = `${Buffer.from(username, "utf8").toString("base64url")}.${expiry}`;
  const mac = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export interface SessionClaims {
  username: string;
  expiresAt: number;
}

export function verifySession(
  token: string, secret: string, now = Date.now()
): SessionClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [userPart, expiryPart, mac] = parts as [string, string, string];
  const expected = createHmac("sha256", secret)
    .update(`${userPart}.${expiryPart}`)
    .digest("base64url");
  if (!safeEqual(mac, expected)) return null;
  const expiresAt = Number(expiryPart);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;
  return {
    username: Buffer.from(userPart, "base64url").toString("utf8"),
    expiresAt,
  };
}

/** Minimal Cookie-header parser — avoids pulling in a cookie plugin. */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/**
 * `Secure` is omitted when the deployment is plain HTTP (local development),
 * because a Secure cookie is silently dropped there and the user would appear
 * to be signed out immediately — the exact bug this replaces.
 */
export function sessionCookie(token: string, secure: boolean): string {
  const attrs = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function clearCookie(secure: boolean): string {
  const attrs = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

if (require.main === module) {
  // `npm run hash-password -- 'my password'` → paste into ADMIN_PASSWORD_HASH.
  const pw = process.argv[2];
  if (!pw) {
    console.error("usage: tsx src/security/session.ts '<password>'");
    process.exit(1);
  }
  console.log(hashPassword(pw));
}
