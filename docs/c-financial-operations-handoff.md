# C — Payments financial operations (step 5C), handoff

Implements the C side of [the lead-selected baseline](financial-finalization-decisions.md) against [contract v1.0.0](financial-finalization-contract-handoff.md) and A's prepared router ([runtime handoff](financial-finalization-runtime-handoff.md)). Payments side only; the monolith Booking callbacks (`configureBookingFinancialAccess`) are the next C slice.

## Wiring

```js
import { createFinancialOperations } from "./src/financial/index.js";
createPaymentsRuntime({ database, authenticate, authenticateService, authenticateWebhook, createFinancialOperations });
```

`server.js` is unchanged, so the default production startup still supplies no factory (503). Activation needs B's verifiers and the coordinated switch.

## Storage — migration `005_financial_operations.sql`

- `financial_commands`
  - Key: `(caller_id, command_id)`. Kind is `completion` or `cancellation`. The table also stores the operation UUID, order, request digest and full request, state (`pending` / `ready` / `attention`) and the full v1 result.
  - `UNIQUE (kind, order_id)`: at most one completion and one cancellation per order.
  - A CHECK ties `command_id` to `complete:` / `cancel:` + `operation_id`.
  - It is separate from `payment_commands`, so provisioning and financial keys and results never alias.
- `financial_fences`
  - One row per order, written in the same transaction as a ready cancellation, with an FK to its command.
- A's importer is updated: the pin now includes 005, and both new tables are in the must-be-empty C-state guard. There is a new probe test for `financial_commands`.

## Locks (no reversed order anywhere)

