// Real monolith transport -> real Payments HTTP shell; C/B are explicit doubles.
// This does not implement/verify durable command storage or live authentication.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from '../../services/payments-wallet/src/app.js';
import { createPaymentsClient, PaymentOutcomeUnknownError } from '../../bangkok-homeservice/lib/modules/payments/client.js';
const f=JSON.parse(await readFile(new URL('../../contracts/fixtures/payment-intents.json',import.meta.url),'utf8'));
const clone=value=>structuredClone(value);
async function serve(t,options={}) {
  const calls=[];
  const commands={
    create:async input=>{calls.push(input);return {replayed:false,result:clone(f.created)};},
    get:async input=>{calls.push(input);return clone(f.created);},
    cancel:async input=>{calls.push(input);return clone(f.cancelled);},
  };
  const app=createApp({database:{query:()=>assert.fail('no SQL in shell')},
    authenticateService:async req=>{
      assert.equal(req.get('authorization'),'Bearer boundary-fixture');
      return {service:'booking',callerId:'fixture-issuer|booking'};
    },paymentCommands:commands,...options});
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  return {calls,commands,client:createPaymentsClient({baseUrl:`http://127.0.0.1:${server.address().port}`})};
}
const credentials={token:'boundary-fixture',requestId:'boundary-http',traceparent:'00-11111111111111111111111111111111-2222222222222222-01'};
test('actual prepared client interoperates with create/query/cancel HTTP DTOs',async t=>{
  const {client,calls}=await serve(t);
  assert.deepEqual(await client.createIntent(f.create.body,{...credentials,commandId:f.created.create_command_id}),f.created);
  assert.deepEqual(await client.getOperation({create_command_id:f.created.create_command_id,saga_id:f.created.saga_id,order_id:42,amount_cents:150000},credentials),f.created);
  assert.deepEqual(await client.cancelIntent(f.cancel.body,{...credentials,commandId:f.cancel.headers['Idempotency-Key']}),f.cancelled);
  assert.equal(calls.length,3);
  for (const input of calls) {
    assert.equal(input.callerId,'fixture-issuer|booking');
    assert.equal(input.context.requestId,'boundary-http');
    assert.equal(input.context.traceparent,credentials.traceparent);
    assert.ok(!JSON.stringify(input).includes('boundary-fixture'));
  }
});
test('unknown command lookup is still unknown through real client, not cancellation',async t=>{
  const {client,commands}=await serve(t);commands.get=async()=>null;
  await assert.rejects(client.getOperation({create_command_id:f.created.create_command_id,saga_id:f.created.saga_id,order_id:42,amount_cents:150000},credentials),error=>error instanceof PaymentOutcomeUnknownError && error.reason==='lookup_missing');
});
test('unwired production seams fail closed through the actual consumer client',async t=>{
  const {client,calls}=await serve(t,{authenticateService:undefined,paymentCommands:undefined});
  await assert.rejects(client.createIntent(f.create.body,{...credentials,commandId:f.created.create_command_id}),error=>error instanceof PaymentOutcomeUnknownError && error.upstreamStatus===503);
  assert.equal(calls.length,0);
});
