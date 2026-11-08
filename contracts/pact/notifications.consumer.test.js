
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { PactV3, MatchersV3 } from "@pact-foundation/pact";

import { createNotificationsClient } from "../../bangkok-homeservice/lib/modules/notifications/client.js";

const { eachLike, integer, string, regex } = MatchersV3;

// Save generated Pact contracts in contracts/pacts.
const pact = new PactV3({
  consumer: "bangkok-homeservice",
  provider: "notifications",
  dir: fileURLToPath(new URL("../pacts/", import.meta.url)),
});

test("Monolith can retrieve notifications from Notifications Service", async () => {
  // Define the response that the Monolith consumer expects.
  pact
    .given("customer has notifications")
    .uponReceiving("a request to list customer notifications")
    .withRequest({
      method: "GET",
      path: "/api/notifications",
      headers: {
        Authorization: "Bearer test-customer",
      },
    })
    .willRespondWith({
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
      body: eachLike({
        id: integer(1),
        type: string("booking_status"),
        title: string("Booking awaiting"),
        body: string("Booking #42 is now awaiting."),
        order_id: integer(42),
        read_at: null,
        created_at: regex(
            "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$",
            "2026-11-08T10:00:00.000Z"
            ),
      }),
    });

  // Exercise the real Monolith client against Pact's mock provider.
  await pact.executeTest(async (mockServer) => {
    const client = createNotificationsClient({
      baseUrl: mockServer.url,
    });

    const notifications = await client.listForUser({
      token: "test-customer",
    });

    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].id, 1);
    assert.equal(notifications[0].type, "booking_status");
    assert.equal(notifications[0].title, "Booking awaiting");
    assert.equal(notifications[0].order_id, 42);
    assert.equal(notifications[0].read_at, null);
    assert.ok(notifications[0].created_at);
  });
});