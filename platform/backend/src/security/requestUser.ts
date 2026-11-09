/**
 * Who is asking, and what they may reach.
 *
 * ── Identity ───────────────────────────────────────────────────────────────
 *
 * The session gate in `api/server.ts` resolves the cookie to a `RequestUser`
 * on every request and hangs it on `req.user`. Routes read the owner of the
 * data they touch from there and nowhere else — never from a body or a query
 * string — so no request can name another user's rows.
 *
 * With AUTH_ENABLED=false (local development, the test suite) every request is
 * the admin: that is exactly the single-user product this was before accounts.
 *
 * ── Reach ──────────────────────────────────────────────────────────────────
 *
 * Default-deny for ordinary users. The admin reaches everything; a `user`
 * reaches only the routes listed in `USER_ROUTES` — the chart, its data, their
 * own alerts, watchlists, layouts, scripts and devices, the screener and the
 * Shariah screen (read-only). Trading, the bot's deployments and webhooks,
 * operations, research and the scanner's configuration act on the platform
 * owner's exchange account and real money, and a route added later is
 * admin-only until someone decides otherwise.
 */
import type { FastifyRequest } from "fastify";
import { config } from "../config";
import { ADMIN_USER_ID, getUser, type UserRole } from "../repositories/users";

export interface RequestUser {
  id: string;
  role: UserRole;
  sessionVersion: number;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the session gate; null only on public paths. */
    user: RequestUser | null;
    /**
     * The path every request check runs against: `canonicalRequestPath` of the
     * URL, set by the first request hook in `api/server.ts`.
     */
    gatePath: string;
  }
}

/** The admin, for an unauthenticated (development) instance. */
export const DEV_ADMIN: RequestUser = { id: ADMIN_USER_ID, role: "admin", sessionVersion: 1 };

/**
 * The owner of whatever this request reads or writes.
 *
 * An unauthenticated instance is the admin even where the gate did not run
 * (a route mounted on its own, as the handler tests do); an authenticated one
 * never guesses.
 */
export function userIdOf(req: FastifyRequest): string {
  const user = req.user ?? (config.authEnabled ? null : DEV_ADMIN);
  if (!user) throw Object.assign(new Error("not authenticated"), { statusCode: 401 });
  return user.id;
}

export const isAdmin = (req: FastifyRequest): boolean =>
  (req.user ?? (config.authEnabled ? null : DEV_ADMIN))?.role === "admin";

// ── a short cache of account state ──────────────────────────────────────────

/*
 * Every API request needs the account's role and session version. Those change
 * only on sign-out-everywhere, a role change or a deletion, so a few seconds
 * of caching saves a query per request — and each of those paths calls
 * `forgetUser`, so the cache never outlives the change it would hide.
 */
const CACHE_MS = 15_000;
const cache = new Map<string, { at: number; user: RequestUser | null }>();

type Loader = (id: string) => Promise<RequestUser | null>;
const fromDatabase: Loader = async (id) => {
  const row = await getUser(id);
  return row ? { id: row.id, role: row.role, sessionVersion: row.sessionVersion } : null;
};
let loader: Loader = fromDatabase;

/**
 * Tests that exercise the gate without a database. The suite runs files in
 * parallel and one of them drops and recreates the test database, so a gate
 * test that read accounts from it would race that.
 */
export function useUserLoaderForTests(fn: Loader | null): void {
  loader = fn ?? fromDatabase;
  cache.clear();
}

export async function loadRequestUser(id: string, now = Date.now()): Promise<RequestUser | null> {
  const hit = cache.get(id);
  if (hit && now - hit.at < CACHE_MS) return hit.user;
  const user = await loader(id);
  cache.set(id, { at: now, user });
  if (cache.size > 5_000) cache.delete(cache.keys().next().value!);
  return user;
}

export function forgetUser(id: string): void {
  cache.delete(id);
}

// ── what an ordinary user may reach ─────────────────────────────────────────

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "*";

