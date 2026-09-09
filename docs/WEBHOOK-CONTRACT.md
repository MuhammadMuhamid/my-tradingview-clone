# Cross-repository webhook contract

**Status:** current, **`v6`**. The contract is now a real artifact rather than a
description: `platform/backend/src/contract/webhookContract.ts` is vendored
byte-for-byte into both repositories, carries a `CONTRACT_FINGERPRINT`, and both
test suites hash their own copy against it. Editing one side turns both builds
red until both copies and this document are updated together.

That mechanism is the fix for the root cause. The contract was previously
hand-duplicated with no shared artifact and no test, which is what produced
`X-01`, `X-02` and `X-12` — three defects that all reduce to "the two sides
disagreed and nothing noticed".

One decision authority, two permitted transport roles:

| Sender | Path |
|---|---|
| This platform | `platform/backend/src/alerts/dispatcher.ts` → `deliver()` |
| TradingView | exposure-reducing SELL/exit only; it has no BUY authority |

Receiver: `POST https://<bot-host>/api/webhooks/signal_bots`, validated by
`bot:backend/src/routes/webhookSchema.ts` and processed by
`bot:backend/src/services/webhook.ts` in the bot repository.

Both transports may be active simultaneously, but only Platform may authorize
new exposure.

## Transport

- HTTPS only, port 443, no embedded credentials, and the host must appear in
  `ALLOWED_WEBHOOK_HOSTS`. Enforced by `validateWebhookUrl`.
- `content-type: application/json`.
- The platform retries up to 4 times with exponential backoff and an 8-second
  per-attempt timeout. A 4xx other than 429 is terminal and is not retried.
- The per-bot `secret` authenticates the Bot configuration. A BUY additionally
  requires paired Platform correlation headers and detached HMAC evidence with
  a fresh, durably single-use nonce. The webhook secret alone is never entry
  authority.

## Request — custom bot payload

```jsonc
{
  "secret":          "<32..256 chars>",       // required
  "action":          "buy" | "sell",          // required, 1..40 chars
  "symbol":          "APTUSDT",               // required unless tv_instrument is given
  "tv_instrument":   "BINANCE:APTUSDT",       // alternative to symbol
  "quote_order_qty": 340.01,                  // BUY only; > 0, <= 1_000_000
  "quantity":        1.25,                    // base units; mutually exclusive with sell_percent
  "sell_percent":    50,                      // SELL only; > 0 and <= 100 (v1)
  "exit_leg":        "tp1" | "tp2" | "runner" | "stop" | "signal",
  "dedupe_key":      "L-<barOpenTimeMs>",     // see "Idempotency" below

  // Shariah execution context (v3+). Optional; absent means the sender is not
  // enforcing, which is exactly the pre-Shariah behaviour.
  "shariah": {
    "mode":            "off" | "enforce",
    "policyVersion":   "TS_SHARIAH_V1",       // required under enforce
    "assetId":         "reg_apt_0001",
    "baseAsset":       "APT",                 // binds the decision to the symbol
    "effectiveStatus": "ELIGIBLE" | "REVIEW" | "EXCLUDED",
    "publicationId":   "pub_2026_09_02"       // null only for unresolved REVIEW
  },

  // Detached evidence (v4, v5). Emitted as a SET — all three or none.
  "shariah_ts":    "<epoch ms>",
  "shariah_nonce": "<22..128 base64url>",     // single-use, v5
  "shariah_sig":   "v1=<64 hex>"              // HMAC over the canonical bytes
}
```

### Detached Shariah evidence

The base body is authenticated only by the per-bot `secret` it carries, which
authorises **placing** an order and proves nothing about who **screened** the
asset or an order. Every BUY, including truthful mode-off policy, therefore
travels with its own signature, keyed by the installation's Platform HMAC
secret — which a direct TradingView alert does not have.

The signed bytes are built by `shariahEvidenceCanonical`, newline-joined:

```
TS_SHARIAH_EVIDENCE_V2
<SYMBOL, uppercased, non-alphanumerics stripped>
<side>
<shariah_ts>
<shariah_nonce>
mode=…  policyVersion=…  assetId=…  baseAsset=…  effectiveStatus=…  publicationId=…
```

`shariah_nonce` is v5's addition and the reason it exists. Until v5 the signature
named a symbol, a side, a decision and a time — nothing identifying the ORDER —
so a captured payload re-sent under a fresh `dedupe_key` looked like a brand new
order to every idempotency layer below, and bought again. The nonce is minted per
delivery from 24 CSPRNG bytes, is inside the signed bytes (so it cannot be swapped
for an unspent one), and the receiver claims it durably. One signed decision
authorises **one** entry.

**SELL is never gated by any of this.** An exit carries evidence for protocol
consistency, claims no nonce, and is never refused on Shariah grounds — including
when the authorisation it carries has already been spent.

The schema is **strict**: any field not listed is rejected with HTTP 400. The
platform never sends a price — every order the receiver places is a
`type: "MARKET"` order at the then-current price.

Platform's live runner adds paired `X-Platform-Deployment-Id` and
`X-Platform-Order-Intent-Id` HTTP headers. As of v6, the Bot rejects every BUY
without both valid headers before order processing. The referenced intent is
claimed with the signed one-shot nonce, so a replay under a different dedupe key
is refused. SELL keeps the headers optional and remains available for exposure
reduction.

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

## Idempotency

Five layers now: two on the sender, three on the receiver.

**Sender (platform):**

1. **Order intent** — a row in `order_intents`, UNIQUE on
   `(deployment_id, dedupe_key)`, written BEFORE delivery and resolved after.
   `INSERT … ON CONFLICT DO NOTHING RETURNING` makes the database the
   authority, so two processes racing on the same bar cannot both proceed, and
   "already delivered" is distinguishable from "attempted and failed"
   (`BE-13`, `BE-16`).
2. **Emitter lease** — one row with a TTL. A process that does not hold it
   opens no websocket and emits nothing (`X-06`, `BE-18`).

**Receiver (bot):**

3. **Caller key** — `caller:<botId>:<symbol>:<side>:<dedupe_key>`, held 120 s
   in memory and in a `WebhookReceipt` row. Applies only when the sender
   supplied a `dedupe_key`.
4. **Trade key** — `trade:<botId>:<symbol>:<side>[:<exit_leg>]`, held 45 s,
   source-independent, so it catches a duplicate arriving from the other
   sender. **Exits only.** It used to apply to entries too, so a bot whose
   `maxEntryOrders` legitimately permits several positions in one pair could
   not open a second within 45 seconds — and the response was
   `ignored_duplicate` with HTTP 200, so the sender believed an order had been
   placed when none had. A scale-in is not a duplicate (`BOT-027`).

5. **Shariah authorisation nonce** (v5) — `shariah_nonce`, claimed durably as
   `StrategyOrderIntent.authorizationNonceHash`, which is UNIQUE. This is the
   only layer a replayer cannot route around by choosing a new `dedupe_key`,
   because it is not keyed by anything the sender of the replay controls: the
   nonce is inside the Platform's signature. Applies to **entries under
   enforcement only** — a SELL, the manual HMAC channel, and everything admitted
   while enforcement is off all write null, and nulls do not collide.

   Claiming it and writing the durable intent are the **same insert**, so there
   is no window where an authorisation has been spent but no recoverable intent
   exists, and cleanup cannot remove the evidence while the order it authorised
   is still on file. Recovery is distinguished from replay by the intent
   identity: the same `dedupe_key` derives the same `sourceKey` and resolves to
   the intent already on file, so a legitimate redelivery never needs a second
   authorisation. A different one is a replay, refused with
   `SHARIAH_EVIDENCE_REPLAYED` (HTTP 409, outcome `shariah_blocked`).

   The 120 s `SHARIAH_EVIDENCE_MAX_AGE_MS` window stays, unchanged, as
   defence-in-depth and a bounded retention horizon — not as the replay defence
   it was being asked to be before v5.

