import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";

async function serve(t, options) {
  const server = createApp(options).listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test("business routes fail closed without B verifier, regardless of bearer/identity headers", async t => {
  let queries = 0;
  const base = await serve(t, { database: { query: async () => { queries++; } } });
  for (const headers of [{}, { Authorization: "Bearer forged", "X-User-Id": "1", "X-Role": "admin" }]) {
    const response = await fetch(base + "/api/notifications", { headers });
    assert.equal(response.status, 503);
    assert.deepEqual(Object.keys(await response.json()).sort(), ["error", "requestId"]);
  }
  assert.equal(queries, 0);
});

test("invalid mapped principals are rejected before database access", async t => {
  for (const actor of [null, { role: "admin", domainId: "1" }, { role: "admin", sub: 1 }, { role: "customer", domainId: -1 }]) {
    const base = await serve(t, { database: { query: () => assert.fail("must not query") }, authenticate: async () => actor });
    assert.equal((await fetch(base + "/api/notifications")).status, 401);
  }
});

test("unexpected database failures are scrubbed to JSON with request identity", async t => {
  const base = await serve(t, {
    database: { query: async () => { throw new Error("private DB credential"); } },
    authenticate: async () => ({ role: "customer", domainId: 1 }),
  });
  const response = await fetch(base + "/api/notifications", { headers: { "X-Request-Id": "notify-error" } });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "internal server error", requestId: "notify-error" });
});
