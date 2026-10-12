# Trading Scene — Compute Helper: Final System Guide

Date: 2026-10-11 · Research branch `finalization/nonvisual-compute-delivery-20261011` @ `2297cd6`
(accepted Compute Helper base `finalization/compute-helper-20261011` @ `894e733`)
Authority: current source and tests in the `research` repository. File paths below are relative
to `research/` unless stated.

---

## 1. Name and purpose

The product's name in the UI, CLI and code is **Trading Scene Compute Helper** (often *Compute
Helper*). There is no separate "Backtester Helper" product. The Research **Backtester** web app
refers to helpers as *Helper sessions* and *Paired standalone Compute Helpers*, and to itself as
the **Coordinator for this run**. The Platform's *Getting started* page
(`platform/frontend/app/getting-started/page.tsx`) uses the same names.

**Purpose:** let a second Mac donate spare CPU to long Research Backtester runs. It is a
**worker only**. It connects *out* to a coordinator, proves its identity, advertises capacity its
owner allows, pulls allowlisted work, runs it, and returns the result. It owns no scheduling,
lease or coordinator-administration state, and starts no coordinator listener
(`backtester/compute_helper.py`, module docstring).

## 2. Architecture

```
 Coordinator Mac (Research Backtester app)                Donating Mac (Compute Helper)
 ┌──────────────────────────────────────────┐            ┌──────────────────────────────────┐
 │ backtester/web/* (Distributed panel)     │            │ compute_helper_web/* (loopback UI)│
 │ distributed_production.py (freeze inputs │  mTLS HTTPS │ compute_helper_server.py (8877)  │
 │   → content-addressed bundle, units)     │◀──────────▶│ compute_helper.py  HelperRuntime │
 │ distributed.py  WorkCoordinator (leases, │  (helper    │   heartbeat · pull · execute ·   │
 │   attempts, acceptance)                  │  dials out) │   deliver · retain               │
 │ private_transport.py (listener, pairing) │            │ private_transport.py (client)    │
 │ storage.py RunStore (runtime/runs/<id>/) │            │ full3y1h_executor.py → Platform  │
 └──────────────────────────────────────────┘            │   backend engine via Node         │
                                                          └──────────────────────────────────┘
```

**Platform / Research relationship.** The production work type is one complete `full3y1h` replay
symbol (`full3y1h-replay-symbol-v1`). The helper's executor (`full3y1h_executor.py`) runs the
**Platform backend's own engine** (configured `--platform-backend`, `--node-bin`), so results use
canonical Platform semantics. The coordinator records the required engine/executor fingerprints
(`compatibility.execution`, work-state schema v3). A helper must reproduce them
(`execution_fingerprint.py`), or it is not offered the work and its result is refused.

## 3. Responsibilities

| Helper (donating Mac, browser page + process) | Coordinator (Research Backtester) |
|---|---|
| Owner opt-in (Helping ON/OFF), resource profile, drain, power policy | Creates runs and freezes inputs into bundles |
| Outbound mTLS connection, heartbeat, presence | Listener, pairing block, trust of helper identities |
| Advertises capacity (0 when not accepting or busy) | Offers runs, grants leases, tracks attempts |
| Downloads and verifies input bundles by content id | Accepts or refuses results by lease/attempt/compat identity |
| Executes one unit serially, keeps heartbeating | Expires stale leases; makes units retryable |
| Delivers, retries, retains results bound to their owner | Stores accepted results in `RunStore` |
| Truthful local status page | Authoritative run progress panel |

The helper's loopback page (`compute_helper_server.py`) binds `127.0.0.1` by default. It only
answers requests whose `Host` is loopback, and **refuses state-changing requests whose `Origin`
is not the helper page** (verified live this session: a cross-origin POST returned
`403 mutation origin must match the local helper page`). It has no run creation, history,
coordinator administration or listener control.

## 4. Pairing and authentication

- `identity --name` creates the helper's P-256 certificate/key. The peer id is the SHA-256 of the
  certificate DER.
- The coordinator shows a *pairing block* (address, port, fingerprint, certificate). The helper
  owner pastes it, sees the fingerprint **before** anything is trusted, then trusts it
  (`trust-coordinator`). A certificate that does not match its stated fingerprint is never
  trusted (test `q`).
