import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomInt,randomUUID} from 'node:crypto';
import {createDatabase} from '../src/database.js';
import {migrate} from '../src/migrations.js';
import {createPaymentsRuntime} from '../src/runtime.js';
import {createFinancialOperations} from '../src/financial/index.js';
const hash='a'.repeat(64);
test('approved imported intents: actual PG eligibility, settlement, financial replay and fencing',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 const db=createDatabase(process.env.TEST_DATABASE_URL);await migrate(db);
 const runtime=()=>createPaymentsRuntime({database:db,createFinancialOperations,legacyManifestSha256:hash});
 const r=runtime(),orders=[],callerId='legacy-fixture:'+randomUUID();
 const make=async()=>{
  const order_id=randomInt(1400000000,1500000000);orders.push(order_id);
  const context={order_id,customer_id:7,provider_id:randomInt(700000000,799999999),amount_cents:1000,currency:'THB'};
  const intent=await r.business.prepareIntent(context);
  await db.query(`INSERT INTO legacy_payment_bindings(order_id,binding_id,manifest_sha256,intent_id,customer_id,provider_id,amount_cents,currency,eligibility) VALUES($1,$2,$3,$4,$5,$6,$7,'THB','open_unpaid')`,[order_id,`legacy:${hash}:${order_id}`,hash,intent.id,context.customer_id,context.provider_id,1000]);
  const request={...context,payment_method:'gateway',legacy_binding:{binding_id:`legacy:${hash}:${order_id}`,manifest_sha256:hash}};
  const command=kind=>{const operation_id=randomUUID();return {callerId,commandId:(kind==='completion'?'complete:':'cancel:')+operation_id,request:{...request,operation_id,...(kind==='completion'?{commission_cents:100}:{reason:'customer_cancelled'})}};};
  return {context,intent,command};
 };
 const settle=p=>r.business.settleWebhook({gateway_event_id:randomUUID(),type:'payment_intent.succeeded',gateway_ref:p.intent.gateway_ref});
 try{
  await t.test('unapproved gate rejects without settlement; missing/wrong reference reconciles',async()=>{
   const p=await make();const blocked=createPaymentsRuntime({database:db,createFinancialOperations});
   await assert.rejects(blocked.business.settleWebhook({gateway_event_id:randomUUID(),type:'payment_intent.succeeded',gateway_ref:p.intent.gateway_ref}));
   const cmd=p.command('completion');cmd.request.legacy_binding.manifest_sha256='b'.repeat(64);cmd.request.legacy_binding.binding_id=`legacy:${'b'.repeat(64)}:${p.context.order_id}`;
   assert.equal((await r.financialOperations.complete(cmd)).result.reason,'context_mismatch');
   const q=await make();await db.query('DELETE FROM legacy_payment_bindings WHERE order_id=$1',[q.context.order_id]);
   assert.equal((await r.financialOperations.cancel(q.command('cancellation'))).result.reason,'legacy_reconciliation_required');
  });
  await t.test('pending completion waits for real charge then pays once across reconstructed runtime',async()=>{
   const p=await make(),cmd=p.command('completion');
   assert.equal((await r.financialOperations.complete(cmd)).result.reason,'awaiting_settlement');
   await settle(p);const result=await runtime().financialOperations.complete(cmd);assert.equal(result.result.state,'ready');
   assert.deepEqual((await runtime().financialOperations.complete(cmd)).result,result.result);
   const kinds=(await db.query('SELECT kind FROM transactions WHERE order_id=$1 ORDER BY kind',[p.context.order_id])).rows.map(x=>x.kind);assert.deepEqual(kinds,['charge','payout_credit']);
   assert.equal((await r.financialOperations.cancel(p.command('cancellation'))).result.reason,'completion_accounted');
  });
  await t.test('unpaid cancellation voids and fences late payment; paid cancellation refunds once',async()=>{
   const p=await make(),cmd=p.command('cancellation');assert.equal((await r.financialOperations.cancel(cmd)).result.outcome,'voided');
   await assert.rejects(settle(p));assert.equal((await runtime().financialOperations.cancel(cmd)).replayed,true);
   const q=await make();await settle(q);const cancel=q.command('cancellation');
   assert.equal((await r.financialOperations.cancel(cancel)).result.outcome,'refunded');
   assert.equal((await runtime().financialOperations.cancel(cancel)).replayed,true);
   assert.equal((await db.query("SELECT count(*)::int n FROM transactions WHERE order_id=$1 AND kind='refund'",[q.context.order_id])).rows[0].n,1);
   assert.equal((await r.financialOperations.complete(q.command('completion'))).result.reason,'cancellation_fenced');
  });
  await t.test('payment racing cancellation yields one safe fence and no duplicate charge/refund',async()=>{
   const p=await make(),cancel=p.command('cancellation');
   const results=await Promise.allSettled([settle(p),r.financialOperations.cancel(cancel)]);
   assert.equal(results[1].status,'fulfilled');assert.equal(results[1].value.result.state,'ready');
   assert.ok(['voided','refunded'].includes(results[1].value.result.outcome));
   assert.equal(await db.withTransaction(tx=>r.participant.assertSettlementAllowed(tx,p.intent)),false);
   const rows=(await db.query('SELECT kind,count(*)::int n FROM transactions WHERE order_id=$1 GROUP BY kind',[p.context.order_id])).rows;
   assert.ok(rows.every(x=>x.n===1));assert.ok(!rows.some(x=>x.kind==='payout_credit'));
  });
 }finally{
  for(const table of ['financial_fences','financial_commands','legacy_payment_bindings','transactions'])await db.query(`DELETE FROM ${table} WHERE order_id=ANY($1::int[])`,[orders]);
  await db.query('DELETE FROM outbox_events WHERE aggregate_id=ANY($1::text[])',[orders.map(String)]);
  await db.query("DELETE FROM webhook_events WHERE payload_json->>'gateway_ref' IN (SELECT gateway_ref FROM payment_intents WHERE order_id=ANY($1::int[]))",[orders]);
  await db.query('DELETE FROM payment_intents WHERE order_id=ANY($1::int[])',[orders]);await db.close();
 }
});
