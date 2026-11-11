# Notifications event mappings — A to C handoff

> Current-status note — 12 November2026: [A–E status](current-area-status.md)
> and [actual local cutover](validation/a-local-cutover-2026-11-12.md) supersede
> earlier pending/unmounted/unwired/no-cutover labels in this historical handoff.
> PR73–78 are merged; auth/callers/owners and approved local deployment are integrated.
> Keep the contracts, safety requirements and original test limits below. Shared
> defaults remain gated; this local result does not approve another deployment
> or close D's broader races/browser/offline/submission work.

> Current status: C event producers/inboxes are implemented; provider.approved is no longer proposed-only. [Provider writer preparation](provider-event-writes-handoff.md) and [legacy relay retirement preparation](notification-event-delivery-handoff.md) add explicit disabled-by-default selections. The original preparation/absence-of-C statements below are historical; no production cutover is claimed.

Status: pure business projections and atomic local batch writer prepared. The five inherited event mappings and direct provider-approval message are preserved. The monolith still runs its original relay/direct writer; no broker consumer, outbox publisher, data migration, active caller switch or nginx change is made here. C/B integration is still required before cutover.

## Mapping entry points

- `services/notifications/src/event-mappings.js`: `mapNotificationEvent(eventType, data)` returns notification commands using the existing record() camelCase fields. It does no SQL, ack, dedupe, transport validation or ratings work; it does not mutate input or copy extra payload fields into notifications.
- `services/notifications/src/event-writer.js`: `createNotificationEventWriter(database).recordEvent(eventType, data, { client })` projects/validates the entire batch first, then writes every command using Notifications record() with the SAME transaction client. Without a supplied client it opens one local transaction for the batch. With C's client it joins C's transaction. It deliberately does NOT dedupe deliveries itself.
- [Projection schema](../contracts/notification-projections.schema.json) and [fixtures](../contracts/fixtures/notification-projections.json) describe ONLY `{ event_type, data }` for review with C, not a new replacement transport envelope. C validates envelope/version/producer/identity and extracts that pair before invoking the mapping.

## Preserved business rules

| Event | Mapping |
|---|---|
| review.created | new_review to the provider, using the original star/booking message. Catalog/Provider rating aggregation stays with the monolith data owners |
| booking.status_changed | Provider actor notifies customer; customer/admin actor notifies provider. Existing six public status labels and text are retained |
| booking.completed | rating_request to customer |
| bid.accepted | bid_accepted to winner first, then bid_rejected to each loser in input order. Winner uses the booking order ID; loser notifications have null order_id |
| payment.succeeded | payment_received to provider, preserving the original integer-cents text. Explicit provider_id=null is the recognized legacy no-recipient case and returns [] |
| provider.approved — PROPOSED | provider_approved text matching the current direct approval writer, null order_id. This event is not currently emitted by the monolith |

Used identifiers must be positive PostgreSQL INTEGER values. Ratings are integer 1–5, money is nonnegative integer cents and booking status/actor values must match the documented domain. Bid losers may be omitted/null/empty; if present they must be unique IDs disjoint from the winner. JSON Schema validates structure/duplicate losers; the dynamic winner/loser exclusion is an additional business check in the mapper. Unknown events, missing used fields and malformed recipients throw before SQL rather than silently appearing processed. A missing payment provider_id is invalid; explicit null preserves the intentional legacy no-recipient case.

The actor values are customer/provider/admin; internal saga states or new actor labels such as system require a reviewed domain contract/update, not silent coercion. Unused source data is tolerated for compatibility but not copied to notification rows. Producers must still avoid putting credentials/OTPs or unnecessary private data in broker messages.

## C integration pattern — not implemented transport

```js
const writer = createNotificationEventWriter(database);
await database.withTransaction(async client => {
  // C validates envelope/version/producer and inserts consumer_name + event_id
  // using this SAME client; on duplicate, return without creating effects.
  await writer.recordEvent(event.event_type, event.data, { client });
  // C commits the dedupe/effects transaction before acknowledging the broker.
});
```

Every recipient from a bid must share the dedupe transaction; do not commit each recipient separately. C owns actual dedupe persistence, broker retry/poison handling, consumer lifecycle and ack. Standalone recordEvent() is atomic but repeated calls intentionally create repeated notifications. The SQL probe used by tests is not C's schema or a RabbitMQ implementation.

A valid no-recipient event returns [] without SQL in the writer; C can still record successful processing in its own dedupe transaction. An unsupported or invalid event throws; C must apply its explicit retry/quarantine/manual-attention policy instead of silently acknowledging it as a successful projection.

## Producer/cutover work still needed

For provider approval, C must add a versioned provider.approved producer/outbox in the SAME SQLite transaction as the approval flag. It should replace the direct notification writer only during a coordinated cutover. The new mapping alone does not publish anything or make approval asynchronous in the current application.

For review.created, only the notification effect moves here. Catalog and Provider rating recomputation must continue in their owning monolith contexts using a separate appropriate consumer path. Do not move the old relay wholesale into Notifications or suppress the ratings consumer with a shared/global dedupe marker. C must use consumer-scoped dedupe so independent consumers can each apply their own effect.

All original monolith relay/provider-approval writes remain active now. Do not start both old and new delivery paths against the same user-facing stream or switch reads before replacement writers/auth are ready. B still wires real auth; A's existing caller/data cutover and E's final stack remain later work.

## Validation / reproduction

See [mapping validation](validation/notification-mappings-2026-11-06.md). Pure tests exercise each message/recipient rule and reject invalid batches; PostgreSQL tests cover atomic multi-recipient writes, same-client dedupe pattern and rollback; the opt-in Node 20 parity harness executes the actual original relay/direct approval writer on in-memory SQLite and compares exact mapped commands. It does not use a broker or real Keycloak.
