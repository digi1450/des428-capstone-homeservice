# Migration handoff — decisions and implementation draft

Recorded: 5 November 2026, Asia/Bangkok. System: Bangkok Homeservice.

Status: the project lead selected the decisions in section 1. The technical interfaces in later sections are a source-grounded implementation draft, not already implemented APIs or a claim that the team has tested them. No member deadlines are assigned; the actual submission date and teammates' GitHub usernames are not yet known.

## 1. Decisions selected by the project lead

| Topic | Decision |
|---|---|
| Business services | Extract Notifications and Payments & Wallet; keep Booking/Bidding and Providers in the monolith initially |
| Runtime | Follow the repository plan: new services use Express/JavaScript; preserve the existing Next.js monolith |
| Data ownership | Each extracted service owns a PostgreSQL database; the monolith retains SQLite for remaining contexts |
| PostgreSQL deployment | Two PostgreSQL containers, one per new business service, with separate credentials |
| Saga coordination | Booking in the monolith orchestrates durable local steps; no third extracted Booking service |
| First saga | Reserve booking and slots, then create a gateway payment intent; creating an intent is not charging money |
| Confirmed setup failure | Cancel the provisioning booking, release its slots safely and retain its history; do not delete evidence |
| Notifications | Asynchronous via events; an unavailable notification service does not roll back a successful booking |
| Unknown outcome/timeout | Bounded foreground wait, then a safe pending/retry message; preserve the same operation identity and normal success contract |
| Recovery | A worker reconciles durable pending operations and resumes when services recover; bounded/backoff attempts per cycle, visible manual-recovery states when needed |
| Gateway | nginx |
| Implementation split | A implements both business services and monolith adapters; C primarily implements outbox/events/dedupe/saga/recovery, integrating with A's services |
| Schedule | Work by deliverable checkpoints, not fixed individual dates |

Keycloak, RabbitMQ, observability and Pact/act remain course requirements. The source-level API/schema details below operationalize these choices and should be reviewed by the affected implementers before parallel integration. They do not reopen the selected business scope.

## 2. Ownership and first handoffs

| Owner | Implementation responsibility | First concrete handoff | Can start before full extraction? |
|---|---|---|---|
| A — Thumathorn | Both service apps, their business APIs/repositories, gateway and all monolith callers | Table/caller map; service skeletons and health endpoints; payment create/query/cancel interfaces; transaction hooks for C | Yes: extraction inventory, schema and API skeletons |
| B — Nattapat | Keycloak, token validation in both services, roles/domain-ID mapping and ownership tests | Issuer/audience/roles and trusted identity mapping; middleware contract for A/C | Yes: realm/config, middleware and negative-token fixtures |
| C — Peerawit | Transactional outboxes, RabbitMQ relay/consumers, dedupe, Booking saga and recovery worker | Event envelope/contracts; outbox transaction adapter; saga state/transition module and payment client interface | Yes: fixtures, state machine, outbox/consumer modules and tests; real integration needs A's endpoints/DB hooks |
| D — Chanakan | HTTP idempotency/retry/timeout, three faults, concurrency/race evidence | Retry/error/command-ID contract and fault harness used by A/C | Yes: wrappers and harness against contract fixtures |
| E — Nathaporn | Root Compose integration, two PostgreSQL containers, broker/IdP/tool wiring, metrics/traces and Pact/CI | Service names/env/health conventions, runnable infrastructure, trace-context contract | Yes: infrastructure and CI/telemetry scaffolding |

A remains accountable for extracting both services; C owning consistency means C may edit messaging/saga modules inside those services in coordinated PRs. This is not a rule that A must finish two full services before C can work.

Suggested edit boundaries: A owns HTTP/business/repository and monolith adapter changes; C owns messaging, processed-event/outbox/saga modules; B owns auth modules; D owns resilience/fault modules; E owns root Compose, observability and workflows. Shared bootstrap/config/schema changes need a small coordinated PR. Each person writes dossier material and records actual contributions.

## 3. Tables and callers

