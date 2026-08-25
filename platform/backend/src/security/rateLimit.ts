/**
 * Fixed-window rate limiter, in process.
 *
 * Deliberately dependency-free and deliberately narrow: it exists to stop
 * password guessing against `/api/auth/login`, where each attempt costs ~100 ms
 * of scrypt on the same event loop that evaluates live bar closes. It is not a
 * general traffic shaper.
 *
 * It must not interfere with the sliding-session behaviour that keeps a browser
 * signed in, so nothing but the sign-in attempt is counted. An actively used
 * app never touches this path.
 *
 * Single-process only. A multi-instance deployment needs a shared store; that
 * is recorded rather than pretended away.
 */
export interface RateLimitDecision {
  allowed: boolean;
  /** Attempts left in the current window. */
  remaining: number;
  /** Seconds until the window resets. */
  retryAfterSec: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export class FixedWindowLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    /** Cap on distinct keys, so a spray of forged client IPs cannot grow this without bound. */
    private readonly maxKeys = 10_000
  ) {}

  /** Count one attempt against `key`. */
  hit(key: string, now = Date.now()): RateLimitDecision {
    this.prune(now);
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + this.windowMs };
      if (this.buckets.size >= this.maxKeys) this.evictOldest();
      this.buckets.set(key, bucket);
    }
    bucket.count++;
    const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    return {
      allowed: bucket.count <= this.limit,
      remaining: Math.max(0, this.limit - bucket.count),
      retryAfterSec,
    };
  }

  /** Forget a key — called after a successful sign-in so a real user is not punished. */
  reset(key: string): void {
    this.buckets.delete(key);
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt < oldestAt) { oldestAt = bucket.resetAt; oldestKey = key; }
    }
    if (oldestKey !== null) this.buckets.delete(oldestKey);
  }
}

/**
 * The client address to rate-limit on.
 *
 * `X-Forwarded-For` is attacker-controlled unless a proxy we operate sets it,
 * so it is read only when TRUST_PROXY is on, and then only the left-most entry
 * — the rest is whatever the client sent. Without TRUST_PROXY every request
 * behind a reverse proxy would share one bucket, which is why the flag exists.
 */
export function clientKey(
  socketAddress: string | undefined,
  forwardedFor: string | string[] | undefined,
  trustProxy: boolean
): string {
  if (trustProxy && forwardedFor) {
    const raw = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
    const first = (raw ?? "").split(",")[0]?.trim();
    if (first) return first;
  }
  return socketAddress ?? "unknown";
}

/**
 * The sign-in limiter, shared by the request hook that enforces it and the
 * login handler that clears it after a correct password. It lives here rather
 * than in `api/server.ts` so the route does not have to import the server.
 *
 * Five attempts per minute per client address.
 */
export const loginLimiter = new FixedWindowLimiter(5, 60_000);