const USER_ROUTES: readonly [Method, RegExp][] = [
  ["*", /^\/api\/auth(\/|$)/],
  // The chart and its data.
  ["GET", /^\/api\/symbols(\/|$)/],
  // Opening a coin the platform does not track yet starts tracking it.
  ["POST", /^\/api\/symbols$/],
  ["GET", /^\/api\/data\/trades$/],
  ["POST", /^\/api\/data\/(backfill|ensure)$/],
  ["GET", /^\/api\/market\/v1\//],
  // Their own things.
  ["*", /^\/api\/pine(\/|$)/],
  ["*", /^\/api\/layouts(\/[^/]+)?$/],
  ["*", /^\/api\/watchlists(\/|$)/],
  ["*", /^\/api\/chart-state\//],
  ["*", /^\/api\/ma-alerts(\/|$)/],
  ["*", /^\/api\/push\//],
  // The screener, read-only, and pattern analysis (pure computation).
  ["GET", /^\/api\/scanner(\/|$)/],
  ["POST", /^\/api\/scanner\/(patterns|classical-patterns)\/analyze$/],
  // The Shariah screen, read-only.
  ["GET", /^\/api\/shariah\//],
  // Packages: browse, ask to join, and see only their own holdings.
  ["GET", /^\/api\/packages$/],
  ["POST", /^\/api\/packages\/cohorts\/[0-9a-f-]{36}\/join$/],
  ["GET", /^\/api\/portfolio$/],
];

/** Admin-only paths that a broader user pattern above would otherwise match. */
const ADMIN_ONLY: readonly RegExp[] = [
  /^\/api\/layouts\/sync-deployments$/,
];

/** The same exceptions, as the route patterns the router matches them by. */
const ADMIN_ONLY_ROUTES: ReadonlySet<string> = new Set([
  "/api/layouts/sync-deployments",
]);

/**
 * `path` must be the CANONICAL path (`canonicalRequestPath`), never `req.url`:
 * these patterns describe the paths the router dispatches on.
 */
export function userMayReach(method: string, path: string): boolean {
  if (ADMIN_ONLY.some((re) => re.test(path))) return false;
  const m = method.toUpperCase();
  return USER_ROUTES.some(([allowed, re]) => (allowed === "*" || allowed === m) && re.test(path));
}

/**
 * The gate's whole decision for an ordinary account: the canonical path is in
 * reach, AND the route the router actually matched is not one of the
 * admin-only exceptions. The second half is a backstop for any difference
 * between the canonical path and the router that this file failed to foresee.
 */
export function userMayReachRoute(method: string, path: string, routeUrl: string | undefined): boolean {
  if (routeUrl !== undefined && ADMIN_ONLY_ROUTES.has(routeUrl)) return false;
  return userMayReach(method, path);
}

// ── the path a request is checked against ───────────────────────────────────

/** An absolute-form request target (`POST http://host/path`), as the router strips it. */
const ABSOLUTE_FORM = /^https?:\/\/.*?\//;

/**
 * The path the router dispatches this URL on, or null for a URL this API refuses.
 *
 * Every request check (`PUBLIC_PATHS`, the sign-in limit, `userMayReach`) must
 * see the same path the router matched, or a request can pass a check written
 * for one path and run the handler of another. The raw `req.url` is not that
 * path: the router strips an absolute-form `http://host`, cuts at the first
 * `?` OR `#`, and percent-decodes. A gate reading the raw URL once let an
 * ordinary account reach `POST /api/layouts/sync-deployments` as
 * `/api/layouts/sync%2Ddeployments`.
 *
 * This mirrors find-my-way 9 under Fastify 5's defaults (case-sensitive; no
 * trailing-slash, duplicate-slash or dot-segment folding; `;` is not a
 * delimiter). Its path decoding is `decodeURI`, which leaves the escapes of
 * reserved characters (`# $ & + , / : ; = ? @`) encoded, with `%25` also kept
 * as `%25`; parameters are decoded fully afterwards, which changes no route
 * choice. `tests/sessionGatePathDb.test.ts` holds both to the real router.
 *
 * Refused (null, answered 400):
 *  - an escape that does not decode — the router refuses those too, before
 *    any hook runs, so this is a second lock;
 *  - an encoded slash, `%2F`. The router keeps it in the path but decodes it
 *    to a real `/` inside a parameter, so one segment is two depending on who
 *    reads it. This product's client never sends one;
 *  - a target that does not start with `/` once an absolute-form prefix is
 *    removed. The router never compares the first character, so it dispatches
 *    `xapi/layouts/sync-deployments` as `/api/layouts/sync-deployments`, while
 *    every check here is written for a leading `/`. Node's own HTTP parser
 *    refuses such request lines, so this closes the gap for in-process
 *    dispatch (inject) and keeps the stated invariant exact. (`OPTIONS *` is
 *    400 rather than 404 as a result; no route serves it.)
 */
export function canonicalRequestPath(rawUrl: string): string | null {
  let path = rawUrl;
  if (path.charCodeAt(0) !== 47 /* "/" */) path = path.replace(ABSOLUTE_FORM, "/");
  if (path.charCodeAt(0) !== 47) return null;
  // From index 1, as the router scans: the query and the fragment are not path.
  const end = path.slice(1).search(/[?#]/);
  if (end !== -1) path = path.slice(0, end + 1);
  if (/%2f/i.test(path)) return null;
  try {
    return decodeURI(path.replace(/%25/g, "%2525"));
  } catch {
    return null;
  }
}
