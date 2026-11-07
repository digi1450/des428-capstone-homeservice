// Area C — idempotent receiver for Notifications (Week 9 slides 26–30).
// The dedupe record and every notification produced by one event are written with
// ONE transaction client. A redelivered event finds its record and does nothing.
// Two concurrent deliveries of the same event serialize on the primary key: the
// second waits for the first to commit, then sees the conflict and skips.
import { createNotificationEventWriter } from "../event-writer.js";
import { HttpError } from "../errors.js";
import { EXPECTED_PRODUCER, PermanentEventError } from "./envelope.js";

export const CONSUMER_NAME = "notifications.inbox";

export function createInbox(database, { consumerName = CONSUMER_NAME, writer = createNotificationEventWriter(database) } = {}) {
  return {
    async handle(envelope) {
      const expected = EXPECTED_PRODUCER[envelope.event_type];
      if (!expected) throw new PermanentEventError(`unsupported event type ${envelope.event_type}`);
      if (envelope.producer !== expected) throw new PermanentEventError(`${envelope.event_type} must come from ${expected}`);
      return database.withTransaction(async client => {
        const claimed = await client.query(
          `INSERT INTO processed_events (consumer_name, event_id, event_type, producer, effect_count)
           VALUES ($1, $2, $3, $4, 0)
           ON CONFLICT (consumer_name, event_id) DO NOTHING`,
          [consumerName, envelope.event_id, envelope.event_type, envelope.producer],
        );
        if (claimed.rowCount === 0) return { duplicate: true, effects: 0 };
        let created;
        try {
          created = await writer.recordEvent(envelope.event_type, envelope.data, { client });
        } catch (error) {
          // The mapping rejects malformed data with 400: retrying cannot fix it.
          if (error instanceof HttpError && error.statusCode === 400) throw new PermanentEventError(error.message);
          throw error;
        }
        await client.query(
          "UPDATE processed_events SET effect_count = $3 WHERE consumer_name = $1 AND event_id = $2",
          [consumerName, envelope.event_id, created.length],
        );
        return { duplicate: false, effects: created.length };
      });
    },
  };
}
