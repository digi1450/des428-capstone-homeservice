# Actual root-stack acceptance

Run `node tests/final-stack/run.mjs` from the repository root. Requires Docker
Compose v2, Node22+, OpenSSL and enough Docker memory for the actual16 services
(configured limits sum6.250GiB), plus image-build headroom. Stop unrelated stacks
yourself first; this script never stops them or changes Docker memory settings.
Fixed test ports must be free (including18443/18444); collisions fail startup.

The runner snapshots source into a new temporary checkout, generates local test
credentials/TLS, validates disabled defaults and activates auth only in the copy.
Real Keycloak cookie-jar forms, existing identity provisioning, signup/wallet events,
booking/payment/replay, scoped outages/readiness, persistent whole-stack restart
and monitoring are checked using actual independent deployment processes.

It refuses an existing project name (containers or volumes). Default project is
`homeservice-e-auth-final-<pid>`; optionally set `FINAL_STACK_PROJECT` to another
new `homeservice-e-auth-*` name. It does not add a persistent test container.
Cleanup removes only the marked disposable project and its fresh test volumes.
Test outputs contain assertion labels, never token/cookie/secret dumps.

For diagnosis only, `FINAL_STACK_KEEP=true` retains that disposable stack; the
printed temporary directory contains private generated credentials, diagnostics
and Docker stats. Keep it private. `FINAL_STACK_DIRECTORY` resumes only a directory
with the matching ownership marker; it is an internal debugging option and is not
idempotent after fixture accounts/business records have been created. Prefer a
fresh default run. Never use either override for a shared/useful environment.
The script checks functional deployment, not peak/load8GB, graphical browser UX,
complete cross-service traces, historical migration or production readiness.

See [dated evidence](../../docs/validation/a-e-final-stack-2026-11-10.md).

For E Task5 selected full-flow trace/log/dashboard acceptance, set
`FINAL_STACK_TELEMETRY=true` before running the same command. It verifies actual
Jaeger parent-child edges for provider-to-wallet, webhook-to-Booking via the PG
outbox/relay, and completion-to-Notifications, plus correlated JSON logs and all
three provisioned dashboard queries against actual Prometheus data. The only new
output file is a sanitized `task5-telemetry-summary.json` in the private evidence
directory. No additional runtime service is added. Jaeger's in-memory traces are
checked before the full-stack restart; historical retention is not claimed.
See [E handoff](../../docs/e-task5-full-flow-handoff.md).

Set `FINAL_STACK_FAULTS=true` as well for Task5 crash-window and recovery acceptance.
It kills real child relay/consumer processes at broker-confirm, pre-commit and
post-commit/pre-ack boundaries, then restarts the normal workers and checks actual
queue drainage, trace parents and owning-store effect counts. It also SIGKILLs
standalone Next with cancellation pending during a Payments outage and verifies
autonomous recovery with the same command/key/trace after restart. No production
fault flags or additional persistent service are added. The child processes use
the production protocol/storage libraries; this is deterministic checkpoint
testing rather than a timing-based claim about arbitrary normal-worker PID1 kills.
Sanitized outputs are `task5-fault-summary.json` and `task5-recovery-trace.json`.
See [fault/recovery handoff](../../docs/e-task5-fault-recovery-handoff.md).