1. `42803` financial command (`caller:command_id`)
2. `42802` provisioning (`caller:create_command_id`), gateway cancellation only; it is the same lock the participant takes
3. `42801` order (A's `lockOrder`, also held by `settleWebhook`)

Every decision is made after lock 3. Command, result, fence, provisioning change and money effects commit in one PostgreSQL transaction.

## Behaviour

| Situation | Result |
|---|---|
| Same caller/key/request after ready or attention | stored result replayed (`replayed: true`) |
| Same key after pending | re-evaluated under the same key (pending → ready / attention) |
| Same key, different request | coded 409 `FINANCIAL_COMMAND_CONFLICT`, stored row untouched |
| Different key, same order and kind | coded 409 `FINANCIAL_COMMAND_CONFLICT` |
| **Completion, gateway**, intent not settled | pending `awaiting_settlement` (no payout from a merely existing intent) |
| Completion, gateway, matching succeeded charge | ready `payout_credit` = amount − commission (A's `applyCompletion`, same client) |
| Completion, COD, no intent | ready `commission_owed` = commission |
| Completion after a fence or voided intent | attention `cancellation_fenced` |
| Completion after a refund, or a charge/intent contradiction | attention `settlement_contradiction` |
| Completion with wrong provisioning refs, amount or ids; COD with an intent | attention `context_mismatch` |
| Gateway intent with no provisioning row (legacy) | attention `legacy_reconciliation_required` |
| **Cancellation**, gateway, unpaid intent | ready `voided` + fence; provisioning set to `fenced` (`cancel_reason = financial_cancellation`) |
| Cancellation, gateway, settled charge | ready `refunded` (A's `applyRefund`, exactly once) + fence |
| Cancellation, gateway, create never arrived | ready `no_payment`, an absent-create provisioning fence and the order fence |
| Cancellation, COD | ready `no_payment` + fence |
| Cancellation after completion accounting | attention `completion_accounted` (no fence, no refund) |
| Cancellation while completion work is pending | coded 409 `FINANCIAL_OPERATION_BLOCKED`, not stored |

The order fence is also checked by the participant: the settlement gate (`assertSettlementAllowed` → false, so the webhook gets 409 and no charge), a late `create` and `activate` (coded `PAYMENT_SETUP_CANCELLED`).

`get()` is a read-only, caller-scoped lookup; `null` maps to 404 (unknown). For a pending command, Booking recovery re-POSTs the same key. The GET does not advance it.

## For A to review

- `UNIQUE (kind, order_id)` means a second logical cancellation after an attention result is a coded conflict. Manual resolution must be explicit (operator), not a new key.
- A legacy intent is a durable attention result (`legacy_reconciliation_required`), not the coded `FINANCIAL_LEGACY_RECONCILIATION_REQUIRED`. A also allows that code; say if you prefer the coded form.
- Cancellation never returns `pending` here: every case is decided inside one transaction. Completion uses `pending` only for `awaiting_settlement`.
- The new schema must be reviewed against the importer before activation; the pin and guards are already updated in this PR.

## A integration review follow-up — 9 November

The original C commits are preserved and main (including D #47) is merged normally.
Two reviewed defects are corrected without a schema or wire-contract change:

- After the command lock/replay check, acquire the gateway-cancellation provisioning
  lock when applicable, then the order lock **before** looking for another accepted
  command. Evaluation and INSERT retain that lock. Different keys racing on one
  completion now yield one ready result and one FINANCIAL_COMMAND_CONFLICT, not
  a raw unique-constraint failure/HTTP500. Terminal replay remains immutable.
- In the absent-create path, an existing key bound to another order cannot be
  mistaken for absence just because its saga matches. It yields durable
  context_mismatch with no target fence or mutation of the referenced provisioning.
  Financial absent-create fences retain the request's order/owner/amount/currency
  binding even before an intent exists. A genuine old order-less setup-compensation
  fence can be bound once while preserving its key/state, then cannot be reused to
  fence another order. Migration004 already supports these fields on fenced rows;
  no new schema/keys or legacy adoption is introduced.

Regression tests use two real PostgreSQL transactions queued behind an externally
held order lock, plus cross-order references in created/activated/fenced and absent
states. Both new cases fail on the original PR implementation and pass after the
fix. Final local Payments suite115 (PG16/Rabbit4.1), financial subset15 and actual
A HTTP/PG boundary15 pass with fixture auth. Importer36 also passes with isolated
owning databases; legacy eligibility remains closed.

The old payment-view test assumed saga activation was not automatic. It failed in
exactly the same two child cases on main. Its fixture now explicitly holds the
activation boundary until the test's activation stage, with an asserted created
provisioning state. Production activation behavior is unchanged. CI now runs this
boundary together with runtime/financial boundaries serially to avoid collisions
between their fixed fixture Booking IDs. Booking financial callbacks/recovery,
real B verifiers, legacy eligibility and live cutover remain separate work.
## Monolith side — Booking finalization (C slice 2)

`lib/modules/booking/finalization.js`:

```js
import { createBookingFinalization, recoverFinalizationOnce } from "./finalization.js";
const bookingFinalization = createBookingFinalization({ financial: createFinancialClient({ baseUrl }), credentials: serviceCredentials });
configureBookingFinancialAccess({ bookingFinalization }); // A's seam; then call recoverFinalizationOnce() on a timer
```

- **Work table** `booking_financial_work` (SQLite) holds one row per accepted logical completion or cancellation: `UNIQUE(order_id, kind)`, the operation UUID, `command_id`, the frozen v1 snapshot and its state. It has its own lease and backoff. Existing files gain it through `migrate.js` `UPGRADES` step 2, starting empty: legacy money is never replayed.
- **complete:** in ONE transaction it rechecks provider, OTP and `started`, runs `completeAtomic`, emits the same `booking.completed` and `status_changed` events, and saves the work, with no SQLite wallet or ledger write. It then makes one best-effort delivery and returns the completed order with `accounting_status`.
  - Completion takes gateway provisioning refs from its COMPLETED saga. Cancellation may also use the saved refs of an in-progress saga; it never fabricates refs for legacy orders.
  - A legacy gateway order without a saga gets 409, and everything rolls back.
- **cancel:** in ONE transaction it rechecks the customer and `awaiting`/`confirmed`, then saves the work. The order and its holds are **kept**.
  - Only a ready Payments result finalizes, in one transaction: `cancelAtomic`, release holds, `markRefunded` only when the outcome is `refunded`, and one status event.
  - If the booking is paid but the result is not a refund, it goes to attention.
- **status** reads accounting/cancellation status from the work. **assertTransitionAllowed** is synchronous and refuses `confirm`/`start`/`reschedule` while a cancellation is pending or in attention. A pending cancellation also blocks completion, and a completed booking cannot be cancelled.
- **Delivery and recovery:** every attempt uses the same saved key and snapshot under a per-claim lease token, so stale results are discarded.
  - pending or unknown: retry with backoff, and one `consistency_attention` row after `escalateAfter` attempts (401/403 is recorded right away).
  - validated attention or any `FinancialReconciliationError` (coded or uncoded): work goes to attention plus a `consistency_attention` row, and is never retried.
- A's exporter guard now also rejects sources with `booking_financial_work` history.

Still needed: B's service credentials, A/E composition (timer + selector), D's retry values, the legacy gateway gate.

## A review fix: customer cancellation during setup — 9 November

A legal cancellation is durably accepted even when its gateway saga is
INTENT_CREATE_PENDING, COMPENSATION_PENDING or RECOVERY_PENDING. It uses the saved
create/saga references and the same financial cancellation key on recovery.
While its financial result is unknown, keep the order/holds and block competing
Booking transitions. Provisioning recovery excludes these orders, and in-flight
prepare/compensation/activation results cannot overwrite the accepted cancellation.
Only a safe Payments acknowledgement atomically cancels Booking, releases holds,
marks unfinished provisioning CANCELLED and blocks activation. Existing COMPLETED
provisioning history is retained. Attention requires explicit reconciliation;
legacy gateway orders without a saga still fail closed.

The added regression fails on the original PR49 implementation and passes after
this fix (9 tests including parent). Monolith241 and actual HTTP/PG boundaries
15 + 7 passed, no skips. The 7-test boundary includes cancellation during a
Payments outage before create, same-key recovery, and real rejection of late
create/activate by the persisted Payments fence. Auth remains an explicit fixture;
production composition, credential verification and recovery timer are not enabled.
CI runs the older boundaries first, then Booking finalization, so synthetic wallet
state cannot invalidate an earlier pending-wallet fixture. No schema/contract change.