- Transport is HTTPS with **mutual TLS** (`ssl.CERT_REQUIRED` on both sides, each presenting its
  identity certificate). Results are bound to the authenticated peer: *"result does not belong to
  the authenticated peer"* is refused.
- Untrusted or revoked identities cannot become active helpers (test `i`).

## 5. Helping ON/OFF, resource profile, drain

- **Helping OFF:** advertises unavailable and accepts no new work (test `b`). Already-finished
  results are still delivered: *"Delivery does not depend on Helping/Drain: both mean finish what
  you have."*
- **Helping ON:** capacity comes from the adaptive resource controller (test `c`).
- **Profiles:** `light`, `balanced`, `maximum`, `custom` → `RemoteResourceConfig` (CPU load
  target/ceiling, memory pressure target/ceiling, pause when the user is active or the owner runs
  local work, automatic throttle/resume, sampling 10 s). Mapping is deterministic (test `h`).
- **Execution concurrency is 1** (`MAX_EXECUTION_CONCURRENCY`): the production executor is serial
  and may run up to its 3 h timeout. Work that cannot start immediately is never reserved.
- **Drain:** non-preemptive. The current job finishes, and no new work is advertised or pulled
  (test `c4e`: a drain saved mid-cycle stops the very next pull).

## 6. Connection, heartbeat, presence and timeout — HELPER-PRESENCE

- Heartbeat every **15 s** (`DEFAULT_HEARTBEAT_INTERVAL_SECONDS`). On failure, bounded
  exponential backoff **2 s → 60 s**, never a busy loop (test `e`). Trusting a coordinator retests
  immediately instead of waiting out backoff (test `p`).
- **Connection states:** `connecting`, `connected`, `offline`. A failure only flips to `offline`
  after **45 s** without success (`PRESENCE_OFFLINE_TIMEOUT_SECONDS`); before that it is
  `connecting`. With no coordinator configured the state is `offline` with
  `lastError = "no coordinator is configured"` (verified live: Helping ON, still offline,
  capacity 0, no claimed connection).
- **During a job** a separate thread keeps sending authenticated heartbeats with
  `accepting=false, capacity=0` ("alive, but do not invite another reservation"). A transient
  presence failure never pre-empts the job; the lease covers the executor timeout.

**HELPER-PRESENCE (truthful presence, `43bc9fa`, `399723f`).** Two defects made the status page lie:
(1) during a long job, status stopped reflecting heartbeat health, so an unreachable coordinator
still showed *connected*; (2) after the owner re-pointed the helper to a different coordinator (or
the same peer at a different host/port), a heartbeat answered by the *old* endpoint could mark the
*new* one connected. Now in-job heartbeat outcomes update presence, and every presence update is
bound to the exact **(host, port, peer id)** that answered. A reply from a previous endpoint proves
nothing about the current one (tests `c4d6`, `c4d7`, `c4d8`). Status never advertises a helper
that cannot actually run work (test `l`), and reports whether the coordinator is trusted (test
`m`).

## 7. Active-work discovery and assignment

When connected, accepting and owing no result, the helper's work phase discovers runs the
coordinator publishes. It **auto-joins** a compatible offer (registers a session, obtains the
run's input bundles), pulls one assignment (`WorkAssignment`: run, unit, attempt, lease, worker,
session, lease expiry, input content id, compatibility hash and payload), verifies the bundle by
content id, and executes. After about one minute of idle heartbeats (4 cycles) an auto-joined run
is released so another can be discovered. A runtime that proves unusable is de-advertised for
5 minutes and then re-probed once.

**Lease:** production lease = executor timeout (3 h) + 15 min grace. A result is accepted after the
former 300 s boundary (test `c5`).

## 8. Job lifecycle and result acceptance

```
offered → joined → leased (attempt) → executing (heartbeats) → result → submit
   → coordinator: accepted | duplicate | stale | rejected | released(retryable)
```

The coordinator's `WorkCoordinator.submit` (`distributed.py`) expires old leases, then checks: the
session is registered, the result belongs to the authenticated peer, the unit and attempt exist,
the lease id matches, the input content id matches, the compatibility identity matches, and the
attempt is still `leased`. Outcomes: *logical result accepted*; *duplicate* (same accepted result
re-sent); *stale* (the unit already has an accepted result, or the attempt is no longer leased);
*rejected* (mismatch); *released* (a failed/yielded/cancelled attempt makes the unit retryable).
Accepted results are stored in the coordinator's `RunStore` (`runtime/runs/<run-id>/…`).
Bounded sizes: payload 256 KiB, result 1 MiB, artifacts 16 MiB.

