# Cross-repository webhook contract

**Status:** current, `v0` — this document describes the contract **as it exists
today**, including its defects. Nothing here has been changed to make it look
correct. Where the two sides disagree, the disagreement is written down.

Two senders, one receiver:

| Sender | Path |
|---|---|
| This platform | `platform/backend/src/alerts/dispatcher.ts` → `deliver()` |
| TradingView | a Pine `alert()` call built by `bot:deploy/SR-Trend-v5-custom-webhook-ALERTS.pine` in the bot repository |

Receiver: `POST https://<bot-host>/api/webhooks/signal_bots`, validated by
`bot:backend/src/routes/webhookSchema.ts` and processed by
`bot:backend/src/services/webhook.ts` in the bot repository.

Both senders may be active simultaneously. They do **not** share dedupe state.

## Transport

- HTTPS only, port 443, no embedded credentials, and the host must appear in
  `ALLOWED_WEBHOOK_HOSTS`. Enforced by `validateWebhookUrl`.
- `content-type: application/json`.
- The platform retries up to 4 times with exponential backoff and an 8-second
  per-attempt timeout. A 4xx other than 429 is terminal and is not retried.
- Authentication is the per-bot `secret` field. There is no signature, no
  timestamp binding and no replay window beyond the dedupe keys below.

## Request — custom bot payload

```jsonc
{
  "secret":          "<32..256 chars>",       // required
  "action":          "buy" | "sell",          // required, 1..40 chars
  "symbol":          "APTUSDT",               // required unless tv_instrument is given
  "tv_instrument":   "BINANCE:APTUSDT",       // alternative to symbol
  "quote_order_qty": 340.01,                  // BUY only; > 0, <= 1_000_000
  "quantity":        1.25,                    // base units; mutually exclusive with sell_percent
  "sell_percent":    50,                      // SELL only; > 0 and < 100 — see the defect below
  "exit_leg":        "tp1" | "tp2" | "runner" | "stop" | "signal",
  "dedupe_key":      "L-<barIndex>-<barTimeMs>"
}
```

The schema is **strict**: any field not listed is rejected with HTTP 400. The
platform never sends a price — every order the receiver places is a
`type: "MARKET"` order at the then-current price.

### Normalisation applied by the receiver

- `action` is lowercased with spaces, underscores and hyphens removed, then
  matched against `buy | enterlong | long | entrylong | openlong` →
  **buy**, and `sell | exitlong | closelong | close | exit | closeposition |
  market` → **sell**. Anything else is rejected.
- `symbol` is uppercased, an exchange prefix before `:` is dropped, and `/` and
  `-` are removed. `BINANCE:near/usdt` → `NEARUSDT`.
- The symbol must appear in the bot's configured pair allowlist.

## Request — 3Commas payload

An all-strings shape mirroring `3commas_alert_message_template.json`, POSTed to
`https://api.3commas.io/signal_bots/webhooks`. It carries **no dedupe key at
all**, so a retried delivery on this path has no idempotency protection
(`BE-12`).

## Position status

```
POST /api/webhooks/signal_bots/status
{ "secret": "...", "symbols": ["APTUSDT", "..."] }   // 1..100 symbols

200 { "status": "ok", "positions": { "APTUSDT": "long" | "flat" } }
```

Polled every 30 seconds by the live runner. It returns a complete two-state
report; the platform currently consumes only `"flat"` (`X-03`).

## Response

The receiver answers HTTP 200 with `{"status": ...}` for all of:

| `status` | Meaning | Order placed? |
|---|---|---|
| `ok` | Executed | **yes** |
| `ignored_duplicate` | Suppressed by a dedupe key | no — but the original did execute |
| `ignored_stale_sell` | The tracked position was re-opened after a recent close, so the sell was skipped to protect the newer trade | **no, and the receiver is still long** |

Non-2xx: 400 validation, 401 bad secret, 404 bot missing or inactive, 422 the
bot's own configuration refused the action, 503 upstream exchange failure.

## Idempotency

Two layers, both in the receiver:

1. **Caller key** — `caller:<botId>:<symbol>:<side>:<dedupe_key>`, held 120 s
   in memory and in a `WebhookReceipt` row. Only applies when the sender
   supplied a `dedupe_key`.
2. **Trade key** — `trade:<botId>:<symbol>:<side>[:<exit_leg>]`, held 45 s.
   Source-independent, so it catches a duplicate arriving from the other sender
   within that window.

## Known defects in this contract

These are live. Each is tracked in [REMEDIATION-LEDGER.md](REMEDIATION-LEDGER.md).

| Id | Defect |
|---|---|
| `X-01` | The platform can emit `sell_percent: 100`; the receiver's schema is `< 100`, so the leg is rejected with a terminal 400, the take-profit never reaches the exchange, and the platform still marks the tier done. |
| `X-02` | `dedupe_key` embeds `barIndex`, which the two senders compute differently — the platform uses `floor(epoch_ms / interval_ms)` (~1.9e6), Pine uses chart-relative `bar_index` (a few thousand). The comment in `dispatcher.ts` claiming byte-identity is false. Cross-source duplicates are caught only by the 45-second trade key. |
| `X-03` | Reconciliation is one-directional: a receiver-reported `long` against a locally-flat deployment has no handler. |
| `X-12` | The sender treats any 2xx as an executed order, so `ignored_stale_sell` advances platform state while the receiver stays long. |
| `BE-12` | The 3Commas payload carries no dedupe key, and the retry loop swallows client-side timeouts. |
| `BE-20` | The `contracts` value on a SELL is computed from the original position size, so it is wrong after a partial exit. |

## Verifying a change to this contract

Both repositories carry a contract test that mirrors the other side:

- `platform/backend/tests/webhookContract.test.ts`
- `bot:backend/tests/webhookContract.test.ts` in the bot repository

Change the contract in both, and in this document, in one commit.
