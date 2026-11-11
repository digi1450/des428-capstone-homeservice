# Initial team plan — Homeservice

This retains the original boundary/coordination plan. For current completion and remaining tasks, use [current A–E status](current-area-status.md), reviewed12 November2026 through PR78. The two-service local milestone is complete; further extraction after lecturer feedback is a separate scope decision.

Historical plan selected5 November2026: the lead chose the scope, PostgreSQL deployment, saga and work split. [Migration handoff](migration-handoff.md) retains the original decisions and then-draft interfaces; the selected implementation is now integrated. This plan is not the completed architecture dossier or defence. No individual deadlines are assigned.

## Scope

- Preserve Booking and Bidding together initially, including their shared slot-hold invariant.
- A implements Notifications and Payments & Wallet as two Express services with separately owned PostgreSQL databases in two PostgreSQL containers; C primarily implements consistency/saga/recovery modules and coordinates their integration with A.
- Keep unrelated capabilities in the Next.js monolith. Move all callers of migrated tables; do not leave cross-service SQL or shared database writes.
- The notification relay also updates Catalog/Provider ratings: leave each aggregate write with its data owner rather than moving the whole relay into a service that writes monolith tables.
- Next.js Server Components call business code directly; routing HTTP endpoints alone does not complete extraction.

## Before parallel implementation

A and C lead a short meeting with B/D/E to record:

1. Owned tables and every caller/read/write path, including booking placement, identity registration, cancellation/refunds, completion, webhook and notifications.
2. HTTP routes, methods, request/response/error shapes and compatibility requirements.
3. Event producer/consumer, payload/version/event ID and correlation metadata.
4. Keycloak subject to existing user ID mapping, roles/audiences and ownership rules.
5. Idempotency scope, timeout/retry semantics and durable saga state/compensation.

The source-grounded first evidence pair is booking.status_changed and payment.succeeded; see migration-handoff.md for draft schemas, durable provisioning saga and compensation rules. Do not equate payment-intent creation with charging money, or a timeout with a failed write.

## Historical first tasks (starter branches)

| Area | First branch | Start now | Dependency for real integration |
|---|---|---|---|
| A | feat/a-extract-and-route | Both business services/repositories/APIs, nginx and monolith adapters; hand off schema/transaction hooks and payment interfaces early | B auth contract, C consistency/saga modules, E Compose |
| B | feat/b-secure | Keycloak setup and identity/ownership mapping | A/C endpoints for validation tests |
| C | feat/c-keep-data-correct | Outbox/broker/dedupe, Booking orchestration and recovery against agreed interfaces; no need to wait for complete extraction | A payment APIs/transaction hooks and Booking adapters, E wiring |
| D | feat/d-survive-failure | Retry/idempotency and fault/concurrency harness across both A-owned services | A/C write paths for real fault tests |
| E | feat/e-observe-and-ship | Compose plan, health, CI/telemetry skeleton and Pact from agreed contracts | A/C implementations and B tokens for final verification |

Use stubs/fixtures matching agreed contracts during development, then verify with actual services before claiming integration complete. A implements both business services by the lead's choice; C integrates messaging/saga code in coordinated PRs, while B/D/E supply cross-cutting modules. E starts early.

## Early integration target

Within the team's agreed schedule, demonstrate one real authenticated operation through a new service and database, then outbox → RabbitMQ → notification in its own database. Test duplicate delivery with recorded effect counts. This is an integration milestone, not proof the full booking saga or capstone is complete.

## Clarifications and evidence

- The assignment allows a different seam when defended in the dossier. Document why these two boundaries are chosen; its summary table and the detailed Homeservice README differ.
- B and D must identify real inherited BOLA/race candidates. Existing guards already cover several examples in this source. If no matching candidate is found, clarify acceptable evidence with the lecturer; do not introduce a defect and claim it was inherited.
- Baseline tests are historical evidence only. New measurements, traces and tests must come from the team's actual implementation runs.
- Current repository visibility is public. Main uses PRs with zero mandatory approvals; any writer may merge when applicable checks/conversations pass. Admin bypass is not standing agent authorization. See CONTRIBUTING.md.
- Root full-stack Compose and CI now have integrated evidence. Four final demos, dossier, recording and other delivery acceptance must be checked separately; do not infer completion from passing CI.
