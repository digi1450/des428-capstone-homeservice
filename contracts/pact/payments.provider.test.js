
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Verifier } from "@pact-foundation/pact";

import { createDatabase } from "../../services/payments-wallet/src/database.js";
import { migrate } from "../../services/payments-wallet/src/migrations.js";
import { createPaymentsService } from "../../services/payments-wallet/src/service.js";
import { createApp } from "../../services/payments-wallet/src/app.js";

const pactFile = fileURLToPath(
  new URL("../pacts/bangkok-homeservice-payments-wallet.json", import.meta.url)
);

const providerId = 100000222;

test("Payments Wallet provider satisfies Monolith Pact contract", async () => {
  const databaseUrl = process.env.PAYMENTS_PACT_DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("PAYMENTS_PACT_DATABASE_URL is required");
  }

  // Prevent accidentally connecting to the team's real database.
  const parsedUrl = new URL(databaseUrl);

  if (
    parsedUrl.hostname !== "payments-pact-db" ||
    parsedUrl.pathname !== "/payments_pact_test"
  ) {
    throw new Error("Refusing to use a non-Pact database");
  }

  const db = createDatabase(databaseUrl);
  const payments = createPaymentsService(db);

  let server;

  try {
    await migrate(db);

    // Authentication test double for the Pact interaction.
    const authenticate = async req => {
      if (req.get("authorization") !== "Bearer test-provider") {
        throw new Error("Invalid test token");
      }

      return {
        role: "provider",
        domainId: providerId,
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
      provider: "payments-wallet",
      providerBaseUrl,
      pactUrls: [pactFile],
      stateHandlers: {
        "provider has a wallet": async () => {
          await payments.provisionWallet(providerId);
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
