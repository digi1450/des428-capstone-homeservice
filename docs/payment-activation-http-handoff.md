# A activation HTTP handoff — 7 November 2026

Status: the Payments activation HTTP route is implemented against C's participant merged in #27, including allow-listed conflict serialization, OpenAPI 0.3 and isolated HTTP/PostgreSQL tests. **Production is still unwired:** `server.js` injects neither B's service verifier nor the participant. Default requests return 503; no live Booking saga/caller switch or fake production verifier is added.

Read the [confirmed A/C interface](c-payment-participant-interface.md), [selected decisions](payment-participant-decisions.md), [command handoff](payment-command-http-handoff.md) and [OpenAPI](../contracts/payment-intents.openapi.json). C confirmed the interface in [#25](https://github.com/digi1450/des428-capstone-homeservice/pull/25#issuecomment-6707477381). The earlier reserved/unavailable activation description in the #22 snapshot is superseded by this handoff.

## Request and success

`POST /internal/payment-intents/activate-by-command` uses B's existing `authenticateService(req,{operation:'activate'})` seam, verifies the normalized Booking service identity and passes its stable `callerId` to C. Body/header/query fields do not choose the caller. No authorization token is passed into C.

- `Idempotency-Key`: a stable activation command id, 1–128 characters in the existing grammar. It must differ from the original create id; C's shared command store rejects reuse across already-recorded kinds/targets, including a cancel command. The HTTP request does not carry a cancel key and cannot validate an unknown future cancel id.
- Strict JSON body: `{ create_command_id, saga_id }`; reject extras, missing/invalid fields, exact dot segments and oversized bodies and unsupported encodings under the existing 16 KiB parser. Invalid input 400, wrong media/encoding 415, oversized body 413.
- Delegate exactly once to `paymentCommands.activate({callerId,commandId,request,context})`, where context contains requestId/optional trace headers only. C owns the transaction, command storage, effective fence and settlement eligibility. A makes no direct SQL/business primitive shortcut.
- C returns `{replayed,result}`. Both fresh and replay success produce **200** `{create_command_id,saga_id,outcome:'activated'}`. A validates the exact wrapper/result shape and matching command/saga identities, rejects private/extra/malformed results with 503, and never exposes the replay wrapper/storage fields.

Successful activation is an acknowledgement of eligibility, not a charge. C must recheck effective fences on replay; an old successful activation cannot override a subsequent cancellation. HTTP responses retain no-store/request correlation behavior.

## Conflict and failure contract

The shared Payments serializer exposes **only** `HttpError` status 409 with `code === 'PAYMENT_SETUP_CANCELLED'` as `{error,requestId,code}`. It supports C's current error objects without changing their constructor/call signature. The same reviewed code may be returned by a fenced create; OpenAPI 409 responses now use the explicit coded/uncoded union. Existing strict `Error` remains unchanged for all other errors.

- Coded 409: confirmed setup cancellation from the participant, for the future activation client to validate and classify.
- Uncoded 409: changed key input/kind/target, unknown provisioning or mismatched saga; reconciliation, not an assumed fence.
- Other/unreviewed codes, and the cancellation code on non-409 statuses, are not serialized. Unexpected exceptions remain sanitized 500. Missing verifier/participant, or invalid participant result, return 503 with Retry-After 2. No HTTP status alone authorizes slot release.

The original HTTP-only change did not add Booking's activation client/adapter. The subsequent [activation client extension](payment-activation-client-handoff.md) now supplies the adapter and validated coded/uncoded 409 handling. Existing create/query/cancel non-success behavior remains unchanged. No live startup/recovery wiring is enabled by either change. The #29 lease/classification review and #30 consumer lifecycle review are separate C fixes, not resolved here.

## Next ownership and activation gates

A's [step 2 transport/adapter](payment-activation-client-handoff.md) is now implemented; next is Booking payment-setup UI/callers. C provides corrected durable monolith activation state/upgrade/recovery and wallet delivery. B still provides the real Payments JWT verifier/permissions; the token redirect issue was separately fixed in #31. Later A composes the verifier, participant and settlement/outbox hooks, without opening traffic until the real integrated auth/race/restart checks pass. E's Pact/tracing/final stack and legacy-data eligibility/cutover gates remain pending.

## Validation performed

- Node 22 + isolated PostgreSQL 16, no host ports/useful data: **Payments 63 passed, 0 failed/skipped**, including actual HTTP → C participant → PG create/activate/replay, effective eligibility, uncoded conflicts, cancel then replayed coded fence, one stored activation command and one intent.
- Existing HTTP/PostgreSQL client boundaries: **4 passed, 0 failed/skipped**. The existing monolith transport is unchanged.
- `npm --prefix contracts test`: **18 passed**, including OpenAPI validation, activation fixtures, strict result/code schemas and malformed cases.
- Node syntax checks for all changed JS and `git diff --check` passed. Service HTTP tests additionally verify auth-operation denial, strict request/media/size rules, invalid C results and code stripping on non-409/unexpected errors.

The PG harness used a disposable `homeservice-c-review` project with Node 22, PostgreSQL tmpfs and a read-only repository mount; resources were removed after the run. Existing C participant race checks also passed within the 63-test suite. No Keycloak, full-stack Compose, Pact, monolith restart suite or live migration was run for this service/contract-only change. Tests use explicit auth doubles, not real JWT verification. No dependencies, schema migrations, business participant implementation or default startup composition changed.
