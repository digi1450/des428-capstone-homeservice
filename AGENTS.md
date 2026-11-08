# Repository guidance

## Project and scope

This private DES428 team project migrates the supplied Bangkok Homeservice monolith into two business services. Do not expand the task into splitting every context or rewriting the product.

- Read `README.md` for setup, `CONTRIBUTING.md` for Git/review workflow, `OWNERS.md` for A–E accountability, and `docs/team-plan.md` for the proposed boundaries and dependencies.
- The supplied Next.js/SQLite monolith is in `bangkok-homeservice/` and still uses `edemand` internally. Do not rename its internals merely to match the project title.
- Selected extractions are Notifications and Payments & Wallet, using Express and separately owned PostgreSQL databases in two PostgreSQL containers. Read `docs/migration-handoff.md` for the lead-selected decisions and draft interfaces. Selected scope is not proof of implementation; inspect current code before making claims.
- Use the course stack described in the team plan. Keep unrelated capabilities in the monolith and avoid unrelated dependency upgrades, formatting sweeps or infrastructure additions.

## Read the shared handoffs before implementation

- For Notifications API/page readers and the explicit credential/client seam, read `docs/notifications-callers-handoff.md`; remote reader preparation does not retire SQLite writers or activate cutover.

- For A step 5 remaining SQLite callers/writers, existing C producers, implementation order and data/routing gates, read `docs/a-step5-caller-audit.md`; its source snapshot is explicit and it does not activate cutover.

- For A step 4 runtime assembly, real C participant/readiness/recovery and the B auth activation gate, read `docs/payment-runtime-composition-handoff.md` before changing bootstrap/composition.
- For E messaging tracing, C lifecycle preservation, durable parent-context propagation and the tested/remaining integration boundaries, read `docs/e-cross-service-tracing-handoff.md`.
- Start with `docs/project-status.md` for merged work, active limitations, per-area dependencies and links to PRs/validation. It is a dated snapshot: check current code and newer merged PRs before relying on its pending statuses.
- For Booking pending/ready UI, remote intent/simulate/wallet/history callers and the explicit end-user credential/readiness injection gate, read `docs/payment-setup-callers-handoff.md`. These callers are prepared; production cutover remains disabled.
- For the activation client/Booking adapter, typed cancellation/reconciliation errors and malformed-409 behavior, read `docs/payment-activation-client-handoff.md` before connecting C recovery or UI callers.
- For A's activation HTTP implementation, strict coded/uncoded errors and remaining Booking client work, read `docs/payment-activation-http-handoff.md`; default production composition remains unavailable.
- For A's prepared internal HTTP routes and proposed B/C injection interfaces, read `docs/payment-command-http-handoff.md`; do not enable production with the test doubles.
- For the B #26 / C #27 integration review, restored FK/importer checks, pending Payments JWT verifier and token-redirect issue, read `docs/a-b-c-integration-review.md`. These checks do not authorize live saga activation.
- For the A response to C's proposed callable/replay/activation interface, read `docs/c-payment-participant-interface.md`; verify whether C has confirmed the revision before describing it as a bilateral agreement.
- Before A/C command/fence/eligibility or wallet provisioning work, read `docs/payment-participant-decisions.md` for the lead's selected ownership/activation/pending-UI/async-wallet decisions. Keep its proposed technical interfaces distinct from completed implementation.
- For either service, read `services/README.md`, `docs/notifications-handoff.md` and `docs/payments-business-handoff.md`; for C/D integration also read `docs/payment-adapter-handoff.md` and `docs/notification-mappings-handoff.md`.
- Before gateway, data or caller changes, read `docs/nginx-handoff.md`, `docs/data-cutover-handoff.md` and `docs/extraction-inventory.md`. These document activation gates and the API/Server Component/relay/signup/Booking paths still on SQLite.
- Prepared implementations and fixture tests are not live cutover or real auth/saga evidence. Verify the B/C integration seams before activating traffic; review importer compatibility when schema migrations change. Preserve the explicit pending work instead of treating merged preparation as completed extraction.
- Update the shared status/evidence links when work merges. Do not infer a teammate's unmerged progress from a missing evidence link; inspect their PR/branch or ask the owner when needed.

