# Shared project status and handoff

Recorded 6 November 2026 against `main` at `67bd023fa64df9b12a2a6424473e389b565e80b2`. This is a shared implementation snapshot, not the final dossier. Check newer merged PRs, current code and affected owners before treating a pending item as current. A missing merged evidence link does not mean a teammate has not started work on a branch.

## Integration update — 7 November 2026

C's messaging/outbox/consumer/saga preparation is merged through PRs #14–18; read [C messaging](c-messaging-handoff.md) and [C saga](c-saga-handoff.md). Saga activation and Payments participant endpoints/fence/eligibility remain pending. E's logging/metrics/Grafana/per-service tracing and PostgreSQL CI are integrated with those C commits in this change; [handoff](e-observability-handoff.md) and [validation](validation/e-main-sync-2026-11-07.md) cover available behavior and limits. The earlier snapshot below describes the A preparation milestone; C/E items there are historical, superseded by these handoffs where applicable. No final-stack/cutover completion is claimed.

New lead decisions: [A/C payment participant and wallet provisioning](payment-participant-decisions.md) fixes the ownership split, reuse of existing draft, durable HTTP activation, payment-setup-pending UI and asynchronous wallet provisioning. These are selected requirements, not implemented endpoints.

A importer review: [C-schema compatibility and message-state safeguards](validation/importer-c-state-2026-11-07.md) verifies the reviewed migrations and rejects nonempty outbox/dedupe state before fresh import or replay. No real migration or legacy-watermark handover has been performed.

## Decisions already selected

Extract Notifications and Payments & Wallet as Express services, each owning PostgreSQL in its own container/credentials. Booking/Bidding and remaining contexts stay in the Next.js/SQLite monolith initially. nginx is the gateway; Booking orchestrates the provisioning saga; notifications are asynchronous. [Migration handoff](migration-handoff.md) records the lead-selected decisions and proposed interfaces; [team plan](team-plan.md) and [OWNERS](../OWNERS.md) describe responsibilities. Draft interfaces still require integration review with B/C/D/E.

## Merged A work

All PRs below were verified merged. Their code/config/tooling is available on main; "prepared" means it has not been connected to live monolith traffic. Follow each handoff's exact limits and recorded test run rather than summing old test totals into a new end-to-end result.

