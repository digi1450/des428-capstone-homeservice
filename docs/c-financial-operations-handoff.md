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
