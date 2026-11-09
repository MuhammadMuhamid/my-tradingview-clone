"use client";
/**
 * The signed-in account, read once per page load and shared.
 *
 * `/api/auth/me` answers who is signed in, their role, whether they have
 * finished onboarding, and which ways in this instance offers (Google,
 * sign-ups). Every reader shares one request; `refreshSession` re-reads after
 * a profile change.
 */
import { useEffect, useState } from "react";

export interface SessionUser {
  id: string;
  email: string | null;
  displayName: string;
  avatarUrl: string | null;
  role: "admin" | "user";
  onboarded: boolean;
  hasPassword: boolean;
  passwordManagedByServer: boolean;
  googleLinked: boolean;
  githubLinked: boolean;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  /** Email verified and two-factor on: what money features will ask for. */
  moneyFeaturesUnlocked: boolean;
  createdAt: string;
}

export interface SessionState {
  authenticated: boolean;
  authEnabled: boolean;
  user: SessionUser | null;
  providers: { google: boolean; github: boolean; signups: boolean; email: boolean };
  /**
   * True when `/api/auth/me` did not answer: a network failure or a non-2xx.
   *
   * Recorded rather than folded into "signed out" or "administrator", because
   * neither is known. The screen offers nothing role-specific for it and says
   * the account could not be checked (`roleOf` → "unreadable").
   */
  readFailed?: boolean;
}

/** What a read that did not answer leaves us with: no account, and that it failed. */
const UNREAD: SessionState = {
  authenticated: false, authEnabled: true, user: null, providers: { google: false, github: false, signups: true, email: false },
  readFailed: true,
};

/*
 * A failed read must recover without anyone asking. An administrator whose
 * chart loaded during a backend restart otherwise lost the Trade ticket and
 * their positions until they found Retry in a menu, long after the server was
 * back. The read is repeated, backing off, and at once when the browser comes
 * back online; a read that answers ends it.
 */
const READ_RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000];
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryAttempt = 0;

function cancelReadRetry(): void {
  if (retryTimer !== null) clearTimeout(retryTimer);
  retryTimer = null;
  if (typeof window !== "undefined") window.removeEventListener("online", retryReadNow);
}

function retryReadNow(): void {
  void refreshSession();
}

function scheduleReadRetry(): void {
  if (typeof window === "undefined" || retryTimer !== null) return;
  const delay = READ_RETRY_DELAYS_MS[Math.min(retryAttempt, READ_RETRY_DELAYS_MS.length - 1)]!;
  retryAttempt += 1;
  retryTimer = setTimeout(retryReadNow, delay);
  (retryTimer as { unref?: () => void }).unref?.();
  window.addEventListener("online", retryReadNow);
}

let pending: Promise<SessionState> | null = null;
let current: SessionState | null = null;
const listeners = new Set<(s: SessionState) => void>();

async function fetchSession(): Promise<SessionState> {
  try {
    const res = await fetch("/api/auth/me", { credentials: "same-origin", cache: "no-store" });
    if (!res.ok) return UNREAD;
    const body = await res.json() as Partial<SessionState>;
    return {
      authenticated: !!body.authenticated,
      authEnabled: body.authEnabled !== false,
      user: body.user ?? null,
      providers: { google: !!body.providers?.google, github: !!body.providers?.github, signups: body.providers?.signups !== false, email: !!body.providers?.email },
    };
  } catch {
    return UNREAD;
  }
}

/** Pages a signed-out reader is meant to be on; never redirected away from. */
const SIGN_IN_PAGES = new Set(["/login", "/signup"]);

/**
 * Send the reader to sign in, carrying where they were.
 *
 * Shared with `lib/api.ts`: an expired session is recoverable, and both a 401
 * from any request and a session read that answers "not signed in" end here. Never during SSR, never
 * for the auth endpoints themselves (a wrong password is a 401 the form must
 * show), and never from the sign-in pages, which would loop.
 */
export function redirectToSignIn(path = ""): void {
  if (typeof window === "undefined") return;
  if (path.startsWith("/api/auth/")) return;
  const here = window.location.pathname;
  if (SIGN_IN_PAGES.has(here)) return;
  const next = encodeURIComponent(here + window.location.search);
  window.location.href = `/login?next=${next}`;
}

export function loadSession(): Promise<SessionState> {
  if (current) return Promise.resolve(current);
  pending ??= fetchSession().then((s) => {
    current = s;
    pending = null;
    forgetOtherAccountsCache(s.user?.id ?? null, s.user?.role === "admin");
    listeners.forEach((fn) => fn(s));
    if (s.readFailed) scheduleReadRetry();
    else retryAttempt = 0;
    /*
     * The server ANSWERED, and said nobody is signed in: the cookie the proxy
     * let through no longer verifies (expired, or signed out elsewhere). That
     * used to read as the administrator — `user` is null, so it was not "an
     * ordinary account" — and the page drew the owner's controls for a reader
     * with no session at all. It is a way back to sign-in instead.
     */
    if (!s.readFailed && s.authEnabled && !s.authenticated) redirectToSignIn();
    return s;
  });
  return pending;
}

