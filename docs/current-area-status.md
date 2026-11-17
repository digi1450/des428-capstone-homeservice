# Current area status — 15 November 2026

Verified against merged `main` through PR84 (`4c0929a`), the dated validation
records and the current ownership/evidence links. This is the current two-service
milestone, not a claim that the whole course submission or production security is
complete. Shared browser/offline/demo/dossier/defence work remains separate.

Documentation integration reviewed 17 November 2026: D's evidence map from
closed PR #85 is carried forward with the E ownership row corrected. The
implementation snapshot remains PR84; no new runtime acceptance is claimed,
and D's two closure decisions remain open.

| Area | Implemented and integrated | Remaining closure work |
| --- | --- | --- |
| A — Extract and route | Notifications and Payments & Wallet own separate PostgreSQL databases; monolith callers, routing, auth composition, legacy import/bindings and signed operator checkpoint integrated. Actual authorized local cutover passed. | Visual browser acceptance of current UI and final extraction/architecture evidence. Any additional extraction is a separately agreed scope change. |
| B — Secure | Keycloak, receiving JWT verifiers, explicit subject/role/domain-ID mapping, persistent OIDC sessions, selected signup and separate Booking/gateway authority integrated. Real issuer/ownership tests and local historical identity mapping passed. | Consolidate security/BOLA evidence and defence; review inherited dependency advisories before claiming production security. Do not infer a demonstrated inherited vulnerability merely from a denial test. |
| C — Keep data correct | Outbox, RabbitMQ consumers/dedupe, provisioning/activation, financial work/fences/recovery, legacy eligibility/schema006/bindings and checkpoint reconciliation merged. Shared saga/activation/finalization retry helper merged in #50. Joint D/C financial-race acceptance over real HTTP for new and legacy booking origins merged in #81; strengthened suite recorded 14 pass, 0 fail, 0 skip and 0 Payments consistency-checker violations. | Consolidate C implementation evidence and defence; continue any separately listed C items without reopening the completed #81 race suite. |
| D — Survive failure | PR #47: conditional bid insert, deterministic two-SQLite-connection stale-read regression, equal-jitter saga retry and three HTTP fault fixtures. PR #50: shared equal-jitter policy and deterministic random injection. PR #61: selected real-service outage/crash/redelivery/restart recovery. PR #81: joint real-HTTP/Payments-PostgreSQL financial-race acceptance. | Confirm retry budgets with A/C and map every course fault requirement to its evidence. PR #47's one-shot HTTP 500 is not a sustained outage; PR #61 proves a real outage/recovery path for cancellation/finalization, not initial create-intent. Add a disposable real-stack create-intent outage test only if the rubric requires that exact case. See [D evidence map](d-area-d-evidence-map.md). |
| E — Observe and ship | All six tracking tasks have implementation and recorded evidence: logs/metrics/dashboard, distributed traces, Pact/CI/act, authenticated16-service readiness, selected recovery and measured8GB budget. PR63 resource work is merged. | Current browser acceptance, clean-clone/offline packaging, final demos and delivery evidence with the team. Task6 is not this separate submission bucket. |

## Evidence to use

- [Actual local cutover](validation/a-local-cutover-2026-11-12.md), PR76–78:
  owner imports, approved signed receipt, nine real PKCE identities, migrated reads,
  backup restore, session persistence after restart and trusted HTTPS readiness.
- [Real Keycloak/onboarding](validation/a-b-live-keycloak-2026-11-10.md) and
  [authenticated16-service acceptance](validation/a-e-final-stack-2026-11-10.md).
- [Legacy v1.1 integration](legacy-v11-integration-handoff.md), PR73–75:
  checkpoint-gated eligibility/callers and isolated new-process financial recovery.
- [Area D requirement-to-evidence map](d-area-d-evidence-map.md), including PR47,
  PR50, PR61 and PR81 boundaries.
- [C/D financial-race validation](validation/c-financial-race-acceptance-2026-11-12.md):
  strengthened real-HTTP/disposable-PostgreSQL run and its fixture-auth/one-process
  Booking limits.
- [E Task5 crash/recovery validation](validation/e-task5-fault-recovery-2026-11-10.md):
  selected real service outage, process-crash checkpoints and autonomous recovery.
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
