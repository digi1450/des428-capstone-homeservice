import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createNotificationsClient } from "../lib/modules/notifications/client.js";

const row = { id: 1, type: "booking_status", title: "Booking awaiting", body: "Booking #42 is now awaiting.", order_id: 42, read_at: null, created_at: "2026-11-05T00:00:00.000Z" };
async function serve(t, handler) {
  const server = http.createServer(handler).listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test("notifications client forwards bearer/trace context and preserves public payloads over HTTP", async t => {
  const requests = [];
  const baseUrl = await serve(t, (req, res) => {
    requests.push({ path: req.url, method: req.method, headers: req.headers });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(req.method === "GET" ? [row] : { ...row, read_at: "2026-11-05T01:00:00.000Z" }));
  });
  const client = createNotificationsClient({ baseUrl });
  const credentials = { token: "test-token", requestId: "notify-client-1", traceparent: "00-01234567890123456789012345678901-0123456789012345-01", tracestate: "demo=1" };
  assert.deepEqual(await client.listForUser(credentials), [row]);
  assert.equal((await client.markRead(1, credentials)).read_at, "2026-11-05T01:00:00.000Z");
  assert.deepEqual(requests.map(req => [req.method, req.path]), [["GET", "/api/notifications"], ["POST", "/api/notifications/1/read"]]);
  assert.equal(requests[0].headers.authorization, "Bearer test-token");
  assert.equal(requests[0].headers["x-request-id"], credentials.requestId);
  assert.equal(requests[0].headers.traceparent, credentials.traceparent);
  assert.equal(requests[0].headers.tracestate, credentials.tracestate);
  assert.equal(requests[0].headers["x-user-id"], undefined);
});

test("notifications client refuses missing credentials and invalid IDs without sending requests", async () => {
  let requests = 0;
  const client = createNotificationsClient({ baseUrl: "http://localhost:3001", fetchImpl: async () => { requests++; assert.fail(); } });
  await assert.rejects(client.listForUser({}), error => error.statusCode === 401);
  assert.throws(() => client.markRead(-1, { token: "test" }), error => error.statusCode === 400);
  await assert.rejects(client.listForUser({ token: "test", requestId: "invalid request id" }), error => error.statusCode === 400);
  assert.equal(requests, 0);
});

test("notifications client retains expected 4xx statuses and scrubs upstream internal errors", async t => {
  for (const status of [400, 401, 403, 404, 500, 503]) {
    const baseUrl = await serve(t, (_req, res) => { res.writeHead(status); res.end("private password and internal stack"); });
    const client = createNotificationsClient({ baseUrl });
    await assert.rejects(client.listForUser({ token: "test" }), error => {
      assert.equal(error.statusCode, status < 500 ? status : 503);
      assert.ok(!error.message.includes("password"));
      return true;
    });
  }
});

test("notifications client rejects schema drift and malformed JSON", async t => {
  for (const payload of ["not JSON", JSON.stringify([{ ...row, id: "1" }]), JSON.stringify([{ ...row, recipient_id: 9 }])]) {
    const baseUrl = await serve(t, (_req, res) => res.end(payload));
    await assert.rejects(createNotificationsClient({ baseUrl }).listForUser({ token: "test" }), error => error.statusCode === 503);
  }
});

test("notifications client does not follow redirects with credentials", async t => {
  let leaked = 0;
  const target = await serve(t, (_req, res) => { leaked++; res.end(JSON.stringify([row])); });
  const baseUrl = await serve(t, (_req, res) => { res.writeHead(302, { Location: target }); res.end(); });
  await assert.rejects(createNotificationsClient({ baseUrl }).listForUser({ token: "test" }), error => error.statusCode === 503);
  assert.equal(leaked, 0);
});

test("notifications deadline includes a body that stalls after response headers", { timeout: 3000 }, async t => {
  const baseUrl = await serve(t, (_req, res) => { res.writeHead(200); res.flushHeaders(); });
  await assert.rejects(createNotificationsClient({ baseUrl, timeoutMs: 50 }).listForUser({ token: "test" }), error => error.statusCode === 503);
});
