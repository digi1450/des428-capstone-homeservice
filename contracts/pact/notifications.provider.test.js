
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Verifier } from "@pact-foundation/pact";

import { createDatabase } from "../../services/notifications/src/database.js";
import { migrate } from "../../services/notifications/src/migrations.js";
import { createNotificationsService } from "../../services/notifications/src/service.js";
import { createApp } from "../../services/notifications/src/app.js";
import { HttpError } from "../../services/notifications/src/errors.js";

const pactFile = fileURLToPath(
  new URL("../pacts/bangkok-homeservice-notifications.json", import.meta.url)
);

const userId = 100000111;

test("Notifications provider satisfies Monolith Pact contract", async () => {
  const databaseUrl = process.env.NOTIFICATIONS_PACT_DATABASE_URL;

  // Only allow the dedicated PostgreSQL database created for Pact tests.
  if (!databaseUrl) {
    throw new Error("NOTIFICATIONS_PACT_DATABASE_URL is required");
  }

  const parsedUrl = new URL(databaseUrl);

  if (
    parsedUrl.hostname !== "notifications-pact-db" ||
    parsedUrl.pathname !== "/notifications_pact_test"
  ) {
    throw new Error("Refusing to use a non-Pact database");
  }

  const db = createDatabase(databaseUrl);
  const notifications = createNotificationsService(db);

  let server;

  try {
    await migrate(db);

    // Authentication test double, not a Keycloak verification.
    const authenticate = async req => {
      if (req.get("authorization") !== "Bearer test-customer") {
        throw new HttpError(401, "invalid token");
      }

      return {
        role: "customer",
        domainId: userId,
      };
    };

    server = createApp({
      database: db,
      authenticate,
    }).listen(0, "127.0.0.1");

    await new Promise(resolve => server.once("listening", resolve));

    const providerBaseUrl =
      `http://127.0.0.1:${server.address().port}`;

    const verifier = new Verifier({
      provider: "notifications",
      providerBaseUrl,
      pactUrls: [pactFile],
      stateHandlers: {
        "customer has notifications": async () => {
          // Clear only test data belonging to this fixed test actor.
          await db.query(
            "DELETE FROM notifications WHERE recipient_role = $1 AND recipient_id = $2",
            ["customer", userId]
          );

          await notifications.record({
            recipientRole: "customer",
            recipientId: userId,
            type: "booking_status",
            title: "Booking awaiting",
            body: "Booking #42 is now awaiting.",
            orderId: 42,
          });
        },
      },
      logLevel: "info",
    });

    const result = await verifier.verifyProvider();
    assert.ok(result);
  } finally {
    if (server) {
      await new Promise((resolve, reject) =>
        server.close(error => error ? reject(error) : resolve())
      );
    }

    await db.close();
  }
});