| Merged PR | Available implementation | Handoff / recorded validation |
|---|---|---|
| [#5](https://github.com/digi1450/des428-capstone-homeservice/pull/5) | Two Express apps, independently owned PostgreSQL schemas/pools/migrations, transaction hooks, health checks and isolated dev Compose | [Service setup](../services/README.md), [scaffold evidence](validation/a-scaffold-2026-11-05.md) |
| [#6](https://github.com/digi1450/des428-capstone-homeservice/pull/6) | Notifications repository/business API, owner-scoped inbox/read updates and prepared monolith client | [Notifications handoff](notifications-handoff.md), [evidence](validation/notifications-business-2026-11-05.md) |
| [#7](https://github.com/digi1450/des428-capstone-homeservice/pull/7) | Payments intent/wallet/ledger/completion/refund/webhook primitives and guarded wallet/history reads | [Payments handoff](payments-business-handoff.md), [evidence](validation/payments-business-2026-11-05.md) |
| [#8](https://github.com/digi1450/des428-capstone-homeservice/pull/8) | Prepared Payments transport and Booking snapshot/key adapter, including unknown-outcome handling | [Adapter handoff](payment-adapter-handoff.md), [evidence](validation/payment-adapters-2026-11-06.md) |
| [#9](https://github.com/digi1450/des428-capstone-homeservice/pull/9) | Inherited notification recipient/content mappings and atomic batch writer for C's consumer integration; proposed provider-approval mapping | [Mapping handoff](notification-mappings-handoff.md), [evidence](validation/notification-mappings-2026-11-06.md) |
| [#10](https://github.com/digi1450/des428-capstone-homeservice/pull/10) | Prepared nginx baseline/candidate configs and real-nginx fixture routing/outage/recovery tests | [Gateway handoff](nginx-handoff.md), [evidence](validation/nginx-routing-2026-11-06.md) |
| [#11](https://github.com/digi1450/des428-capstone-homeservice/pull/11) | Read-only SQLite snapshot export, per-owner dry-run/import with replay/identity safeguards and caller cutover matrix | [Data/caller handoff](data-cutover-handoff.md), [evidence](validation/data-migration-2026-11-06.md) |

Shared setup/decisions and workflow were recorded earlier in PRs [#1](https://github.com/digi1450/des428-capstone-homeservice/pull/1), [#2](https://github.com/digi1450/des428-capstone-homeservice/pull/2), [#3](https://github.com/digi1450/des428-capstone-homeservice/pull/3) and [#4](https://github.com/digi1450/des428-capstone-homeservice/pull/4). Policy history: PR #3 replaced owner-only approval with one eligible peer approval. The lead subsequently selected zero mandatory approvals on 6 November: a PR is still required and any writer may merge their own or another member's PR when other applicable requirements pass. GitHub does not allow authors to approve themselves; removing mandatory approval enables this workflow. Owner bypass remains enabled, but agents still need explicit authorization to merge or bypass rules. Read [CONTRIBUTING](../CONTRIBUTING.md) for current workflow. The [original baseline](baseline/2026-11-04/README.md) is historical evidence.

## What is still active / not yet integrated

- Original monolith still serves user flows from SQLite. Prepared clients/adapters are unused by existing routes/pages/financial writers. APIs and Server Components both need coordinated changes; [inventory](extraction-inventory.md) lists them.
- Real service bootstraps have no B token verifier yet: business HTTP access fails closed with 503. Test auth doubles are not Keycloak evidence. Payments mutation HTTP endpoints remain unmounted pending authorized B/C wrappers.
- Primitives/hooks and notification mappings are not C's durable command results/cancel fences, saga/recovery, outbox publisher, RabbitMQ consumers or dedupe. No production consistency integration is claimed.
- nginx configs are prepared; candidate routing has not been activated. The isolated routing fixtures are not the full application stack.
- No real backup/export/import or caller cutover has been performed. The migration importer pins current A schema versions and intentionally rejects additional migrations until reviewed with C. Business rows alone do not bootstrap C's command/eligibility/dedupe state.
- Original monolith startup still DROP/reseeds its SQLite schema. Durable storage and non-destructive startup must be implemented before migration/cutover; do not reset useful data. Final root Compose, actual auth/fault/Pact/OTel/CI/full-stack resource evidence, report/demo/recording remain pending in this snapshot.

A's independent preparation is merged. Area A is **not complete**: actual extraction requires authoritative service reads/writes, compatible public flows and no monolith SQL against the moved tables after cutover. The inherited test baseline, fixture success and merged preparation PRs do not prove that final state.

## Where teammates can continue

| Area | Read before integration | Next work / A's integration revisit |
|---|---|---|
| B — Secure | [Notifications](notifications-handoff.md), [Payments](payments-business-handoff.md), [adapters](payment-adapter-handoff.md), [gateway](nginx-handoff.md) | Real issuer/signature/expiry/audience/role verification, integer domain-ID mapping and end-user/service credentials. A wires these into both services and HTTP/Server Component calls, then verifies real ownership/auth behavior. |
| C — Keep data correct | [Migration decisions](migration-handoff.md), [Payments hooks](payments-business-handoff.md), [adapter keys](payment-adapter-handoff.md), [mappings](notification-mappings-handoff.md), [data/caller cutover](data-cutover-handoff.md) | Durable command/fence/eligibility, same-client outbox/dedupe effects, Booking saga/recovery and all inherited producers/consumers. Agree wallet registration flow and legacy-state bootstrap. A integrates hooks/writers/callers and extends importer compatibility only after C migrations are reviewed. |
| D — Survive failure | [Adapter semantics](payment-adapter-handoff.md), [Payments](payments-business-handoff.md), [gateway](nginx-handoff.md), [migration decisions](migration-handoff.md) | Bounded retries with stable keys, real fault/concurrency evidence and the assigned race work. Unknown timeout must not release slots or create a new command. A integrates wrappers and fixes issues exposed by actual tests. |
| E — Observe and ship | [Service setup](../services/README.md), [gateway](nginx-handoff.md), [data/caller cutover](data-cutover-handoff.md), [migration decisions](migration-handoff.md) | Final root Compose, persistent/non-destructive runtime, private networking and real trace/log/metric/Pact/Actions-act wiring. A coordinates names/ports, candidate activation and full-stack acceptance; measure the combined stack against 8 GB. |

Teammates may continue their implementation using reviewed fixtures/contracts; they do not need to wait for final cutover. Consult the owner before changing a shared interface. Do not substitute raw identity headers, cross-owner SQL, SQLite fallback or invented production state for a missing integration.

## Before claiming completion

Use the [data/caller runbook](data-cutover-handoff.md) and [nginx activation checklist](nginx-handoff.md): review actual B/C/D/E deliveries; integrate and test auth/consistency/resilience; replace destructive startup; freeze/reconcile/backup; preflight and migrate both owners; coordinate all callers/writers/event boundaries/gateway; test real API/UI behavior and restart/faults. Keep real contribution/test evidence and prepare the team's dossier/demo/recording. No individual deadlines are assigned here.

This document records shared project decisions and implementation evidence. It does not reproduce the chat's complete requests or any local private planning notes.
