# A step 5: caller/writer audit — 8 November 2026

Source snapshot: `main` commit `48d7780f31a5a45a46ec2a2a257078fe5de1a1cd`
(after #37 runtime composition, #38 tracing runner and #39 resource override).
This is a static source audit and implementation order, not completed cutover or
new runtime evidence. It supersedes older inventory statements where they say
all clients are unused, C events/consumers do not exist, or importer support ends
at Payments migration 003. Paths in tables are relative to `bangkok-homeservice/`.

> Follow-up: [step 5A Notifications reader preparation](notifications-callers-handoff.md) implements the explicit API/page access seam identified below. The table remains the preceding source snapshot; writer/data/auth activation gates are unchanged.

> Provider follow-up: [step 5B signup/approval writer preparation](provider-event-writes-handoff.md) adds an explicit events-only selector for those two writers; remaining financial/notification writers and all production activation gates stay open.

> Relay follow-up: [legacy relay retirement preparation](notification-event-delivery-handoff.md) selects C broker/independent ratings delivery without local claims. Startup/data/auth cutover remains gated.

> Step 5C policy follow-up: [financial finalization decisions](financial-finalization-decisions.md) records the lead selections separately from the A/C/B technical proposal; financial writer implementation remains pending.

## Ownership and present state

Notifications owns `notifications`. Payments & Wallet owns `payment_intents`,
`transactions`, `provider_wallets`, `webhook_events` and its own consistency
metadata. Booking/Bidding, identity, provider profiles, Catalog/Provider ratings,
SQLite outbox/inbox and Booking saga state remain monolith-owned.

There are three distinct states today: prepared remote callers, inherited local
writers still in use, and actual process activation not yet configured. None is
permission to open mixed SQLite/PostgreSQL ownership. A remote outage must never
select stale SQLite after the remote owner has been chosen.

## Remaining call paths

| Flow | Verified current source | Remaining A work / dependency | Acceptance before cutover |
|---|---|---|---|
| Notification list/read/API and HTML inbox | `app/api/notifications/route.js`, `app/api/notifications/[id]/read/route.js`, `app/notifications/page.js` call local `lib/modules/notifications/service.js` -> `repository.js`. `client.js` exists but those callers do not use it. | Add explicit authorized access composition and async callers, including Server Component credentials from B. Keep public projections and existing ownership checks. | List/mark-read through API and page with migrated IDs/read state; wrong owner/role/expired credentials rejected; no SQL fallback on service failure. |
| Notification event delivery | `lib/modules/notifications/relay.js` still writes SQLite notifications and recomputes ratings. `instrumentation.js` always starts it. C's broker relay and separate Notifications inbox already exist. | Retire local notification dispatch together with producer/consumer cutover; coordinate saved event watermark/queues with C/E. Preserve rating recomputation via C's monolith rating consumer. | Each booking/review/bid/payment/approval event produces the intended notifications once under redelivery/restart; ratings remain correct. Do not simply stop the old relay before its rating replacement is active. |
| Provider approval | `lib/modules/providers/service.js:approveProvider` performs BOTH a direct SQLite notification insert and durable `provider.approved` event in the profile transaction. | C's event is already implemented: remove the direct notification writer only with remote inbox/data transition. No HTTP call inside the profile transaction. | Approval survives notification downtime; one eventual notification, preserved response and profile state. |
| Provider registration/wallet | `lib/modules/identity/service.js:registerProvider` inserts provider/profile, calls `repository.insertProviderWallet`, and stages `provider.registered` in one SQLite transaction. C's `services/payments-wallet/src/wallet-consumer.js` already exists. | Keep durable event with provider/profile, retire the SQLite wallet insert only with reviewed rollout. E wires wallet consumer and monolith broker publishing/migration readiness. B coordinates identity, not wallet SQL. | Registration while Payments/consumer is unavailable remains recoverable; pending wallet shown correctly; replay creates one PG wallet and preserves balances. |
| Placement and payment views | `app/api/bookings/route.js` uses C saga only when configured, otherwise inherited placement creates SQLite intent; configured remote access without saga rejects gateway placement. `booking/service.js:reserveBooking` still has explicit `localIntent` mode. `payment-view.js` and `payments/access.js` already prepare remote detail/simulate/wallet/history. | Finish B injection and production startup; choose remote ownership coherently. Preserve default compatibility until the cutover gate. Review legacy non-saga bookings separately. | Gateway/COD creation, lost reply/activation recovery and stable keys; no local intent reads/writes after remote selection. Remote intent existence alone never grants ready. |
| Provider wallet/dashboard and customer history | API routes and provider Server Components already use `payments/access.js`; without runtime it calls legacy Payments service. | Reuse existing composition; supply B's delegated end-user credentials for BOTH request and page contexts. Do not rewrite these as missing clients. | Migrated balances/history, missing-wallet pending union, owner checks and unavailable behavior through APIs AND HTML. |
| Complete booking (including custom-job COD) | `app/api/bookings/[id]/complete/route.js` -> `booking/service.js:completeBooking` updates Booking and directly credits SQLite wallet / inserts payout or commission ledger. Bidding creates COD bookings, so it is affected even without an intent. | Design durable completion handoff with C. PG `applyCompletion` is implemented, but no authorized HTTP/client operation or durable Booking completion delivery is mounted. Preserve OTP/state transitions and reconcile unknown outcomes. | Gateway payout and COD commission exactly once, missing-wallet/restart recovery, repeated/concurrent completion, historical replay without double credit; no remote HTTP inside SQLite transaction. |
| Cancel/refund/void | `app/api/bookings/[id]/cancel/route.js` -> `booking/service.js:cancelBooking` releases slots, marks local paid orders refunded and inserts SQLite refund. C's provisioning cancel fence addresses create/activation compensation, not the entire paid-booking refund flow. | Agree durable cancellation/refund state and pending/confirmed result with C. PG `applyRefund`/`voidUnpaidIntent` exist as primitives, not mounted authorized operations for these callers. | Paid/unpaid cancellation, settlement racing cancellation, duplicate/refund replay, timeout/restart and ledger reconciliation; never claim refund completed from a timeout. |
| Webhook and inherited simulation | `app/api/payments/webhook/route.js` uses shared-secret auth then local `payments/service.js:handleWebhook`, which writes receipt/intent/charge and Booking paid flag. Legacy `payments/gateway.js` calls that same function. New remote simulation exists separately. | Provide the reviewed remote callback path/auth and reconcile delivery with C. Use C's existing `booking/payment-events.js` handler for Booking paid status after PG settlement. Do not confuse a business `settleWebhook` function with an exposed webhook route. | Gateway-event and intent dedupe, one charge/outbox, actual Booking paid event, unknown/cancelled/refunded cases recorded for attention; no new PG service cross-reads SQLite orders. |

## Existing pieces to reuse, not rebuild

- [Payment runtime](payment-runtime-composition-handoff.md): real C participant,
  transaction-coupled outbox, Booking readiness and explicit recovery composition.
  Startup still lacks B verifiers/delegation; default protected service HTTP is 503.
- [Payment callers](payment-setup-callers-handoff.md): pending/ready UI, remote
  intent/simulation/wallet/history callers. Default legacy paths remain temporary.
- C monolith `lib/messaging/consumers.js` registers payment-status and rating
  consumers; `instrumentation.js` starts broker relay/consumers only when
  `AMQP_URL` is supplied. Root Compose currently does not supply that to monolith.
- Provider registration and approval already stage their C events. Do not ask C
  to implement those producers from scratch or add a duplicate event path.
- PG completion/refund/void/provision primitives exist in
  `services/payments-wallet/src/service.js`. Their existence does not supply a
  durable command protocol, Booking caller or authorized transport.

## Data, schema and routing gates

1. `tools/data-migration/import-snapshot.mjs` already accepts Notifications
   migrations 001–002 and Payments 001–004. It requires outbox, command,
   provisioning and dedupe state to be empty. Do not clear live message state to
   satisfy it. Re-review after any newer schema change.
2. Importer does not activate legacy unpaid intents. A/C must define treatment
   of old unpaid/paid/refunded/completed bookings, stored HTTP replay responses,
   frozen event watermark and already-queued messages before importing/opening
   traffic. Never replay old bookings as new create/activate commands.
3. `lib/db/seed.js` still writes local provider wallets. `schema.js` and
   `migrate.js` describe/validate the exact inherited SQLite schema; normal
   startup preserves it. Treat source seed, PG fixture setup, schema retirement
   and migrated startup as coordinated work; do not delete tables now or weaken
   the non-destructive schema guard merely to pass tests. SQLite order/ledger
   foreign keys also require review before any future physical table removal.
4. Root gateway still mounts `infra/nginx/routes.baseline.conf`.
   `routes.services.conf` is candidate-only: it routes all `/api/payments/*` to
   Payments, whose public webhook is currently absent. Validate each actual
   exposed path and final callback/auth contract before enabling candidate.
   HTML/Server Components remain monolith-owned even when API routes move.
5. Follow [data cutover runbook](data-cutover-handoff.md): stop/drain all writers,
   consistent SQLite backup, reconcile/export, both-owner dry-run, import and
   validation before opening writes. After new writes, reverting nginx alone to
   stale SQLite is unsafe. No useful data is migrated in this audit.

## Recommended implementation order

| Slice | Start now | Must coordinate before activating |
|---|---|---|
| 5A Notifications readers | Add explicit client/credential seam and async API/page callers; test with clearly labeled fixture auth. This is the smallest next A change. | B real user verification/delegation, C/E writer/data/event transition. Do not enable readers against an unseeded/partially migrated PG inbox. |
| 5B Registration and notification writers | Prepare caller policy/tests to retire local wallet/notification writes while retaining existing durable events. | C/E wallet worker, broker/ratings/notification delivery and shared cutover mode; B registration changes. |
| 5C Completion/refund/webhook | Inventory complete; draft transport, durable keys, outcome/state and replay acceptance from existing primitives. | Agree A/C protocol and B permissions before implementing new contracts. D validates faults; E wires processes. |
| 5D Legacy data and routing rehearsal | Build acceptance fixtures and review frozen snapshot/importer compatibility; no useful-data apply. | A/C legacy eligibility and event watermark, then B/D/E final-stack acceptance. |
| Final switch | Only after step 4 auth/process gates and the above whole-flow transitions pass. | Coordinated backup/import/readiness/routing, load/recovery evidence and data-aware rollback. |

Do not label step 4 or 5 complete because one reader works. Scan again after
each slice for direct SQL, repository imports, legacy service fallbacks and
Server Component calls. Validate relevant unit/business and actual service
boundary tests; use disposable data and explicit auth doubles until B delivers
real credentials. No new business tests were run for this documentation-only
audit, and no runtime/Compose/credential/data setting was changed.