## Team coordination and boundaries

- A implements both business services and owns extraction/routing; B security; C outbox/events/dedupe, Booking-orchestrated saga and recovery; D resilience; E observability/delivery. Follow the handoffs in `docs/migration-handoff.md` and consult owners in `OWNERS.md` for interface changes. Ownership does not prohibit coordinated integration edits.
- Agree on HTTP routes, payloads/errors, events, token/user mapping and idempotency rules with affected consumers before changing them. Update contracts and callers together.
- Preserve existing user-facing paths, response shapes and access behavior unless the assigned migration task explicitly changes them.
- Each extracted service owns its database. The monolith must stop directly reading/writing migrated tables; services must not use cross-service SQL or a shared database connection as a shortcut.
- Inspect Next.js Server Component reads as well as API handlers: pages can call the service layer directly.
- Keep Booking and Bidding together initially to preserve slot-hold invariants. The current notification relay also updates Catalog/Provider ratings; retain each aggregate write with its data owner when extracting notifications.
- Follow existing JavaScript ESM conventions. In the monolith, keep validation/auth in HTTP handling, business logic in services, and SQL in repositories. Do not copy this SQLite implementation into new services without adapting transactions and constraints to their databases.

## Commands and validation

Run these from the repository root for the original monolith:

```sh
docker compose -f bangkok-homeservice/docker-compose.yml config --quiet
docker compose -f bangkok-homeservice/docker-compose.yml up -d --wait edemand
docker compose -f bangkok-homeservice/docker-compose.yml run --rm test
```

- The test service uses an isolated in-memory database. Run the inherited suite for changes affecting monolith business behavior or integration, plus relevant service/contract tests as those are implemented.
- For API/event changes, verify producer/consumer integration; a single service's unit tests do not establish end-to-end correctness.
- For documentation-only changes, check commands, referenced paths and `git diff --check`; do not rerun application tests without a relevant reason.
- Report actual commands/results and checks not run. Do not invent lint/CI scripts or claim the final root full-stack Compose command exists before it does.
- Normal monolith startup initializes/seeds only a new SQLite database and preserves the exact current schema on restart. Read `docs/sqlite-startup-handoff.md` before schema or bootstrap changes: incompatible schemas stop startup and need explicit migration; test resets are restricted to in-memory databases. Never reset/delete useful data or stop unrelated projects as part of routine checks.

## Git and review

- Inspect `git status` and the current branch first. Preserve others' changes and use a task branch from current `main`; do not force-push, rewrite others' history or resolve conflicts by discarding their work.
- Stage only reviewed files for the task. Keep commits and PRs small; document interface changes, validation and remaining limitations.
- Follow `CONTRIBUTING.md`: changes to `main` still go through a PR, but zero approving reviews are required. Any collaborator with write access may merge their own or another member's PR when other applicable requirements pass. GitHub does not allow authors to approve their own PR; this policy removes the approval requirement instead. `.github/CODEOWNERS` suggests an optional review contact. `OWNERS.md` describes academic responsibilities, not GitHub access control.
- The repository owner has explicitly enabled admin bypass, but that is not standing authorization for an agent to use it. A request to commit/push does not authorize merging a PR, bypassing review or pushing directly to `main`; do those only when explicitly requested for the task.
- Do not change repository visibility, branch protection or collaborator access without user direction. Keep this repository private.

## Data and evidence

- Keep real secrets in environment variables, never commits, logs or PR bodies. Do not commit `.env`, tokens, live databases, `node_modules`, `.next` or other generated runtime/build data. Examples must contain placeholders rather than real credentials.
- `docs/baseline/2026-11-04/` records the original 61-test run and smoke checks. It is historical evidence, not proof that later changes or migration requirements pass. Do not rewrite old observations to imply a new run.
- Only claim timings, effects, traces, concurrency behavior and test outcomes observed in actual runs. Do not introduce an unsafe race or authorization flaw merely to claim an inherited defect was fixed.
- Team members must understand their implementations and produce their own architecture-defence reasoning from evidence. Track real contributions in `OWNERS.md` and disclose AI assistance in the final dossier as required by the assignment.
