# Payments & Wallet business slice — integration handoff

Status: A business primitives, PostgreSQL ledger invariants and wallet/history HTTP reads implemented. B real auth, C command-result/fence/provisioning/outbox integration, payment HTTP mutations, monolith payment client/cutover and final gateway remain pending. All original application financial flows still run in the monolith. Do not call this completed extraction.

## A business entry points

`createPaymentsService(database, hooks)` lives in `services/payments-wallet/src/service.js`. Mutations accept optional `{ client }` to join C's SAME PostgreSQL transaction; otherwise they open a local transaction. SQL stays in `repository.js`. No method reads or updates the monolith database.

| Method | Internal behavior |
|---|---|
| prepareIntent(context, options) | Context: order_id, customer_id, provider_id, amount_cents, currency=THB. Creates one intent per booking; same business context converges, changed context or voided intent conflicts. This is not HTTP command-result replay |
| getIntentForOrder(orderId, principal) | Customer/provider owner-only read, matching original intent fields |
| voidUnpaidIntent(orderId, options) | Fails existing unpaid intent; replay keeps failed state. Settled/completed conflicts. An absent intent returns 404/unknown, NEVER a safe cancellation fence |
| provisionWallet(providerId, options) | Inserts missing wallet without resetting an existing balance |
| applyCompletion(context, options) | Trusted completed-Booking facts plus payment_method and commission_cents. Gateway credits total minus commission; COD adds commission owed. One completion effect per booking, exact business context on replay |
| applyRefund(context, options) | Records one full refund matching a successful gateway charge; completed or mismatched/failed charge conflicts. This is offline bookkeeping, not an external refund API |
| settleWebhook(payload, options) | payload: gateway_event_id, type=payment_intent.succeeded, gateway_ref. Requires BOTH C hooks below; receipt, intent flip, one charge and staged event commit atomically |
| simulateSucceeded(orderId, principal) | Checks customer ownership and drives the same guarded offline webhook logic; returns the inherited ok/replay/settled shape |
| getWallet(principal), listCustomerTransactions(principal) | Provider/customer role-scoped reads, original public fields, numbers and ISO dates |

All amounts are integer cents within the current PostgreSQL INTEGER range. Booking remains responsible for trusted catalog pricing, OTP/order-state authorization and its authoritative completed/cancelled facts. No public caller may supply arbitrary completion/refund context. The completion primitive preserves the inherited gateway earnings/COD commission split; introducing a new payment-before-completion policy is not part of this slice. A full refund here applies to the inherited pre-completion cancellation flow; post-completion adjustments need separate reconciliation.

Migration `002_ledger_invariants.sql` adds private context_json and a unique order_id/kind ledger index. It rejects inconsistent financial replays independently of C event IDs. Do not edit applied migrations. Before importing historical ledger rows, audit duplicates and populate completion context; old rows without comparable context must be reconciled, not silently treated as an exact retry. Public projections never expose context_json/customer_id/provider_id from ledger storage.

## B authentication seam and read APIs

`createApp({ database, authenticate })` expects the same verified `{ role, domainId }` contract as Notifications. B verifies Keycloak issuer/signature/expiry/audience and maps subject to the integer domain ID; raw user/role headers and query hints are not identity.

Implemented paths: GET `/api/provider/wallet` and GET `/api/customer/transactions`. Default server has no verifier and returns 503 for business reads. Health checks report HTTP/database migration readiness only. Wrong-role callers receive 403; invalid mapped identity receives 401. Tests use explicit auth doubles, never a production bypass.

The [read OpenAPI](../contracts/payments-reads.openapi.json) describes these routes. The existing [payment intent OpenAPI](../contracts/payment-intents.openapi.json) remains a DRAFT: create/query/cancel HTTP endpoints are still unmounted. Public simulate/webhook and internal financial mutation routes also remain unmounted until B/C wrappers can enforce the required policy. No shared-secret-only webhook or unguarded mutation is exposed.

## C coordination BEFORE mutation HTTP/cutover

1. Persist scoped command IDs, request digests and terminal responses separately from the business primitives. A's per-booking intent uniqueness does not replace durable command results.
2. Cancellation must durably fence an absent/late create, then call voidUnpaidIntent if present. A 404 is not proof that a create cannot still commit. Coordinate state/locking so a cancelled command cannot recreate an active intent. No cancellation fence is implemented here.
3. Supply `assertSettlementAllowed(client, intent)` which returns exactly true ONLY for eligible finalized provisioning; false throws a business conflict, and absence of the hook fails with 503. It must inspect C's local authoritative eligibility state using the supplied client under the booking business lock, not make remote HTTP calls in the transaction. All eligibility writers must use the same order-lock convention.
4. Supply `stageEvent(client, event)` that INSERTS C's durable outbox row using the SAME client. The draft event includes event_type=payment.succeeded, aggregate_type=order, aggregate_id and data with order/customer/provider/amount. C supplies envelope ID/version/correlation metadata and publishes after commit. A callback that does not persist the event does not fulfill this contract.
5. Consumer dedupe plus applyCompletion/applyRefund/provisionWallet must share a transaction. A's ledger uniqueness is a second business invariant, not RabbitMQ dedupe. Keep the producer event meanings/source data consistent with Booking.

The A business lock is `pg_advisory_xact_lock(42801, order_id)` in repository.lockOrder. Review lock order with C before integrating: outer command/dedupe guards -> one booking business lock -> ledger/wallet mutations. Hooks must not acquire locks in reverse order or perform network calls. Batch work touching multiple bookings needs an explicitly agreed ordering. Missing outbox/eligibility hooks keep settlement unavailable, and runtime HTTP writes are unmounted.

Gateway receipt replay checks event ID and normalized payload; an existing unprocessed receipt requires reconciliation rather than being acknowledged as completed. Voided intents cannot settle. Already-settled intents do not create another charge/event even if a new gateway event ID arrives. C's payment event consumer updates Booking's paid flag; this service never directly writes it.

## Next integration work

B/C review these interfaces and add their adapters. A now has a [prepared monolith Payments client and Booking adapter](payment-adapter-handoff.md); active callers, migration/backfill and coordinated UI cutover remain pending; E/D integrate gateway/Compose, auth, retries and real fault/contract/trace evidence. Keep original readers/writers active together until a coordinated cutover; do not switch only reads and leave new writes in SQLite.

Test staging uses a temporary SQL probe table and synthetic eligibility/auth callbacks to verify atomicity. That is not a RabbitMQ outbox implementation, actual Keycloak verification, saga recovery or D's required fault/race evidence. See [recorded validation](validation/payments-business-2026-11-05.md) for observed checks and reproduction.
