// Must be the first import: gives the monolith an isolated in-memory SQLite database.
import { freshBoot, getDb } from "../../bangkok-homeservice/test-helpers/boot.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import amqp from "../../services/notifications/node_modules/amqplib/channel_api.js";
import { call } from "../../bangkok-homeservice/test-helpers/call.js";
import { loginSeededCustomer, loginSeededProvider, loginAdmin, futureWeekday } from "../../bangkok-homeservice/test-helpers/auth.js";
import * as bookings from "../../bangkok-homeservice/app/api/bookings/route.js";
import * as approve from "../../bangkok-homeservice/app/api/admin/providers/[id]/approve/route.js";
import { relayOnce } from "../../bangkok-homeservice/lib/messaging/broker-relay.js";
import { createPublisher } from "../../bangkok-homeservice/lib/messaging/publisher.js";
import { envelopeFromRow } from "../../bangkok-homeservice/lib/messaging/envelope.js";
import { createDatabase } from "../../services/notifications/src/database.js";
import { migrate } from "../../services/notifications/src/migrations.js";
import { createInbox } from "../../services/notifications/src/messaging/inbox.js";
import { startConsumer } from "../../services/notifications/src/messaging/consumer.js";
import { QUEUE, DEAD_LETTER_QUEUE, assertConsumerTopology } from "../../services/notifications/src/messaging/topology.js";

// Area C: monolith SQLite outbox -> RabbitMQ -> Notifications PostgreSQL. Opt-in, DISPOSABLE
// database and broker only (the test purges the Notifications queues). No Keycloak/nginx/saga.
const env = process.env;
const enabled = env.TEST_NOTIFICATIONS_DATABASE_URL && env.TEST_AMQP_URL;

async function eventually(check, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) assert.fail("timed out waiting for " + label);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test("monolith booking and approval events reach the Notifications database once", { skip: !enabled }, async (t) => {
  freshBoot();
  const notes = createDatabase(env.TEST_NOTIFICATIONS_DATABASE_URL);
  const started = new Date();
  const logs = [];
  const eventIds = [];
  let consumer, publisher, admin, channel;
  const owner = "it-monolith-relay";
  const notificationsFor = async (role, id, type) => (await notes.query(
    "SELECT * FROM notifications WHERE recipient_role=$1 AND recipient_id=$2 AND type=$3 AND created_at >= $4",
    [role, id, type, started])).rows;
  try {
    await migrate(notes);
    admin = await amqp.connect(env.TEST_AMQP_URL);
    channel = await admin.createChannel();
    await assertConsumerTopology(channel);
    await channel.purgeQueue(QUEUE);
    await channel.purgeQueue(DEAD_LETTER_QUEUE);
    consumer = await startConsumer({ amqpUrl: env.TEST_AMQP_URL, inbox: createInbox(notes), retryDelayMs: 100, log: (e) => logs.push(e) });
    publisher = await createPublisher(env.TEST_AMQP_URL);
    // Seed rows (if any) are not part of this test.
    getDb().prepare("UPDATE events SET published_at = 'seed' WHERE published_at IS NULL").run();

    const customer = await loginSeededCustomer("nong@example.com");
    const provider = await loginSeededProvider("sparkle@example.com");
    const addressId = getDb().prepare("SELECT id FROM addresses WHERE customer_id = ? LIMIT 1").get(customer.id).id;
    let bookingRow;

    await t.test("a customer's booking notifies the provider through the broker", async () => {
      const placed = await call(bookings.POST, { token: customer.token, body: {
        provider_id: provider.id, address_id: addressId, service_date: futureWeekday(5), starting_time: "11:00",
        items: [{ service_id: 2, quantity: 1 }], payment_method: "cod" } });
      assert.equal(placed.status, 201);
      bookingRow = getDb().prepare("SELECT * FROM events WHERE type='booking.status_changed' AND aggregate_id=?").get(placed.body.order.id);
      eventIds.push(bookingRow.event_uuid);
      const result = await relayOnce({ publisher, owner });
      assert.equal(result.published, 1);
      const rows = await eventually(async () => {
        const found = (await notificationsFor("provider", provider.id, "booking_status")).filter((n) => n.order_id === placed.body.order.id);
        return found.length ? found : null;
      }, "provider notification");
      assert.equal(rows.length, 1);
      assert.equal(rows[0].title, "Booking awaiting");
    });

    await t.test("the same monolith event republished twice still yields one notification", async () => {
      await publisher.publish(envelopeFromRow(bookingRow));
      await publisher.publish(envelopeFromRow(bookingRow));
      await eventually(() => logs.filter((e) => e.event === "event_duplicate_skipped" && e.event_id === bookingRow.event_uuid).length === 2, "duplicate skips");
      const rows = (await notificationsFor("provider", provider.id, "booking_status")).filter((n) => n.order_id === bookingRow.aggregate_id);
      assert.equal(rows.length, 1);
    });

    await t.test("provider approval reaches Notifications as provider.approved", async () => {
      const adminUser = await loginAdmin();
      const glowId = getDb().prepare("SELECT id FROM providers WHERE email = 'glow@example.com'").get().id;
      const res = await call(approve.POST, { token: adminUser.token, params: { id: String(glowId) }, method: "POST" });
      assert.equal(res.status, 200);
      eventIds.push(getDb().prepare("SELECT event_uuid FROM events WHERE type='provider.approved' AND aggregate_id=?").get(glowId).event_uuid);
      await relayOnce({ publisher, owner });
      await eventually(async () => (await notificationsFor("provider", glowId, "provider_approved")).length === 1, "approval notification");
    });
  } finally {
    if (consumer) await consumer.close();
    if (publisher) await publisher.close();
    if (admin) await admin.close();
    try {
      await notes.query("DELETE FROM processed_events WHERE event_id = ANY($1::uuid[])", [eventIds]);
      await notes.query("DELETE FROM notifications WHERE created_at >= $1 AND type IN ('booking_status','provider_approved')", [started]);
    } finally { await notes.close(); }
  }
});
