import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { readConfig } from "../src/config.js";

async function serve(t, database) {
  const server = createApp({ database }).listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test("liveness survives database outage; readiness fails without leaking details", async t => {
  const base = await serve(t, { checkReady: async () => { throw new Error("secret database URL"); } });
  assert.equal((await fetch(base + "/health/live")).status, 200);
  const response = await fetch(base + "/health/ready", { headers: { "X-Request-Id": "probe-1" } });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("x-request-id"), "probe-1");
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.status, "not_ready");
  assert.equal(body.requestId, "probe-1");
  assert.ok(!JSON.stringify(body).includes("secret"));
});

test("readiness succeeds independently while unwired internal command routes fail closed", async t => {
  const base = await serve(t, { checkReady: async () => {} });
  const response = await fetch(base + "/health/ready");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "ready");
  const business = await fetch(base + "/internal/payment-intents", { method: "POST" });
  assert.equal(business.status, 503);
  assert.equal(business.headers.get("retry-after"), "2");
  assert.equal((await business.json()).error, "internal server error");
  assert.equal((await fetch(base + "/internal/not-a-route")).status, 404);
});

test("configuration rejects missing database and invalid ports", () => {
  assert.throws(() => readConfig({}), /DATABASE_URL/);
  assert.throws(() => readConfig({ PORT: "NaN", DATABASE_URL: "postgres://localhost/demo" }), /PORT/);
  assert.throws(() => readConfig({ DATABASE_URL: "https://localhost/demo" }), /PostgreSQL/);
});