**Exchange:** every order carries a deterministic `newClientOrderId` derived
from the logical order's dedupe key, so a retry of the same logical order
collides at Binance rather than duplicating, and an order that succeeded but
threw locally can be found again (`BOT-007`).

## What changed in v1, and why

Each of these was a live defect. They are recorded in
[REMEDIATION-LEDGER.md](REMEDIATION-LEDGER.md) with their commits.

| Id | Was | Now |
|---|---|---|
| `X-01` | `sell_percent` had to be `< 100`. The sender clamps to 100 whenever `rrTp1Size + rrTp2Size >= 100` — a 50/50 take-profit split makes the TP2 leg exactly 100 — so that leg was a terminal 400: the take-profit never reached the exchange while the platform marked the tier done. | The bound is `<= 100`, and the receiver treats exactly 100 as the full close it is. The sender no longer emits it: a tier taking 100 % of the remainder resets the position and omits the field. Accepting 100 remains the fail-safe for an un-updated sender. |
| `X-02` | `dedupe_key` embedded a bar index the two senders computed differently — `floor(epoch_ms / interval_ms)` here (~1.9e6 for a 15m bar), chart-relative `bar_index` in Pine (a few thousand). The comment asserting byte-identity was false, and cross-source duplicates were caught only by the 45-second trade key. | The key is `<L or X>-<barOpenTimeMs>[-<exitLeg>]`. Bar open time is the one quantity both senders read identically. Legacy keys still validate, so an un-updated sender is not locked out during a rollout. |
| `X-03` | Reconciliation consumed only `"flat"` from a two-state report. | A receiver-reported `long` against a locally-flat deployment PAUSES the deployment and records why. It is not adopted: the platform does not know the entry price, and inventing one would put real money behind a guess. |
| `X-12` | Three outcomes shared HTTP 200 and the sender's success test was `res.ok`. | Every outcome answers three questions — did an order reach the exchange, may the sender advance its state, what HTTP status — and the outcomes that placed no order answer **409**, so a sender that ignores the body still fails safe. |
| `BE-12` | The 3Commas payload carries no dedupe key, and the retry loop retried a client-side timeout that may have succeeded. | `deliver` takes `idempotent`; a payload with no key gets one attempt instead of four. |
| `BE-20` | The SELL base quantity was the original notional divided by the EXIT price, through a ternary whose branches were identical. | Computed from the ENTRY price and reduced by the take-profit tiers already taken. |

## Response

The receiver reports one of five outcomes. `orderPlaced`,
`mayAdvanceLocalState` and `httpStatusFor` in the contract module are the
authority on what each one means.

| `status` | Order placed? | Sender may advance state? | HTTP |
|---|---|---|---|
| `ok` | **yes** | yes | 200 |
| `ignored_duplicate` | no — but the ORIGINAL did | yes | 200 |
| `ignored_stale_sell` | **no, and the receiver is still long** | **no** | 409 |
| `halted` | no — the operator halted trading | **no** | 409 |
| `risk_blocked` | no — a risk limit refused it | **no** | 409 |

Other statuses: 400 validation, 401 bad secret, 404 bot missing or inactive,
422 the bot's own configuration refused the action, 503 upstream exchange
failure.

## Verifying a change to this contract

Both repositories carry a contract test that mirrors the other side:

- `platform/backend/tests/webhookContract.test.ts`
- `bot:backend/tests/webhookContract.test.ts` in the bot repository

Change the contract in both, and in this document, in one commit. Both suites
also assert that `emittablePayloads()` — the executable definition of "every
payload the sender can produce" — round-trips through the validator, and the bot
suite additionally asserts that the shared validator and the route's zod schema
agree on what to REJECT. Two validators that drift would let the contract test
pass while the running server refused traffic.
