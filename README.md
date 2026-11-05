# DES428 Capstone — Bangkok Homeservice

Private team repository for migrating the supplied Homeservice monolith into two business services. Keep this repository private and share it with the lecturer and team.

## Current status

- Original monolith is preserved in `bangkok-homeservice/`.
- The initial Docker baseline passed 61 tests and HTTP smoke checks on 4 November 2026. See [recorded evidence](docs/baseline/2026-11-04/README.md).
- Notifications and Payments & Wallet are the selected extraction boundaries. Their Express/PostgreSQL scaffold is in [services/](services/README.md). [Notifications business logic/read API and a prepared monolith client](docs/notifications-handoff.md) are implemented; real auth, event delivery and monolith cutover remain pending. [Payments financial primitives and wallet/history reads](docs/payments-business-handoff.md) are implemented with C/B integration pending. Gateway, full business cutover, Keycloak, saga and observability are pending.
- Prepared [Payments client/Booking adapters](docs/payment-adapter-handoff.md) are tested; active monolith callers and service command/auth integration remain pending.
- Prepared [Notifications event mappings](docs/notification-mappings-handoff.md) preserve inherited recipients/messages; broker delivery and active cutover remain pending.
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
bangkok-homeservice/       supplied monolith, original README and tests
docs/baseline/             recorded baseline evidence
docs/team-plan.md          initial scope, interfaces and first tasks
.github/                  pull request template
OWNERS.md                 owners A–E and contribution links
CONTRIBUTING.md            branch, review and integration workflow
```

Initial additions: `services/notifications/`, `services/payments-wallet/`, isolated `services/compose.dev.yml`, [caller inventory](docs/extraction-inventory.md) and draft contracts in `contracts/`. See [service setup and handoff](services/README.md). Planned: final `infra/`, contract/resilience integration tests, root `docker-compose.yml`, final demo scripts and `docs/dossier.md`. A scaffold does not mean extraction is complete.

## Capstone completion work

The final submission must include a root Compose command that starts the full migration stack, two extracted services with their own databases, Keycloak, messaging/outbox/saga, resilience tests, observability, Pact/act, the four required demo scripts, a dossier, ownership evidence and the recording. None of those migration requirements is claimed complete by this initial baseline.

Each member must understand their code and use evidence from actual runs in the dossier. Record AI assistance in the final dossier according to the assignment.
