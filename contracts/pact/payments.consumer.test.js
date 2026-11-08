
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { PactV3, MatchersV3 } from "@pact-foundation/pact";

import { createPaymentsClient } from "../../bangkok-homeservice/lib/modules/payments/client.js";

const { integer, eachLike } = MatchersV3;

const pact = new PactV3({
  consumer: "bangkok-homeservice",
  provider: "payments-wallet",
  dir: fileURLToPath(new URL("../pacts/", import.meta.url)),
});

test("Monolith can retrieve provider wallet from Payments Wallet Service", async () => {
  pact
    .given("provider has a wallet")
    .uponReceiving("a request to retrieve provider wallet")
    .withRequest({
      method: "GET",
      path: "/api/provider/wallet",
      headers: {
        Authorization: "Bearer test-provider",
      },
    })
    .willRespondWith({
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
      body: {
        provider_id: integer(1),
        balance_cents: integer(5000),
        commission_owed_cents: integer(500),
        transactions: [],
      },
    });

  await pact.executeTest(async mockServer => {
    const client = createPaymentsClient({
      baseUrl: mockServer.url,
    });

    const wallet = await client.getWallet({
      token: "test-provider",
    });

    assert.equal(wallet.provider_id, 1);
    assert.equal(wallet.balance_cents, 5000);
    assert.equal(wallet.commission_owed_cents, 500);
    assert.deepEqual(wallet.transactions, []);
  });
});
