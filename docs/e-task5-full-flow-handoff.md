# E Task5 — selected full-flow telemetry

Based on main9ad496a (PR56/57 merged), 10 November 2026. PR57 already closes
Task4's fresh authenticated16-service deployment. This extends that runner;
it does not repeat auth/onboarding implementation or change its activation gates.

## Implemented

- Monolith OTel SDK starts once per process before application boot, with explicit
  manual request/AMQP instrumentation. Dependencies are pinned to API1.9.0 and
  SDK/exporter0.208.0, whose declared engines support the retained Node20 runtime.
  Services keep their existing Node22/SDK0.301.0 dependencies. No framework upgrade.
- Shared request context works across Next instrumentation/API bundles. Route
  spans and structured completion logs carry trace/request IDs. Public request IDs
  are bounded to the same128-character allowlist as the extracted services.
  Span route names normalize integer/UUID IDs; query/body/token/OTP/actor/baggage
  and raw exception messages are excluded from the new instrumentation.
- Existing user/Booking/original-webhook credentials are preserved. Only safe
  metadata from the active request span is added to outgoing service calls.
  Background recovery never gains browser authority or borrows another request.
- `insertEvent` commits an allowlisted carrier in monolith-owned
  `event_trace_context` in the same SQLite transaction as the outbox row. Domain
  payloads, public envelopes and business schemas are unchanged. Publish restores
  that carrier from ROOT_CONTEXT, creates a producer span and injects a fresh child
  header. Retries preserve the saved carrier/event ID. Missing/invalid carrier
  starts a root, never inherits an unrelated relay span.
- Monolith payment/rating consumers and the Payments wallet consumer now wrap
  actual parse/effect/ack in processing spans. Existing retries, dedupe, supervisor,
  queue/DLQ policy and acknowledgements remain in place. Error spans finish before
  the existing retry handler receives the original error. Successful consumer logs
  include trace IDs, enabling correlation with HTTP logs.
- PostgreSQL healthchecks use TCP; the temporary first-boot Unix socket is no
  longer mistaken for readiness before the application can connect over TCP.

## Schema compatibility

The additional metadata table references its owning event with ON DELETE CASCADE.
The existing conservative startup migrator recognizes the exact previous main
fingerprint `6a323e7e3610be0b37cc4f69353b38b2f4ccfee9d0695ffb4759d83c870bb21d`
and adds only this empty table atomically. It never invents historical trace
parents or changes old event UUID/publication/lease/retry state. Older reviewed
activation/financial-work upgrades still apply in sequence; unknown schemas and
markers fail closed. Old application images cannot validate the newer schema;
rollback requires a reviewed compatible image/backup procedure, never deleting a
marker or dropping the table to bypass the guard. No useful database was upgraded
during this task. The offline legacy exporter still exports business history,
not this transport-only metadata; its distributed-state guards are unchanged.

## Reproduce and verify

Requires Docker Compose v2, Node22+, OpenSSL and the free ports/headroom documented
in [the existing runner](../tests/final-stack/README.md). In PowerShell:

```powershell
$env:FINAL_STACK_TELEMETRY='true'
node tests/final-stack/run.mjs
```

On POSIX, `FINAL_STACK_TELEMETRY=true node tests/final-stack/run.mjs`.
Use a new project only. The runner checks an ownership marker and refuses existing
containers/volumes; faults and cleanup select only its disposable project. Shared
auth/cutover/signup defaults stay false. `FINAL_STACK_KEEP=true` retains that
disposable stack for diagnosis; its directory contains secrets and must stay private.

The verifier retrieves actual Jaeger traces by the generated IDs and checks
service names, queue names and parent-child relationships, not just span presence.
It also fetches the authenticated provisioned Grafana dashboard and evaluates its
exact three PromQL expressions, requiring finite values for both owning services.
Only correlated allowlisted HTTP/consumer log fields are saved. The checked-in
summary contains synthetic trace/event/request IDs, no credentials or user data.
Jaeger is in-memory: trace checks happen before the restart and do not prove
historical retention. CI repeats the full acceptance with a new run-specific
project on relevant PR/main changes or manual dispatch.

See [dated local evidence](validation/e-task5-full-flow-2026-11-10.md).

## Limits and remaining work

This supplies real telemetry evidence for the three named flows; it is not a claim
that every recovery/financial/error path is one trace. Recovery rounds after a
process crash may start new traces; business operation/event IDs remain durable.
Whole-stack recovery/idempotency/owner counts are rerun from PR57, not replaced
by spans. Broader D fault scenarios, sampled peak/load8GB acceptance, graphical
browser on latest main, offline clean-clone/image packaging, four final demo scripts,
dossier and recording remain. Historical identities/data/watermark eligibility
and coordinated cutover are separate A/B/C gates. Local passing evidence is not
GitHub CI or a merge claim. AI assisted implementation, review and validation.
