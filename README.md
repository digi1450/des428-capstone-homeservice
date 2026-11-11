# DES428 Capstone — Bangkok Homeservice

University team capstone repository for migrating the supplied Homeservice monolith into two business services. See [public readiness checklist](docs/public-readiness.md) before changing repository visibility.

## Current status

The two selected business services, Notifications and Payments & Wallet, are
implemented and integrated with separately owned PostgreSQL databases. Keycloak,
monolith callers, messaging/saga/recovery, nginx, telemetry and CI are integrated.
User-authorized **local data cutover completed on 12 November 2026**, including
backup/restore, signed checkpoint approval, migrated read comparisons and restart
checks. See [actual local acceptance](docs/validation/a-local-cutover-2026-11-12.md).

Start with [current A–E status and remaining work](docs/current-area-status.md),
then the [dated implementation history](docs/project-status.md). Remaining work
includes D/C's final race/fault evidence review and shared browser/offline/demo/
dossier/defence deliverables. Further extraction after lecturer feedback needs a
separate scope decision; this milestone does not claim whole-project completion.

- [Area ownership and evidence](OWNERS.md); [Git workflow](CONTRIBUTING.md).
- [Service setup](services/README.md); [E's six-task evidence](docs/e-task-checklist.md).
- The original monolith remains in `bangkok-homeservice/`; its61-test baseline
  from4 November is [historical evidence](docs/baseline/2026-11-04/README.md).
- Deployment remains opt-in: tracked flags are false. The approved persistent
  local deployment uses private config, receipts and credentials, not default
  Compose or seeded passwords. No secrets or live source data belong in this repo.

## Run the original system

These commands are for a separate disposable baseline environment. Do not run
them against the retired local source or the approved migrated deployment. Use
that deployment's private wrapper/configuration to manage it; never fall back to
SQLite-only mode after distributed effects. Seeded logins below belong only to
the baseline demo, not the actual Keycloak deployment.

Install and start Docker with Docker Compose. From the repository root:

```sh
docker compose -f bangkok-homeservice/docker-compose.yml config --quiet
docker compose -f bangkok-homeservice/docker-compose.yml up -d --wait edemand
```

Open http://localhost:3000. The source still uses its former internal name `edemand`.

Seeded demo accounts (local demo only), all with password `eDemand-2026!`:

| Role | Login | Page |
|---|---|---|
| Customer | `nong@example.com` | `/login` |
| Approved provider | `sparkle@example.com` | `/provider/login` |
| Admin | `admin@edemand.test` | `/admin/login` |

Run the inherited test suite:

```sh
docker compose -f bangkok-homeservice/docker-compose.yml run --rm test
```

Inspect and stop this project's containers:

```sh
docker compose -f bangkok-homeservice/docker-compose.yml ps
docker compose -f bangkok-homeservice/docker-compose.yml logs --tail=100 edemand
docker compose -f bangkok-homeservice/docker-compose.yml down
```

Normal startup initializes and seeds a new database once, then preserves it on restart. Both Compose files mount persistent monolith data; `down` and container recreation retain it. Existing databases must have the exact current schema or startup stops without resetting their data. Read [SQLite startup and persistence](docs/sqlite-startup-handoff.md) for legacy adoption, backups and fresh disposable demos. Never use `down -v` to update an existing project.

The initial image build downloads dependencies and needs internet access. Host `node_modules/` and `.next/` are ignored. The supplied monolith Compose publishes port 3000; the root stack routes through the gateway.

## Repository layout

```text
bangkok-homeservice/       original monolith plus prepared service clients/Booking adapter
services/                 two Express/PostgreSQL services and isolated dev Compose
contracts/                draft HTTP/event schemas, fixtures and contract checks
infra/nginx/              prepared baseline/candidate gateway configs
tests/integration/        service boundary and notification parity tests
tests/gateway/            isolated real-nginx routing fixtures/tests
tools/data-migration/     offline snapshot/import preparation and rehearsal tests
docs/project-status.md    shared merged-work/dependency/remaining-work map
docs/baseline/            historical original-system evidence
docs/validation/          recorded validation for subsequent implementation slices
.github/                  review contacts and pull request template
AGENTS.md                 coding-agent entry points and repository guidance
OWNERS.md                 owners A–E and contribution evidence
CONTRIBUTING.md            branch, review and integration workflow
```

See [service setup](services/README.md), the historical [caller inventory](docs/extraction-inventory.md) and [current remaining work](docs/current-area-status.md). Full-stack Compose, telemetry, Pact/CI and actual local cutover now have evidence; final submission and uncovered D/C acceptance remain separate.

## Capstone completion work

The final submission must include a root Compose command that starts the full migration stack, two extracted services with their own databases, Keycloak, messaging/outbox/saga, resilience tests, observability, Pact/act, the four required demo scripts, a dossier, ownership evidence and the recording. The shared status map distinguishes merged preparation from the integrated requirements that remain unfinished.

Each member must understand their code and use evidence from actual runs in the dossier. Record AI assistance in the final dossier according to the assignment.

E authenticated deployment: [local Compose/TLS/Keycloak/worker integration](docs/e-authenticated-compose-handoff.md). Base Compose has13 services; the explicit authenticated overlay has16. Activation remains opt-in; follow the runbook and recorded validation.

Area E Task 3: [Pact coverage, tracing/reliability CI and act commands](docs/e-task3-ci-handoff.md), with [dated local results](docs/validation/e-task3-ci-2026-11-10.md).

Area E Task 5: [selected actual full-flow trace/log/dashboard acceptance](docs/e-task5-full-flow-handoff.md), with [dated local evidence](docs/validation/e-task5-full-flow-2026-11-10.md). Extends the merged Task4 runner; broader D race and offline/submission gates remain; load and local cutover have newer evidence linked in the current status.

Task5 follow-up: [process-crash/redelivery and durable financial recovery tracing](docs/e-task5-fault-recovery-handoff.md), with [dated local results](docs/validation/e-task5-fault-recovery-2026-11-10.md). Run the same fresh-stack runner with FINAL_STACK_TELEMETRY=true and FINAL_STACK_FAULTS=true.

Area E [six-task checklist](docs/e-task-checklist.md): Task6 is **8GB Resource Budget**, not the separate browser/offline/dossier deliverables. [Budget/load method](docs/e-task6-resource-budget-handoff.md) and [dated local measurement](docs/validation/e-task6-resource-budget-2026-11-10.md) add no-swap caps, raw kernel peaks and explicit allowances; enable FINAL_STACK_RESOURCES with both Task5 flags.
