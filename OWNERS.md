# Area owners

Ownership records accountability across the full area, not exclusive permission to edit a directory. Each member owns at least one area and contributes implementation and evidence.

| Area | Owner | Scope | Work evidence |
|---|---|---|---|
| A — Extract and route | Thumathorn Rungratana | Implement both business services/APIs/databases, nginx, monolith adapters and compatibility; coordinate C consistency, B auth, D resilience and E delivery | [Scaffold PR #5](https://github.com/digi1450/des428-capstone-homeservice/pull/5) merged; [Notifications business slice](docs/notifications-handoff.md) and [Payments primitives](docs/payments-business-handoff.md) implemented with auth/consistency/cutover pending |
| B — Secure | Nattapat Lertsiritam | Keycloak, validation in both services, ownership and inherited BOLA evidence | Pending |
| C — Keep data correct | Peerawit Amnartpanich | Outbox, RabbitMQ, dedupe, Booking-orchestrated saga/compensation and recovery worker; integrate with A-owned business APIs/transaction hooks | Pending |
| D — Survive failure | Chanakan Maiain | HTTP retry/idempotency, 3 faults, inherited race fix/concurrency evidence across A-owned services; coordinate C command/event semantics | Pending |
| E — Observe and ship | Nathaporn Prucksayanont | Compose integration, telemetry/dashboard/traces, Pact, GitHub Actions/act | Pending |

All five areas have named owners. Update evidence links as work merges. Initial repository setup is not evidence that migration areas A–E are complete. Every member writes their own dossier material, participates in integration and rehearses a question outside their owned area.