| Data | Owner after extraction |
|---|---|
| notifications | Notifications PostgreSQL |
| payment_intents, transactions, provider_wallets, webhook_events | Payments & Wallet PostgreSQL |
| orders, order_items, slot_holds, addresses | Booking in the monolith's SQLite |
| customers/providers/admins, profiles/timings, catalog, bidding, reviews | Their remaining monolith contexts; do not move these merely to simplify cross-service queries |
| outbox/published state | Each producer's own database, atomically with its local business changes |
| processed_events/inbox dedupe | Each consumer's own database, atomically with its business effect |
| saga state, booking request keys and recovery leases | Booking orchestrator's SQLite; durable across worker restarts |

A must include more than the obvious modules in the caller map:

- `bangkok-homeservice/lib/modules/booking/service.js`: intent creation, completion credits/commission, refunds and reading an intent for a booking.
- `bangkok-homeservice/lib/modules/payments/service.js`: presently reads orders and writes Booking's paid flag. Replace cross-context access with validated context/events and let Booking write its own payment status.
- `bangkok-homeservice/lib/modules/identity/repository.js`: provider signup inserts a wallet directly. Replace with an idempotent service-owned provisioning path/API/event.
- `bangkok-homeservice/lib/modules/providers/service.js`: provider approval writes a notification directly. Replace this path too.
- `bangkok-homeservice/lib/modules/notifications/relay.js`: handles notifications and recomputes Catalog/Provider ratings. Keep rating writes in their owning monolith contexts.
- Public notification/payment/wallet/transaction routes and Next.js notification/provider wallet/dashboard pages. Server Component imports must become service calls too.
- `bangkok-homeservice/lib/db/schema.js`, seed/bootstrap and inherited tests: remove moved business-table dependencies only when their replacements are ready; do not silently keep dual writers.

Do not invent cross-database foreign keys. Keep immutable order/customer/provider identifiers and payment context in the service that needs them, supplied through authorized APIs/events.

## 4. Payment integration contract — proposed v1

These internal endpoints are new proposals. A implements them; C uses them from saga/recovery, D tests their idempotency and faults, B authorizes them and E verifies contracts. Preserve existing public routes such as `/api/bookings`, `/api/payments/simulate`, `/api/payments/webhook`, `/api/provider/wallet` and `/api/customer/transactions` through adapters/gateway.

| Proposed internal endpoint | Request | Required behavior |
|---|---|---|
| POST /internal/payment-intents | order_id, customer_id, provider_id, amount_cents, currency=THB, saga_id; stable create-command key in Idempotency-Key | Create exactly one intent for the accepted command/booking. Return the stored result on replay; a different payload under the same scoped key conflicts |
| GET /internal/payment-operations/{create_command_id} | Authorized lookup scoped to the caller/operation | Report the durable create-operation outcome and intent if present; a lookup miss alone does not prove that an earlier request cannot still commit |
| POST /internal/payment-intents/cancel-by-command | create_command_id, saga_id, reason; stable cancellation-command key | Idempotently void an unpaid intent or durably fence the create command against late creation. Do not report safe cancellation while a later replay could recreate an active intent |

The create-operation result and payment status are distinct: a successful create operation yields an intent requiring payment, not payment.succeeded. Retain the public payment-intent fields `id`, `order_id`, `amount_cents`, `gateway_ref`, `status` and compatible field types from the original booking response.

Booking calculates prices from trusted catalog data. Payment amounts and customer/provider IDs on internal create calls are not accepted merely because a browser sent them. B must authorize the Booking service caller and map verified end-user identity for user-facing reads/actions. Services validate Keycloak issuer/signature/expiry/audience themselves; raw role/user headers are not authority. The offline mock gateway must authenticate when calling the extracted service; do not leave its inherited shared-secret-only webhook as an unexamined exception to the token requirement.

## 5. Booking orchestration and compensation

Proposed internal states: BOOKING_RESERVED, INTENT_CREATE_PENDING, INTENT_CREATED, COMPLETED, COMPENSATION_PENDING, CANCELLED, RECOVERY_PENDING. These are saga/provisioning states, not replacements for provider-controlled public booking statuses.

