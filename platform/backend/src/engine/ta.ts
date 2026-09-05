/**
 * Pine-exact technical-analysis primitives — now one implementation, shared.
 *
 * ── What moved, and what did not ──────────────────────────────────────────
 *
 * Every function this module has ever exported now lives in `src/ta/core.ts`,
 * moved there verbatim. Nothing was rewritten, retuned or "tidied": strategies,
 * both live evaluators, the alert runner, the Pine interpreter and the
 * Backtester consume these exact semantics, and the Backtester's results are
 * frozen into manifests a user's leaderboard already holds. A primitive that
 * moved by one bar or one ulp would not fail loudly — it would quietly
 * disagree with history this product has already published.
 *
 * So this file re-exports rather than re-implements, and
 * `tests/taParity.test.ts` asserts that by REFERENCE EQUALITY: every name here
 * must be the core's own function object, which no amount of copy-paste drift
 * can satisfy by accident.
 *
 * ── Why the core is somewhere else at all ─────────────────────────────────
 *
 * The browser needs the same maths. A native chart study that computed its RSI
 * differently from the server that alerts on it would be a product with two
 * RSIs, and the user would find out at the worst possible moment. `ta/core.ts`
 * is dependency-free and exists byte-identically at `frontend/lib/ta/core.ts`;
 * both sides' tests compare the two files as bytes, so a divergence in a
 * formula — or in a comment — fails the suite.
 *
 * Import from here on the server, exactly as before.
 */
export * from "../ta/core";
