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
