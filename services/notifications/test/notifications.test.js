import { test } from "node:test";
import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { createDatabase } from "../src/database.js";
import { migrate } from "../src/migrations.js";
import { createNotificationsService } from "../src/service.js";
import { createApp } from "../src/app.js";
import { HttpError } from "../src/errors.js";

// Auth is a TEST DOUBLE here, never a Keycloak verification claim.
test("PostgreSQL notification business API", { skip: !process.env.TEST_DATABASE_URL }, async t => {
  const db = createDatabase(process.env.TEST_DATABASE_URL);
  const service = createNotificationsService(db);
  const userId = randomInt(100000000, 200000000);
  const actors = {
    "test-customer": { role: "customer", domainId: userId },
    "test-other": { role: "customer", domainId: userId + 1 },
    "test-provider": { role: "provider", domainId: userId },
    "test-admin": { role: "admin", domainId: userId },
  };
  let server;
  const inserted = [];
  const record = async (input, options) => {
    const result = await service.record(input, options);
    inserted.push(result.id);
    return result;
  };
  try {
    await migrate(db);
    const input = { recipientRole: "customer", recipientId: userId, type: "booking_status", title: "Booking awaiting", body: "Booking #42 is now awaiting.", orderId: 42 };
    const first = await record(input);
    const second = await record({ ...input, body: "It's literal: '); DROP TABLE notifications; --" });
    await record({ ...input, recipientRole: "provider", title: "Provider inbox" });
    await record({ ...input, recipientId: userId + 1, title: "Other inbox" });
    server = createApp({
      database: db,
      authenticate: async req => {
        const actor = actors[req.get("authorization")?.replace(/^Bearer /, "")];
        if (!actor) throw new HttpError(401, "invalid token");
        return actor;
      },
    }).listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (path, token = "test-customer", method = "GET") => fetch(base + path, { method, headers: { Authorization: `Bearer ${token}` } });

    await t.test("inbox is newest first, scoped to role AND mapped domain ID, with original public fields", async () => {
      const response = await call("/api/notifications?recipient_id=1&role=admin");
      assert.equal(response.status, 200);
      const list = await response.json();
      assert.deepEqual(list.map(row => row.id), [second.id, first.id]);
      assert.equal(list[0].body, "It's literal: '); DROP TABLE notifications; --");
      assert.equal(list[0].read_at, null);
      assert.match(list[0].created_at, /^\d{4}-\d{2}-\d{2}T.*Z$/);
      assert.deepEqual(Object.keys(list[0]).sort(), ["body", "created_at", "id", "order_id", "read_at", "title", "type"]);
      assert.equal((await (await call("/api/notifications", "test-provider")).json()).length, 1);
    });
    await t.test("unauthenticated callers get 401 and foreign owners (including admin) get 403", async () => {
      assert.equal((await call("/api/notifications", "invalid")).status, 401);
      for (const actor of ["test-other", "test-provider", "test-admin"]) {
        assert.equal((await call(`/api/notifications/${first.id}/read`, actor, "POST")).status, 403);
      }
      assert.equal((await service.listForUser(actors["test-customer"]))[1].read_at, null);
    });
    await t.test("missing/invalid IDs get 404/400 without generic database errors", async () => {
      assert.equal((await call("/api/notifications/2147483647/read", "test-customer", "POST")).status, 404);
      for (const id of ["0", "-1", "abc", "2147483648"]) {
        assert.equal((await call(`/api/notifications/${id}/read`, "test-customer", "POST")).status, 400);
      }
    });
    await t.test("parallel mark-read replays preserve a single read timestamp", async () => {
      const responses = await Promise.all(Array.from({ length: 4 }, () => call(`/api/notifications/${first.id}/read`, "test-customer", "POST")));
      assert.ok(responses.every(response => response.status === 200));
      const rows = await Promise.all(responses.map(response => response.json()));
      assert.ok(rows[0].read_at);
      assert.equal(new Set(rows.map(row => row.read_at)).size, 1);
      assert.equal((await service.listForUser(actors["test-customer"]))[1].read_at, rows[0].read_at);
    });
    await t.test("C's supplied transaction rolls notification writes back with its other work", async () => {
      let rolledBackId;
      await assert.rejects(db.withTransaction(async client => {
        rolledBackId = (await record(input, { client })).id;
        throw new Error("consumer failed");
      }), /consumer failed/);
      assert.equal((await db.query("SELECT id FROM notifications WHERE id = $1", [rolledBackId])).rowCount, 0);
      assert.ok((await db.query("SELECT id FROM notifications WHERE id = $1", [first.id])).rowCount);
    });
    await t.test("invalid internal write inputs are rejected before inserting", async () => {
      for (const fields of [{ recipientRole: "root" }, { recipientId: "1" }, { title: "" }, { orderId: -1 }]) {
        await assert.rejects(service.record({ ...input, ...fields }), error => error.statusCode === 400);
      }
    });
  } finally {
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    try {
      if (inserted.length) await db.query("DELETE FROM notifications WHERE id = ANY($1::integer[])", [inserted]);
    } finally { await db.close(); }
  }
});
