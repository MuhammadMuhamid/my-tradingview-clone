# Trading Scene security posture

This is the current operator overview. Platform decides, Bot executes, and Research consumes Platform's canonical market and backtest semantics. The Bot alone holds exchange credentials. Research and Compute Helper cannot submit exchange orders.

## Trust boundaries

- Platform's Fastify API uses a signed, HttpOnly, SameSite=Lax session cookie for the configured administrator. Authentication is on by default; a deliberate `AUTH_ENABLED=false` is appropriate only in an isolated local environment. The frontend proxies `/api` to the backend on the same origin. Rate limits and bounded asynchronous password checks protect sign-in. Production TLS must set secure cookies and trusted proxy configuration correctly.
- Platform-to-Bot manual and control requests use an independent shared HMAC over method, canonical path, timestamp, nonce, request ID and body. Both services enforce a short freshness window; Bot stores each accepted nonce durably through the entire window and stores command results for idempotency. Browser cookies cannot authenticate this channel.
- Strategy webhooks carry a per-deployment receiver secret. A BUY additionally requires Platform correlation and a signed, single-use Shariah decision. Bot verifies and durably consumes that authorization before admitting exposure. Direct TradingView traffic can request exits only. Operator exits remain available under the halt; automation follows the halt and Bot's final gate. Platform's webhook dispatcher accepts only approved HTTPS hosts and refuses redirects.
- Bot encrypts exchange keys at rest with its configured encryption key and salt. The key material, API keys, signed request secrets, private keys, browser profiles and databases belong in runtime configuration or protected local storage, never Git, handoff ZIPs or public logs. Do not rotate Binance keys as part of routine hardening.
- Research's local Backtester controller and Helper setup UI bind to loopback and reject cross-site mutations. Remote Helper traffic uses mutually authenticated TLS 1.3 with explicitly approved certificate fingerprints. Revocation removes trust. The coordinator owns run, worker, lease, attempt and result decisions; a Helper's result must match the original coordinator and the exact assignment. Bundles are allowlisted and extracted with size, path and duplicate checks. Helper execution is restricted to the shipped full3y1h replay work type.

## Deployment checks

1. Confirm intended Git commit, config, TLS, host allowlists and secure cookie settings. Check that the Bot's live/paper enablement matches the operator decision.
2. Keep Platform, Research and Bot checkouts and current schema migrations in sync with their documented contracts. Review database targets before migrations; do not run migrations against an unconfirmed live database.
3. Verify the Bot control channel and Shariah floor before allowing new exposure. Test a blocked BUY and an allowed operator exit with fixtures or in a disposable environment.
4. Review CI secret, docs, test, build and dependency-audit results. Keep logs free of credentials and inspect any new externally reachable route for auth, body bounds and rate limits.

## Assumptions and remaining risk

This is an owner-operated, single-administrator deployment. A trusted administrator and a compromised Bot host can access execution capability; neither is isolated as a hostile tenant. The local Research UI relies on loopback binding and browser origin checks, not a user login. Do not expose it through a public reverse proxy. Tailwind 3's development/build dependency graph has outstanding scanner advisories that require a major Tailwind 4 migration; the current runtime does not parse attacker-supplied Tailwind patterns. See the workspace hardening report for exploitability and validation.
