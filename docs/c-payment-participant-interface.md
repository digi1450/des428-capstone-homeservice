# C payment participant interface — PROPOSAL for A/C agreement (7 November 2026)

Status: **draft for A review; nothing here is implemented yet.** Based on [selected decisions](payment-participant-decisions.md) and A's [command HTTP shell](payment-command-http-handoff.md). Split: C owns the participant module (tables, transactions, fence, eligibility, activation state, wallet delivery). A owns HTTP routes, validation, the monolith client and caller/UI changes. Neither side builds a second store.

## 1. Callable interface (Payments service)

C exports one factory. Its method names match A's router seam, so A can inject it directly with no adapter.

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
- Every method runs in **one** PostgreSQL transaction and calls A's business primitives with `{ client }`. It never makes HTTP calls inside the transaction.
- Errors are `HttpError` with statuses A already maps: 409 for conflicts, 404 only from `get` (returned as `null`). Anything unexpected passes through to A's sanitized 503.

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

Importer (A review): add `004_payment_participant.sql` to `expectedMigrations`, and add `payment_commands`, `payment_provisioning` and `processed_events` to the `messageTables` guard from #21. They must be **empty** at import: legacy bookings are not replayed as fresh commands.

## 3. Semantics per command

| Command | Current provisioning state → result |
|---|---|
| **create** | none → `prepareIntent({client})`, state `created`, store result, `replayed=false` · same key + same digest → stored result, `replayed=true` · same key + different digest → 409 · `fenced` → **409 (create after fence never makes an intent)** · `created`/`activated` with another key for the same order → 409 |
| **get** | none → `null` (404; **never** treated as a fence) · `created` / `activated` → `CreatedOperation` (intent read fresh) · `fenced` → `CancelledOperation` |
| **cancel** | none → write `fenced` with no intent (**absent-create fence**) · `created` / `activated` → `voidUnpaidIntent({client})` then `fenced` (eligibility removed) · `fenced` → replay · intent already settled → **409, no fence written**: a refund/reconciliation case, and the saga goes to `RECOVERY_PENDING` |
| **activate** | `created` → `activated` · `activated` → replay · `fenced` → **409 `PAYMENT_SETUP_CANCELLED`, even when replaying an earlier successful activate** · none or saga mismatch → 409 |
| **assertSettlementAllowed** | true only if, under the order lock, the provisioning row for `intent.order_id` is `activated` and `intent_id` matches. Otherwise 409. A stored successful create is not enough |

**Replay after fence (A's open question):** `activate` replies with the **current effective state**, not the stored historical success. Nobody can mistake an old acceptance for current readiness. `create` keeps its stored-result replay because a created intent is still a fact. The fence shows through `get` and `activate`.

**Locks (lead's agreed order):**
1. Command lock: `pg_advisory_xact_lock(42802, hashtext(caller_id || ':' || create_command_id))`. It serializes create, cancel and activate for one provisioning, including the absent-create case, which has no order id.
2. Booking business lock: `pg_advisory_xact_lock(42801, order_id)`, taken inside A's primitives or explicitly before changing the provisioning state.
3. Ledger and wallet changes.

`settleWebhook` already holds lock 2 when it calls `assertSettlementAllowed`. Cancel and activate change the state only after taking lock 2, so settlement versus cancel/activate is serialized. No path acquires these locks in the reverse order.

## 4. Activation contract proposal (for A's route and client)

`POST /internal/payment-intents/activate-by-command`
- Header `Idempotency-Key`: activate command id. It must differ from the create and cancel ids. Booking uses `activate:<saga_id>`.
- Body `{ "create_command_id": "...", "saga_id": "..." }`. The strict shape matches the cancel DTO, minus `reason`.
- `200 { create_command_id, saga_id, outcome: "activated" }` for both fresh and replay (`replayed` is for logs only).
- `409 { error, code: "PAYMENT_SETUP_CANCELLED" }` if fenced. `409` with no code for an unknown or mismatched create.
- 400, 401, 403, 415 and 503 behave as the existing shell already does.

**Monolith side (C):** an additive SQLite migration (needed now that #23 made startup persistent) adds `activation_state` (`pending` | `activated` | `blocked`) and `activate_command_id` to `booking_sagas`. These are written in the **same** transaction that sets `COMPLETED`. Recovery also picks up `COMPLETED` sagas whose activation is `pending` and retries the same key. A timeout leaves the activation pending; it never cancels the booking. A 409 fenced sets `blocked` and writes `consistency_attention`. **A:** expose `payment_setup: "pending" | "ready"` from `activation_state`, and enable payment only when it is `ready`. The server-side gate is `assertSettlementAllowed`.

## 5. Wallet provisioning (async, lead-selected)

- **Monolith (C):** in the provider registration transaction, call `insertEvent("provider.registered", "provider", id, { provider_id })` on the existing outbox. Add it to the broker relay's published types. Registration commits and the event exists, or neither.
- **Payments (C):** a new consumer `payments.wallets` on queue `payments.events`, which accepts `provider.registered` from `monolith` only. In one transaction it inserts `processed_events` and calls `provisionWallet(provider_id, {client})`. Retries never reset a balance. The DLQ follows the existing scheme.
- **Visibility (A):** a missing wallet means "pending", never a verified zero balance. Legacy direct SQLite wallet creation stays until cutover.
- The event name is a proposal; A and E should confirm it.

## 6. Tests C will provide

- Create: retry converges, and changed input with the same key gives 409.
- Absent-create fence followed by a late create: no intent.
- Cancel after activation: intent voided and settlement refused.
- Cancel after settlement: 409 and no fence.
- Activate: retry and lost reply converge; a stale activate after the fence gets 409.
- Concurrent activate vs cancel vs `settleWebhook` on real PostgreSQL: exactly one valid end state.
- Settlement before activation: refused. After activation: allowed.
- Wallet: duplicate `provider.registered` and restart give one wallet with the balance unchanged.
- Monolith activation delivery: retry, restart and lease.

## 7. Questions for A / B / D

1. **A:** do the names and shapes in §1, §3 and §4 work for the router? Is a stored-result replay for create plus an effective-state reply for activate acceptable?
2. **A:** should `get` keep strict `CreatedOperation` for `activated` (my proposal), or should it gain a readiness field through a contract change?
3. **B:** the `callerId` format for Booking. C only stores and compares it.
4. **D:** retry and backoff values for activation delivery. The existing saga defaults apply until then.
