# E authenticated Compose validation — 10 November 2026

Based on main `be230cc5` (PR53); branch `feat/e-authenticated-compose`.
AI-assisted implementation and local validation. No shared deployment, useful-data
migration, GitHub push/merge or real-user provisioning was performed.

## Observed passing checks

- Root+resource+authenticated+authenticated-resource Compose configuration valid.
  Parsed Docker Compose JSON: **16 services**, limits on all 16, **6.250 GiB** total.
  Default application startup/cutover gates remain false. This is arithmetic, not
  a load measurement or proof of fitting the complete host under 8 GB.
- Built actual Node 22 service images and the Node 20/Next 14.2.35 standalone image.
  Production Next build passed. Existing cached image/dependency layers were used;
  this is not clean-clone/offline-reproducibility evidence.
- Fresh project `homeservice-e-auth-verified`: full 16-container `up -d --wait`
  completed successfully under those limits. Next `/api/ready` via trusted HTTPS,
  Prometheus `/-/ready`, Grafana `/api/health` and Jaeger HTTP returned 200.
- Actual Keycloak 26.4.0/PostgreSQL 16 fresh realm import, client-credentials issuance,
  signed RS256/JWKS verification with B's existing smoke script: Booking's seven
  operation roles, Gateway's webhook role, exact issuer/audience, stable caller on
  new issuance, cross-client denial, tampered-signature and missing-token rejection
  all passed. No token or secret was printed. Human/browser auth was not exercised.
- Trusted Node->Keycloak and Node->TLS->Notifications requests passed using the
  generated CA inside containers. Public Payments internal route and disallowed
  private-resolver path returned 404. `nginx -t` passed.
- **Actual broker stop/restart:** all three worker `/health/ready` endpoints went
  **200 -> 503 -> 200**, with no manual worker restart. This proves connection
  recovery/readiness, not message backlog or exactly-once financial effects.
- Notifications full service/PG suite: **51 passed, 0 failed/skipped**.
- Payments full service/PG suite in a NEW dedicated `payments_e_tests` database,
  with `--test-concurrency=1`: **128 passed, 0 failed, 2 skipped**. Two broker-opt-in
  cases were not enabled with `TEST_AMQP_URL`. Real worker broker recovery was
  tested separately as above. Both service runs include the new worker readiness
  regression covering broker/DB loss, recovery and disconnect during a DB probe.
- Script syntax, `git diff --check`, ignored-secret paths and refusal to overwrite
  an existing local preparation were checked. New Compose CI configuration exists;
  no GitHub run for these unpushed changes is claimed.

## Corrections made during the rehearsal

1. B's minimal realm had audience claims but omitted role claims on fresh import.
   Generated local realm now adds explicit assigned-client-role mappers while
   preserving isolated service-account grants and B's original source realm.
   Repeated on a second fresh project/Keycloak volume; no existing realm was reset.
2. First Payments test invocation mounted only test files into a runtime image,
   omitted `/contracts` fixtures and shared an active relay's disposable DB.
   That run failed (missing fixtures, competing outbox delivery and concurrent
   fixture interference); it is not passing evidence. The recorded rerun mounts
   contracts and uses an independent database with serial file execution. No
   business tests/constraints were weakened to make it pass.
3. Compose JSON memory values were numeric strings; the verification script now
   converts them explicitly before summing. Windows CRLF in the existing smoke
   script's shebang is handled before sending source to container stdin.

## Reproduction and boundaries

Use [the deployment runbook](../e-authenticated-compose-handoff.md). This rehearsal
used Windows Docker Desktop 29.7.2 with Linux containers, Node 22.23.4 in services,
Node 20 for monolith image build and Node 24.18.0 for host orchestration. It touched
only task-specific projects/volumes. The initial project was stopped with `down`
without deleting volumes before the corrected fresh-project import.

Representative commands from repository root:

```sh
# Initial preparation once; refuses overwrite.
node scripts/prepare-authenticated-compose.mjs
# Use all four files as documented in the runbook.
COMPOSE_PROJECT_NAME=homeservice-e-auth-verified \
  node scripts/verify-authenticated-compose.mjs --faults --full-stack
# The service image tests mounted services/<service>/test:/app/test:ro,
# contracts:/contracts:ro for Payments, and supplied a private TEST_DATABASE_URL.
# The Payments rerun used node --test --test-concurrency=1 test/*.test.js.
```

Not proven: real browser login/refresh/logout, account signup/migration/ownership,
auth-enabled full business command/event/notification/rating flow, final legacy
checkpoint/cutover, complete monolith/wallet Jaeger traces, application process/DB
failure financial convergence, load/peak RAM/OOM/latency or completed Area E.
No flags enabling application auth/cutover were turned on in the shared system.

After validation both task-created projects were stopped with `down` (no volume deletion). Local CA, secrets and task database volumes are preserved; no test containers remain running.
