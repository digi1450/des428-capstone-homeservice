# A response to C payment participant interface — pending C confirmation (7 November 2026)

Status: **A accepts the interface direction with the clarifications below; C confirmation of this revision is pending. Nothing here is implemented yet.** This updates C's proposal merged in [PR #24](https://github.com/digi1450/des428-capstone-homeservice/pull/24); that merge alone did not establish bilateral agreement or runtime readiness. Based on [selected decisions](payment-participant-decisions.md) and A's [command HTTP shell](payment-command-http-handoff.md). Split: C owns the participant module (tables, transactions, fence, eligibility, activation state, wallet delivery). A owns HTTP routes, validation, the monolith client and caller/UI changes. Neither side builds a second store.

## 1. Callable interface (Payments service)

A accepts the proposed factory and `create/get/cancel` method names and DTOs, which match the existing router seam. The `activate` seam, HTTP validation and client still require A implementation. C confirms the exports in implementation; this document does not claim that the factory already exists.

```js
// services/payments-wallet/src/participant/index.js  (C)
createPaymentParticipant({ database, business })   // business = createPaymentsService(database, hooks)
  .create({ callerId, commandId, request, context })   // -> { replayed, result: CreatedOperation }
  .get({ callerId, createCommandId, context })         // -> CreatedOperation | CancelledOperation | null
  .cancel({ callerId, commandId, request, context })   // -> CancelledOperation (only after the fence is durable)
  .activate({ callerId, commandId, request, context }) // -> { replayed, result: ActivatedOperation }   (NEW)
  .assertSettlementAllowed(client, intent)             // -> true, else throws HttpError 409   (business hook)
```

- `request` is A's validated DTO. `context` = `{ requestId, traceparent?, tracestate? }` and never carries a token. `callerId` comes only from B's verified service identity.
- Each command joins its command result, provisioning state and business effects in **one** PostgreSQL transaction, passing the same `{ client }` to A's primitives. `assertSettlementAllowed(client, intent)` uses the caller's already-open transaction/order lock; it must not open another transaction or acquire the command lock in reverse order. No HTTP calls occur inside a transaction.
- Expected conflicts use `HttpError(409, ...)`; absence from `get` is `null`, mapped by A to 404. A owns the reviewed error-code extension described in section 4. The current generic handler sanitizes unexpected errors as 500, not 503; explicit unavailable/unconfirmed conditions use 503. No unexpected error or bare HTTP status is proof of a cancellation fence.

## 2. Tables (Payments migration `004_payment_participant.sql`, C)

```sql
-- One row per command key. Stored result = exact replay.
CREATE TABLE payment_commands (
  caller_id        TEXT NOT NULL,
  command_id       TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('create','cancel','activate')),
  create_command_id TEXT NOT NULL,          -- the provisioning this command belongs to
  request_digest   TEXT NOT NULL,           -- sha256 of the canonical validated request
  result           JSONB NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (caller_id, command_id)
);

-- Authoritative fence / eligibility per provisioning (caller + create command).
CREATE TABLE payment_provisioning (
  caller_id          TEXT NOT NULL,
  create_command_id  TEXT NOT NULL,
  saga_id            TEXT NOT NULL,
  state              TEXT NOT NULL CHECK (state IN ('created','fenced','activated')),
  order_id           INTEGER UNIQUE,         -- NULL when fenced before any create arrived
  customer_id        INTEGER, provider_id INTEGER, amount_cents INTEGER, currency TEXT,
  intent_id          INTEGER REFERENCES payment_intents(id),
  cancel_command_id  TEXT, cancel_reason TEXT,
  activate_command_id TEXT,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (caller_id, create_command_id),
  CHECK ((state = 'fenced') OR (order_id IS NOT NULL AND intent_id IS NOT NULL))
);

-- Consumer dedupe for wallet provisioning (section 5), same pattern as Notifications.
CREATE TABLE processed_events (
  consumer_name TEXT NOT NULL, event_id UUID NOT NULL, event_type TEXT NOT NULL,
  producer TEXT NOT NULL, processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer_name, event_id)
);
```

Importer (future A review after C implements/tests the migration): review compatibility before adding `004_payment_participant.sql` to `expectedMigrations`, and add `payment_commands`, `payment_provisioning` and `processed_events` to the `messageTables` guard from #21. They must be **empty** at initial business-row import: legacy bookings are not replayed as fresh commands. This is not eligibility initialization for existing unpaid bookings; see section 7. Do not loosen the current importer pins/guards merely to accept this proposed DDL.

## 3. Semantics per command