## 9. Delivery failure, retry and retention — HELPER-DELIVERY / OWNER

`_deliver` submits one finished result and classifies the outcome:

- **Upload never got an answer** (network, TLS, broken HTTP, bad JSON: `RESULT_RETRY_ERRORS`): the
  exact result archive is **retained on disk** (`retained/<uuid5(attemptId)>.tar` + `.json`
  metadata, mode 0600, fsync, atomic rename). The entry stays owed, and it is re-sent on backoff
  (2 s × 2ⁿ, capped at 60 s), at most **20 attempts** (`MAX_RESULT_SUBMIT_ATTEMPTS`, roughly the
  lease grace). After exhaustion the slot is released, and the archive remains with a
  `lastError` naming its path.
- **Coordinator answered and refused** (stale lease, oversize): final. The archive is retained as
  evidence and not retried.
- **Accepted:** the retained copy is removed and the slot released.

Retained archives are **evidence, never automatically reassigned to a new lease**, and survive
restarts (test `c4d2`). Restart never claims a delivery or reuses a lease.

**HELPER-DELIVERY/OWNER (`33f5547`, `fc413c3`).** Previously, any failure other than a
coordinator refusal escaped the cycle with the result in hand: *"up to three hours of finished
work was silently thrown away by one dropped connection."* Now results are kept and re-sent, and
each retained result records its **original owner** (coordinator host, port, peer id, lease,
attempt, session). That owner is captured **before** the job can change settings (test `c4d5`).

## 10. Replacement connection — HELPER-DELIVERY-REPOINT (`f7d9720`)

If the owner re-points the helper to another coordinator while a result is owed, two rules apply:
(1) the owed result is **never sent to the replacement** (test `c4d3`): it goes to its original
owner via a client built for that origin; (2) delivery to the original owner happens
**independently of whether the replacement answers heartbeats** (test `c4d9`). `tick()` calls
`_retry_undelivered` before, and regardless of, the new coordinator's heartbeat cycle. The defect
was that retries were gated on the replacement's heartbeat, so an offline replacement silently
stalled delivery of work owed to the original coordinator.

## 11. Revocation and storage failure — HELPER-REVOKED-STORAGE (`2297cd6`)

If the original owner is no longer trusted (revoked) or unknown, the result is **never sent to it**.
Instead it is retained locally and the slot released, with the status *"a finished result is
retained locally; its original coordinator is unknown or no longer trusted"* (test `c4d10`).

