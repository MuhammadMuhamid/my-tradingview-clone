/**
 * A backend failure, said the way a reader needs it.
 *
 * ── Why this is its own module ─────────────────────────────────────────────
 *
 * TVP8 moved this out of `app/shariah/page.tsx` — the one page that was doing
 * it correctly — into `components/ui.tsx`, and then found `lib/freshness.ts`
 * building `Could not load: ${lastError}` where `lastError` is whatever
 * `lib/api.ts` put in `Error.message`: a status line, a URL-encoded route, or
 * "fixture server has no route for GET /api/alerts". That string was the whole
 * of a red banner across the top of the Trading page.
 *
 * `freshness.ts` is pure and cannot import a `.tsx`, so the rule lives here and
 * `ui.tsx` re-exports it. One implementation, reachable from both sides.
 *
 * The raw cause is never discarded — it is the tooltip, and it is what a
 * support request needs. It is just not the headline. A route path or a stack
 * frame as the most prominent line on a page tells the reader nothing they can
 * do and everything about our plumbing.
 */
export function shortReason(raw: string): string {
  if (/\b(401|403|unauthor|forbidden)/i.test(raw)) return "You may need to sign in again.";
  if (/\b(404|no route)/i.test(raw)) return "This environment does not serve it.";
  if (/\b(5\d\d|timeout|fetch failed|network)/i.test(raw)) return "The service did not answer. Try again shortly.";
  return "Hover for the reason reported.";
}
