import { test } from "node:test";
import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { createDatabase } from "../../services/payments-wallet/src/database.js";
import { migrate } from "../../services/payments-wallet/src/migrations.js";
import { createPaymentsService } from "../../services/payments-wallet/src/service.js";
import { createApp } from "../../services/payments-wallet/src/app.js";
import { HttpError } from "../../services/payments-wallet/src/errors.js";
import { createPaymentsClient,PaymentOutcomeUnknownError } from "../../bangkok-homeservice/lib/modules/payments/client.js";

// Real client -> HTTP read API -> PostgreSQL, explicit TEST-ONLY auth mapping.
// Command paths fail closed with 503 until service auth/participant are configured.
test("monolith Payments client interoperates with HTTP/PostgreSQL and preserves unknown commands",{skip:!process.env.TEST_DATABASE_URL},async()=>{
  const db=createDatabase(process.env.TEST_DATABASE_URL),base=randomInt(300000000,400000000);
  let server;
  const metadata=[];
  try {
    await migrate(db);
    const payments=createPaymentsService(db);
    const effect=await payments.applyCompletion({order_id:base,customer_id:base,provider_id:base+1,amount_cents:1000,payment_method:"cod",commission_cents:150});
    const actors={"test-provider":{role:"provider",domainId:base+1},"test-customer":{role:"customer",domainId:base},"test-other":{role:"provider",domainId:base+2}};
    server=createApp({database:db,authenticate:async req=>{
      metadata.push(req.get("x-request-id"));const actor=actors[req.get("authorization")?.replace(/^Bearer /,"")];
      if(!actor)throw new HttpError(401,"invalid token");return actor;
    }}).listen(0,"127.0.0.1");
    await new Promise(resolve=>server.once("listening",resolve));
    const client=createPaymentsClient({baseUrl:`http://127.0.0.1:${server.address().port}`});
    const wallet=await client.getWallet({token:"test-provider",requestId:"payment-boundary"});
    assert.equal(wallet.provider_id,base+1);assert.equal(wallet.balance_cents,0);assert.equal(wallet.commission_owed_cents,150);
    assert.deepEqual(wallet.transactions,[effect]);assert.equal(metadata[0],"payment-boundary");
    assert.deepEqual(await client.listCustomerTransactions({token:"test-customer"}),[effect]);
    assert.deepEqual(await client.getWallet({token:"test-other"}),{provider_id:base+2,balance_cents:null,commission_owed_cents:null,transactions:[],wallet_setup:"pending"});
    await assert.rejects(client.getWallet({token:"test-customer"}),error=>error.statusCode===403);
    await assert.rejects(client.listCustomerTransactions({token:"invalid"}),error=>error.statusCode===401);
    const saga_id="test-saga:"+base,commandId="test-create:"+base;
    await assert.rejects(client.createIntent({order_id:base+3,customer_id:base,provider_id:base+1,amount_cents:1000,currency:"THB",saga_id},{token:"test-provider",commandId}),error=>error instanceof PaymentOutcomeUnknownError&&error.createCommandId===commandId);
    await assert.rejects(client.getOperation({create_command_id:commandId,saga_id,order_id:base+3,amount_cents:1000},{token:"test-provider"}),error=>error instanceof PaymentOutcomeUnknownError&&error.createCommandId===commandId&&error.reason==="unexpected_status"&&error.upstreamStatus===503);
    assert.equal((await db.query("SELECT id FROM payment_intents WHERE order_id=$1",[base+3])).rowCount,0);
  } finally {
    if(server)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
    try{await db.query("DELETE FROM transactions WHERE order_id=$1",[base]);await db.query("DELETE FROM provider_wallets WHERE provider_id=$1",[base+1]);}finally{await db.close();}
  }
});
