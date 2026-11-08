# Step 5C — lead-selected A/C/B implementation baseline

8 November 2026. Source reviewed at main `884d557` after PR #42.
**The team lead has selected both the six policies and the technical approach
below as the implementation baseline.** This supersedes PR #43's earlier
proposal/review-before-code status. A/C/B can proceed within their ownership
without waiting for separate teammate approval of this direction. Adoption by
the lead is not evidence that teammates have been notified or acknowledged it,
or that routes, schemas and integration are implemented. No financial runtime,
data, auth or routing change is made here.

A owns the next concrete deliverable: versioned OpenAPI, exact payload/error and
callable-interface fixtures, then endpoints/client/callers. C/B implement against
that common contract and this baseline; do not invent conflicting interfaces in
parallel. Report an implementation blocker or unsafe/incompatible assumption for
coordinated revision instead of silently changing it. Existing integration,
migration and real-auth verification gates still apply before activation.

> Exact v1 contract follow-up: [wire/callable handoff](financial-finalization-contract-handoff.md) and [OpenAPI](../contracts/financial-finalization.openapi.json) supply A’s request/result/status fixtures. Implementation and real integration remain pending.

## Lead-selected policies

| Decision | Selected behavior |
|---|---|
| A/C split | A implements endpoints, validation/transport, clients and monolith callers. C owns durable command/result, dedupe, recovery and cross-service consistency coordination. |
| Completion visibility | After valid provider/OTP checks and an atomic Booking completion + durable-work commit, Booking is completed; accounting stays pending until Payments confirms. |
| Cancellation visibility/slots | Do not finalize cancelled or release reserved slots until Payments confirms a safe financial result. |
| Settlement versus cancellation race | Serialize under the same Payments order lock. Cancellation winning first fences future settlement; an earlier successful charge follows the eligible refund path. Never automatically refund after payout. |
| Unknown/conflicting outcomes | Retry/query the same durable command identity. Unknown remains pending with automatic recovery; contradictory/uninterpretable outcomes go to attention rather than fabricated success. |
| Webhook ownership | Payments owns callback receipt, charge and outbox. Booking applies paid from payment.succeeded. Preserve the public callback path and offline mock gateway; B defines callback authentication, separate from customer credentials. |

These decisions extend [prior participant decisions](payment-participant-decisions.md),
not replace their create/activate/cancel provisioning protocol. See
[caller audit](a-step5-caller-audit.md) for remaining direct SQLite writers.

## Current source constraints — verified, not new implementation

- Monolith `lib/modules/booking/service.js:completeBooking` still couples Booking
  completion to SQLite payout/commission writes. `cancelBooking` still releases
  slots and records a local refund. Both must be replaced as whole flows.
- PG `services/payments-wallet/src/service.js` already provides `applyCompletion`,
  `applyRefund`, `voidUnpaidIntent` and `settleWebhook`. These primitives are not
  durable completion/cancellation transports or a Booking recovery workflow.
- Existing `applyCompletion` checks an eligible-looking intent for gateway mode
  but does not itself require a succeeded charge. The new orchestration must
  enforce the selected payout eligibility; the baseline below defers payout until
  real settlement is confirmed. A primitive's existence is not sufficient proof.
- C's participant handles create/query/cancel/activate **provisioning**, not full
  paid cancellation/refund/completion. Its current command schema has kind and
  provisioning identity constraints. Do not stuff new financial commands into
  those fields unchecked or build a duplicate A-owned command store.
- COD/custom-job completion has no gateway intent/create-command identity.
  Financial workflow design must cover it without fabricating an intent/saga.
- `payment.succeeded` already has monolith-owned Booking and independent
  Notifications consumers. PG receipt/charge/outbox staging and per-order lock
  are already present. Reuse them instead of cross-reading/writing SQLite.

## Technical baseline — selected by the lead

### Durable identities, transport and trusted context

Selected internal route baseline (not mounted; A still authors versioned OpenAPI):

| Route | Purpose |
|---|---|
| `POST /internal/booking-completions` | Apply one trusted completion snapshot to Payments accounting. |
| `POST /internal/booking-cancellations` | Atomically fence further settlement and determine/apply the appropriate no-payment/void/refund result. |
| `GET /internal/financial-operations/{command_id}` | Query the durable financial command result, scoped to its authenticated stable caller. |
| Existing public `POST /api/payments/webhook` | Preserve callback path, move the reviewed handler into Payments. |