export async function refreshSession(): Promise<SessionState> {
  cancelReadRetry();
  current = null;
  return loadSession();
}

/** Who is signed in; `null` while the first read is in flight. */
export function useSession(): SessionState | null {
  const [state, setState] = useState<SessionState | null>(current);
  useEffect(() => {
    listeners.add(setState);
    void loadSession().then(setState);
    return () => { listeners.delete(setState); };
  }, []);
  return state;
}

/**
 * What this account may be OFFERED: "admin", "user", "unknown" while the one
 * shared session read is still in flight, or "unreadable" when it could not be
 * checked.
 *
 * The backend is what enforces reach; this only decides what the screen
 * offers. "unknown" exists so that nothing is drawn as the administrator's —
 * and nothing is drawn as refused — before the answer is in: the server render
 * and the first client paint of a page used to show every admin control, and
 * an ordinary account watched them appear and then vanish. A caller renders a
 * neutral state for it (no admin controls, no restriction notice).
 *
 * "unreadable" is a read that did not answer (offline, a 5xx), or one that
 * answered "nobody is signed in" on an instance that has accounts. Either way
 * the account is not known, so — exactly as for "unknown" — nothing of the
 * administrator's is offered. This used to resolve to "admin" so the owner
 * could not be locked out of their own menu; the result was that an ordinary
 * account whose read failed was shown the owner's Trade ticket, Turn on, Sync
 * universe and the whole admin navigation. The owner's way back is a Retry
 * (`AdminOnlyPage`), not an assumption. An instance WITHOUT authentication is
 * still "admin": there is no other account it could be. `lib/api.ts`
 * `refusedForThisAccount` refuses locally only for a KNOWN ordinary account,
 * so an unreadable session's requests still reach the server, which answers.
 */
export type SessionRole = "admin" | "user" | "unknown" | "unreadable";

export function roleOf(s: SessionState | null): SessionRole {
  if (s === null) return "unknown";
  if (s.readFailed) return "unreadable";
  if (!s.authEnabled) return "admin";
  if (!s.authenticated || !s.user) return "unreadable";
  return s.user.role === "admin" ? "admin" : "user";
}

export function useSessionRole(): SessionRole {
  return roleOf(useSession());
}

/**
 * True once the account is known to be one the administrator's controls are
 * for (see `useSessionRole`). False for an ordinary account, while the session
 * is still being read, and when it could not be read — so no admin control is
 * drawn for an account that is not known to be the administrator's.
 */
export function useIsAdmin(): boolean {
  return useSessionRole() === "admin";
}

export async function signOut(everywhere = false): Promise<void> {
  await fetch(everywhere ? "/api/auth/logout-all" : "/api/auth/logout", {
    method: "POST", credentials: "same-origin",
  }).catch(() => undefined);
  cancelReadRetry();
  current = null;
  window.location.href = "/login";
}

/*
 * Browser storage belongs to an ACCOUNT, not to a browser. The chart caches
 * layouts, studies, drawings and watchlists locally; on a shared computer the
 * next person to sign in must not open the previous one's chart. When the
 * signed-in account differs from the one this storage was written for, the
 * app's cached state is cleared. Display preferences (theme) are kept.
 */
const OWNER_KEY = "ts.account.owner";
const KEEP = new Set([OWNER_KEY, "theme", "tv.theme"]);

function forgetOtherAccountsCache(userId: string | null, isAdmin: boolean): void {
  if (!userId || typeof window === "undefined") return;
  try {
    const owner = window.localStorage.getItem(OWNER_KEY);
    if (owner === userId) return;
    // Storage written before accounts existed is the admin's: kept for the
    // admin, cleared for anyone else.
    if (owner !== null || !isAdmin) {
      for (const key of Object.keys(window.localStorage)) {
        if (!KEEP.has(key) && !key.toLowerCase().includes("theme")) window.localStorage.removeItem(key);
      }
    }
    window.localStorage.setItem(OWNER_KEY, userId);
  } catch { /* storage unavailable — nothing cached to leak */ }
}

/**
 * After this account is deleted (OD-6): everything the app cached in this
 * browser for it goes too, the owner marker included, so nothing of it is left
 * for whoever uses the browser next. Display preferences (theme) are kept,
 * as when another account signs in.
 */
export function forgetAccountStorage(): void {
  if (typeof window === "undefined") return;
  try {
    for (const key of Object.keys(window.localStorage)) {
      if (key === OWNER_KEY || (!KEEP.has(key) && !key.toLowerCase().includes("theme"))) {
        window.localStorage.removeItem(key);
      }
    }
  } catch { /* storage unavailable: nothing cached */ }
  try { window.sessionStorage.clear(); } catch { /* storage unavailable */ }
}

/** Initials for an avatar without a picture. */
export function initialsOf(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0]![0]! + (parts.length > 1 ? parts[parts.length - 1]![0]! : "")).toUpperCase();
}

/** Forget the cached session — for tests, which render many accounts in one process. */
export function resetSessionForTests(): void {
  cancelReadRetry();
  retryAttempt = 0;
  current = null;
  pending = null;
}
