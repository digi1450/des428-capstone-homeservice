# A extraction inventory — initial source audit

Status: source inventory for the first scaffold, not a completed extraction. Notifications repository/service/router and an unused monolith HTTP client are now implemented; see [Notifications handoff](notifications-handoff.md). All existing callers below still run in the monolith. Preserve their public paths, authorization, field types and behavior when replacing direct imports/SQL with authorized service clients. See [migration handoff](migration-handoff.md) for selected boundaries and saga rules.

| Existing path | Current access/effect | Required destination / coordination |
|---|---|---|
| `lib/modules/notifications/repository.js` | Insert, list, get and mark read | Notifications PostgreSQL repository; B verifies recipient ownership |
| `lib/modules/notifications/service.js` | Inbox projection/ownership checks | Notifications service plus authorized monolith client |
| `lib/modules/notifications/relay.js` | Five event handlers create notifications; review handler also recomputes ratings | C moves delivery to RabbitMQ; keep Catalog/Provider rating writes with monolith owners |
| `lib/modules/providers/service.js` | Provider approval directly inserts notification | Replace with durable event or authorized service-owned write |
| `app/api/notifications/route.js`, `app/api/notifications/[id]/read/route.js` | Public inbox and mark-read | Preserve routes and response projections; call Notifications with verified identity |
| `app/notifications/page.js` | Server Component calls service directly | Async authorized service client; gateway routing alone doesn't replace it |
| `lib/modules/payments/repository.js` | Intent, transaction, wallet and webhook writes/reads | Payments & Wallet PostgreSQL repository |
| `lib/modules/payments/service.js` | Settlement also reads orders and marks them paid | Payments stores trusted context locally; C delivers settlement event, Booking updates own paid flag |
| `lib/modules/payments/gateway.js` | Simulate payment and drive webhook | Preserve owner checks and offline mock flow; B authorizes the internal callback |
| `lib/modules/booking/service.js` | Placement inserts intent; completion credits wallet/commission; cancellation records refund; detail reads intent | A replaces all moved-table operations; C orchestrates provisioning/compensation, D retry semantics |
| `lib/modules/identity/repository.js`, `lib/modules/identity/service.js` | Provider registration initializes wallet in local transaction | Idempotent service-owned wallet provisioning and recoverable registration behavior |
| `app/api/payments/simulate/route.js`, `app/api/payments/webhook/route.js` | Public simulated payment/webhook | Preserve routes; coordinate B authentication and C replay handling |
| `app/api/provider/wallet/route.js`, `app/api/customer/transactions/route.js` | Public wallet/history | Authorized service calls; retain response fields and owner scope |
| `app/(provider)/provider/wallet/page.js`, `app/(provider)/provider/dashboard/page.js` | Server Components read wallet directly | Async authorized Payments client |
| `app/_ui/client.js` | UI uses booking result to call payment simulation | Preserve gateway/COD and payment_intent fields; retain stable request key for pending recovery |
| `lib/db/schema.js`, `lib/db/seed.js`, `instrumentation.js`, inherited tests | Shared SQLite table setup, provider wallets, relay boot and direct test dependencies | Retire migrated table access only after adapters and replacement data setup work; keep original tests meaningful |

All paths in the table are relative to `bangkok-homeservice/`. A must re-run the caller search after each migration: static inspection here is not proof that no callers remain.

Data owner after cutover: Notifications owns `notifications`; Payments & Wallet owns `payment_intents`, `transactions`, `provider_wallets`, `webhook_events`. Booking's `orders`, `order_items`, `slot_holds` and its saga stay in SQLite. No new PostgreSQL table references monolith tables through SQL foreign keys.

The initial schemas preserve integer domain identifiers, minor-unit money and existing payment status values. Payments adds trusted customer/provider context and THB currency locally. C's command results/fences/outbox and notification consumer dedupe require subsequent migrations; they are not implemented by the business schema. A must serialize PostgreSQL dates to compatible ISO strings and project original public fields instead of exposing storage rows blindly. Review data backfill/identity-sequence handling before any existing data is moved.

Prepared follow-ups now include [Payments/Booking adapters](payment-adapter-handoff.md), [notification mappings](notification-mappings-handoff.md), [nginx baseline/candidate configs](nginx-handoff.md) and [offline data/caller cutover preparation](data-cutover-handoff.md). The latter refreshes the caller/dependency/acceptance matrix above and provides synthetic SQLite→PostgreSQL rehearsal tools. No original caller or writer is switched by these preparations; real B/C/D/E integration and coordinated cutover remain required.
