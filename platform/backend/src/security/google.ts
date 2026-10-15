/**
 * Sign in with Google — OpenID Connect, authorization-code flow with PKCE.
 *
 * ── The round trip ─────────────────────────────────────────────────────────
 *
 *   /api/auth/google/start     makes a random `state` and PKCE verifier,
 *                              keeps them in a short-lived signed cookie, and
 *                              sends the browser to Google.
 *   /api/auth/google/callback  checks `state` against that cookie, trades the
 *                              code (with the verifier and the client secret)
 *                              for tokens at Google's token endpoint, and
 *                              reads the ID token.
 *
 * The ID token comes straight back from Google's token endpoint over TLS, in
 * response to a request this server authenticated with its client secret.
 * OpenID Connect Core §3.1.3.7 allows TLS server validation in place of
 * checking the token's signature in exactly that case; issuer, audience,
 * expiry and `email_verified` are still checked, because they are claims
 * about WHO, not about transport.
 *
 * Nothing here holds a Google access token past the callback: the platform
 * needs to know who signed in, not to act on their Google account.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { safeEqual } from "./session";

export const OAUTH_COOKIE = "srtrend_oauth";
const OAUTH_TTL_MS = 10 * 60 * 1000;
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);

export interface OAuthState {
  state: string;
  verifier: string;
  /** Where to land afterwards — a path on this site, never a URL. */
  next: string;
  /** Set when a signed-in user is LINKING Google, rather than signing in. */
  linkUserId: string | null;
  exp: number;
}

const b64url = (buf: Buffer): string => buf.toString("base64url");

/** Only a path on this site: "/chart", never "//evil.example" or "https://…". */
export function safeNext(raw: unknown, fallback = "/chart"): string {
  if (typeof raw !== "string") return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return fallback;
  if (raw.startsWith("/api/") || raw.length > 512) return fallback;
  return raw;
}

export function newOAuthState(next: string, linkUserId: string | null, now = Date.now()): OAuthState {
  return {
    state: b64url(randomBytes(24)),
    verifier: b64url(randomBytes(48)),
    next: safeNext(next),
    linkUserId,
    exp: now + OAUTH_TTL_MS,
  };
}

export function sealState(s: OAuthState, secret: string): string {
  const body = b64url(Buffer.from(JSON.stringify(s), "utf8"));
  const mac = createHmac("sha256", secret).update(`oauth.${body}`).digest("base64url");
  return `${body}.${mac}`;
}

export function openState(sealed: string | null, secret: string, now = Date.now()): OAuthState | null {
  if (!sealed) return null;
  const [body, mac] = sealed.split(".");
  if (!body || !mac) return null;
  const expected = createHmac("sha256", secret).update(`oauth.${body}`).digest("base64url");
  if (!safeEqual(mac, expected)) return null;
  try {
    const s = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as OAuthState;
    if (typeof s.state !== "string" || typeof s.verifier !== "string" || !(s.exp > now)) return null;
    return { ...s, next: safeNext(s.next) };
  } catch {
    return null;
  }
}

/** The cookie that carries the state across the round trip, scoped to it. */
export function oauthCookie(value: string, secure: boolean): string {
  const attrs = [`${OAUTH_COOKIE}=${value}`, "Path=/api/auth/google", "HttpOnly",
    // Lax: Google sends the user BACK with a top-level GET, which Strict would
    // strip the cookie from.
    "SameSite=Lax", `Max-Age=${Math.floor(OAUTH_TTL_MS / 1000)}`];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function clearOauthCookie(secure: boolean): string {
  const attrs = [`${OAUTH_COOKIE}=`, "Path=/api/auth/google", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function authorizeUrl(opts: {
  clientId: string; redirectUri: string; state: OAuthState;
}): string {
  const challenge = b64url(createHash("sha256").update(opts.state.verifier).digest());
  const url = new URL(AUTH_URL);
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", opts.state.state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string;
  picture: string | null;
}

export class GoogleSignInError extends Error {}

/** Exchange the code, and read who signed in. */
export async function exchangeCode(opts: {
  code: string; verifier: string; clientId: string; clientSecret: string; redirectUri: string;
  fetchImpl?: typeof fetch; now?: number;
}): Promise<GoogleIdentity> {
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: opts.code,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      redirect_uri: opts.redirectUri,
      grant_type: "authorization_code",
      code_verifier: opts.verifier,
    }).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new GoogleSignInError(`Google refused the sign-in (${res.status})`);
  const body = await res.json() as { id_token?: unknown };
  if (typeof body.id_token !== "string") throw new GoogleSignInError("Google sent no identity");
  return readIdToken(body.id_token, opts.clientId, opts.now ?? Date.now());
}

/** The ID token's claims, checked. Exported for tests. */
export function readIdToken(idToken: string, clientId: string, now: number): GoogleIdentity {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new GoogleSignInError("malformed identity token");
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new GoogleSignInError("malformed identity token");
  }
  if (!ISSUERS.has(String(claims.iss))) throw new GoogleSignInError("identity token from the wrong issuer");
  const aud = claims.aud;
  const audOk = aud === clientId || (Array.isArray(aud) && aud.includes(clientId));
  if (!audOk) throw new GoogleSignInError("identity token for another application");
  if (!(typeof claims.exp === "number" && claims.exp * 1000 > now)) {
    throw new GoogleSignInError("identity token has expired");
  }
  if (typeof claims.sub !== "string" || !claims.sub) throw new GoogleSignInError("identity token has no subject");
  if (typeof claims.email !== "string" || claims.email_verified !== true) {
    throw new GoogleSignInError("Google has not verified this account's email address");
  }
  const picture = typeof claims.picture === "string" && claims.picture.startsWith("https://")
    ? claims.picture.slice(0, 2048) : null;
  return {
    sub: claims.sub,
    email: claims.email.trim().toLowerCase(),
    name: typeof claims.name === "string" ? claims.name.slice(0, 80) : "",
    picture,
  };
}
