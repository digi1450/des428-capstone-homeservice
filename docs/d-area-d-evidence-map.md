# Area D — requirement, implementation and evidence map

Updated 15 November 2026 against `main` at `4c0929a` (after merged PR #84).

This is an evidence map for D's closure review. It does not add a retry layer,
change another owner's runtime code, or turn a fixture result into real-service
evidence. Read it with [the D implementation handoff](d-survive-failure-handoff.md),
[the migration acceptance plan](migration-handoff.md) and the linked validation
records.

## D scope

D is accountable for HTTP timeout/retry/idempotency behavior, the three fault
scenarios, and race/concurrency evidence across the A-owned services, while
coordinating stable command/event semantics with C. The selected migration
acceptance plan also names restart recovery and failed-compensation retry.

## Requirement-to-evidence map

| Requirement / failure | Implementation and evidence | What the evidence proves | Boundary / remaining limit |
| --- | --- | --- | --- |
| Reply is lost after the remote write committed | `bangkok-homeservice/test/booking-saga-http.test.js`; PR [#47](https://github.com/digi1450/des428-capstone-homeservice/pull/47) | The HTTP fixture creates an intent before dropping the reply. The Booking saga returns pending, then retries the same create command and receives the same intent; the fixture records one operation for that key. | The fixture's Payments store is a JavaScript `Map`, not the real Payments PostgreSQL service. This is contract/client/adapter/saga evidence, not a real-service outage result. |
| Reply arrives after the client timeout | Same HTTP test: fixture delay is 600 ms and client timeout is 300 ms | The first call times out while the simulated write already exists; recovery with the same command returns the original intent and does not create another one. | The timing is deliberately simulated. It is not a latency measurement of the deployed Payments service. |
| Payments returns a temporary failure | Same HTTP test: `failOnce` returns one HTTP 500, then permits the retry | The pending saga keeps the booking and stable create command; retry resolves to one intent. | This particular test is one failed response, not a multi-request outage window. Do not describe it as a sustained service outage. |
| A real service is unavailable for a window; accepted work recovers | E's actual 16-service Task 5 acceptance, [PR #61](https://github.com/digi1450/des428-capstone-homeservice/pull/61), [handoff](e-task5-fault-recovery-handoff.md), [dated validation](validation/e-task5-fault-recovery-2026-11-10.md) | Payments is stopped while a customer cancellation is pending (HTTP 202); holds remain. The actual standalone Next process is killed/restarted while Payments is still down. After Payments returns, autonomous recovery uses the original operation/command/trace and only releases holds after a safe acknowledgement. | This is real outage/restart evidence for Booking financial cancellation/finalization. It is not the same operation as first-time payment-intent creation. |
| Failed/unknown compensation must not be reported as cancelled | `booking-saga.test.js` and the durable compensation state machine in `booking/saga.js`; PR #47 | An unconfirmed cancel/fence remains recoverable and is not treated as a successful cancellation; slots are not released before the fence is confirmed. | Unit/contract-faithful fake evidence. It does not by itself prove a real Payments outage during create compensation. |
| Activation response is unknown | `booking-saga-activation.test.js`; shared retry policy in PR [#50](https://github.com/digi1450/des428-capstone-homeservice/pull/50) | Lost reply/timeout keeps activation pending and retries the same activation command; escalation is count-based and does not mark the booking ready. | Adapter/payment outcomes are test doubles in this suite. PR #50 adds deterministic `random` injection and tests the shared delay bounds. |
| Crash/redelivery and restart recovery | E Task 5 [PR #61](https://github.com/digi1450/des428-capstone-homeservice/pull/61) | Actual relay/consumer child processes are killed at broker-confirm, pre-commit and post-commit/pre-ack checkpoints; normal workers restart. A pending cancellation also survives a real Next process restart during Payments outage. | These are named, test-controlled checkpoints in a disposable 16-service stack, not arbitrary PID 1 timing guarantees. They close E Task 5 evidence; do not duplicate them as missing D work. |
| Bid accepted while a stale provider request attempts to place another bid | `bid-stale-read.test.js` and `bidding/repository.js:insertBid`; PR #47 | A parent connection reads the job as open; a worker uses a second real SQLite connection to accept and commit; the resumed stale bid is rejected with 409. One accepted order remains and no late pending bid is inserted. | The deterministic two-connection regression is the race evidence. The older `Promise.all` route test alone is not a deterministic interleaving proof. |
| Financial completion/cancellation/webhook races | Joint C/D real-HTTP acceptance, [PR #81](https://github.com/digi1450/des428-capstone-homeservice/pull/81), [dated validation](validation/c-financial-race-acceptance-2026-11-12.md) | Strengthened suite: 14 passed, 0 failed, 0 skipped. Across new and legacy booking origins it checks webhook × cancellation, completion × cancellation, duplicate/distinct webhook × cancellation, webhook × completion plus same-key retry, and same cancellation key ×3. The Booking cancel × provider start interleaving also checks slot/transition outcomes. The Payments consistency checker reported 0 violations. | Payments calls use real HTTP routes and disposable PostgreSQL with real C operations/locks. Auth is a fixture verifier. Booking cancel × start is interleaved in one Node process, not two independently racing SQLite connections. No process crash is part of #81; PR #61 covers selected crashes/recovery. |

## Retry policy currently present in `main`

The shared helper is `bangkok-homeservice/lib/modules/booking/backoff.js`,
merged by PR #50 and used by saga steps, activation delivery and Booking financial
work:

```text
capped = min(maxMs, baseMs * 2^(attempts - 1))
delay  = floor(capped * (0.5 + random() * 0.5))
```

This is equal jitter: 50–100% of the capped exponential delay. The same durable
command/idempotency key is reused on retry. The HTTP Payments client does not add
its own retry loop; avoid nested retry amplification around C's recovery.

Current source defaults (engineering defaults, not a separately recorded lecturer
mandate):

| Path | Current defaults / behavior |
| --- | --- |
| Payments HTTP client | `timeoutMs = 2000` |
| Booking provisioning saga | `baseBackoffMs = 1000`, `maxBackoffMs = 30000`; `maxCreateAttempts = 5`, `maxCancelAttempts = 5`; lease 15000 ms; pending response `Retry-After: 2` seconds |
| Saga recovery scheduler | `startSagaRecovery({ intervalMs = 2000 })`; drives due persisted work |
| Activation delivery | Same shared 1000/30000 ms defaults; `activateEscalateAfter = 5` is a count-based attention threshold, not a change to the booking's completion state |
| Booking financial finalization | 1000/30000 ms backoff defaults, 15000 ms lease and `escalateAfter = 5`; unknown work stays pending with the same key, while attention is recorded at the threshold (401/403 is recorded immediately) |

The policy bounds are covered by `booking-backoff.test.js` (PR #50). The suite
checks deterministic low/high random inputs, cap-before-jitter and activation's
use of the same helper. Do not present the current defaults as a measured optimal
retry budget; D should confirm them with A/C and record the rationale/acceptance.

## Closure decisions

1. **Do not reimplement #47 or #50.** Their code is already merged. Do not replace
   C's `retryDelay()` helper with a second D helper or add retries inside the HTTP
   client.
2. **Use #81 as the current D/C financial-race evidence.** It supersedes the
   earlier status statement that the joint race acceptance was still pending.
3. **Keep the three HTTP fixture fault results labelled as fixture evidence.**
   The one-shot 500 is not a sustained outage. #61 supplies actual service-outage
   and process-restart evidence for cancellation/finalization, but not for the
   first-time create-intent path.
4. **One possible rubric-specific gap remains:** if the lecturer expects the third
   fault to be a *real Payments outage window during initial gateway booking /
   create-intent*, current records do not demonstrate that exact path. The safe
   follow-up is a disposable real-stack test: make Payments unavailable while a
   gateway booking request is pending, verify the same booking and
   `create_command_id` stay durable with slot holds retained, restore Payments,
   then verify recovery produces exactly one intent and one booking. Coordinate
   A (transport/composition), B (real service credentials), C (participant/recovery)
   and E (disposable stack/telemetry) before implementing or claiming this.
5. **Confirm the retry budgets.** Review the current defaults above with A/C and
   either accept them as D's configured policy or record the agreed changes and
   their tests. Do not silently tune production values from a unit-test fixture.

## Current D completion statement

The merged implementation covers conditional bid insertion, deterministic
two-connection stale-read rejection, equal-jitter retry shared by saga/activation/
financial work, and the three simulated HTTP fault cases. Additional real-stack
evidence covers selected service outage, crash/redelivery/restart, and the
joint financial races. The final closure item is not another local edit to
`saga.js`: it is to confirm the numeric retry budgets and decide whether the
course's third fault specifically requires a real Payments outage during
initial booking creation. Keep that limit visible until such a run exists.
