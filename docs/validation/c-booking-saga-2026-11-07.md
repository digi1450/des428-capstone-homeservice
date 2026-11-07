# C Booking-orchestrated saga — recorded validation, 7 November 2026

Branch `feat/c-booking-saga` (stacked on `feat/c-monolith-consumers`). Commands and results actually observed. Node v22.23.4, in-memory SQLite. Payments is a contract-faithful fake (`test/booking-saga.test.js`) or a local HTTP fixture reached through A's real `createPaymentsClient` (`test/booking-saga-http.test.js`) — **not** the Payments service, whose internal endpoints are not mounted.

| Check | Command | Result |
|---|---|---|
| Monolith suite incl. both saga test files | `node --test` in `bangkok-homeservice` | 112 pass, 0 fail (103 before; existing tests unchanged after extracting `reserveBooking`) |
| Saga cases (fake Payments behind A's adapter) | `node --test test/booking-saga.test.js` | 8 subtests pass |
| Saga over real HTTP client + fixture | `node --test test/booking-saga-http.test.js` | 1 subtest pass |
| Demo | `node tests/integration/c-saga-demo.mjs` | output below |
| Regression (real PostgreSQL 16.15 / RabbitMQ 3.12.1) | the three C end-to-end tests | 6 / 4 / 4 pass |
| Contracts, build | `npm --prefix contracts test`; `npx next build` | 0 fail; build OK |

Saga cases observed:

1. Not configured: a gateway booking keeps the inherited flow (local SQLite intent, no saga row).
2. Success: 201 with the Payments intent; saga `COMPLETED`; exactly one `booking.status_changed` written at finalize; no SQLite intent. A retry with the same key returned an identical body with no second saga or create call. The same key with a different body returned 409.
3. Timeout: 503 `BOOKING_PENDING` with `Retry-After: 2`; the saga stayed `INTENT_CREATE_PENDING`; the slots stayed held and another customer got 409 for that slot. After Payments recovered, one recovery pass reached `COMPLETED`. Every attempt used the same create command, and exactly one intent exists.
4. Lost reply (Payments created the intent, the reply was lost): 503, then the retry returned 201 with the same intent id. Still one intent.
5. Payments never confirms: after the attempt limit the saga went to `COMPENSATION_PENDING`, sent one cancel with the cancel command id, then `CANCELLED`. The order row was kept as `cancelled` and its slot holds dropped to 0. A late create with the original command produced no intent. Retrying the key returned 409 `BOOKING_SETUP_FAILED`, and the slot could be booked again.
6. Cancel never confirmed: the saga reached `RECOVERY_PENDING`; the order stayed `awaiting` with its slots held; it was never reported cancelled.
7. Finalize failed after the intent existed (a SQLite trigger aborted the outbox insert): `COMPENSATION_PENDING` with reason `booking_finalization_failed`, then `CANCELLED`; the Payments intent was voided and the slots released.
8. Restart: a pending saga leased by a "dead" process was not touched while the lease was live. After it expired, a newly configured orchestrator completed it with one intent.
9. Real HTTP: a stalled fixture reply timed out (300 ms client timeout) and returned 503 pending after the fixture had committed. The retry returned 201 with that same intent, and there is still one intent.

Demo output:

```text
POST /api/bookings -> 503 BOOKING_PENDING
BEFORE (after 1st attempt)   saga=INTENT_CREATE_PENDING  order=awaiting   slot_holds=3
recovery pass 1              saga=INTENT_CREATE_PENDING  order=awaiting   slot_holds=3
recovery pass 2              saga=COMPENSATION_PENDING   order=awaiting   slot_holds=3
recovery pass 3              saga=CANCELLED              order=cancelled  slot_holds=0
recovery pass 4              saga=CANCELLED              order=cancelled  slot_holds=0
transitions: BOOKING_RESERVED->INTENT_CREATE_PENDING, INTENT_CREATE_PENDING->COMPENSATION_PENDING, COMPENSATION_PENDING->CANCELLED
retry same key -> 409 BOOKING_SETUP_FAILED
same slot booked again (COD) -> 201
```

Not run: the real Payments service (endpoints unmounted), Keycloak credentials, settlement eligibility, Compose. Timings are test settings (1 ms backoff, 300 ms timeout), not measurements.
