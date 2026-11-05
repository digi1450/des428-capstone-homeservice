# Notifications business slice — A handoff

Status: PostgreSQL repository/service and read/mark-read HTTP router implemented. The monolith HTTP client is prepared and tested, but existing monolith routes/pages/relay still use SQLite. Authentication, broker delivery/dedupe, cutover/backfill and final gateway remain pending. This is progress toward extraction, not a completed migration.

## A: implemented entry points

- `services/notifications/src/repository.js`: parameterized inserts/reads and role+ID-scoped mark-read; no other context/database imports.
- `services/notifications/src/service.js`: `listForUser(principal)`, `markRead(id, principal)` and internal `record(command, { client })`. Public rows retain exactly id/type/title/body/order_id/read_at/created_at; PostgreSQL timestamps serialize as ISO UTC strings, IDs remain numbers. Inbox is newest first. Read replays preserve the first timestamp.
- HTTP `GET /api/notifications` and `POST /api/notifications/{id}/read` preserve original public paths/shapes. Existing owner checks are preserved: a different role or ID, including admin, cannot mark another recipient's item read. Missing item is 404; invalid ID is 400.
- `bangkok-homeservice/lib/modules/notifications/client.js`: `createNotificationsClient({ baseUrl, timeoutMs, fetchImpl })`; `listForUser(credentials)` / `markRead(id, credentials)`. It forwards a bearer token and optional requestId/traceparent/tracestate, rejects redirects and malformed payloads, and bounds both response headers and body with one deadline. D may wrap it with agreed retries; it does not retry or fall back to SQLite.
- [Notifications OpenAPI](../contracts/notifications.openapi.json) and [fixtures](../contracts/fixtures/notifications.json) describe the read interface. B/C/E must review integration details before cutover; schema tests are not Pact.

## B: concrete authentication seam

`createApp({ database, authenticate })` accepts an async `authenticate(req)` function. It must validate Keycloak issuer/signature/expiry/audience and resolve the end-user subject into:

```js
{ role: "customer", domainId: 7 } // role: customer/provider/admin; integer domain ID
```

The router revalidates that shape. It does not derive identity from X-Role/X-User-Id, query parameters or a request body. Throw `HttpError(401, "invalid token")` or `HttpError(403, "forbidden")` from the verifier for expected auth failures; unexpected errors are scrubbed. Do not enable a test verifier in production.

The current `src/server.js` deliberately supplies no verifier: business routes return **503** until B wires one; health routes still check HTTP/database readiness. No environment variable enables a header-trust shortcut. Test code explicitly injects synthetic token-to-user mappings; those tests do not prove real Keycloak verification. The existing monolith session tokens are not automatically Keycloak-compatible; B/A must settle browser/Server Component token forwarding during cutover.

## C: atomic notification writes

The internal command shape matches the inherited repository:

```js
{
  recipientRole: "provider", recipientId: 3, type: "payment_received",
  title: "Payment received", body: "Payment for booking #42.", orderId: 42
}
```

This is an internal function input, not an HTTP write endpoint. C should validate the event envelope/version/producer, then execute its consumer dedupe and ALL notification effects in one local transaction:

```js
await database.withTransaction(async client => {
  // C: check/insert (consumer_name, event_id) here, using this client.
  // On a duplicate, return without writing any notification.
  await notifications.record(command, { client });
  // C: commit before broker acknowledgement; rollback must leave neither effect nor dedupe.
});
```

`record()` with a client joins the transaction; without a client it opens its own. This method alone provides no event dedupe. C's outbox/inbox and consumer lifecycle remain C's implementation. The original relay's five notification mappings still live in the monolith; coordinate their movement with A. Review-created rating recomputations stay with Catalog/Provider data owners. Provider approval's direct notification must also become durable service-owned delivery before retiring SQLite writes.

## Remaining cutover acceptance

1. B's real verifier and end-user/domain-ID mapping work in both HTTP and Server Component paths; test expired/wrong-audience/ownership cases.
2. C's durable producer/consumer integration and dedupe work for all inherited notification paths; outage/replay does not lose or duplicate effects.
3. A migrates existing notification IDs/data and identity sequence safely, switches API handlers AND `app/notifications/page.js` to await the client, and removes monolith notification-table access only after replacement writers/readers work together. Do not enable remote reads while new notifications are still written only to SQLite.
4. E wires gateway/Compose, contracts/Pact and tracing; D validates agreed timeouts/retry behavior. Prepared trace header forwarding is not a measured distributed trace.

Recorded results: [Notifications validation](validation/notifications-business-2026-11-05.md).

## Reproduce checks

Start the isolated scaffold per [services setup](../services/README.md). From the repository root after installing service/monolith dependencies:

```sh
npm --prefix contracts test
docker compose -f bangkok-homeservice/docker-compose.yml run --rm --build test
# Use only an isolated disposable Notifications database for these opt-in tests:
TEST_DATABASE_URL='postgresql://USER:PASSWORD@127.0.0.1:PORT/DB' npm --prefix services/notifications test
TEST_DATABASE_URL='postgresql://USER:PASSWORD@127.0.0.1:PORT/DB' node --test tests/integration/notifications-boundary.test.mjs
```

The boundary test uses the real monolith client, HTTP router and PostgreSQL together, with a clearly identified auth test double. It does not use real Keycloak, RabbitMQ or nginx and does not activate the existing application routes.
