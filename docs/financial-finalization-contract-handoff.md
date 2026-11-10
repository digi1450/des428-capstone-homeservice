# Step 5C — exact financial finalization contract v1.0.0

10 November follow-up: [legacy manifest and target1.1 artifacts](legacy-manifest-contract-handoff.md) extend the selected interface with audited legacy bindings. This retained v1 spec still describes the current runtime; target1.1 is separate and not implemented/activated by conformance tests. Earlier runtime-pending statements below are dated history, not a reversal of merged A/B/C acceptance.

8 November 2026, based on main `7cbec6a` and the
[lead-selected baseline](financial-finalization-decisions.md).
Initial delivery supplied schemas, fixtures, conformance validation and CI.
**Superseding runtime update, 9 November:** A HTTP/client/callers are now prepared;
read [runtime handoff](financial-finalization-runtime-handoff.md) for the exact
injection and evidence limits. C durable financial persistence/work/recovery,
B real verification and production activation are still pending.
Existing legacy endpoints keep their behavior; new projection contracts below
apply only to the later coordinated financial mode. Do not enable any selector
or candidate gateway based on static contract tests.

## Sources of truth

- [OpenAPI](../contracts/financial-finalization.openapi.json), v1.0.0: strict
  requests, result unions, public projections, status/auth boundaries and callable
  metadata. It is separate from provisioning's existing payment-intents contract.
- [Fixtures](../contracts/fixtures/financial-finalization.json): named synthetic
  gateway/COD operations, ready/pending/attention, public results, webhook acks
  and allow-listed conflicts. None contains real tokens, users or databases.
- [Reference validator](../contracts/validation/financial-finalization.mjs):
  development-only schema and cross-field checks. Runtime services must implement
  equivalent validation in their own code, not import this dev tool or interpret
  it as JWT/DB/workflow proof.
- [Tests](../contracts/test/financial-finalization.test.js): OpenAPI validity,
  accepted/rejected shapes, request/key/result binding, arithmetic and status
  classification. Cross-field checks are mandatory: OpenAPI structural validation
  alone cannot prove header/body equality or money arithmetic.

## Requests and identity

| Route | Verified caller/operation | Request |
|---|---|---|
| POST /internal/booking-completions | Booking / complete_financial | CompletionRequest, Idempotency-Key complete:<operation_id> |
| POST /internal/booking-cancellations | Booking / cancel_financial | CancellationRequest, Idempotency-Key cancel:<operation_id> |
| GET /internal/financial-operations/{command_id} | Booking / query_financial | Saved command key; no additional query fields |
| POST /api/payments/webhook | Mock gateway / settle_webhook | gateway_event_id, type=payment_intent.succeeded, gateway_ref |

All command requests have operation_id (canonical lowercase UUID), order_id,
customer_id, provider_id, amount_cents, currency=THB and payment_method. Completion
also has commission_cents (0..amount_cents); cancellation has
reason=customer_cancelled. IDs are positive PG INTEGER values; money is a
nonnegative integer within PG INTEGER range. Command JSON is strict, limited to
16 KiB and supported application/json encoding. No OTP, browser role, user token,
email, arbitrary money field or extra property is permitted internally.

Gateway v1 requires `provisioning:{create_command_id,saga_id}` from its saved
reviewed Booking saga. COD forbids that property and needs no invented intent or
saga. This version does not adopt imported gateway intents without reviewed
provisioning references: A/C's legacy eligibility/migration gate remains open.
Do not manufacture keys to satisfy the schema. If legacy support requires a
contract extension, version and review it with the importer and C state model.

Booking derives/persists one operation UUID and immutable snapshot in the local
transition/work transaction, not per HTTP retry. Callback gateway event IDs are
separate from command keys and request/trace IDs. Same caller/operation key plus
identical snapshot retries the same work; changed context conflicts. C preserves
existing provisioning command identity constraints and prevents accidental aliasing
between old provisioning cancellation and new financial cancellation; it must not
reinterpret one protocol's key/result as the other's operation.

## Result and HTTP interpretation

Each operation result is strict:
`{command_id,kind,request,state,...stateFields}`. Kind is completion/cancellation;
request echoes the entire validated original snapshot; command identity must
match the route/key and echoed operation_id. The transport validates that echo
against its expected saved request, not only its JSON shape.

| HTTP result | Meaning / Booking action |
|---|---|
| POST 200 with validated ready | Ready financial result; apply the appropriate local acknowledgement/finalization. |
| POST 202 with validated pending | Durably accepted work still pending; retain the same key and recover. |
| POST 409 with validated attention | Durable operation needs recorded reconciliation; no guessed success or slot release. |
| 409 coded conflict | FINANCIAL_COMMAND_CONFLICT, FINANCIAL_CONTEXT_MISMATCH, FINANCIAL_OPERATION_BLOCKED or FINANCIAL_LEGACY_RECONCILIATION_REQUIRED; record attention, not automatic safe cancellation. |
| Uncoded/malformed 409 | Uninterpretable conflict: reconcile; do not parse error text as a fence/refund. |
| GET 200 | Lookup succeeded only. Inspect the matching result's ready/pending/attention state. |
| GET 404 | Unknown for this caller; retry/query original work, never infer safe cancellation or create a fresh key. |
| Timeout, malformed success, 500/503 | Financial outcome unknown; keep pending/guard/holds and recover from the same durable work. |
| 400/413/415 or 401/403 | Fix invalid contract/auth/permissions through recorded operational handling. These errors are not evidence of financial failure/safe release. Avoid blind permanent-error loops. |

