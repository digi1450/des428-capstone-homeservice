import { test } from "node:test";
import assert from "node:assert/strict";
import { randomInt,randomUUID } from "node:crypto";
import { createDatabase } from "../src/database.js";
import { migrate } from "../src/migrations.js";
import { createPaymentsService } from "../src/service.js";
import { createApp } from "../src/app.js";
import { HttpError } from "../src/errors.js";

test("Payments PostgreSQL business primitives and HTTP reads",{skip:!process.env.TEST_DATABASE_URL},async t=>{
  const db=createDatabase(process.env.TEST_DATABASE_URL);
  const base=randomInt(100000000,200000000),orders=[],refs=[];
  const sink="payment_event_probe_"+randomUUID().replaceAll("-","");
  let server,counter=0;
  const next=(changes={})=>{ const order_id=base+(++counter);orders.push(order_id);return {order_id,customer_id:base,provider_id:base+1,amount_cents:1000,currency:"THB",...changes}; };
  const stageEvent=async(tx,event)=>{await tx.query(`INSERT INTO ${sink} (order_id,event_json) VALUES ($1,$2::jsonb)`,[event.aggregate_id,JSON.stringify(event)]);};
  const service=createPaymentsService(db,{assertSettlementAllowed:async()=>true,stageEvent});
  const plain=createPaymentsService(db);
  const prepare=async(value)=>{const intent=await service.prepareIntent(value);refs.push(intent.gateway_ref);return intent;};
  const gateway=intent=>({gateway_event_id:"test-"+randomUUID(),gateway_ref:intent.gateway_ref,type:"payment_intent.succeeded"});
  const count=async(orderId,kind)=>(await db.query("SELECT id FROM transactions WHERE order_id=$1 AND kind=$2",[orderId,kind])).rowCount;
  let paidContext,paidIntent,refundContext,refundIntent;
  try {
    await migrate(db);
    await db.query(`CREATE TABLE ${sink} (order_id INTEGER PRIMARY KEY,event_json JSONB NOT NULL)`);
    await t.test("parallel prepare converges on one intent, context changes conflict, amounts/currency validate",async()=>{
      paidContext=next();
      const results=await Promise.all(Array.from({length:4},()=>prepare(paidContext)));
      paidIntent=results[0];
      assert.equal(new Set(results.map(row=>row.id)).size,1);
      assert.equal((await db.query("SELECT id FROM payment_intents WHERE order_id=$1",[paidContext.order_id])).rowCount,1);
      await assert.rejects(prepare({...paidContext,amount_cents:1001}),error=>error.statusCode===409);
      for(const fields of [{amount_cents:-1},{amount_cents:1.1},{currency:"USD"},{customer_id:"1"}]) await assert.rejects(service.prepareIntent({...next(),...fields}),error=>error.statusCode===400);
    });
    await t.test("intent reads enforce role AND owner domain ID",async()=>{
      assert.deepEqual(await service.getIntentForOrder(paidContext.order_id,{role:"customer",domainId:base}),paidIntent);
      assert.deepEqual(await service.getIntentForOrder(paidContext.order_id,{role:"provider",domainId:base+1}),paidIntent);
      for(const actor of [{role:"customer",domainId:base+1},{role:"provider",domainId:base},{role:"admin",domainId:base}]) await assert.rejects(service.getIntentForOrder(paidContext.order_id,actor),error=>error.statusCode===403);
    });
    await t.test("void is repeatable and cannot reactivate; absent-create void is NOT reported as fenced",async()=>{
      const value=next();await prepare(value);
      assert.equal((await service.voidUnpaidIntent(value.order_id)).status,"failed");
      assert.equal((await service.voidUnpaidIntent(value.order_id)).status,"failed");
      await assert.rejects(prepare(value),error=>error.statusCode===409);
      await assert.rejects(service.voidUnpaidIntent(next().order_id),error=>error.statusCode===404);
    });
    await t.test("non-ready provisioning guard rolls back webhook receipt and leaves intent unpaid",async()=>{
      const value=next(),intent=await prepare(value),event=gateway(intent);
      const guarded=createPaymentsService(db,{assertSettlementAllowed:async()=>false,stageEvent});
      await assert.rejects(guarded.settleWebhook(event),error=>error.statusCode===409);
      assert.equal((await db.query("SELECT id FROM webhook_events WHERE gateway_event_id=$1",[event.gateway_event_id])).rowCount,0);
      assert.equal((await db.query("SELECT status FROM payment_intents WHERE id=$1",[intent.id])).rows[0].status,"requires_payment");
    });
    await t.test("outbox callback failure rolls back charge, intent, receipt AND staged SQL effect",async()=>{
      const value=next(),intent=await prepare(value),event=gateway(intent);
      const failing=createPaymentsService(db,{assertSettlementAllowed:async()=>true,stageEvent:async(tx,event)=>{await stageEvent(tx,event);throw new Error("outbox failed");}});
      await assert.rejects(failing.settleWebhook(event),/outbox failed/);
      assert.equal(await count(value.order_id,"charge"),0);
      assert.equal((await db.query(`SELECT * FROM ${sink} WHERE order_id=$1`,[value.order_id])).rowCount,0);
      assert.equal((await db.query("SELECT id FROM webhook_events WHERE gateway_event_id=$1",[event.gateway_event_id])).rowCount,0);
      assert.equal((await db.query("SELECT status FROM payment_intents WHERE id=$1",[intent.id])).rows[0].status,"requires_payment");
    });
    await t.test("concurrent webhook replay settles once and stages one local event",async()=>{
      const event=gateway(paidIntent);
      const results=await Promise.all(Array.from({length:4},()=>service.settleWebhook(event)));
      assert.equal(results.filter(result=>result.settled).length,1);
      assert.equal(results.filter(result=>result.replayed).length,3);
      assert.equal(await count(paidContext.order_id,"charge"),1);
      const staged=await db.query(`SELECT * FROM ${sink} WHERE order_id=$1`,[paidContext.order_id]);
      assert.equal(staged.rowCount,1);
      assert.equal(staged.rows[0].event_json.data.customer_id,base);
      assert.deepEqual(await service.settleWebhook(gateway(paidIntent)),{replayed:false,already_settled:true});
      const other=await prepare(next());
      await assert.rejects(service.settleWebhook({...event,gateway_ref:other.gateway_ref}),error=>error.statusCode===409);
      await assert.rejects(service.voidUnpaidIntent(paidContext.order_id),error=>error.statusCode===409);
    });
    await t.test("offline simulation checks customer ownership and cannot create another charge",async()=>{
      const result=await service.simulateSucceeded(paidContext.order_id,{role:"customer",domainId:base});
      assert.equal(result.ok,true);assert.equal(result.already_settled,true);
      assert.equal(await count(paidContext.order_id,"charge"),1);
      await assert.rejects(service.simulateSucceeded(paidContext.order_id,{role:"provider",domainId:base+1}),error=>error.statusCode===403);
      await assert.rejects(service.simulateSucceeded(paidContext.order_id,{role:"customer",domainId:base+2}),error=>error.statusCode===403);
    });
    await t.test("voided and unknown intents never settle; unsupported event type is rejected",async()=>{
      const value=next(),intent=await prepare(value);await service.voidUnpaidIntent(value.order_id);
      await assert.rejects(service.settleWebhook(gateway(intent)),error=>error.statusCode===409);
      await assert.rejects(service.settleWebhook({...gateway(intent),gateway_ref:"unknown-ref"}),error=>error.statusCode===404);
      await assert.rejects(service.settleWebhook({...gateway(intent),type:"unexpected"}),error=>error.statusCode===400);
    });
    await t.test("wallet provisioning is idempotent and completion credits earnings once under concurrency",async()=>{
      await Promise.all(Array.from({length:3},()=>service.provisionWallet(base+1)));
      const input={...paidContext,payment_method:"gateway",commission_cents:100};
      const results=await Promise.all(Array.from({length:4},()=>service.applyCompletion(input)));
      assert.equal(new Set(results.map(row=>row.id)).size,1);
      const wallet=await service.getWallet({role:"provider",domainId:base+1});
      assert.equal(wallet.balance_cents,900);
      assert.equal(wallet.commission_owed_cents,0);
      await service.provisionWallet(base+1);
      assert.equal((await service.getWallet({role:"provider",domainId:base+1})).balance_cents,900);
      await assert.rejects(service.applyCompletion({...input,commission_cents:101}),error=>error.statusCode===409);
      await assert.rejects(service.applyCompletion({...input,amount_cents:1100,commission_cents:200}),error=>error.statusCode===409);
      await assert.rejects(service.applyCompletion({...input,payment_method:"cod"}),error=>error.statusCode===409);
      await assert.rejects(service.applyRefund(paidContext),error=>error.statusCode===409);
    });
    await t.test("COD completion increases commission owed once and does not credit balance",async()=>{
      const value=next(),input={...value,payment_method:"cod",commission_cents:150};
      await Promise.all(Array.from({length:4},()=>service.applyCompletion(input)));
      const wallet=await service.getWallet({role:"provider",domainId:base+1});
      assert.equal(wallet.balance_cents,900);assert.equal(wallet.commission_owed_cents,150);
      assert.equal(await count(value.order_id,"commission_owed"),1);
      await assert.rejects(prepare(value),error=>error.statusCode===409);
    });
    await t.test("full refund records one matching settled charge and prevents later completion",async()=>{
      refundContext=next({amount_cents:500});refundIntent=await prepare(refundContext);
      await service.settleWebhook(gateway(refundIntent));
      const results=await Promise.all(Array.from({length:3},()=>service.applyRefund(refundContext)));
      assert.equal(new Set(results.map(row=>row.id)).size,1);assert.equal(results[0].status,"refunded");
      await assert.rejects(service.applyRefund({...refundContext,amount_cents:501}),error=>error.statusCode===409);
      await assert.rejects(service.applyCompletion({...refundContext,payment_method:"gateway",commission_cents:50}),error=>error.statusCode===409);
      await assert.rejects(service.applyRefund(next()),error=>error.statusCode===409);
    });
    await t.test("an incomplete receipt and a failed imported charge require reconciliation",async()=>{
      const value=next(),intent=await prepare(value),event=gateway(intent);
      await db.query("INSERT INTO webhook_events(gateway_event_id,type,payload_json) VALUES($1,$2,$3::jsonb)",[event.gateway_event_id,event.type,JSON.stringify(event)]);
      await assert.rejects(service.settleWebhook(event),error=>error.statusCode===409);
      const failed=next();
      await db.query("INSERT INTO transactions(order_id,customer_id,provider_id,kind,amount_cents,method,status) VALUES($1,$2,$3,'charge',$4,'gateway','failed')",[failed.order_id,failed.customer_id,failed.provider_id,failed.amount_cents]);
      await assert.rejects(service.applyRefund(failed),error=>error.statusCode===409);
    });
    await t.test("C supplied transaction rolls wallet and ledger effects back together",async()=>{
      const value=next(),input={...value,payment_method:"cod",commission_cents:100};
      await assert.rejects(db.withTransaction(async client=>{await plain.applyCompletion(input,{client});throw new Error("consumer failed");}),/consumer failed/);
      assert.equal(await count(value.order_id,"commission_owed"),0);
      assert.equal((await service.getWallet({role:"provider",domainId:base+1})).commission_owed_cents,150);
    });
    await t.test("public HTTP reads preserve projections and isolate users; simulation requires valid input and C hooks",async()=>{
      const actors={provider:{role:"provider",domainId:base+1},customer:{role:"customer",domainId:base},other:{role:"customer",domainId:base+2}};
      server=createApp({database:db,authenticate:async req=>{const actor=actors[req.get("authorization")?.replace(/^Bearer /,"")];if(!actor)throw new HttpError(401,"invalid token");return actor;}}).listen(0,"127.0.0.1");
      await new Promise(resolve=>server.once("listening",resolve));
      const origin=`http://127.0.0.1:${server.address().port}`;
      const call=(path,actor="provider",method="GET")=>fetch(origin+path,{method,headers:{Authorization:`Bearer ${actor}`}});
      const walletResponse=await call("/api/provider/wallet?provider_id=1");assert.equal(walletResponse.status,200);
      const wallet=await walletResponse.json();assert.equal(wallet.provider_id,base+1);assert.equal(wallet.balance_cents,900);
      assert.deepEqual(Object.keys(wallet.transactions[0]).sort(),["amount_cents","created_at","gateway_ref","id","kind","method","order_id","status"]);
      assert.equal((await call("/api/provider/wallet","customer")).status,403);
      assert.equal((await call("/api/customer/transactions","invalid")).status,401);
      assert.deepEqual(await (await call("/api/customer/transactions","other")).json(),[]);
      const history=await (await call("/api/customer/transactions","customer")).json();assert.ok(history.length>=4);
      assert.ok(history.every(row=>row.created_at.endsWith("Z")));
      assert.equal((await call("/api/payments/simulate","customer","POST")).status,415);
      const owned=(await db.query("SELECT order_id FROM payment_intents WHERE customer_id=$1 LIMIT 1",[base])).rows[0];
      assert.equal((await fetch(origin+"/api/payments/simulate",{method:"POST",headers:{Authorization:"Bearer customer","Content-Type":"application/json"},body:JSON.stringify({order_id:owned.order_id})})).status,503);
      assert.equal((await call("/internal/payment-intents","customer","POST")).status,503);
    });
  } finally {
    if(server)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
    try {
      await db.query("DELETE FROM webhook_events WHERE payload_json->>'gateway_ref'=ANY($1::text[])",[refs]);
      await db.query("DELETE FROM transactions WHERE order_id=ANY($1::integer[])",[orders]);
      await db.query("DELETE FROM payment_intents WHERE order_id=ANY($1::integer[])",[orders]);
      await db.query("DELETE FROM provider_wallets WHERE provider_id=$1",[base+1]);
      await db.query(`DROP TABLE IF EXISTS ${sink}`);
    } finally {await db.close();}
  }
});
