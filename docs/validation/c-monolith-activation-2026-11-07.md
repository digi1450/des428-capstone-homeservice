# C monolith activation — recorded validation, 7 November 2026

> Historical 7 November evidence follows. The 8 November main-sync and fixture correction below supersede statements that A has no activation adapter/UI yet.

Branch `feat/c-monolith-activation` from `main` at `b4d0b46`. These are the commands and results actually observed. Node v22.23.4, better-sqlite3, no network. Payments is a fake behind A's real Booking adapter, plus an `activate` method with the agreed shape (A's real method is not written yet).

| Check | Command | Result |
|---|---|---|
| Activation delivery | `node --test test/booking-saga-activation.test.js` | 12 pass (after A's review fixes) |
| Upgrade path | `node --test test/startup-upgrade.test.js` | 5 pass |
| Monolith suite | `npm test` in `bangkok-homeservice` | 145 pass, 0 fail (142 before the review fixes) |
| A's exporter | `python3 -m pytest -q` in `tools/data-migration` | 8 pass |
| Real old file | DB created and written by the code at `b4d0b46` (worktree), then started twice with this branch | fingerprint `6c9ccb3f…` → `7bce7dfa…`; first start `"action":"upgraded"`, second `"preserved"`; orders 1 → 1, customers 3 → 3; the old COMPLETED saga got one `pending` activation `activate:saga-main` |

Activation cases observed:

1. COMPLETED writes a `pending` activation in the same transaction. With no `activate` on the adapter nothing is delivered; once it is present, recovery delivers it and `paymentSetupFor` turns `ready`.
2. A fresh booking is activated right after the 201. Replaying the 201 does not deliver again, and the body is unchanged.
3. A timeout, then a lost reply, then success: one stable key, 3 calls, the saga stays COMPLETED and the slots are kept. No attention row.
4. 5 unknown outcomes: still `pending` (not ready), exactly one `activation_unconfirmed` attention row.
5. Coded `PAYMENT_SETUP_CANCELLED`: `blocked`, one attention row, not retried into success afterwards.
6. Uncoded 409, whether direct or as an unknown outcome with upstream 409: `reconcile`, one `activation_conflict` row, never ready, slots kept.
7. Lease: two `activate()` calls and a `recoverOnce()` at the same time make one delivery.
8. Restart: an activation leased by a dead worker (expired lease) is delivered by a new runtime with the same key.

Upgrade cases observed: the previous fingerprint equals main's. An old versioned or unversioned file is upgraded with every row preserved and only the intent-bearing COMPLETED saga backfilled, then "preserved". An unknown marker, an extra table or a missing index on the old schema still throws `SQLITE_SCHEMA_MISMATCH` and creates nothing. An injected backfill failure rolls back the new table and keeps the old marker, and the next start upgrades.

Not done here: A's adapter/client `activate` and coded-error parsing, the payment_setup UI, live wiring, and an end-to-end run against the real participant over HTTP (the route is A's).

## Review fixes (8 November 2026, A's review of `496d0a6`)

- **P1, stale lease:** every claim now gets its own token (`<owner>:<uuid>`, unique even inside one process), and the runtime is captured at claim time. Every result, retry/backoff, attention and release write requires `locked_by = token`. A late result from an expired claim is discarded and logged, and it does not release the newer claim's lease.
- **P2, fence:** `blocked` now requires HTTP 409 (`statusCode` or `upstreamStatus`) **and** the code `PAYMENT_SETUP_CANCELLED`. A code on a 5xx or unknown error stays `pending` and is retried.
- New regressions, observed failing on the previous commit (8 pass / 4 fail) and passing now (12 pass):
  1. Worker A's late success after worker B claimed the activation is discarded, and B's lease is kept. B's coded 409 then gives `blocked`, never `ready`.
  2. A late unknown, conflict or fence from A after B's claim leaves attempts unchanged and writes no attention row. B's success then gives `activated`.
  3. A coded 503 or a coded unknown stays `pending` (attempts 1, no attention). A coded 409, direct or as upstream 409, gives `blocked`.

## A main-sync and test compatibility correction — 8 November 2026

The lead authorized fixing PR #29 directly. C head `652f152` was synchronized with main `393d940` by a normal merge (no history rewrite). No production saga, lease, migration, auth or caller behavior was changed by this correction.

The original `test/booking-saga.test.js` fake only implemented create/query/cancel. Main's real Booking adapter now exposes `activate`, so the fake was incomplete and recovery counts included activation work. On the synchronized source before correction, its timeout and restart child tests failed (9 reported tests: 6 pass / 3 fail, counting the failed parent).

The fixture now implements activation for an existing created intent, checks the saved activation key and records activation calls. Timeout/restart assertions verify the target saga completes, becomes ready, activates once, and retains one intent/the original create key. The live-lease case checks that target state/owner and delivery count are unchanged and its slots remain held. The test expires that lease explicitly instead of relying on a 100 ms scheduling window. No runtime guard or assertion about financial effects was removed to make the suite green.

Observed on copied source in Node 20 Docker:

- Full monolith `npm test`: **178 pass, 0 fail/skipped**, including activation stale-claim/classification, exact-schema upgrade and existing caller tests.
- Additional temporary integration probe: **5 pass, 0 fail/skipped** against an isolated PostgreSQL 16 database. It adapts the existing payment-views boundary fixture to use C's actual `paymentSetupFor` and `activate`: the initial activation has an explicit unknown outcome, readiness remains pending, then C → A adapter/client → Payments HTTP/participant commits activation and readiness becomes ready. Simulation/replay yields one charge; Booking still awaits its paid event; wallet provisioning retains the pending/history behavior.

The additional probe changed only a temporary source copy, not the committed integration fixture; its authentication remains a test double. This is not Keycloak, broker/worker/full-stack or live-cutover evidence. No browser test or image rebuild was repeated for the fixture/documentation-only correction. All checks used isolated in-memory SQLite or disposable PG tmpfs, no published ports, and no useful data. `git diff --check` passed.
