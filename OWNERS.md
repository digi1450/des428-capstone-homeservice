# Area owners

Ownership records accountability across the full area, not exclusive permission to edit a directory. Each member owns at least one area and contributes implementation and evidence.

| Area | Owner | Scope | Work evidence |
|---|---|---|---|
| A — Extract and route | Thumathorn Rungratana | Both service boundaries/databases, gateway, monolith adapters and compatibility; C/D help implementation | Pending — add implementation PR/commit links |
| B — Secure | TBD — assign teammate | Keycloak, validation in both services, ownership and inherited BOLA evidence | Pending |
| C — Keep data correct | TBD — assign teammate | Outbox, RabbitMQ, dedupe, saga/compensation; help Payments & Wallet | Pending |
| D — Survive failure | TBD — assign teammate | Retry/idempotency, 3 faults, inherited race fix/concurrency evidence; help Notifications | Pending |
| E — Observe and ship | TBD — assign teammate | Compose integration, telemetry/dashboard/traces, Pact, GitHub Actions/act | Pending |

Fill the four names before implementation starts and update evidence links as work merges. Initial repository setup is not evidence that migration areas A–E are complete. Every member writes their own dossier material, participates in integration and rehearses a question outside their owned area.