| Command | Current provisioning state → result |
|---|---|
| **create** | First validate an existing command's kind, target and digest: same successful create key + same canonical request → stored result, `replayed=true`, including after a later fence; changed kind/target/input → 409. If no successful create result exists: `fenced` → **409, never create an intent**; none → `prepareIntent(input,{client})`, state `created`, store result, `replayed=false`. Another create identity for an already-bound order → 409. |
| **get** | none → `null` (404; **never** treated as a fence) · `created` / `activated` → `CreatedOperation` (intent read fresh) · `fenced` → `CancelledOperation` |
| **cancel** | none → write `fenced` with no intent (**absent-create fence**) · `created` / `activated` → `voidUnpaidIntent({client})` then `fenced` (eligibility removed) · `fenced` → replay · intent already settled → **409, no fence written**: a refund/reconciliation case, and the saga goes to `RECOVERY_PENDING` |
| **activate** | `created` → `activated` · `activated` → replay · `fenced` → **409 `PAYMENT_SETUP_CANCELLED`, even when replaying an earlier successful activate** · none or saga mismatch → 409 |
| **assertSettlementAllowed** | true only if, under the order lock, the provisioning row for `intent.order_id` is `activated` and `intent_id` matches. Otherwise 409. A stored successful create is not enough |

**A's selected replay rule — C to confirm:** an already-committed create result is historical evidence and is replayed unchanged for its exact original request, without recreating an intent or changing the fence/eligibility. In contrast, an absent-create fence has no successful create result to replay: a delayed create is rejected. `get` returns the current fenced/cancelled outcome; `activate` checks the effective fence before returning success, including replays. A must not infer payment readiness from any create replay.

All command kinds must reject reuse of a command id with changed kind, target, saga or canonical request before returning a result or applying effects. A cancellation referencing a different saga must not fence the original saga. The `(caller_id, command_id)` primary key spans kinds: command reuse across different provisioning targets must conflict safely even though provisioning locks use different create ids.

`get` keeps the existing strict `CreatedOperation | CancelledOperation | null` shape, including for an activated provisioning. Do not add a readiness field to that DTO. A exposes UI/payment setup through the separate Booking contract extension in section 4.

**Lock order accepted by A for C confirmation and concurrency tests:**
1. Command lock: `pg_advisory_xact_lock(42802, hashtext(caller_id || ':' || create_command_id))`. It serializes create, cancel and activate for one provisioning, including the absent-create case, which has no order id.
2. Booking business lock: `pg_advisory_xact_lock(42801, order_id)`, taken inside A's primitives or explicitly before changing the provisioning state.
3. Ledger and wallet changes.

`settleWebhook` already holds lock 2 when it calls `assertSettlementAllowed`. Cancel and activate change the state only after taking lock 2, so settlement versus cancel/activate is serialized. No path acquires these locks in the reverse order.

## 4. Activation contract accepted by A — implementation pending

`POST /internal/payment-intents/activate-by-command`
- Header `Idempotency-Key`: activate command id. It must differ from the create and cancel ids. Booking uses a stable `activate:<saga_id>` when within the existing 128-character key limit; any alternative must also be persisted once and reused, never regenerated on retry.
- Body `{ "create_command_id": "...", "saga_id": "..." }`. The strict shape matches the cancel DTO, minus `reason`.
- `200 { create_command_id, saga_id, outcome: "activated" }` for both fresh and replay (`replayed` is for logs only).
- `409 { error, code: "PAYMENT_SETUP_CANCELLED" }` if fenced. `409` with no code for an unknown or mismatched create.
- A extends `HttpError`/serialization with the allow-listed `PAYMENT_SETUP_CANCELLED` code and updates the activation client to validate it. Current serialization drops `code`, and the existing command client discards non-success bodies: neither is sufficient yet. Other generic errors must stay sanitized, including requestId; malformed/private upstream responses remain unconfirmed.
- Only a validated `409` carrying `PAYMENT_SETUP_CANCELLED` is classified as a confirmed activation fence. An uncoded 409, unknown create or mismatched identity is unresolved/reconciliation work; never interpret every 409 as a fence or success, and never release Booking slots on that basis.
- A adds activation request/result/error fixtures, strict transport validation (JSON size/media/encoding/key rules matching the command shell), HTTP boundary tests and OpenAPI/client changes together. The route remains unavailable until real B/C integration is supplied.

