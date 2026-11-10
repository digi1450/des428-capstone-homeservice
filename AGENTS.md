# Repository guidance

## Project and scope

This private DES428 team project migrates the supplied Bangkok Homeservice monolith into two business services. Do not expand the task into splitting every context or rewriting the product.

- Read `README.md` for setup, `CONTRIBUTING.md` for Git/review workflow, `OWNERS.md` for A–E accountability, and `docs/team-plan.md` for the proposed boundaries and dependencies.
- The supplied Next.js/SQLite monolith is in `bangkok-homeservice/` and still uses `edemand` internally. Do not rename its internals merely to match the project title.
- Selected extractions are Notifications and Payments & Wallet, using Express and separately owned PostgreSQL databases in two PostgreSQL containers. Read `docs/migration-handoff.md` for the lead-selected decisions and draft interfaces. Selected scope is not proof of implementation; inspect current code before making claims.
- Use the course stack described in the team plan. Keep unrelated capabilities in the monolith and avoid unrelated dependency upgrades, formatting sweeps or infrastructure additions.

## Read the shared handoffs before implementation

- For E Task6's8GB runtime budget, use `docs/e-task6-resource-budget-handoff.md`: all16 services need no-swap caps, raw cgroup-v2 peaks during the declared load/recovery, and explicit observer/host reserve allowances. Do not replace kernel peaks with cache-adjusted stats or call a larger-host run a full8GB-machine test. Upload only the three allowlisted sanitized outputs; do not change Docker/WSL settings or unrelated stacks. E's six-task titles are in `docs/e-task-checklist.md`; browser/offline/dossier work is separate from Task6.

- For exact legacy manifest v1/hash/owner-row and financial target v1.1 fixtures, read `docs/legacy-manifest-contract-handoff.md`. Keep the retained runtime v1 spec strict until coordinated receiver/caller implementation. Dev references/static tests do not create bindings, authorize import or prove frozen source/DB eligibility. C/A use the shared vectors before implementing006/importer/Booking CLI.

- For the lead-selected old open gateway booking path, read `docs/c-legacy-binding-proposal.md` (accepted baseline despite its stable filename). A publishes exact manifest/hash and v1.1 reference fixtures first; C/A implement against them. Payments bindings are atomic with its import; both owners/checkpoint must reconcile before traffic opens. Append Booking upgrades after E's existing steps. Acceptance of this plan is not implemented legacy eligibility or cutover approval.

- Before using the read-only C consistency checker for cutover/rollback, read `docs/c-consistency-check.md`: validate current owner schemas, stable command/request/result identity and broker ready/unacknowledged coverage. Quiescent checks require frozen writers and drained/disconnected consumers; missing counters or sources are not cutover approval.

- For E Task5 deterministic process-crash/redelivery and financial trace recovery, read `docs/e-task5-fault-recovery-handoff.md`. Test-only child workers use production libraries; do not add runtime fault hooks or alter retry/business state to force recovery. Keep work/context atomic and preserve original command/snapshot/authority. Run both FINAL_STACK_TELEMETRY and FINAL_STACK_FAULTS acceptance in a new disposable project.

- For E's actual selected full-flow telemetry and additive outbox metadata, read `docs/e-task5-full-flow-handoff.md`. Preserve exact-schema upgrades and atomic event/context writes; never put credentials/baggage or transport metadata in public event data. Run the existing final-stack acceptance with `FINAL_STACK_TELEMETRY=true`; three trace paths do not prove all recovery/load/offline gates.

- For A-led E Task4 actual authenticated16-service acceptance, read `tests/final-stack/README.md` and `docs/validation/a-e-final-stack-2026-11-10.md`. Use a new disposable project; never enable its flags against useful data or treat the smoke resource snapshot as load/peak8GB evidence. Historical migration and remaining E tasks stay separate.

- For A-led real Keycloak verification, trusted proxy origin, refresh nonce/JWKS handling and selected customer/provider signup, read `docs/keycloak-onboarding-handoff.md`. `identity.profile_created` is private monolith binding work, never a broker event. Never auto-link by email, accept self-selected admin/domain IDs or copy Keycloak passwords. Self-registration/deployment flags remain false by default.

- For explicit authenticated startup, cross-Next-bundle runtime/error identity and deployment gates, read `docs/authenticated-startup-handoff.md`. Both startup gates remain false by default. Compiled API/RSC fixture acceptance is not real Keycloak, broker readiness or useful-data cutover.

- For A's integrated B session/identity + C financial/saga recovery composition, read `docs/authenticated-runtime-handoff.md`. Construction is explicit, not default startup activation. Configure before legacy timers, keep one recovery scheduler, and pass through the actual webhook bearer instead of minting gateway authority. Real Keycloak/page/AMQP/data-cutover gates remain.

- For B JWT/user-ID mapping, separate user/Booking/gateway permissions and persistent OIDC session/credential interfaces, read `docs/b-authentication-handoff.md`. PR51 is staged integration preparation, not permission to enable auth or proxy/cutover flags. A/B/E must configure trusted HTTPS, credentials and persistent sidecars and verify real flows first. Existing stateless token-bearing user cookies require a fresh login; do not restore that fallback.

- For C Payments financial operations/migration005, read `docs/c-financial-operations-handoff.md`, including the A review follow-up on lock ordering, distinct-key conflicts and absent-create context binding. The factories and Booking financial callbacks/recovery are explicit; B real verifiers, runtime/timer composition and legacy cutover remain gated. Customer cancellation during setup supersedes provisioning: preserve its durable work/guard, discard late setup results and release holds only after safe Payments acknowledgement.

- For D retry jitter, HTTP fault fixture limits and the deterministic two-connection bid regression, read `docs/d-survive-failure-handoff.md`. Do not equate in-process Promise.all or a Map-backed HTTP fixture with full real-service failure evidence, and do not add nested retry loops around C recovery.

- For step 5D legacy-only rehearsal, source distributed-state guards, eight historical cohorts and remaining eligibility/checkpoint gates, read `docs/legacy-cutover-rehearsal-handoff.md`. Do not clear source/target C state or invent legacy command identities to force export/import; mixed ownership needs a separate reviewed procedure.

- For step 5C HTTP/client/Booking completion-cancellation-webhook callers, read `docs/financial-finalization-runtime-handoff.md`. A transport is prepared; C durable work, synchronous local guards/recovery and B real verifiers remain required. Do not enable it with fixture callbacks or introduce a duplicate A command store.

- For exact step 5C financial request/result/status/callable/auth fixtures, read `docs/financial-finalization-contract-handoff.md` and `contracts/financial-finalization.openapi.json` v1.0.0. The reference validator is dev-only; contract tests do not implement or prove the financial runtime.

- Before step 5C completion/refund/webhook work, read `docs/financial-finalization-decisions.md`: the lead has selected the policies and technical direction as the implementation baseline. A publishes exact versioned contracts; C/B implement against them and report blockers. Do not wait for separate direction approval or treat adoption as completed integration.

- For legacy notification relay retirement and monolith-owned ratings, read `docs/notification-event-delivery-handoff.md`; disabling the local timer does not validate broker/data readiness or mark historical events delivered.

- For provider signup-wallet and approval-notification event-only writer preparation, read `docs/provider-event-writes-handoff.md`; it reuses C events and must not be enabled while remaining financial/inbox writers still own SQLite.

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