Use `Idempotency-Key` for commands and B's verified Booking service credentials.
Persist a lifecycle operation UUID once in Booking; use the stable key forms
`complete:<operation_uuid>` or `cancel:<operation_uuid>`. All attempts, recovery
and status queries refer to the same saved identity and canonical payload.
Request/correlation/trace IDs are separate metadata, never idempotency keys.
Stable caller identity must survive token refresh. Same caller/key/kind/body
returns the stored result; changed operation/context with the same key conflicts.

A trusted snapshot comes from Booking's locked authoritative row, not from browser
money/owner fields. Required immutable context: operation UUID, order/customer/
provider IDs, total minor units, currency and payment method; completion also
includes frozen commission minor units. Include existing provisioning references
for gateway orders only when applicable. Never send OTPs, identity profiles,
passwords or user tokens as financial payload. A specifies exact field names,
optional/required cases and strict response/error fixtures in the common versioned
contract; C/B flag constraints or incompatibilities rather than create a second
contract. They need not re-approve the selected direction before work proceeds.

C owns schema/storage/migration and any required participant extension. Reuse the
existing lock order: do not take an order lock then call code that acquires the
provisioning lock in reverse. Completion/cancellation and settlement must share
order-level serialization while accounting/fence/result persist atomically in
Payments' owning transaction. A passes C's SAME transaction client to existing
business primitives; no HTTP inside SQLite/PG transactions. C's final schema
changes trigger A importer/startup review before merge/activation.

A durable command lookup returning 404 is unknown, not evidence that the command
failed or cancellation is safe. Retry the original operation; never mint a new
key to escape an uncertain or conflicting result. A recovery claim must prevent
a stale worker from finalizing a newer state. Numeric timeout/backoff/fault policy
remains D's integration work, not a newly selected value here.

### Completion flow

1. In one Booking transaction, verify provider, OTP and legal local state under
   the state-transition guard; record completed, frozen financial context and
   durable completion work/key. Existing completion/status domain events must be
   consistent with that local commit. No local wallet/ledger write in new mode.
2. Commit before calling Payments. Completion stays visible, with accounting
   pending; worker retries/query use the saved key and context after restart.
3. Payments acceptance: reject context mismatch, cancellation/fence or
   refund conflicts. COD records commission once without an intent. For gateway
   payout, require a matching successful charge and no refund; if settlement is
   still genuinely unresolved, do not credit a payout from a merely existing
   intent. A defines distinct pending versus attention wire codes; C must return
   the corresponding durable outcomes and flag any implementation blocker.
4. Terminal acknowledgement marks accounting ready locally; unknown transport
   stays pending. Contradiction moves work to attention without silently reverting
   physical completion, resetting money or issuing another payout command.

Selected public projection: additive `accounting_status` of pending/ready/attention
on the existing completed order. A records its exact wire schema/status and replay
fixtures in the common contract, then updates schemas, UI and replay bodies
together. No unimplemented response is claimed to be served by this document.

### Cancellation/refund/void flow

1. Booking authorizes customer and legal cancellation, then records durable
   cancellation work plus a local pending-transition guard. Keep the original
   nonterminal order and holds until the financial acknowledgement. The guard
   must block competing start/confirm/complete/reschedule and conflicting cancel
   work in the same local transaction; otherwise a delayed cancellation could
   target an already-completed booking. C owns this guard/recovery design.
2. Payments handles one cancellation command under the reviewed locks. Persist
   the settlement fence with the terminal result, covering late create/activate/
   settle requests for that same order. An unpaid gateway intent can be voided;
   an already settled matching charge can be refunded once if no completion
   accounting exists. COD has no gateway refund, but still needs a durable safe
   result and mutual exclusion with commission/completion.
3. A successful response must explicitly distinguish safe no-refund/void/refund
   outcomes. A generic 200 or provisioning-only cancel is not enough evidence
   that a paid booking was refunded. Completion accounting or mismatched money/
   identities goes to conflict/attention, never an automatic extra refund.
4. Only after validated terminal financial acknowledgement does Booking atomically
   mark cancelled, release holds, update refunded if actually confirmed and emit
   its status event. Keep the financial operation identity for replay/recovery.
   If Payments committed but the acknowledgement/local finalize was lost, recovery
   finalizes from the same saved result; a stale worker cannot cancel newer work.
