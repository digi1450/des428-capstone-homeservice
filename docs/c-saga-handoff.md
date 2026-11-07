# Area C saga handoff — Booking-orchestrated provisioning (DRAFT v1)

Recorded 7 November 2026. Owner: C (Peerawit). Implements the lead-selected decision in [migration handoff §5](migration-handoff.md#5-booking-orchestration-and-compensation): Booking in the monolith orchestrates gateway booking provisioning; Payments & Wallet is a participant. Evidence: [validation record](validation/c-booking-saga-2026-11-07.md).

**Status:** implemented and tested in the monolith against a contract-faithful fake and an HTTP fixture through A's real client. **Not active:** `POST /api/bookings` uses the saga only after `configureBookingSaga()` is called, and nothing calls it yet because the Payments internal endpoints are unmounted and B's service credentials don't exist. COD bookings never enter the saga.

## Steps and compensation

| Step | Where | Compensation |
|---|---|---|
| T1 reserve order + items + slot holds + `booking_sagas` row (`INTENT_CREATE_PENDING`) | one IMMEDIATE SQLite transaction | cancel order + release slot holds, keeping the rows |
| Remote: create payment intent with stable `create_command_id` | Payments (no SQLite transaction open) | `cancel-by-command` with a different stable `cancel_command_id` (fence: the create can never commit later) |
| T2 finalize: `COMPLETED`, store intent, write the deferred `booking.status_changed` (awaiting) outbox event | one SQLite transaction | n/a (last step) |

Compensation runs in reverse order: **first** the Payments fence must be confirmed, **then** the local cancel and slot release.

## State machine (`booking_sagas.state`, history in `booking_saga_transitions`)

```
BOOKING_RESERVED ─▶ INTENT_CREATE_PENDING ──created──▶ COMPLETED
                       │  unknown outcome: retry SAME command (backoff)
                       │  N unconfirmed attempts, or finalize failed
                       ▼
                    COMPENSATION_PENDING ──cancel confirmed──▶ CANCELLED
                       │  cancel unconfirmed N times
                       ▼
                    RECOVERY_PENDING   (manual attention; slots stay held)
```

Rules:
- **Unknown is not failure.** Timeouts, lost replies and every HTTP error from A's client are `PaymentOutcomeUnknownError`. The saga keeps its slots and command id and retries the same command, because Payments replays the stored result.
- **Slots are released only after a confirmed fence.** A compensation that cannot be confirmed becomes `RECOVERY_PENDING`. It is never falsely `CANCELLED`.
- **One saga per `(customer, Idempotency-Key)`.** A retry resumes the saga. A completed saga replays the original 201 `{order, otp, payment_intent}`. The same key with a different body returns 409. Without a key, each request gets its own saga.
- **Lease per saga** (`locked_by/locked_until`), so two workers never drive the same saga at once.
- **The booking stays `awaiting`** in the public API. Saga states are internal. The `awaiting` event is published only when provisioning completes.

Foreground responses: `COMPLETED` returns 201 as before. Pending returns **503** with `Retry-After` and `{ code: "BOOKING_PENDING", order_id }`. `CANCELLED` returns **409** with `{ code: "BOOKING_SETUP_FAILED" }`.

Recovery: `recoverOnce()` drives every due saga one step, and `startSagaRecovery()` runs it on an interval. After a restart, a new process picks up sagas once the dead process's lease expires.

Defaults (engineering defaults, not measured): `maxCreateAttempts` 5, `maxCancelAttempts` 5, backoff 1 s doubling up to 30 s, lease 15 s, `Retry-After` 2 s. D should own the retry policy values.

## Wiring needed (A / B / D)

```js
import { createPaymentsClient } from "#lib/modules/payments/client.js";
import { createBookingPaymentsAdapter } from "#lib/modules/booking/payment-adapter.js";
import { configureBookingSaga, startSagaRecovery } from "#lib/modules/booking/saga.js";
configureBookingSaga({
  payments: createBookingPaymentsAdapter({ paymentsClient: createPaymentsClient({ baseUrl: process.env.PAYMENTS_BASE_URL }) }),
  credentials: async () => ({ token: await serviceToken() }), // B: Booking service-caller token
});
startSagaRecovery();
```

- **A:** mount `/internal/payment-intents`, `/internal/payment-operations/{id}` and `/internal/payment-intents/cancel-by-command` with durable command results and the cancel fence (C can co-write the command/fence tables). Booking detail and simulate still read the SQLite intent, so saga bookings need the coordinated caller switch.
- **B:** supply the service-caller credential. The saga never forwards end-user tokens.
- **D:** retry and timeout values. The foreground waits for one client timeout, then returns 503.
- **Settlement eligibility (`assertSettlementAllowed`)** must let a payment settle only for a `COMPLETED` saga. This needs Payments-side eligibility state written with the command result. It is not done yet.

## Activation delivery (added 7 Nov 2026)

`COMPLETED` means *provisioned*, not payable. In the same SQLite transaction that sets `COMPLETED`, the saga inserts a `booking_saga_activations` row (`pending`, key `activate:<saga_id>`). Delivery runs afterwards, outside any transaction, under its own lease: first right after the 201, then from `recoverOnce()`.

| Payments answer | Activation state | Effect |
|---|---|---|
| success (fresh or replay) | `activated` | `paymentSetupFor(orderId)` → `"ready"` |
| unknown outcome (timeout, lost reply, 5xx) | stays `pending` | same key retried with backoff; one `consistency_attention` row (`activation_unconfirmed`) after `activateEscalateAfter` attempts; the booking is never cancelled |
| validated 409 with `code: PAYMENT_SETUP_CANCELLED` | `blocked` | attention `payment_setup_cancelled`; no further delivery |
| uncoded 409 (also `PaymentOutcomeUnknownError` with `upstreamStatus` 409) | `reconcile` | attention `activation_conflict`; never treated as a fence, slots kept |

**Interface change to review with A:** the agreed text put `activation_state` / `activate_command_id` on `booking_sagas`. SQLite's `ALTER TABLE ADD COLUMN` stores a different `CREATE` text than a fresh database, so #23's exact-schema guard could never accept an upgraded file. The state therefore lives in its own table, and `lib/db/migrate.js` gains a reviewed, additive `UPGRADES` list: a file whose schema and marker are exactly the previous one (fingerprint `6c9ccb3f…`, main at `b4d0b46`) gets the new objects with the same `CREATE` text plus a backfill (`COMPLETED` sagas with an intent → `pending`), all in one IMMEDIATE transaction, then a full exact-schema check. Anything else still fails closed.

**A still needs to:** add `activate(workflow, credentials)` to the Booking payments adapter/client (`POST /internal/payment-intents/activate-by-command`, Idempotency-Key = `activateCommandId`), surface the coded 409 as `error.code === "PAYMENT_SETUP_CANCELLED"`, and show `payment_setup` from `paymentSetupFor()`. Until the adapter has `activate`, rows stay `pending` and nothing is delivered. **D:** the retry numbers are the existing saga defaults.

## Defence material

The [demo](../tests/integration/c-saga-demo.mjs) (`node tests/integration/c-saga-demo.mjs`) prints the state before and after compensation. Explaining **why** the team chose orchestration (Week 10 slides 57, 61–66) is each member's own work, based on these runs.
