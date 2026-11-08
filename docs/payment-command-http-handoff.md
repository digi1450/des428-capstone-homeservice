# A payment command HTTP shell — 7 November 2026

> Step 4 update: [runtime composition](payment-runtime-composition-handoff.md) now assembles C hooks and real readiness behind the B auth/explicit startup gate; earlier uncomposed-startup statements below describe the prior slice.

Current activation update: [activation HTTP handoff](payment-activation-http-handoff.md) implements the formerly reserved route and coded 409 serialization. Default production remains unwired. The rest of this document records the original #22 preparation; its reserved-route statements are historical.

Original #22 status: create/query/cancel routing, validation, B/C injection seams and HTTP boundary tests are implemented. **This is preparation, not durable Payments participant implementation or live saga activation.** Default `server.js` injects neither internal service verifier nor command adapter, so registered internal routes return 503. The activation path is reserved/unavailable and cannot dispatch arbitrary injected code. No command/fence/eligibility tables, settlement routes or actual monolith caller switch are introduced here.

Read [selected decisions](payment-participant-decisions.md), [draft OpenAPI](../contracts/payment-intents.openapi.json), [consumer client](payment-adapter-handoff.md), [C saga](c-saga-handoff.md), [business primitives](payments-business-handoff.md) and [validation](validation/payment-command-http-2026-11-07.md).

## HTTP behavior

| Method/path | Shell behavior with explicit B/C integration | Default runtime |
|---|---|---|
| POST `/internal/payment-intents` | Validate stable create key/body; delegate; verify C outcome; 201 for fresh, 200 for replay | 503 |
| GET `/internal/payment-operations/{create_command_id}` | Scope lookup by verified caller + original key; return validated created/cancelled outcome; absence 404, never a cancellation fence | 503 |
| POST `/internal/payment-intents/cancel-by-command` | Require different cancel/create keys; delegate; only matching durable cancelled outcome can produce 200 | 503 |
| POST `/internal/payment-intents/activate-by-command` | RESERVED: no finalized success/body contract; always unavailable even if an `activate` function is supplied | 503 |

Request bodies use the existing strict draft fields, int32 IDs/cents, THB currency and command/saga key grammar (reject exact `.`/`..`). POST requires application/json, max 16 KiB, uncompressed; malformed JSON/shape 400, unsupported media/encoding 415, too large 413. Query accepts no query-string caller hints. Correlation/trace metadata are passed separately from command body; credentials are not passed to C. Valid trace forwarding is not itself a live OTel/auth claim.

C results are validated before successful serialization: exact public shape, matching command/saga and create order/amount, valid intent state. Invalid/private/mismatched results return sanitized 503, not false success or leaked storage fields. Missing C methods/auth also return 503 plus Retry-After 2 (consistent initial engineering hint, not measured D retry policy). Expected HttpError 400/401/403/404/409 remains explicit; unexpected errors are scrubbed by existing handler. A command error/404 is still UNKNOWN through the existing monolith client: never release slots based only on an HTTP status.

## Proposed callable boundary for C — review/adapter needed

C proposed matching exports in PR #24. [A's interface response](c-payment-participant-interface.md) records accepted shapes and clarifications, pending C confirmation; it does not change the current shell behavior. In particular the coded activation error/client handling is still A implementation work.

`createApp({ database, authenticate, authenticateService, paymentCommands })` preserves the existing end-user read verifier `authenticate` and adds separate internal injection points. These are A's concrete HTTP-adapter proposal, not a claim that C has agreed/implemented these exact names. C may expose these methods or provide a small adapter around its own module; agree before live wiring and do not implement duplicate command stores.

```js
paymentCommands.create({ callerId, commandId, request, context })
// -> { replayed: boolean, result: CreatedOperation }
paymentCommands.get({ callerId, createCommandId, context })
// -> CreatedOperation | CancelledOperation | null (unknown lookup)
paymentCommands.cancel({ callerId, commandId, request, context })
// -> CancelledOperation, only after durable cancellation/fence confirmation
```

`request` is the validated create/cancel DTO from the draft. `context` contains requestId and optional traceparent/tracestate, not the bearer token. `callerId` comes only from B's verified service identity. C scopes result/digest/fence/lookup by stable caller/operation/key, binds immutable business context and serializes concurrent work. `replayed` is supplied by C, not inferred by the router or held in memory. The shell makes one call; it creates no keys, retries, SQL transactions or business effects directly.

C's command transaction must join business primitives and outbox with the same database client where applicable. Do not simply wrap `prepareIntent()`/`voidUnpaidIntent()` in a successful HTTP response: neither implements durable command replay, absent-create fence or settlement eligibility. See the C/business handoffs for lock order and cancellation behavior. `paymentCommands.get()` must return the effective fenced/cancelled outcome rather than a failed intent in a created-success DTO.

## B authentication seam

`authenticateService(req, {operation})` verifies Keycloak signature/issuer/expiry/audience plus service permission for create/query/cancel/activate, then returns:

```js
{ service: "booking", callerId: "stable-verified-issuer|client-subject" }
```

This is a proposed normalized identity, not a dictated raw JWT claim layout. B chooses the real token mapping/scopes. `callerId` must be stable across token rotations and bounded printable non-space text, never the access-token string. The router requires bearer syntax, rejects malformed principals and any non-Booking service; it does not verify JWT cryptography itself. Raw X-Role/X-User-Id/body/query data are never authority. A user/admin read principal is not a service principal. No header-based or env-enabled fake verifier is added to production; tests inject explicit doubles only.

## Activation and next integration

The lead selected durable HTTP activation, successful Booking with payment-setup-pending UI, and asynchronous wallet provisioning. Those choices remain unchanged. Exact activation DTO/reply/replay-after-fence and C callable interface still need A/C agreement; OpenAPI marks the reserved operation without promising any 2xx response. No activate client method, durable activation delivery, payment-ready UI or wallet flow is implemented by this shell.

Next: agree/adapt C interfaces, implement its result/fence/eligibility module, settle activation state/replay and B claims, then mount real adapters/credentials. Update activation contract, client, recovery and callers together. Test real create/replay/cancel races, restart, effective settlement gate and real auth before configuring live Booking saga. E may use current shell examples for contract preparation but cannot treat doubles as real durable provider/Pact verification. Public nginx still blocks `/internal`; Booking calls the private service directly.