Pending reason is processing; gateway completion additionally permits
awaiting_settlement. A COD completion cannot wait for a nonexistent gateway
charge. Pending progress may become ready/attention under the same command and
immutable request; a terminal ready result and its effects replay unchanged.
Attention is not ready and is not automatically retried into success; manual
resolution must be explicit/auditable, not a changed payload with an old key.

Completion ready includes `accounting:{transaction_id,kind,amount_cents}`.
Gateway kind is payout_credit and amount=total-commission; COD kind is
commission_owed and amount=commission. C must additionally enforce actual settled
charge eligibility, refund/cancellation guards and snapshot consistency under
its existing order lock, with accounting+result in one owning DB transaction.
A schema/echo/arithmetic check does not verify those database facts.

Cancellation ready requires `settlement_fenced:true`. Outcome is no_payment,
voided (requires voided_intent_id) or refunded (requires refund_transaction_id).
COD permits only no_payment. These are explicit durable safe results, not any
arbitrary 200. C serializes fence/void/refund/completion/settlement under the
reviewed lock order and rejects refund after completion accounting. Pending and
attention carry no asserted refund or safe-fence field. A must not release slots
or mark cancelled from them.

## C callable seam and B verifier seam

A's router injects a `financialOperations` object; no duplicate A store:

```js
// Interface only, not an implementation.
complete({callerId, commandId, request, context})
// -> {replayed: boolean, result: CompletionOperation}
cancel({callerId, commandId, request, context})
// -> {replayed: boolean, result: CancellationOperation}
get({callerId, commandId, context})
// -> FinancialOperation | null
```

C commits accepted pending/attention/results atomically with the corresponding
owning state/effects. A validates the wrapper/result before returning it and maps
state to the status table above; the replay flag is not part of the public wire
result. C can throw reviewed typed conflicts for rejected/changed commands
without overwriting a prior accepted result. Metadata context is allow-listed
requestId/traceparent/tracestate only, never authorization authority or a token.

B supplies `authenticateService(req,{operation})` for the three financial labels,
returning `{service:'booking',callerId:<stable string>}` after real verification.
Audience is payments-wallet-service; B maps permission labels to its actual
roles/scopes. Stable caller identity survives refresh. Webhook uses a DISTINCT
`authenticateWebhook(req,{operation:'settle_webhook'})` returning a verified
`{service:'mock-gateway',callerId:<stable string>}`.

The OpenAPI fixes bearer transport for the new callback. B owns credential
provisioning and actual validation/permissions; flag incompatibility rather than
introducing a fallback. No customer token, Booking principal, decoded claim/raw
header or implicit legacy webhook-secret alternative may authenticate that new
callback. The old monolith shared-secret endpoint remains unchanged until the
coordinated switch. Nothing in this PR supplies production credentials.

Webhook ack retains the public `received:true` plus exactly one existing branch:
replayed:true, or replayed:false+settled:true, or
replayed:false+already_settled:true. PG receipt/charge/outbox transaction and the
Booking payment.succeeded consumer remain C/A's owning paths. Retry the same
gateway event on unknown acknowledgement; never return received success for a
failed/unknown transaction. No new event schema is introduced.

## Public Booking mode and pending visibility

The prepared financial-mode completion route keeps provider/OTP ownership checks
and the existing flat completed order fields, adding accounting_status
pending/ready/attention. It returns 200 once completed+work is durably committed,
even if accounting is pending. No financial success is inferred from that 200.
OTP stays a public input to Booking only and is not forwarded to Payments.

The prepared cancellation route accepts no body or an empty JSON object only.
202 returns `{order:<awaiting|confirmed>,cancellation_status:'pending'}`; keep
holds and C's local transition guard. 409 may expose the corresponding attention
projection. Terminal 200 returns `{order:<cancelled>,refunded:boolean,
cancellation_status:'ready'}`. Refunded true requires a gateway/refunded order;
a safe no-refund result has payment_status pending. This preserves the current
cancellable states; rescheduled/started cancellation is not newly enabled.

Public callers need not mint internal command keys. C's local work identity is
created once per accepted logical order operation and recovered on same-owner
retries; do not create a new work UUID just because the HTTP response was lost.
Completion replay still verifies provider and OTP; cancellation replay verifies
customer. Existing detail GET must expose applicable accounting/cancellation
status when implemented, so refresh can inspect pending work. Its full existing
items/participant/OTP projection is not redefined by this contract. A now prepares UI, replay responses and detail projection through the injectable
C Booking adapter; C must supply the actual durable work implementation.

## Remaining implementation and evidence

A validation/router/client/callers are now prepared and fail closed without C/B;
see the linked runtime handoff for the superseding execution evidence. C owns new participant/work/guards/recovery/migrations;
B real verification; D faults; E final processes/tracing/Pact. New C schema must
be reviewed against importer and preserved SQLite startup before activation.
Do not enable #40/#41/#42 selectors or route webhook traffic to an unmounted API.

Local conformance run: **29 tests passed** (19 existing + 10 new), no failures,
skips or cancellations, Node 22 in a network-disabled container with read-only
source. OpenAPI parser and fixtures/reference invariants passed. A dedicated
`API schemas and fixtures` job is added alongside existing Pact CI; ordered
consumer/provider Pact execution is unchanged. Existing Pact coverage remains the Notifications and wallet-read boundaries;
financial HTTP boundary tests are separate, not newly claimed Pact verification. No application/business,
real SQL/HTTP/auth/race/recovery/Jaeger/load evidence is claimed from these static
tests; their acceptance cases remain in the selected baseline.

```sh
npm ci --prefix contracts
npm test --prefix contracts
```
