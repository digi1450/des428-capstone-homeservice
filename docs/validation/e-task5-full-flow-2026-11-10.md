# E selected full-flow telemetry — 10 November 2026

Base main `9ad496a5994bc6ed3ed257bfcf2433f4e6dfd4a6` (PR57). Actual observed
local run on branch `feat/e-task5-full-flow`; no GitHub CI or merge claim here.
AI assisted implementation, diagnosis and verification. E remains area owner.

## Actual deployment result

**PASS22 assertion groups** in NEW disposable project
`homeservice-e-auth-task5-live`, using the actual four root Compose files and all
sixteen runtime services. Only the copied test env enabled auth/signup/cutover.
No shared flags, useful database/realm, host DNS/CA trust or unrelated stack changed.
The inherited runner snapshots source and uses real TLS Keycloak26.4.0, standalone
Node20 Next, independent Node22 Express/workers, owning PG16 databases and RabbitMQ.

```powershell
$env:FINAL_STACK_PROJECT='homeservice-e-auth-task5-live'
$env:FINAL_STACK_TELEMETRY='true'
$env:FINAL_STACK_KEEP='true'
node tests/final-stack/run.mjs
```

OpenSSL was supplied through OPENSSL_BIN on this Windows host. The complete run
exited0. [Sanitized transcript](e-task5-full-flow-2026-11-10.txt) and
[trace/panel/log summary](e-task5-full-flow-2026-11-10.json) are checked in.

## Actual trace and dashboard assertions

| Flow | Trace ID | Spans observed | Verified edges |
|---|---|---:|---|
| New provider profile → wallet | `f9e121018e33410f99ced13cf683a87a` |13| monolith HTTP → durable SQLite carrier/producer → independent Payments wallet consumer |
| Gateway webhook → paid Booking | `f7f7a2be69844868bd254a9317d7d2f2` |43| monolith HTTP → Payments HTTP → owning PG outbox parent → independent relay → monolith Booking consumer |
| OTP completion → notification | `4965d8e6b0974e9fad1d1c3b38cd6bda` |41| monolith completion/Payments present → monolith durable producer → independent Notifications consumer |

Assertions retrieve each actual trace by ID and verify span IDs/parent references,
service/queue/routing-key labels. This is not a synthetic in-memory exporter test.
The trace IDs are synthetic evidence, not auth/session IDs. Span counts are a
snapshot, not stable regression expectations. Jaeger is in-memory and its data was
lost on the deliberate whole-stack restart AFTER these assertions; these IDs are
historical evidence, not guaranteed live UI links or retention acceptance.

Authenticated Grafana dashboard API returned the provisioned dashboard and exact
PromQL expressions. All three expressions (P95,5xx percentage,request rate) returned
finite values for both `notifications` and `payments-wallet` in actual Prometheus.
This proves working query/provisioning/data paths, not peak latency/load targets.
Correlated HTTP/consumer JSON records were observed in edemand, Payments HTTP,
Payments wallet consumer and Notifications consumer logs. Allowlisted saved fields
exclude query/body/token/cookie/actor data. The verifier checked correlated records
for the generated test password and Booking/Gateway/session secrets and found none;
this is not an audit of every historical log or all possible secret values.

## Business/restart regression rerun

The existing PR57 acceptance also passed real login/refresh/stale replay, provider
signup/wallet delivery, service-role/private-route isolation, booking/activation,
paid webhook replay/BOLA, OTP completion, cancellation/refund replay, actual Payments
outage with holds preserved across Next restart, autonomous cancellation recovery,
and owning-PG exactly-one charge/payout/refund counts. Actual RabbitMQ stop/start
made all three independent workers go200→503→200 and reconnect.

Full sixteen-service restart preserved Keycloak/mapping/session/Booking/PG state;
logout revoked the app session afterward. All16 were running and every configured
healthcheck healthy. Each container reported OOMKilled=false and RestartCount=0
afterward. Configured ceilings still total6.250GiB; neither that arithmetic nor
this functional run proves peak8GB acceptance. Only the marked Task5 project was
stopped after evidence collection, with volumes retained.

## Focused regression

- Full Node20 monolith: **296 passed**,0 failed/skipped, isolated in-memory DB.
  Includes existing business/auth suite, all three exact historical startup
  fingerprints, preserving current-main rows/publication state, atomic carrier
  persistence, retry immutability, safe context isolation and normalized route names.
- Stronger active-context transaction rollback assertion rerun: **1 passed**.
- Payments tracing tests on its Node22/SDK0.301.0 image: **6 passed**,0 skips.
  The new wallet processing case preserves the publisher parent, returns the
  original failure and marks the span before retry handling without raw exception
  details. Existing publisher cases still pass.
- Read-only legacy exporter fixture suite with the added metadata schema:
  **17 passed**, using Python3 in an isolated container.
- Root Compose configuration and `git diff --check` passed.

The full suite used a test target with `/contracts` and `/infra` readonly mounts;
no running demo volume or live credential was supplied. Other suites are left to
the PR workflows; local skips are not counted as evidence. The new hosted workflow
repeats full-stack telemetry/recovery but has not run at the time of this local record.

## Remaining

Broader D faults/recovery trace continuity, load/peak8GB, graphical browser on latest
main, offline clean-clone/image packaging, four final demo scripts/dossier/recording,
and historical data/identity/checkpoint/cutover acceptance remain. This closes the
three named live telemetry paths only, not all of Area E or production readiness.
See [implementation and migration handoff](../e-task5-full-flow-handoff.md).
