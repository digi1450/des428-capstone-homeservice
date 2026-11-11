# Current area status — 12 November 2026

Verified against merged main through PR78 (`5762b97`), the dated validation
records and GitHub's open-PR list at this review. No implementation PR was open
at that point; this documentation follow-up is separate. An absent PR does not
prove completion of unsubmitted work. This is the current two-service milestone,
not a claim that the whole course submission or production security is complete.

| Area | Implemented and integrated | Remaining closure work |
| --- | --- | --- |
| A — Extract and route | Notifications and Payments & Wallet own separate PostgreSQL databases; monolith callers, routing, auth composition, legacy import/bindings and signed operator checkpoint integrated. Actual authorized local cutover passed. | Visual browser acceptance of current UI and final extraction/architecture evidence. Any additional extraction is a separately agreed scope change. |
| B — Secure | Keycloak, receiving JWT verifiers, explicit subject/role/domain-ID mapping, persistent OIDC sessions, selected signup and separate Booking/gateway authority integrated. Real issuer/ownership tests and local historical identity mapping passed. | Consolidate security/BOLA evidence and defence; review inherited dependency advisories before claiming production security. Do not infer a demonstrated inherited vulnerability merely from a denial test. |
| C — Keep data correct | Outbox, RabbitMQ consumers/dedupe, provisioning/activation, financial work/fences/recovery, legacy eligibility/schema006/bindings and checkpoint reconciliation merged. | Joint D/C financial-race acceptance and evidence/defence. Selected crash/redelivery and recovery are already tested with E; do not duplicate them as if missing. |
| D — Survive failure | Conditional bid insertion and actual two-connection stale-read regression; bounded jitter and HTTP fault fixtures merged. Later full-stack suites cover selected outages, process crashes, redelivery and restart. | Map existing real-service evidence to D's required faults/retry budgets; close any uncovered settlement/cancellation/completion races with C and record outcomes. Map-backed HTTP fixtures alone do not close real-service acceptance. |
| E — Observe and ship | All six tracking tasks have implementation and recorded evidence: logs/metrics/dashboard, distributed traces, Pact/CI/act, authenticated16-service readiness, selected recovery and measured8GB budget. PR63 resource work is merged. | Current browser acceptance, clean-clone/offline packaging, final demos and delivery evidence with the team. Task6 is not this separate submission bucket. |

## Evidence to use

- [Actual local cutover](validation/a-local-cutover-2026-11-12.md), PR76–78:
  owner imports, approved signed receipt, nine real PKCE identities, migrated reads,
  backup restore, session persistence after restart and trusted HTTPS readiness.
- [Real Keycloak/onboarding](validation/a-b-live-keycloak-2026-11-10.md) and
  [authenticated16-service acceptance](validation/a-e-final-stack-2026-11-10.md).
- [Legacy v1.1 integration](legacy-v11-integration-handoff.md), PR73–75:
  checkpoint-gated eligibility/callers and isolated new-process financial recovery.
- [D's actual regression and limits](d-survive-failure-handoff.md).
- [E's six-task evidence index](e-task-checklist.md), including measured resource
  evidence and selected process-crash/recovery tests. These do not prove every D race.

## What is still shared

All five owners must prepare their contribution/evidence, architecture dossier,
AI-assistance disclosure, final demonstrations/recording and defence. Check the
assignment and current artifacts before declaring any missing delivery completed.
The lecturer's later feedback about further service extraction remains a separate
team decision; this update does not authorize splitting another service.

## Deployment and historical documents

The persistent local cutover is complete, but tracked deployment flags still
remain false by default. A fresh clone does not inherit the approved deployment,
operator receipt, users, credentials, source records or private backups. Do not
activate another environment merely because this one passed. Never start the
original SQLite-only Compose against the retired source as a fallback or restore
stale backups after new distributed effects.

`docs/validation/` and older dated entries are immutable observations of their
runs. Earlier handoff sections describe implementation slices and the gates at
that time; use this page and newer acceptance for current completion status,
while retaining the technical contracts and safety requirements in those handoffs.
Runtime-only pending states (such as a wallet awaiting provisioning) remain valid.
