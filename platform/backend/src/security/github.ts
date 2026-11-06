/**
 * Sign in with GitHub: OAuth 2 authorization code with PKCE.
 *
 * GitHub issues no ID token, so who signed in comes from its API, read over TLS
 * with the token its token endpoint just gave this server. Only a primary,
 * verified address is accepted: the account joins by email, so an unverified one
 * could claim someone else's account. The token isn't kept past the callback.
 */
import { createHash } from "node:crypto";
import type { OAuthState } from "./google";

const AUTH_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const API = "https://api.github.com";

export interface GithubIdentity {
  id: string;
  email: string;
  name: string;
  picture: string | null;
}

export class GithubSignInError extends Error {}

export function githubAuthorizeUrl(opts: { clientId: string; redirectUri: string; state: OAuthState }): string {
  const url = new URL(AUTH_URL);
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("scope", "read:user user:email");
  url.searchParams.set("state", opts.state.state);
  url.searchParams.set("code_challenge",
    createHash("sha256").update(opts.state.verifier).digest().toString("base64url"));
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function exchangeGithubCode(opts: {
  code: string; verifier: string; clientId: string; clientSecret: string; redirectUri: string;
  fetchImpl?: typeof fetch;
}): Promise<GithubIdentity> {
  const doFetch = opts.fetchImpl ?? fetch;
  const tokenRes = await doFetch(TOKEN_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: opts.code, client_id: opts.clientId, client_secret: opts.clientSecret,
      redirect_uri: opts.redirectUri, code_verifier: opts.verifier,
    }).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!tokenRes.ok) throw new GithubSignInError(`GitHub refused the sign-in (${tokenRes.status})`);
  const token = (await tokenRes.json() as { access_token?: unknown }).access_token;
  if (typeof token !== "string" || !token) throw new GithubSignInError("GitHub sent no token");

  const read = async (path: string): Promise<unknown> => {
    const res = await doFetch(`${API}${path}`, {
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`,
        "user-agent": "trading-scene", "x-github-api-version": "2022-11-28" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new GithubSignInError(`GitHub refused ${path} (${res.status})`);
    return res.json();
  };
  const profile = await read("/user") as { id?: unknown; name?: unknown; login?: unknown; avatar_url?: unknown };
  const emails = await read("/user/emails");
  if (typeof profile.id !== "number" && typeof profile.id !== "string") {
    throw new GithubSignInError("GitHub sent no account id");
  }
  const primary = Array.isArray(emails)
    ? (emails as { email?: unknown; primary?: unknown; verified?: unknown }[])
      .find((e) => e.primary === true && e.verified === true && typeof e.email === "string")
    : undefined;
  if (!primary) throw new GithubSignInError("GitHub has no verified primary email for this account");
  const name = typeof profile.name === "string" && profile.name ? profile.name
    : typeof profile.login === "string" ? profile.login : "";
  return {
    id: String(profile.id),
    email: (primary.email as string).trim().toLowerCase(),
    name: name.slice(0, 80),
    picture: typeof profile.avatar_url === "string" && profile.avatar_url.startsWith("https://")
      ? profile.avatar_url.slice(0, 2048) : null,
  };
}