**Defect:** the revoked-owner path assumed the on-disk archive existed, even when an earlier
retention had failed because the disk was full. Retiring the entry then discarded the **only
copy** (the in-memory one). **Correction:** retain *before* retiring. If storage fails, keep the
in-memory result **and** the serial slot, set a truthful error (*"owner unavailable and local
retention failed: …"*), and retry retention after 60 s. Never send to the revoked peer. The same
retain-or-keep rule applies to the network-failure and refusal paths (tests `c4d4`, `c4d11`; an
independent disk-full / revoke / storage-recovery reproduction passed in the nonvisual fresh
review).

## 12. Truthful UI status

`GET /api/helper/status` (rendered by `compute_helper_web/app.mjs`) reports: `helping`,
`profile`, `connectionState`, `activity` (`idle` / `helping` / `delivering`), `draining`,
`lastSeenAt`, `currentJobs`, `undeliveredResults`, `retainedResultCount`, `advertisedCapacity`,
`executionConcurrency`, `activeAssignments`, coordinator and `coordinatorTrusted`, identity,
production executor (configured, advertising, last error, staged closure), `lastError`,
`savedConfigError` and the resource controller state. Controls keep answering while a job runs
(test `c4b`). A corrupt saved configuration never resets a live helper (test `n2`).

The coordinator's Distributed panel (`backtester/web/distributed*.mjs`) is authoritative for run
progress: accepted units, active assignments, pending/retryable work, helper sessions and accepted
local/remote contribution. It explicitly avoids claiming restarts or connections it cannot know
(`a991ad4`).

## 13. Security boundaries

- Loopback-only helper UI, strict Host check, same-origin mutations, CSP `default-src 'self'`,
  no-store JSON.
- mTLS with explicit fingerprint-confirmed trust; results bound to the authenticated peer.
- Only allowlisted production work types; inputs are content-addressed and verified; bounded
  payload, result and artifact sizes.
- The helper holds no exchange credentials and places no orders. It runs backtest replay only.

## 14. Storage

Helper root `~/.trading-scene-compute-helper` (or `$COMPUTE_HELPER_ROOT` / `--root`): config
(`HelperConfigStore`, schema v2), identity certificate/key, trust store, verified input bundles
(bounded set of content ids), `retained/` result archives. Coordinator: `runtime/runs/<run-id>/`
with `work-state.json` (schema v3) and accepted results.

## 15. Operating it

```
scripts/compute-helper.sh identity --name "Studio Mac"           # once
scripts/compute-helper.sh trust-coordinator --certificate coord.pem
scripts/compute-helper.sh configure --coordinator-host … --coordinator-port … \
    --coordinator-peer-id … --profile balanced --helping on
scripts/compute-helper.sh set-execution --research-root … --platform-backend … --node-bin …
scripts/compute-helper.sh run          # then open http://127.0.0.1:8877
scripts/assemble-compute-helper.sh /path/to/staging   # standalone package for a donating Mac
```

## 16. Test coverage

`tests/test_backtester_compute_helper.py` (37 tests: a–q, c4b–c4d11, c5, p2; run this session
**37/37 OK**), `tests/test_backtester_compute_helper_staged.py`,
`tests/test_backtester_distributed_operator.py`, `tests/test_backtester_distributed_production.py`,
`tests/compute_helper_ui.test.mjs` (run this session **16/16**),
`tests/backtester_distributed_ui.test.mjs`. Full Research: 224/224 Python, 101/101 Node (inherited
from the nonvisual closure; branch unchanged since).

## 17. Failure modes (summary)

| Failure | Behaviour |
|---|---|
| Coordinator unreachable | `connecting` → `offline` after 45 s; backoff ≤ 60 s |
| Coordinator re-pointed mid-job | presence bound to the new endpoint only; owed result goes to the original owner |
| Upload lost in transit | retained on disk, re-sent ≤ 20 times, then kept as evidence |
| Coordinator refuses (stale lease) | final; archive kept as evidence |
| Original owner revoked | never sent; retained; slot freed only once a disk copy exists |
| Disk full during retention | in-memory result and slot kept; truthful error; retry in 60 s |
| Executor unusable | de-advertised for 5 min, then re-probed once |
| Helper restart | retained archives survive; no delivery claimed, no lease reused |

## 18. Limitations

- One production work type (`full3y1h` replay symbol, topN=1); one job at a time per helper.
- Retained-but-undeliverable results need operator action. They are evidence and are not
  re-leased automatically.
- macOS resource sampling (`MacOSResourceSampler`); other platforms are not a target.
- Pairing is manual by design (fingerprint confirmation).

## 19. Walkthroughs (illustrative)

**Successful job.** The owner on Mac B runs the helper, pastes Mac A's pairing block, confirms the
fingerprint, sets profile *balanced*, Helping ON. Status: `connecting` → `connected`, capacity 1.
Mac A starts a `full3y1h` run; the helper auto-joins, pulls `unit-ETHUSDT` (lease 3 h 15 min),
verifies the bundle, and executes via the Platform engine while heartbeating `capacity=0`. Status
shows the current job and `helping`. The result is submitted; the coordinator checks peer, lease,
content id and compatibility → `accepted`. The helper removes nothing (nothing was retained),
frees the slot, and pulls the next unit.

**Failed delivery and recovery.** The job finishes while Mac A's Wi-Fi drops. `submit_result`
raises an `OSError` → the archive is written to `retained/…tar` with its owner. Status shows
`activity: delivering`, `undeliveredResults: 1`, *"has not reached the coordinator yet (attempt
1); it is kept and re-sent"*. The owner re-points Mac B to coordinator C during the outage: C's
heartbeat state drives presence, but the owed result keeps retrying to A only. A returns on attempt
4 → `accepted` → the retained copy is deleted and the slot freed. If instead A's certificate had
been revoked, the result would never be sent: it stays in `retained/` with a status line saying so.
If the disk had also been full, the result would stay in memory with the slot held until
retention succeeds.
