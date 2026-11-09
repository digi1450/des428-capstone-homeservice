# A step 5A — Notifications reader composition

8 November 2026. Prepared API and Server Component callers, not live extraction.
The [step-5 caller audit](a-step5-caller-audit.md) records the preceding source
snapshot and remaining whole-flow transitions.

## Implemented

`bangkok-homeservice/lib/modules/notifications/access.js` exports
`configureNotificationsAccess({notificationsClient, credentials})`,
`getNotificationsAccess`, `listNotifications(auth, context)` and
`markNotificationRead(id, auth, context)`. Use the existing
`createNotificationsClient({baseUrl, timeoutMs})` for the client. Credentials must
be supplied by B after verified end-user mapping/delegation; this module does
not manufacture a token, accept raw role/ID headers, or implement JWT checking.

Both client operations and the credentials callback are required before
configuration is set; an incomplete configuration cannot partially enable it.
Replacement is rejected. Each call validates the mapped integer subject and
customer/provider/admin role, snapshots its configuration, then delegates. HTTP
routes pass their Request to the callback; the Server Component calls with the
verified session and no Request. B's callback must support both contexts using
its reviewed server-side session/delegation mechanism. Only role and subject
are passed as actor data; tokens/passwords are not copied from arbitrary claims.

Both existing API handlers now await the access layer. `/notifications` is an
async page and uses the same reader while retaining the existing login redirect,
markup and mark-read UI. IDs, response projections, dates and route paths stay
compatible. Recipient ownership remains independently enforced in Notifications
by the verified service principal; there is no local ownership lookup after
remote selection. B must bind the supplied credentials to that user.

With no composition, legacy reads/writes for these reader operations remain the
default. After explicit configuration, list/read calls never fall back to the
SQLite notification repository on unavailable/401/403/404 or missing credentials.
A remote outage is an error, not an empty inbox. The exported reset helper is
for tests or coordinated teardown, not automatic failure recovery; never reset
composition while serving traffic to make an outage use stale SQLite.

> Provider writer follow-up: [signup/approval events-only preparation](provider-event-writes-handoff.md) is available but remains disabled; it does not retire every notification writer or activate readers.

## Activation gate — unchanged

Nothing is added to production bootstrap. The default Notifications server still
has no real B verifier, and this slice does not retire SQLite notification
writers, provider-approval writes, legacy relay, or migrate inbox data. Do not
configure remote readers against an unseeded/partially migrated inbox or enable
candidate nginx routes merely because these tests pass. Coordinate A/C/E writer
and event-watermark transition, preserve ratings in the monolith, import old IDs
and read timestamps, and supply real B credentials before enabling this path.

This is the reader portion of 5A, not all Notifications extraction or step 5.
Completion/refund/webhook protocols, signup wallet transition, legacy eligibility
and final data/routing cutover remain as listed in the audit.

## Validation actually run

All checks used disposable containers/source copies with no host ports or useful
data. No new packages, schema changes or dependency upgrades.

- Full monolith suite, Node 20: **190 passed**, no failures/skips/cancellations.
  New composition tests cover unchanged legacy behavior, owner/read replay,
  incomplete/replacement configuration, shared API/page accessor without the
  SQLite notifications table, unavailable behavior without local mutation, and
  rejection of invalid actors/IDs before credentials are requested.
- Existing Notifications service suite, Node 22 + PostgreSQL 16: **42 passed**,
  no failures/skips/cancellations.
- New `tests/integration/notifications-callers-boundary.test.mjs`, Node 20 +
  actual HTTP/Express/PostgreSQL: **5 passed**, no failures/skips/cancellations.
  It drops the disposable SQLite notifications table; API and page accessor read
  real PG rows, mark-read retains its first timestamp, same integer/different
  role and different owner cannot mark another inbox, and 401/403/404/503 persist.
  Request ID forwarding is observed. Authentication is an explicit fixture map,
  not Keycloak verification. The service's real ownership logic is exercised.
- Production standalone Next Docker build passed. A disposable runtime with
  networking disabled rendered `/notifications` after seeded login and redirected
  an anonymous request. This HTML smoke is **legacy/default mode**; remote page
  access is checked through the shared accessor in boundary tests, not a live
  remote-configured Next/Keycloak deployment or browser interaction.
- Document links/source pointers and `git diff --check` pass.

Reproduction with installed dependencies:

```sh
npm test --prefix bangkok-homeservice
# TEST_DATABASE_URL must point to disposable Notifications PostgreSQL for SQL cases.
npm test --prefix services/notifications
# TEST_NOTIFICATIONS_DATABASE_URL must point to a disposable Notifications DB.
node --test tests/integration/notifications-callers-boundary.test.mjs
```

The boundary skips without its explicit database URL; a skipped run is not the
recorded result. Use compatible native SQLite dependencies for the selected Node
runtime. These checks do not establish final-stack auth, RabbitMQ delivery,
Jaeger tracing, load/resource limits or a real data migration.