1. Validate the customer's request and idempotency key. In one local SQLite transaction, reserve the booking/items/slot holds and durable saga/request state. A slot clash rolls back locally and must not create a payment intent.
2. After committing, call Payments with the stable create-command ID. Never keep a SQLite transaction open across the network; the inherited better-sqlite3 transaction helper cannot be turned into a distributed transaction by putting an async callback inside it.
3. On confirmed intent creation, finalize provisioning locally and record the booking event in the same local transaction. Normal success remains HTTP 201 with `{order, otp, payment_intent}` and Location as in the original API. Public booking status remains awaiting; do not automatically confirm a provider's booking or mark it paid.
4. On a definitive terminal rejection, ensure the create operation cannot later produce an active intent, then cancel locally, release the slot holds and record cancellation/event state in one transaction. Keep the booking/saga history.
5. If an intent was created but finalizing Booking fails, remain in compensation pending and cancel/void by the original create-command ID. After the cancellation/fence is confirmed, cancel Booking and release its slots. A failed cancellation stays recoverable, not falsely completed.
6. On timeout/lost reply/temporary unavailability, preserve pending saga state and slots, query/retry the same create operation and let recovery resume it. Do not cancel/release purely because of a timeout or an inconclusive 404 lookup.

The payment simulate/settle path must not charge a booking whose provisioning is incomplete or already compensated. Cancelling an already-settled intent is not an unpaid-intent void: route it into the appropriate refund/manual-recovery workflow rather than pretending money was never taken.

The saga is complete when the gateway booking and its payment intent are coherently provisioned, not when money is charged or the notification is delivered. Later simulated payment success is its own event-driven consistency path. COD remains supported and does not need an unused gateway intent.

### Foreground response and restart recovery

Proposed default for an unresolved foreground operation: a safe retryable 503 plus Retry-After and a machine-readable pending code, retaining the existing error/requestId convention. This is a draft contract, not an existing endpoint behavior. Review `lib/http/respond.js`: it currently scrubs all 5xx messages, so safe expected pending responses need an explicit implementation rather than throwing raw internal details.

The UI retains one request key for the same booking attempt. A later retry retrieves/resumes that saga and ultimately replays its final 201 result instead of reserving a second booking. Same key with different input must conflict. Do not permanently cache an intermediate 503 as the final result and prevent eventual progress.

C implements durable recovery selection/leases and next-attempt state; D supplies configurable bounded retry/backoff/jitter and foreground timeouts. No deadline or retry timing has been selected by the lead: document initial configurable engineering defaults and measure them rather than presenting them as observed results. After process/service restarts, recover the original operations; surface irrecoverable or ambiguous cases for manual attention. An exhausted foreground retry budget is not permission to discard the operation.

## 6. Events, keys and tracing — proposed v1

Use existing event meanings for the first two required cross-boundary event flows:

| Event | Producer | Consumer/effect |
|---|---|---|
| booking.status_changed | Booking's monolith outbox | Notifications writes the appropriate inbox notification; for initial booking, publish the successful awaiting transition only after provisioning completes |
| payment.succeeded | Payments & Wallet outbox, after successful simulated settlement | Booking updates its own payment flag; Notifications records payment_received |

This is the minimum evidence pair, not permission to drop other inherited behavior. Preserve review.created, booking.completed, bid.accepted and other notification/financial flows; provider approval and wallet provisioning also need service-owned replacements. A/C inventory all these paths before declaring extraction complete.

Proposed envelope fields: event_id, event_type, schema_version, producer, occurred_at, aggregate_type, aggregate_id, saga_id when applicable, correlation_id, and data. Retain existing payload meanings: booking transitions carry order_id/from/to/customer_id/provider_id/actor_role; payment success carries order_id/provider_id/amount_cents. Include any additional authoritative identifiers needed by the target consumer in a reviewed versioned contract, not through direct SQL into another service's database.

