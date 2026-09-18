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

/**
 * ── REV-UX-01: the same rule, at the one surface that was still breaking it ─
 *
 * `shortReason` above is a GUESS — it reads a status code out of prose. That
 * was the only thing available when it was written, and it is wrong in both
 * directions: a provider that answers a 502 with
 * `invalid SOLUSDT 15m backfill: invalid_close_time` carries no code to find,
 * and a message naming a price or a symbol with three digits in it matches a
 * code that was never sent.
 *
 * `lib/api.ts` now throws `ApiError`, which knows. So when the cause is one of
 * those, the status decides; otherwise the old guess still applies, because a
 * `TypeError: fetch failed` from the network stack is not an `ApiError` and
 * never will be.
 *
 * The shape returned is deliberately two fields. `headline` is what the page
 * says — one sentence, the reader's vocabulary, no endpoint and no exception
 * text. `detail` is the cause VERBATIM, for the tooltip and for a bug report.
 * Neither is optional: a failure that is summarised and then thrown away is
 * how a support request becomes unanswerable, and a failure quoted raw is the
 * defect this function exists to end.
 */
export interface FailureCopy {
  /** One short sentence. Safe as the most prominent copy on a page. */
  headline: string;
  /** The cause exactly as it arrived. Never page copy; always available. */
  detail: string;
}

/** The status this cause carries, if it carries one. */
function statusOf(cause: unknown): number | null {
  const status = (cause as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}

function reasonForStatus(status: number): string {
  if (status === 401 || status === 403) return "You may need to sign in again.";
  if (status === 404) return "This environment does not serve it.";
  if (status === 429) return "The service is rate-limiting us. Try again shortly.";
  if (status >= 500) return "The service did not answer. Try again shortly.";
  if (status >= 400) return "The request was refused.";
  return "Hover for the reason reported.";
}

/** The cause exactly as it arrived, whatever shape it arrived in. */
export function causeText(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return String(cause);
}

/**
 * One short sentence saying what the reader can do about this, and nothing
 * about how the request was plumbed.
 */
export function failureReason(cause: unknown): string {
  const status = statusOf(cause);
  return status === null ? shortReason(causeText(cause)) : reasonForStatus(status);
}

/**
 * Say that `what` could not be LOADED, keeping the cause intact beside it.
 *
 * `what` is a noun phrase naming the thing the reader was waiting for — "Price
 * history", "The Shariah universe" — not the endpoint that served it.
 */
export function describeFailure(cause: unknown, what: string): FailureCopy {
  return { headline: `${what} could not be loaded. ${failureReason(cause)}`, detail: causeText(cause) };
}

/**
 * Say that an ACTION the reader asked for did not happen.
 *
 * `action` is the thing they asked for, in their words and in the infinitive —
 * "pause BTCUSDT", "save the layout". The distinction from `describeFailure`
 * is not cosmetic: "could not be loaded" invites a retry of a read, and a
 * reader who has just pressed a button that sends orders needs to be told that
 * the button did NOT take effect, which is a different fact.
 */
export function describeAction(cause: unknown, action: string): FailureCopy {
  return { headline: `Could not ${action}. ${failureReason(cause)}`, detail: causeText(cause) };
}

/**
 * A sentence this product wrote itself, with no cause behind it.
 *
 * Several dialogs hold ONE error slot that carries both kinds of message: the
 * validation they authored ("Enter a price above zero.") and whatever the
 * backend threw. Making the slot a `FailureCopy` is what stops the second kind
 * being rendered like the first; this is how the first kind goes in.
 */
export function said(headline: string): FailureCopy {
  return { headline, detail: "" };
}


/**
 * Why a screener row could not be resolved, in the reader's words.
 *
 * The Screener rendered the provider's own failure as the row body. On this
 * install that meant every one of 36 rows read as an HTTP status, a vendor URL
 * and a clause of Binance's terms of service — the whole table was one error
 * message repeated 36 times. The UI contract has a rule for exactly this
 * ("provider/fixture error strings are never primary page copy") and this was
 * the surface still breaking it.
 *
 * The note is never discarded: it is the tooltip, verbatim, because a failure
 * that is summarised and then thrown away cannot be reported to anyone. What
 * changes is which of the two the reader meets first.
 *
 * The geo-restriction case gets its own sentence because it is not a fault the
 * operator can retry their way out of — it is a property of where the request
 * came from, and saying "try again shortly" would send them round a loop.
 */
export function unresolvedSymbolReason(note: string | null | undefined): string {
  const raw = String(note ?? "");
  if (!raw) return "This symbol could not be resolved against the exchange.";
  if (/\b451\b|restricted location|eligibility/i.test(raw)) {
    return "The exchange refuses requests from this location, so its instrument directory "
      + "could not be read. This is not a fault with the symbol.";
  }
  if (/unreachable|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|timeout|fetch failed|network/i.test(raw)) {
    return "The exchange directory could not be reached, so this symbol could not be resolved.";
  }
  if (/\b(404|not found|unknown symbol|invalid symbol)\b/i.test(raw)) {
    return "The exchange does not list this symbol.";
  }
  if (/\b(401|403|unauthor|forbidden)\b/i.test(raw)) {
    return "The exchange refused the directory request, so this symbol could not be resolved.";
  }
  return "This symbol could not be resolved against the exchange.";
}
