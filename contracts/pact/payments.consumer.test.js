
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { PactV3, MatchersV3 } from "@pact-foundation/pact";

import { createPaymentsClient } from "../../bangkok-homeservice/lib/modules/payments/client.js";

const { integer, regex } = MatchersV3;

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

test('Monolith renders wallet pending before asynchronous provisioning',async()=>{
 pact.given('provider wallet is not provisioned').uponReceiving('a request for a pending provider wallet')
 .withRequest({method:'GET',path:'/api/provider/wallet',headers:{Authorization:'Bearer test-pending-provider'}})
 .willRespondWith({status:200,headers:{'Content-Type':'application/json'},body:{provider_id:integer(100000223),balance_cents:null,commission_owed_cents:null,transactions:[],wallet_setup:'pending'}});
 await pact.executeTest(async server=>{const result=await createPaymentsClient({baseUrl:server.url}).getWallet({token:'test-pending-provider'});assert.equal(result.wallet_setup,'pending');assert.equal(result.balance_cents,null);});
});
test('Monolith retrieves customer transaction history',async()=>{
 pact.given('customer has a charge').uponReceiving('a request for customer transaction history')
 .withRequest({method:'GET',path:'/api/customer/transactions',headers:{Authorization:'Bearer test-customer'}})
 .willRespondWith({status:200,headers:{'Content-Type':'application/json'},body:[{id:integer(1),order_id:integer(100000225),kind:'charge',amount_cents:integer(1000),method:'gateway',gateway_ref:'pact-charge',status:'succeeded',created_at:regex('^\\d{4}-\\d{2}-\\d{2}T.*Z$','2026-11-10T10:00:00.000Z')}]});
 await pact.executeTest(async server=>{const rows=await createPaymentsClient({baseUrl:server.url}).listCustomerTransactions({token:'test-customer'});assert.equal(rows.length,1);assert.equal(rows[0].kind,'charge');assert.equal(rows[0].amount_cents,1000);});
});