**Monolith side (C):** an additive SQLite migration (needed now that #23 made startup persistent) adds `activation_state` (`pending` | `activated` | `blocked`) and `activate_command_id` to `booking_sagas`. These are written in the **same** transaction that sets `COMPLETED`. Recovery also picks up `COMPLETED` sagas whose activation is `pending` and retries the same key. A timeout leaves the activation pending; it never cancels the booking. A validated fenced response sets `blocked` and writes `consistency_attention`; other conflicts must remain non-ready and visible for reconciliation under a bounded retry/escalation policy. Migration must preserve existing rows and advance the schema marker through a reviewed upgrade path from #23, atomically; merely adding columns or deleting the marker will fail the persistent-startup guard. A/C review that integration before deploying the migration. **A:** expose `payment_setup: "pending" | "ready"` from `activation_state`, and enable payment only when it is `ready`. The server-side gate is `assertSettlementAllowed`.

## 5. Wallet provisioning (async, lead-selected)

- **Monolith (C):** in the provider registration transaction, call `insertEvent("provider.registered", "provider", id, { provider_id })` on the existing outbox. Add it to the broker relay's published types. Registration commits and the event exists, or neither.
- **Payments (C):** a new consumer `payments.wallets` on queue `payments.events`, which accepts `provider.registered` from `monolith` only. In one transaction it inserts `processed_events` and calls `provisionWallet(provider_id, {client})`. Retries never reset a balance. The DLQ follows the existing scheme.
- **Visibility (A):** a missing wallet means "pending", never a verified zero balance. Legacy direct SQLite wallet creation stays until cutover.
- A accepts `provider.registered` with `{ provider_id }` inside the existing stable event-id/producer envelope. C confirms the schema and transaction placement; E integrates trace propagation/contract evidence. The producer implementation must preserve provider registration compatibility until coordinated cutover.

## 6. Tests C will provide

- Create: retry converges, and changed input with the same key gives 409.
- Absent-create fence followed by a late create: no intent. Separately, successful create → cancel → replay the original create: identical historical result, no new intent, fence remains effective, get is cancelled and activate/settlement are refused.
- Changed kind, saga, target or payload with reused command ids: conflict, including cross-provisioning command-id reuse.
- Cancel after activation: intent voided and settlement refused.
- Cancel after settlement: 409 and no fence.
- Activate: retry and lost reply converge; a stale activate after the fence gets 409.
- Concurrent activate vs cancel vs `settleWebhook` on real PostgreSQL: exactly one valid end state.
- Settlement before activation: refused. After activation: allowed.
- Wallet: duplicate `provider.registered` and restart give one wallet with the balance unchanged.
- Monolith activation delivery: retry, restart and lease; coded cancellation versus uncoded conflicts stay distinct, and neither enables payment. SQLite upgrade preserves existing domain/saga/outbox/dedupe rows and survives the new startup guard.

## 7. Legacy-data gate and remaining confirmations

**Legacy cutover is separate from new-booking participant implementation.** Imported `requires_payment` intents will have no `activated` provisioning row if the new tables are empty. The strict settlement guard must refuse those until A/C review an explicit eligibility/bootstrap strategy against the frozen Booking state and matching order/customer/provider/amount/intent. Never activate all imported intents, replay legacy bookings as new creates, or infer readiness from an existing intent alone.

A owns importer compatibility and the coordinated offline cutover; C owns eligibility semantics and evidence. Together decide whether to bootstrap verified eligible legacy records through a separate reviewed phase or reconcile/resolve legacy pending bookings before switching traffic. Record ordering, immutable source evidence, replay/restart behavior and non-ready/conflicting cases before live cutover. **No legacy strategy is approved or implemented by this document.** C can implement/test new-booking commands, fences, activation and wallet delivery before that gate is closed; live legacy payment traffic stays blocked.

| Owner | Response / next action |
|---|---|
| A | Accept callable names/DTOs, historical create replay + effective activation/fence rules, unchanged strict get shape, activation endpoint and provider event direction above. Own HTTP/error-code serialization/client/OpenAPI fixtures, Booking pending/ready UI, wallet pending visibility and importer/cutover integration. |
| C | Confirm this revision before calling it a bilateral agreement. Implement participant store/fence/eligibility and wallet consumer; own SQLite activation migration/state/lease/recovery and provider outbox recording. Add tests in section 6 and flag interface changes before implementation diverges. No duplicate store on A's side. |
| B | Confirm stable verified Booking callerId and permissions; no token/header/body-based identity substitute. Isolated tests may inject explicit doubles; live activation still requires the real verifier. |
| D | Confirm activation retry/backoff/lease policy. Existing saga defaults may support initial isolated work, but are not newly measured or selected production values. |
| E | Use the finalized implementation/fixtures for Pact and traces; proposal/CI service tests do not prove provider behavior or final-stack readiness. |

Implementation can proceed in parallel after C confirms the shared interface: C provides the participant/recovery exports while A prepares the activation transport/client/caller work against those shapes. Wire live traffic only after real implementation, authorization and integrated race/restart tests pass. This documentation PR does not mount a new endpoint, migrate data, enable a worker, or claim C has confirmed it.
