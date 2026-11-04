# Initial team plan — Homeservice

Status: selected system; proposed service boundaries, pending source-level interface agreement. This file is a work plan, not a completed architecture dossier or defence.

## Scope

- Preserve Booking and Bidding together initially, including their shared slot-hold invariant.
- Extract Notifications and Payments & Wallet as two Express services with separately owned PostgreSQL or MySQL databases.
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

Suggested events include booking.placed and payment.succeeded; verify actual source semantics before freezing names/schemas. Do not treat a timeout as proof that a payment failed.

## First tasks (starter branches published to the private GitHub repository)

| Area | First branch | Start now | Dependency for real integration |
|---|---|---|---|
| A | feat/a-service-extraction | Caller/table map, service/gateway skeletons, Notifications extraction | B auth contract, C payment/events, E Compose |
| B | feat/b-keycloak | Keycloak setup and identity/ownership mapping | A/C endpoints for validation tests |
| C | feat/c-payment-outbox | Payment transactions, contracts, outbox/broker/dedupe; help build Payments & Wallet | A Booking adapters, E service wiring |
| D | feat/d-resilience | Existing guard inspection, retry/fault harness; help Notifications | A/C write paths for real fault tests |
| E | feat/e-compose-ci | Compose plan, health, CI/telemetry skeleton and Pact from agreed contracts | A/C implementations and B tokens for final verification |

Use stubs/fixtures matching agreed contracts during development, then verify with actual services before claiming integration complete. E starts early; A does not implement two full services alone.

## Early integration target

Within the team's agreed schedule, demonstrate one real authenticated operation through a new service and database, then outbox → RabbitMQ → notification in its own database. Test duplicate delivery with recorded effect counts. This is an integration milestone, not proof the full booking saga or capstone is complete.

## Clarifications and evidence

- The assignment allows a different seam when defended in the dossier. Document why these two boundaries are chosen; its summary table and the detailed Homeservice README differ.
- B and D must identify real inherited BOLA/race candidates. Existing guards already cover several examples in this source. If no matching candidate is found, clarify acceptable evidence with the lecturer; do not introduce a defect and claim it was inherited.
- Baseline tests are historical evidence only. New measurements, traces and tests must come from the team's actual implementation runs.
- The private GitHub remote and starter branches are published. Main requires one approving review from a reviewer with write access other than the PR author, with the repository owner's explicitly chosen admin bypass. Code-owner approval is not mandatory; see CONTRIBUTING.md.
- The root full-stack Compose, four final demo scripts, dossier, recording and CI remain future tasks, not completed scaffolding.