- HTTP request key: scopes the customer's business request and request digest to actor+endpoint.
- saga_id: stable workflow identity, reused after restarts.
- command_id: stable identity per local command, such as intent create versus intent cancel; retries reuse their own command's ID.
- event_id: stable globally unambiguous identity per event, saved in the outbox before publishing. Republishing keeps the same ID; distinct events do not share a dedupe key.
- consumer dedupe: unique `(consumer_name, event_id)` recorded in the same transaction as the effect. One consumer having processed an event must not suppress other consumers.
- E defines propagation of X-Request-Id, correlation metadata, traceparent and tracestate through HTTP and RabbitMQ headers. No passwords, tokens, OTPs or unnecessary private details in event payloads/logs.

Use at-least-once delivery with idempotent effects. Write business changes and outbox rows atomically; publish with broker confirmation and mark published only after success. A crash after publish may cause redelivery and must remain safe. Consumers acknowledge after their effect/dedupe transaction commits. Reuse/rework the existing outbox carefully: its current claim() stamps processed_at before dispatch and is not a reliable publish-confirm protocol as-is.

Do not assume ordered events across all queues. Consumers must reject stale/invalid state transitions; late payment events must not revive a cancelled booking or hide a required refund/reconciliation.

## 7. Work checkpoints — no individual dates

| Checkpoint | Concrete acceptance/handoff |
|---|---|
| Shared starting point | Read this handoff and the user-selected decisions. A/C turn the draft endpoints/envelope into shared fixtures/OpenAPI/event schemas; B/D/E attach their identity/retry/trace requirements |
| A's minimum handoff | Two Express apps, per-service schema/transaction entry points and health checks; payment create/query/cancel contract fixtures and monolith client adapter outline. Full extraction is not required before C begins |
| Parallel work | A builds business endpoints/repositories/callers; C builds state machine/outbox/relay/dedupe/recovery against agreed fixtures and transaction hooks; B builds auth, D faults/retry, E infrastructure/telemetry/Pact |
| First real integration | A payment-intent write uses its own PostgreSQL; an event reaches Notifications' separate PostgreSQL; replay has one effect per consumer. Include actual Keycloak tokens rather than treating a stubbed auth path as finished |
| Saga and failure evidence | Successful provisioning; definitive failure cancels and releases; reply lost after write; slow response; temporary outage; restart recovery; failed compensation retry. Verify one booking/intent/effect and consistent slot state |
| Complete migration | Audit all moved-table callers, wallet registration/completion/refunds, notification reads/mark-read/approval/ratings, auth ownership and negative tokens, both Pact boundaries, traces/dashboard and root Compose boot under the memory constraint |

Notifications failure recovery is separate: booking/payment success is retained while a durable message waits for the notification service to recover. E measures the combined stack with both PostgreSQL containers within the course's 8 GB Docker budget; the architecture choice alone does not prove it fits.

## 8. Evidence boundaries and open course questions

The baseline 61-test run is historical. All new saga, broker, security, concurrency, resource and tracing claims require actual implementation runs. Fixtures and stub tests unblock development but do not substitute for final service integration evidence.

B/D still need real inherited BOLA/race candidates matching the team rubric. Do not introduce a flaw to manufacture a fix; clarify acceptable evidence with the lecturer if the guarded teaching source does not supply the required candidate. This does not block initial API/outbox/saga design.

GitHub membership usernames and the calendar deadline remain unknown. This document records planning decisions; teammate invitations, implementation and deployment require their own actions.


## Selected legacy open-booking compatibility — 10 November 2026

The lead selected the [legacy-binding baseline](c-legacy-binding-proposal.md).
Booking stays in the monolith. A owns manifest/hash and v1.1 fixtures first, then
importer/client/UI; C owns owned binding schemas, eligibility/financial checks,
Booking operator CLI and consistency invariants; B owns concrete operator access.
Preserve E metadata upgrades and keep traffic closed until both owner bindings
and the full checkpoint/rehearsal agree. This is direction only; no006/schema,
contract version or shared activation has changed in this documentation update.
