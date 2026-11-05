import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { createPaymentsService } from "../src/service.js";

async function serve(t, options) {
  const server = createApp(options).listen(0,"127.0.0.1");
  await new Promise(resolve => server.once("listening",resolve));
  t.after(() => new Promise(resolve => { server.close(resolve);server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
test("Payments read routes fail closed before B verifier, even with forged identity headers",async t => {
  const base = await serve(t,{database:{query:()=>assert.fail("must not query")}});
  for (const path of ["/api/provider/wallet","/api/customer/transactions"]) {
    const response = await fetch(base+path,{headers:{Authorization:"Bearer forged","X-Role":"provider","X-User-Id":"1"}});
    assert.equal(response.status,503);
    assert.deepEqual(Object.keys(await response.json()).sort(),["error","requestId"]);
  }
});
test("wallet/customer read ownership gates reject invalid or wrong-role principals",async () => {
  const service = createPaymentsService({query:()=>assert.fail("must not query")});
  await assert.rejects(service.getWallet({role:"provider",domainId:"1"}),error=>error.statusCode===401);
  await assert.rejects(service.getWallet({role:"customer",domainId:1}),error=>error.statusCode===403);
  await assert.rejects(service.listCustomerTransactions({role:"admin",domainId:1}),error=>error.statusCode===403);
});
test("settlement is unavailable without BOTH C eligibility and same-transaction outbox hooks",async () => {
  const event={gateway_event_id:"test-event",gateway_ref:"test-ref",type:"payment_intent.succeeded"};
  for (const hooks of [{},{assertSettlementAllowed:async()=>true},{stageEvent:async()=>{}}]) {
    await assert.rejects(createPaymentsService({},hooks).settleWebhook(event),error=>error.statusCode===503);
  }
});
