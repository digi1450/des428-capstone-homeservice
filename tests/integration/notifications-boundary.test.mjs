import { test } from "node:test";
import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { createDatabase } from "../../services/notifications/src/database.js";
import { createNotificationsService } from "../../services/notifications/src/service.js";
import { createApp } from "../../services/notifications/src/app.js";
import { migrate } from "../../services/notifications/src/migrations.js";
import { HttpError } from "../../services/notifications/src/errors.js";
import { createNotificationsClient } from "../../bangkok-homeservice/lib/modules/notifications/client.js";

// A real client -> HTTP router -> PostgreSQL path, with explicit test-only auth.
// Does not establish real Keycloak, RabbitMQ, nginx or public-route cutover.
test("monolith adapter interoperates with Notifications HTTP and PostgreSQL", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const db = createDatabase(process.env.TEST_DATABASE_URL);
  const recipientId = randomInt(200000001, 300000000);
  let server, created;
  const metadata = [];
  try {
    await migrate(db);
    const service = createNotificationsService(db);
    created = await service.record({ recipientRole: "provider", recipientId, type: "payment_received", title: "Payment received", body: "Payment for booking #42.", orderId: 42 });
    server = createApp({ database: db, authenticate: async req => {
      metadata.push(req.get("x-request-id"));
      if (req.get("authorization") === "Bearer test-owner") return { role: "provider", domainId: recipientId };
      if (req.get("authorization") === "Bearer test-other") return { role: "customer", domainId: recipientId };
      throw new HttpError(401, "invalid token");
    } }).listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    const client = createNotificationsClient({ baseUrl: `http://127.0.0.1:${server.address().port}` });
    const credentials = { token: "test-owner", requestId: "boundary-test" };
    assert.deepEqual(await client.listForUser(credentials), [created]);
    const read = await client.markRead(created.id, credentials);
    assert.ok(read.read_at);
    assert.deepEqual(await client.markRead(created.id, credentials), read);
    assert.deepEqual(await client.listForUser({ token: "test-other" }), []);
    await assert.rejects(client.markRead(created.id, { token: "test-other" }), error => error.statusCode === 403);
    assert.equal(metadata[0], "boundary-test");
    assert.equal((await db.query("SELECT read_at FROM notifications WHERE id=$1", [created.id])).rows[0].read_at.toISOString(), read.read_at);
  } finally {
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    try { if (created) await db.query("DELETE FROM notifications WHERE id=$1", [created.id]); } finally { await db.close(); }
  }
});
