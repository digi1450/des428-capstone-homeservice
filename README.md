# DES428 Capstone — Bangkok Homeservice

Private team repository for migrating the supplied Homeservice monolith into two business services. Keep this repository private and share it with the lecturer and team.

## Current status

Start with the [shared project status and handoff](docs/project-status.md): merged PRs #5–11, what is prepared versus active, and B/C/D/E integration entry points. This snapshot does not claim completed extraction.

- Original monolith is preserved in `bangkok-homeservice/`.
- The initial Docker baseline passed 61 tests and HTTP smoke checks on 4 November 2026. See [recorded evidence](docs/baseline/2026-11-04/README.md).
- Notifications and Payments & Wallet are the selected extraction boundaries. Their Express/PostgreSQL scaffold is in [services/](services/README.md). [Notifications business logic/read API and a prepared monolith client](docs/notifications-handoff.md) are implemented; real auth, event delivery and monolith cutover remain pending. [Payments financial primitives and wallet/history reads](docs/payments-business-handoff.md) are implemented with C/B integration pending. Live gateway wiring, full business cutover, Keycloak, saga and observability are pending.
- Prepared [Payments client/Booking adapters](docs/payment-adapter-handoff.md) are tested; active monolith callers and service command/auth integration remain pending.
- Prepared [Notifications event mappings](docs/notification-mappings-handoff.md) preserve inherited recipients/messages; broker delivery and active cutover remain pending.
- Prepared [nginx routing](docs/nginx-handoff.md) includes baseline/candidate modes and isolated real-nginx tests; live gateway wiring/cutover remains pending with B/C/D/E.
- Prepared [offline data migration and caller cutover plan](docs/data-cutover-handoff.md) includes read-only export, rollback-only dry-run and service-owned import tests; no real data or active callers have been switched.
- Team ownership: [OWNERS.md](OWNERS.md). Branch/PR instructions: [CONTRIBUTING.md](CONTRIBUTING.md).

## Run the original system

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

The original application reseeds its container database on process startup. To reset a disposable local demo, stop and recreate it:

```sh
docker compose -f bangkok-homeservice/docker-compose.yml down
docker compose -f bangkok-homeservice/docker-compose.yml up -d --force-recreate --wait edemand
```

Back up data you need before resetting. The initial image build downloads dependencies and needs internet access. Downloaded host `node_modules/` and `.next/` are unnecessary for Docker and are ignored by Git. The supplied Compose configuration publishes port 3000; its baseline configuration has not been changed.

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

See [service setup](services/README.md), [caller inventory](docs/extraction-inventory.md) and the [shared status map](docs/project-status.md). Still pending: final root full-stack Compose and telemetry infrastructure, integrated resilience/Pact/CI evidence, real data/caller cutover, final demo scripts and dossier. Existing schemas/fixtures/prepared configs do not complete those requirements.

## Capstone completion work

The final submission must include a root Compose command that starts the full migration stack, two extracted services with their own databases, Keycloak, messaging/outbox/saga, resilience tests, observability, Pact/act, the four required demo scripts, a dossier, ownership evidence and the recording. The shared status map distinguishes merged preparation from the integrated requirements that remain unfinished.

Each member must understand their code and use evidence from actual runs in the dossier. Record AI assistance in the final dossier according to the assignment.