5. Pending/unknown keeps holds and the local transition guard. Definitive rejection
   versus an uninterpretable conflict needs separate reviewed codes so recovery
   does not retry permanent contradictions forever or unlock a still-unknown
   financial command. Manual resolution is recorded, not a fake success.

Selected pending response: 202 with current order plus
`cancellation_status:'pending'`; do not assert `refunded:true` or a final cancelled
state. Terminal response preserves `{order,refunded}` and adds status metadata if
needed. Pending callers must not interpret a missing/unconfirmed refund as a
successful no-refund result. A writes the exact wire union/UI/HTTP replay fixtures;
C's implementation must preserve these semantics and report incompatibilities.
No new order-status enum is selected by this document.

A delayed payment.succeeded after a confirmed refund/cancellation must not revive
Booking. Review its expected historical-event handling with C's existing attention
policy; do not treat the event arrival alone as current settlement authority.

### Webhook and real authentication

Preserve the existing callback payload shape for the offline simulator, subject
to owning-service validation of supported type/reference/event identity. B defines
verified callback credentials and required audience/permissions; do not substitute
a customer token, accept a decoded claim/raw role header or silently reuse Booking
command identity as the mock gateway. There is no new default secret/token bypass.

Payments validates callback authentication before effect processing. The existing
receipt identity detects changed replay payloads; one transaction couples receipt,
settlement eligibility/fence checks, charge and outbox. Repeated event IDs, different
event IDs for the same intent and timeout/retry cannot create another charge.
Keep existing payment.succeeded ownership/schema; Booking changes its own paid
flag through its consumer, not Payments SQL into orders. Final nginx candidate
routing must not expose a missing callback or internal command path.

## Ownership, delivery order and acceptance

| Owner | Next deliverable |
|---|---|
| A | Publish the common versioned route/response/client and callable-interface fixtures from this baseline, then HTTP wrappers and Booking/UI callers. Review C migrations against importer and preserved SQLite startup before enabling. |
| C | Implement completion/cancellation/query participant, persistent command/fence/result + Booking work/transition guards, claim fencing/recovery and atomicity/duplicate tests against the baseline and A contract. Cover COD and paid/refunded/legacy handling; report technical blockers. |
| B | Stable service principal, operation permissions and callback verifier, plus real end-user/domain mapping for public callers. |
| D | Validate bounded retry/fault behavior, concurrent operations, unknown outcomes and recovery under final policy. |
| E | Compose final workers/readiness, contracts/CI and trace/evidence once owner interfaces are implemented. |

Acceptance cases to implement (not results already observed):

- Provider/OTP failure changes no Booking/accounting/work; valid completion commits
  completed+work together even when Payments is unavailable; gateway and COD each
  apply the intended accounting once. No payout on an unconfirmed charge.
- C work/event insert failure rolls back the intended local transition; Payments
  command/fence/accounting failure rolls back all its result/effects together.
- Cancellation pending retains slots and blocks conflicting local transitions;
  acknowledgement loss/restart converges to one cancellation/refund and one
  release. Never release/claim refund from a timeout or unknown lookup.
- Settlement before cancellation yields one charge plus at most one eligible
  refund. Cancellation first prevents late settlement/create/activate. Completion
  versus cancellation cannot produce both payout and automatic refund.
- Same key/same snapshot replays; changed key target/payload conflicts. Stable
  caller across token refresh and stale-worker/recovery races are exercised.
- Webhook same/different event IDs, invalid credentials/audience, unsupported type,
  late callback after fence and changed replay payload are tested without PII logs.
- Legacy unpaid/paid/refunded/completed/COD fixtures and imported command metadata
  are explicitly reviewed; never invent old provisioning keys or activate every
  historical intent just to make new commands work.

Next: A authors the common versioned payload/outcome/callable fixtures and OpenAPI
from this selected baseline, without waiting for a separate C/B direction approval.
C/B can prepare their assigned components now and use that published contract for
integration. Do not ask the lead to choose these same policies/direction again;
report an actual technical contradiction or new product tradeoff explicitly for
coordinated revision instead of silently changing the interface. This is documentation only: no
new application tests were run, no teammate message/comment was posted and no
endpoint/auth/schema/runtime activation is claimed.
