# E Task 3 — Pact and CI

Task scope: consumer/provider compatibility for both extracted service boundaries,
automated service/schema/boundary checks, tracing/reliability CI and local `act`
execution. This does not close Tasks 1/2/4/5/6 or certify real Keycloak user flows.

## Contract coverage

| Consumer -> provider | Pact interaction | Provider verification |
| --- | --- | --- |
| Monolith -> Notifications | GET inbox | Real Express/business repository + dedicated Notifications PG |
| Monolith -> Notifications | POST mark-read, timestamp result | Same owning service/PG, fixture-owned unread row |
| Monolith -> Payments | GET ready wallet | Real Express/business repository + dedicated Payments PG |
| Monolith -> Payments | GET pending wallet | Missing wallet, null amounts and explicit pending state |
| Monolith -> Payments | GET customer history | Nonempty charge row including public transaction shape |

Consumer tests use actual A clients against Pact mocks. Consumers finish before
providers start; providers read freshly generated contracts inside the SAME test
container. The checked-in JSON samples are historical snapshots, not the files
used to accept current source. There is no host bind mount for generated contracts,
so nested/remote Docker under `act` sees the same fresh files as GitHub Actions.

Pact authentication remains an explicit fixture. Ownership/BOLA, JWT/PKCE,
provisioning/activation and financial completion/cancellation/webhook behavior are
covered by the existing security, schema and real HTTP/PG boundary workflows, not
claimed as Pact coverage or real Keycloak browser acceptance. Events use schema,
outbox/inbox and AMQP tests rather than Pact message interactions. This coverage
matrix distinguishes those layers; five Pact interactions do not cover every API.

## Workflows

- `pact-contracts.yml`: ordered consumer/provider verification and API schema tests;
  PR, main push and manual triggers. Unique disposable project and always cleanup.
- `area-e-ci.yml`: both service suites with PostgreSQL; PR, main push and manual.
- `e-tracing-reliability.yml`: HTTP->outbox->AMQP->Notifications trace, C consumer
  lifecycle faults, then PG outbox reliability. All three phases are sequential.
  The shell entrypoint requires executed tests, zero failures and zero skips,
  propagates failures through pipes, refuses an existing project and cleans only
  its `homeservice-e-ci-*` project. Cancellation cleanup runs in the workflow too.
- Existing authenticated/financial boundary, identity/security, migration and
  Compose configuration checks remain complementary acceptance layers.

No final-stack deployment, application auth/cutover flag or useful data changes.
Test infrastructure uses separate tmpfs databases/broker and no host ports.

## Reproduce

Docker Compose v2, Bash and a Docker-enabled Linux/WSL shell:

```sh
bash scripts/run-e-tracing-reliability.sh
COMPOSE_PROJECT_NAME=homeservice-e-pact-ci-local \
  docker compose -f docker-compose.pact.yml run --rm --build pact-tests
COMPOSE_PROJECT_NAME=homeservice-e-pact-ci-local \
  docker compose -f docker-compose.pact.yml down --volumes --remove-orphans
```

Use a NEW project for each run. Lifecycle tests delete their disposable queues.
Never substitute the root application project or useful databases/broker.

With `act` installed and a Docker-enabled runner image:

```sh
act pull_request -W .github/workflows/e-tracing-reliability.yml \
  -j tracing-reliability \
  -P ubuntu-latest=ghcr.io/catthehacker/ubuntu:act-latest
act pull_request -W .github/workflows/pact-contracts.yml \
  -j pact-contracts \
  -P ubuntu-latest=ghcr.io/catthehacker/ubuntu:act-latest
```

These commands execute workflows; `act -l`/dry-run alone is not passing evidence.
Do not feed real repository secrets to local fixture workflows. On Windows this
rehearsal used the verified Linux act binary in a Docker container because native
executable policy blocked the Windows binary. The parent mounted the Docker socket
and a read-only checkout; act copied source into sibling Linux runner containers.
No application secrets were passed as act secrets. The runner needs access to the
Docker daemon; it must only run trusted workflow source.

See [dated validation](validation/e-task3-ci-2026-11-10.md) for executed counts,
runtime versions, observed failures/corrections and GitHub CI status. Local act
success does not establish that a future GitHub run passed.

References: [act installation](https://nektosact.com/installation/),
[Docker context limitation](https://nektosact.com/missing_functionality/docker_context.html),
[tracing evidence limits](../tests/e2e-tracing/README.md).
