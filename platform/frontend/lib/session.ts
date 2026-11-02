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
  createdAt: string;
}

export interface SessionState {
  authenticated: boolean;
  authEnabled: boolean;
  user: SessionUser | null;
  providers: { google: boolean; signups: boolean };
}

const EMPTY: SessionState = {
  authenticated: false, authEnabled: true, user: null, providers: { google: false, signups: true },
};

let pending: Promise<SessionState> | null = null;
let current: SessionState | null = null;
const listeners = new Set<(s: SessionState) => void>();

async function fetchSession(): Promise<SessionState> {
  try {
    const res = await fetch("/api/auth/me", { credentials: "same-origin", cache: "no-store" });
    if (!res.ok) return EMPTY;
    const body = await res.json() as Partial<SessionState>;
    return {
      authenticated: !!body.authenticated,
      authEnabled: body.authEnabled !== false,
      user: body.user ?? null,
      providers: { google: !!body.providers?.google, signups: body.providers?.signups !== false },
    };
  } catch {
    return EMPTY;
  }
}

export function loadSession(): Promise<SessionState> {
  if (current) return Promise.resolve(current);
  pending ??= fetchSession().then((s) => {
    current = s;
    pending = null;
    forgetOtherAccountsCache(s.user?.id ?? null, s.user?.role === "admin");
    listeners.forEach((fn) => fn(s));
    return s;
  });
  return pending;
}

export async function refreshSession(): Promise<SessionState> {
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
 * What this account may be OFFERED: "admin", "user", or "unknown" while the
 * one shared session read is still in flight.
 *
 * The backend is what enforces reach; this only decides what the screen
 * offers. "unknown" exists so that nothing is drawn as the administrator's —
 * and nothing is drawn as refused — before the answer is in: the server render
 * and the first client paint of a page used to show every admin control, and
 * an ordinary account watched them appear and then vanish. A caller renders a
 * neutral state for it (no admin controls, no restriction notice).
 *
 * Once the read has ANSWERED, only an account known to be ordinary is "user".
 * A read that failed (offline, a 5xx) and an instance without authentication
 * are "admin": hiding the administrator's pages whenever the session could not
 * be read would lock the admin out of their own menu, and the server refuses
 * anyone else regardless. `lib/api.ts` `refusedForThisAccount` applies the
 * same rule.
 */
export type SessionRole = "admin" | "user" | "unknown";

export function roleOf(s: SessionState | null): SessionRole {
  if (s === null) return "unknown";
  return s.authEnabled && s.user?.role === "user" ? "user" : "admin";
}

export function useSessionRole(): SessionRole {
  return roleOf(useSession());
}

/**
 * True once the account is known to be one the administrator's controls are
 * for (see `useSessionRole`). False for an ordinary account AND while the
 * session is still being read, so no admin control is drawn before the answer.
 */
export function useIsAdmin(): boolean {
  return useSessionRole() === "admin";
}

export async function signOut(everywhere = false): Promise<void> {
  await fetch(everywhere ? "/api/auth/logout-all" : "/api/auth/logout", {
    method: "POST", credentials: "same-origin",
  }).catch(() => undefined);
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

/** Initials for an avatar without a picture. */
export function initialsOf(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0]![0]! + (parts.length > 1 ? parts[parts.length - 1]![0]! : "")).toUpperCase();
}

/** Forget the cached session — for tests, which render many accounts in one process. */
export function resetSessionForTests(): void {
  current = null;
  pending = null;
}
