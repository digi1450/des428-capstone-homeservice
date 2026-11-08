import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomInt } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(
  new URL("../../services/payments-wallet/package.json", import.meta.url)
);

const { NodeSDK } = require("@opentelemetry/sdk-node");
const { trace } = require("@opentelemetry/api");
const { HttpInstrumentation } = require("@opentelemetry/instrumentation-http");

const paymentsUrl = process.env.TEST_PAYMENTS_DATABASE_URL;
const notificationsUrl = process.env.TEST_NOTIFICATIONS_DATABASE_URL;
const amqpUrl = process.env.TEST_AMQP_URL;

if (!paymentsUrl || !notificationsUrl || !amqpUrl) {
  throw new Error("Missing disposable E2E test infrastructure URLs");
}

process.env.OTEL_METRICS_EXPORTER = "none";
process.env.OTEL_LOGS_EXPORTER = "none";

const spans = [];

const sdk = new NodeSDK({
  autoDetectResources: false,
  instrumentations: [new HttpInstrumentation()],
  spanProcessors: [{
    onStart() {},
    onEnd(span) {
      spans.push(span);
    },
    forceFlush: async () => {},
    shutdown: async () => {}
  }]
});

await sdk.start();

// Import application modules only after OpenTelemetry starts.

// Load real application modules after OpenTelemetry initialization.
const { createDatabase: createPaymentsDatabase } =
  await import("../../services/payments-wallet/src/database.js");

const { migrate: migratePayments } =
  await import("../../services/payments-wallet/src/migrations.js");

const { createPaymentsRuntime } =
  await import("../../services/payments-wallet/src/runtime.js");

const { relayOnce } =
  await import("../../services/payments-wallet/src/messaging/outbox.js");

const { createPublisher } =
  await import("../../services/payments-wallet/src/messaging/publisher.js");

const { createDatabase: createNotificationsDatabase } =
  await import("../../services/notifications/src/database.js");

const { migrate: migrateNotifications } =
  await import("../../services/notifications/src/migrations.js");

const { createInbox } =
  await import("../../services/notifications/src/messaging/inbox.js");

const { startConsumer } =
  await import("../../services/notifications/src/messaging/consumer.js");

test("Full E2E: HTTP -> Payments -> Outbox -> RabbitMQ -> Notifications", async () => {
  const paymentsDb = createPaymentsDatabase(paymentsUrl);
  const notificationsDb = createNotificationsDatabase(notificationsUrl);

  const orderId = randomInt(800000000, 900000000);
  const customerId = orderId + 1;
  const providerId = orderId + 2;
  const createCommandId = `e2e-create-${randomUUID()}`;
  const sagaId = `e2e-saga-${randomUUID()}`;
  const requestId = `e2e-${randomUUID()}`;

  let server;
  let publisher;
  let consumer;

  try {
    await migratePayments(paymentsDb);
    await migrateNotifications(notificationsDb);

    const runtime = createPaymentsRuntime({
      database: paymentsDb,

      authenticate: async () => ({
        role: "customer",
        domainId: customerId
      }),

      authenticateService: async () => ({
        service: "booking",
        callerId: "e2e-tracing-fixture"
      })
    });

    server = runtime.app.listen(0, "0.0.0.0");

    await new Promise(resolve => server.once("listening", resolve));

    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const post = (path, body, token, key) =>
      fetch(baseUrl + path, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-Request-Id": requestId,
          ...(key ? { "Idempotency-Key": key } : {})
        },
        body: JSON.stringify(body)
      });

    const created = await post(
      "/internal/payment-intents",
      {
        order_id: orderId,
        customer_id: customerId,
        provider_id: providerId,
        amount_cents: 107,
        currency: "THB",
        saga_id: sagaId
      },
      "service-fixture",
      createCommandId
    );

    assert.equal(created.status, 201);

    const activated = await post(
      "/internal/payment-intents/activate-by-command",
      {
        create_command_id: createCommandId,
        saga_id: sagaId
      },
      "service-fixture",
      `e2e-activate-${randomUUID()}`
    );

    assert.equal(activated.status, 200);

    const settled = await post(
      "/api/payments/simulate",
      { order_id: orderId },
      "customer-fixture"
    );

    assert.equal(settled.status, 200);

    const result = await paymentsDb.query(
      "SELECT event_id, headers, envelope FROM outbox_events WHERE aggregate_id = $1",
      [String(orderId)]
    );

    assert.equal(result.rowCount, 1);

    const event = result.rows[0];

    assert.equal(event.headers["x-request-id"], requestId);
    assert.ok(event.headers.traceparent, "Outbox must contain traceparent");

    consumer = await startConsumer({
      amqpUrl,
      inbox: createInbox(notificationsDb)
    });

    publisher = await createPublisher(amqpUrl);

    const relay = await relayOnce({
      database: paymentsDb,
      publisher,
      owner: `e2e-tracing-${randomUUID()}`
    });

    // A previous interrupted run can leave other pending rows in this disposable DB.
    // Delivery and span checks below are scoped to this test's unique event.
    assert.ok(relay.published >= 1, "Relay must publish at least one event");

    let processed;
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await notificationsDb.query(
        "SELECT effect_count FROM processed_events WHERE event_id = $1",
        [event.event_id]
      );

      if (result.rowCount === 1) {
        processed = result.rows[0];
        break;
      }

      await new Promise(resolve => setTimeout(resolve, 100));
    }

    assert.ok(processed, "Notifications must process the payment event");
    assert.equal(processed.effect_count, 1);

    for (let attempt = 0; attempt < 100; attempt++) {
      const hasPublisher = spans.some(span => span.name === "rabbitmq publish");
      const hasConsumer = spans.some(span => span.name === "rabbitmq process");
      if (hasPublisher && hasConsumer) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    const traceId = event.headers.traceparent.split("-")[1];

    const httpSpan = spans.find(
      span => span.kind === 1 &&
        span.spanContext().traceId === traceId &&
        span.attributes["http.request.method"] === "POST"
    );

    assert.ok(httpSpan, "HTTP server span must exist");

    const storedParentSpanId = event.headers.traceparent.split("-")[2];

    assert.equal(
      storedParentSpanId,
      httpSpan.spanContext().spanId,
      "Outbox must preserve the HTTP server span context"
    );

    const publishedSpan = spans.find(
      span => span.name === "rabbitmq publish" &&
        span.spanContext().traceId === traceId
    );

    const processedSpan = spans.find(
      span => span.name === "rabbitmq process" &&
        span.spanContext().traceId === traceId
    );

    assert.ok(publishedSpan, "RabbitMQ publisher span must exist");
    assert.ok(processedSpan, "Notifications consumer span must exist");

    assert.equal(
      processedSpan.parentSpanContext?.spanId,
      publishedSpan.spanContext().spanId,
      "Consumer must be a child of the publisher"
    );

    const parentSpanId = event.headers.traceparent.split("-")[2];

    assert.equal(
      publishedSpan.parentSpanContext?.spanId,
      parentSpanId,
      "Publisher must continue the stored outbox context"
    );

    console.log("Full E2E Trace ID:", traceId);
    console.log("RabbitMQ -> Notifications: PASS");

    console.log("HTTP -> Payments -> Outbox: PASS");
    console.log("Traceparent:", event.headers.traceparent);

  } finally {
    if (consumer) await consumer.close();
    if (publisher) await publisher.close();

    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }

    try {
      await paymentsDb.close();
    } finally {
      try {
        await notificationsDb.close();
      } finally {
        await sdk.shutdown();
      }
    }
  }
});
