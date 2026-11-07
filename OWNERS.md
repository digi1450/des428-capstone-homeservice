# Area owners

Ownership records accountability across the full area, not exclusive permission to edit a directory. Each member owns at least one area and contributes implementation and evidence.

| Area | Owner | Scope | Work evidence |
|---|---|---|---|
| A — Extract and route | Thumathorn Rungratana | Implement both business services/APIs/databases, nginx, monolith adapters and compatibility; coordinate C consistency, B auth, D resilience and E delivery | [PRs #5–11 merged: implementation/handoff/evidence index](docs/project-status.md#merged-a-work). Both services, adapters, mappings, nginx and data/caller preparation are available; real integration/cutover and Area A completion remain pending |
| B — Secure | Nattapat Lertsiritam | Keycloak, validation in both services, ownership and inherited BOLA evidence | No merged evidence linked here yet; verify current PRs/branch with owner |
| C — Keep data correct | Peerawit Amnartpanich | Outbox, RabbitMQ, dedupe, Booking-orchestrated saga/compensation and recovery worker; integrate with A-owned business APIs/transaction hooks | PRs [#14](https://github.com/digi1450/des428-capstone-homeservice/pull/14)–[#17](https://github.com/digi1450/des428-capstone-homeservice/pull/17) merged: outboxes + RabbitMQ relays, idempotent consumers/DLQs, Booking saga/compensation/recovery ([messaging handoff](docs/c-messaging-handoff.md), [saga handoff](docs/c-saga-handoff.md), validation records in `docs/validation/c-*`). Saga not yet active: Payments internal endpoints/fence, B credentials and settlement eligibility pending |
| D — Survive failure | Chanakan Maiain | HTTP retry/idempotency, 3 faults, inherited race fix/concurrency evidence across A-owned services; coordinate C command/event semantics | No merged evidence linked here yet; verify current PRs/branch with owner |
| E — Observe and ship | Nathaporn Prucksayanont | Compose integration, telemetry/dashboard/traces, Pact, GitHub Actions/act | [Logging/metrics/tracing/CI integration handoff](docs/e-observability-handoff.md), [7 November validation](docs/validation/e-main-sync-2026-11-07.md); final broker/IdP/Pact/full-stack evidence pending |

All five areas have named owners. Update evidence links as work merges. Initial repository setup is not evidence that migration areas A–E are complete. Every member writes their own dossier material, participates in integration and rehearses a question outside their owned area.

Shared project progress and integration entry points: [docs/project-status.md](docs/project-status.md). The table records linked merged evidence, not live monitoring of teammates' unmerged work. A's merged preparation does not complete the full extraction rubric.
