# Shared project status and handoff

## A authenticated A/B/C composition — 10 November 2026

[Authenticated runtime handoff](authenticated-runtime-handoff.md) connects merged B sessions/current identity mapping, A clients/API and page identities, C provisioning/financial recovery and event-only provider/notification ownership in one explicit lifecycle. It adds shared browser OIDC identity selection and original-bearer webhook forwarding without a privileged gateway credential fallback. Default instrumentation/routing/flags remain unchanged. Local monolith273, authenticated HTTP/two-PG boundary7 and production build passed ([evidence](validation/a-authenticated-runtime-2026-11-10.md)). Current staging proves real HTTP/owning PG with signed issuer fixtures; actual Keycloak/browser/page context, broker/paid-event/notification delivery, TLS/volumes, legacy cutover and final D/E acceptance remain open. It is not production activation or completion of A steps4–5.

## B staged authentication and A session review fix — 10 November 2026

[PR #51](https://github.com/digi1450/des428-capstone-homeservice/pull/51) supplies Keycloak realm/roles, RS256/JWKS user and separate Booking/gateway verifiers, trusted monolith-owned identity mapping/resolver, and opt-in OIDC/credential/read-proxy interfaces. A's reviewed correction persists encrypted tokens server-side and uses fixed-size opaque browser session IDs, with atomic refresh rotation and server logout invalidation. Monolith266, OIDC18 and production build passed; the fixed code head passed all12 PR checks including all4 Area B jobs. [B handoff](b-authentication-handoff.md) separates prior developer-reported live service-token evidence from independently tested fixtures.

The lead permits staged merge after review/CI; auth, OIDC and proxy flags remain disabled. A/B/C/E must still validate real user provisioning/login/refresh/ownership, actual webhook and financial replay, trusted container TLS, persistent sidecar volumes and full runtime/cutover. Application session invalidation is not Keycloak global revocation. Historical missing-B-implementation/no-merge statements below are superseded only for this staged deliverable, not for final acceptance.

## C shared retry policy — 9 November 2026

PR #50 extracts the existing capped equal-jitter policy and uses it for saga,
activation and financial finalization. It includes deterministic retry-bound tests
and current C evidence links in OWNERS. The integrated monolith after the PR49
cancellation fix passed243 tests with no skips. D still owns production retry/fault
acceptance; this helper does not establish full-stack resilience or enable timers.

## C Booking financial finalization and A review fix — 9 November 2026

PR #49 supplies durable completion/cancellation callbacks, local guards and recovery
through A's prepared seam, plus the additive startup upgrade/exporter guard.
The review fix accepts cancellation during unfinished gateway setup, retains holds
until safe Payments acknowledgement and suppresses stale provisioning/activation
results. [C handoff](c-financial-operations-handoff.md) records exact behavior and
remaining gates. Local monolith241, existing HTTP/PG boundaries15 and Booking
finalization boundary7 passed with no skips. Real authentication, runtime/timer
composition, legacy eligibility and full D/E fault/cutover evidence remain open;
this does not enable production financial ownership or close all of Area C/A.

## C Payments financial operations and A review fixes — 9 November 2026

[C financial handoff](c-financial-operations-handoff.md) implements durable completion/cancellation/query plus migration005 and importer empty-state guards. The reviewed follow-up serializes distinct-key acceptance under the order lock and binds absent-create financial cancellation context; regression cases fail before and pass after. Payments115, financial subset15, actual HTTP/PG boundaries15 and importer36 passed locally with explicit auth fixtures. Default startup remains unwired; Booking financial work/recovery, B auth/delegation, legacy binding and final integration remain open. D #47 is integrated; full area completion is not claimed.

## D retry and bid race preparation — 9 November 2026

[D handoff](d-survive-failure-handoff.md) records saga backoff jitter, three explicitly simulated HTTP faults and the conditional bid insert. A deterministic file-backed two-connection regression fails with the old insert and passes with the guarded statement; the integrated monolith suite passed218. Real financial fault/restart/auth acceptance with C/B/E remains open; these fixtures do not close Area D.

## A step 5D legacy-only rehearsal — 9 November 2026

[Legacy rehearsal](legacy-cutover-rehearsal-handoff.md) adds known distributed-source/attention guards to the read-only exporter, eight synthetic historical cohorts, actual C runtime/imported-data boundary checks, a WAL backup fixture and CI. Python16 and Node/PG34 tests passed locally using disposable data. Import preserves history but does not adopt/activate legacy intents; C/B eligibility/work/auth and the shared checkpoint/final cutover remain open. Known mixed SQLite/PG/broker state now requires explicit review rather than a SQLite-only export. No runtime schema, useful data, credentials or routing was changed.

## Step 5C A runtime preparation — 9 November 2026

[Financial runtime handoff](financial-finalization-runtime-handoff.md) supersedes the contract-only implementation status below. A now supplies three financial command/query HTTP routes, a separately authenticated callback, strict service-owned validation, the saved-key client, injectable Booking completion/cancellation/status/guard callers and pending/attention UI. Default production remains unwired; no schema, data, routing or real auth was activated. C still supplies durable financial operations, atomic Booking work/guards and recovery; B real verification/delegation; D faults; E final processes/tracing/Pact. See the handoff for exact validation and fixture limitations; step 5C as a whole and legacy eligibility/cutover remain open.

## Step 5C exact contract v1.0.0 — 8 November 2026

[Financial finalization contract](financial-finalization-contract-handoff.md) publishes strict OpenAPI/fixtures plus dev-only shape/identity/arithmetic validation for completion/cancellation/query/webhook and new-mode Booking projections. Local static conformance29 (19 existing+10 new) passed; a dedicated API schema/fixture CI job is added alongside ordered Pact. This is A's contract deliverable, not new endpoints/C persistence/B auth or live acceptance. Gateway v1 requires existing reviewed provisioning references, COD forbids them, and legacy adoption remains gated. A router/client and C/B integration are next; current startup/data/routing remain unchanged.

## Step 5C baseline adopted by the lead — 8 November 2026

The lead has now adopted [financial finalization policies and technical direction](financial-finalization-decisions.md) as the team baseline, superseding the proposal/review-before-code status recorded in #43 and the historical section below. A can author the exact versioned OpenAPI/payload/outcome/callable fixtures and implement its endpoints/client/callers without waiting for C/B direction approval. C owns the durable participant/work/recovery and B the real auth/permissions/callback verifier; both implement against the common baseline and report blockers rather than changing interfaces independently. This records a lead instruction, not teammate notification/acknowledgement or implemented runtime behavior; real integration/schema/data gates remain open.

## A step 5C decisions — 8 November 2026

[Financial finalization decisions](financial-finalization-decisions.md) record the lead's six selected A/C policies: completed with accounting pending, cancellation/hold release only after safe Payments confirmation, serialized settlement/fence/refund, same-key recovery/attention and Payments-owned callback. The separate technical proposal calls out COD without provisioning, local pending-cancel guards, payout eligibility and schema/importer review. No new endpoint, command store, caller, auth or runtime behavior is implemented; C/B technical contract review is next.

## A step 5B local relay retirement preparation — 8 November 2026

[Notification event delivery](notification-event-delivery-handoff.md) adds an explicit disabled-by-default mode that stops/guards the inherited relay without claiming local `processed_at`. C's existing separate ratings inbox retains Catalog/Provider aggregates in monolith. Validation: monolith202, Notifications42, actual SQLite→RabbitMQ→Notes plus monolith ratings boundary4, lifecycle5 and standalone build passed. Startup remains legacy. Provider writers/readers, B auth, old-event watermark/inbox migration and remaining financial writers must switch coherently; null local processed markers after new ownership are not permission to stamp or replay history.

## A step 5B provider writer preparation — 8 November 2026

[Provider event writers](provider-event-writes-handoff.md) add an explicit, disabled-by-default mode that omits signup SQLite wallet and approval SQLite notification writes while retaining C's existing transaction-bound events. Default responses/behavior remain compatible. Validation: monolith197, Notifications42, Payments90, actual monolith→RabbitMQ→two PG owner consumer boundary5 and standalone Next build passed. Remaining completion/refund/webhook, legacy notification relay/ratings, data/watermark/seed and real B/final-stack gates still prevent a production ownership switch. This does not close step 5B for all notification writers.

## A step 5A reader preparation — 8 November 2026

[Notifications caller composition](notifications-callers-handoff.md) prepares async inbox API/page readers behind the existing HTTP client and B credential callback. Default startup remains legacy; remote mode never falls back to local inbox SQL. [The step-5 audit](a-step5-caller-audit.md) distinguishes remaining direct writers and current C producers. Validation: monolith190, Notifications42, real HTTP/PG caller boundary5, standalone build and default-mode HTML smoke passed. Auth is fixture-only in boundary tests; production B auth, notification writer/event/data handover, final-stack and cutover are still gated. Earlier unchanged-caller statements below are historical.

Recorded 6 November 2026 against `main` at `67bd023fa64df9b12a2a6424473e389b565e80b2`. This is a shared implementation snapshot, not the final dossier. Check newer merged PRs, current code and affected owners before treating a pending item as current. A missing merged evidence link does not mean a teammate has not started work on a branch.

## Step 4 runtime assembly — 8 November 2026

This change adds [Payments/Booking composition](payment-runtime-composition-handoff.md) on top of main through #36. Payments startup now constructs C's participant/settlement/outbox hooks but has no real B verifiers and remains 503 for protected HTTP. Booking has an explicit composition for separate service/user credentials, C readiness and opt-in draining recovery; production monolith startup does not enable it. This supersedes older statements that Payments startup has no participant at all, without claiming live auth, final-stack acceptance or cutover. Remaining callers/writers and legacy-data gates still apply.

## Current caller preparation — 8 November 2026

A steps 1–2 are merged in #32–33: activation HTTP and its client/Booking adapter. This branch adds [step 3: pending/ready UI and Payments callers](payment-setup-callers-handoff.md), with owner-scoped intent/simulation HTTP, explicit remote wallet pending state and an injectable end-user access/readiness boundary. Its current validation covers Next route → client → Express → real C participant → isolated PostgreSQL. Authentication and readiness are explicit test doubles; no real Keycloak, C activation recovery or live cutover is claimed.

This supersedes older claims below that **all** clients/callers are unused or Payments mutation routes are unmounted. The default production bootstrap still does not configure them: legacy flows remain until explicit composition, while saga-owned bookings never fall back to a SQLite intent/simulation. Notification callers, provider-registration wallet writer, completion/refund/webhook migration, legacy eligibility, B verifier, corrected C recovery and final gateway/data/full-stack checks remain integration work. The older destructive-startup warning was superseded by #23; never use an older destructive image against preserved data.

## Integration update — 7 November 2026

C's messaging/outbox/consumer/saga preparation is merged through PRs #14–18; read [C messaging](c-messaging-handoff.md) and [C saga](c-saga-handoff.md). Saga activation and Payments participant endpoints/fence/eligibility remain pending. E's logging/metrics/Grafana/per-service tracing and PostgreSQL CI are integrated with those C commits in this change; [handoff](e-observability-handoff.md) and [validation](validation/e-main-sync-2026-11-07.md) cover available behavior and limits. The earlier snapshot below describes the A preparation milestone; C/E items there are historical, superseded by these handoffs where applicable. No final-stack/cutover completion is claimed.

New lead decisions: [A/C payment participant and wallet provisioning](payment-participant-decisions.md) fixes the ownership split, reuse of existing draft, durable HTTP activation, payment-setup-pending UI and asynchronous wallet provisioning. These are selected requirements, not implemented endpoints.

A importer review: [C-schema compatibility and message-state safeguards](validation/importer-c-state-2026-11-07.md) verifies the reviewed migrations and rejects nonempty outbox/dedupe state before fresh import or replay. No real migration or legacy-watermark handover has been performed.

A step 2: [payment command HTTP shell](payment-command-http-handoff.md) adds create/query/cancel validation and injectable B/C boundaries, tested through the actual prepared consumer client. Default production returns 503; activate is reserved/unavailable pending agreed state/replay contract. C persistence and live wiring are not implemented by this shell.

A startup update: [non-destructive SQLite bootstrap](sqlite-startup-handoff.md) initializes/seeds only empty databases, adopts the exact current unversioned schema without reseeding, and fails closed on incompatible schemas. Both Compose files mount persistent monolith data. This supersedes the historical destructive-startup warning below; full cutover/recovery remains pending.

A response to C PR #24: [participant interface](c-payment-participant-interface.md) accepts the direction and specifies historical create replay versus effective fence/activation, unchanged strict get shape, A-owned coded-error/client work and the separate legacy eligibility gate. This revision awaits C confirmation; participant/activation/wallet implementation and live wiring are still pending.

A B/C review: [review and owner handoff](a-b-c-integration-review.md) records C's confirmation of #25, A's importer/participant-FK corrections proposed against #27, and the remaining B-side JWT verifier/token-redirect work from #26. This is an unmerged follow-up; no live activation is claimed.

A activation HTTP update: [current activation route and error contract](payment-activation-http-handoff.md) supersedes the reserved activation route in the earlier #22 snapshot. It delegates to the real C participant in isolated HTTP/PG tests. Booking activation client/adapter/UI, real B verifier, live composition and corrected C recovery remain pending.

A step 2: [activation client and Booking adapter](payment-activation-client-handoff.md) implement the supplied-key transport and validated coded/uncoded 409 distinction. Actual HTTP/participant/PG tests cover replay after a committed/lost reply and an effective cancellation fence. Startup/caller/UI wiring and corrected B/C delivery remain pending.

## Decisions already selected

Extract Notifications and Payments & Wallet as Express services, each owning PostgreSQL in its own container/credentials. Booking/Bidding and remaining contexts stay in the Next.js/SQLite monolith initially. nginx is the gateway; Booking orchestrates the provisioning saga; notifications are asynchronous. [Migration handoff](migration-handoff.md) records the lead-selected decisions and proposed interfaces; [team plan](team-plan.md) and [OWNERS](../OWNERS.md) describe responsibilities. Draft interfaces still require integration review with B/C/D/E.

## Merged A work

All PRs below were verified merged. Their code/config/tooling is available on main; "prepared" means it has not been connected to live monolith traffic. Follow each handoff's exact limits and recorded test run rather than summing old test totals into a new end-to-end result.

| Merged PR | Available implementation | Handoff / recorded validation |
|---|---|---|
| [#5](https://github.com/digi1450/des428-capstone-homeservice/pull/5) | Two Express apps, independently owned PostgreSQL schemas/pools/migrations, transaction hooks, health checks and isolated dev Compose | [Service setup](../services/README.md), [scaffold evidence](validation/a-scaffold-2026-11-05.md) |
| [#6](https://github.com/digi1450/des428-capstone-homeservice/pull/6) | Notifications repository/business API, owner-scoped inbox/read updates and prepared monolith client | [Notifications handoff](notifications-handoff.md), [evidence](validation/notifications-business-2026-11-05.md) |
| [#7](https://github.com/digi1450/des428-capstone-homeservice/pull/7) | Payments intent/wallet/ledger/completion/refund/webhook primitives and guarded wallet/history reads | [Payments handoff](payments-business-handoff.md), [evidence](validation/payments-business-2026-11-05.md) |
| [#8](https://github.com/digi1450/des428-capstone-homeservice/pull/8) | Prepared Payments transport and Booking snapshot/key adapter, including unknown-outcome handling | [Adapter handoff](payment-adapter-handoff.md), [evidence](validation/payment-adapters-2026-11-06.md) |
| [#9](https://github.com/digi1450/des428-capstone-homeservice/pull/9) | Inherited notification recipient/content mappings and atomic batch writer for C's consumer integration; proposed provider-approval mapping | [Mapping handoff](notification-mappings-handoff.md), [evidence](validation/notification-mappings-2026-11-06.md) |
| [#10](https://github.com/digi1450/des428-capstone-homeservice/pull/10) | Prepared nginx baseline/candidate configs and real-nginx fixture routing/outage/recovery tests | [Gateway handoff](nginx-handoff.md), [evidence](validation/nginx-routing-2026-11-06.md) |
| [#11](https://github.com/digi1450/des428-capstone-homeservice/pull/11) | Read-only SQLite snapshot export, per-owner dry-run/import with replay/identity safeguards and caller cutover matrix | [Data/caller handoff](data-cutover-handoff.md), [evidence](validation/data-migration-2026-11-06.md) |

Shared setup/decisions and workflow were recorded earlier in PRs [#1](https://github.com/digi1450/des428-capstone-homeservice/pull/1), [#2](https://github.com/digi1450/des428-capstone-homeservice/pull/2), [#3](https://github.com/digi1450/des428-capstone-homeservice/pull/3) and [#4](https://github.com/digi1450/des428-capstone-homeservice/pull/4). Policy history: PR #3 replaced owner-only approval with one eligible peer approval. The lead subsequently selected zero mandatory approvals on 6 November: a PR is still required and any writer may merge their own or another member's PR when other applicable requirements pass. GitHub does not allow authors to approve themselves; removing mandatory approval enables this workflow. Owner bypass remains enabled, but agents still need explicit authorization to merge or bypass rules. Read [CONTRIBUTING](../CONTRIBUTING.md) for current workflow. The [original baseline](baseline/2026-11-04/README.md) is historical evidence.

## What is still active / not yet integrated

- Original monolith still serves user flows from SQLite. Prepared clients/adapters are unused by existing routes/pages/financial writers. APIs and Server Components both need coordinated changes; [inventory](extraction-inventory.md) lists them.
- Real service bootstraps have no B token verifier yet: business HTTP access fails closed with 503. Test auth doubles are not Keycloak evidence. Payments mutation HTTP endpoints remain unmounted pending authorized B/C wrappers.
- Primitives/hooks and notification mappings are not C's durable command results/cancel fences, saga/recovery, outbox publisher, RabbitMQ consumers or dedupe. No production consistency integration is claimed.
- nginx configs are prepared; candidate routing has not been activated. The isolated routing fixtures are not the full application stack.
- No real backup/export/import or caller cutover has been performed. The migration importer pins current A schema versions and intentionally rejects additional migrations until reviewed with C. Business rows alone do not bootstrap C's command/eligibility/dedupe state.
- Original monolith startup still DROP/reseeds its SQLite schema. Durable storage and non-destructive startup must be implemented before migration/cutover; do not reset useful data. Final root Compose, actual auth/fault/Pact/OTel/CI/full-stack resource evidence, report/demo/recording remain pending in this snapshot.

A's independent preparation is merged. Area A is **not complete**: actual extraction requires authoritative service reads/writes, compatible public flows and no monolith SQL against the moved tables after cutover. The inherited test baseline, fixture success and merged preparation PRs do not prove that final state.

## Where teammates can continue

| Area | Read before integration | Next work / A's integration revisit |
|---|---|---|
| B — Secure | [Notifications](notifications-handoff.md), [Payments](payments-business-handoff.md), [adapters](payment-adapter-handoff.md), [gateway](nginx-handoff.md) | Real issuer/signature/expiry/audience/role verification, integer domain-ID mapping and end-user/service credentials. A wires these into both services and HTTP/Server Component calls, then verifies real ownership/auth behavior. |
| C — Keep data correct | [Migration decisions](migration-handoff.md), [Payments hooks](payments-business-handoff.md), [adapter keys](payment-adapter-handoff.md), [mappings](notification-mappings-handoff.md), [data/caller cutover](data-cutover-handoff.md) | Durable command/fence/eligibility, same-client outbox/dedupe effects, Booking saga/recovery and all inherited producers/consumers. Agree wallet registration flow and legacy-state bootstrap. A integrates hooks/writers/callers and extends importer compatibility only after C migrations are reviewed. |
| D — Survive failure | [Adapter semantics](payment-adapter-handoff.md), [Payments](payments-business-handoff.md), [gateway](nginx-handoff.md), [migration decisions](migration-handoff.md) | Bounded retries with stable keys, real fault/concurrency evidence and the assigned race work. Unknown timeout must not release slots or create a new command. A integrates wrappers and fixes issues exposed by actual tests. |
| E — Observe and ship | [Service setup](../services/README.md), [gateway](nginx-handoff.md), [data/caller cutover](data-cutover-handoff.md), [migration decisions](migration-handoff.md) | Final root Compose, persistent/non-destructive runtime, private networking and real trace/log/metric/Pact/Actions-act wiring. A coordinates names/ports, candidate activation and full-stack acceptance; measure the combined stack against 8 GB. |

Teammates may continue their implementation using reviewed fixtures/contracts; they do not need to wait for final cutover. Consult the owner before changing a shared interface. Do not substitute raw identity headers, cross-owner SQL, SQLite fallback or invented production state for a missing integration.

## Before claiming completion

Use the [data/caller runbook](data-cutover-handoff.md) and [nginx activation checklist](nginx-handoff.md): review actual B/C/D/E deliveries; integrate and test auth/consistency/resilience; replace destructive startup; freeze/reconcile/backup; preflight and migrate both owners; coordinate all callers/writers/event boundaries/gateway; test real API/UI behavior and restart/faults. Keep real contribution/test evidence and prepare the team's dossier/demo/recording. No individual deadlines are assigned here.

This document records shared project decisions and implementation evidence. It does not reproduce the chat's complete requests or any local private planning notes.
