import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomInt,randomUUID} from 'node:crypto';
import {NodeSDK} from '@opentelemetry/sdk-node';
import {trace,propagation,ROOT_CONTEXT} from '@opentelemetry/api';
process.env.OTEL_METRICS_EXPORTER='none';process.env.OTEL_LOGS_EXPORTER='none';
const sdk=new NodeSDK({autoDetectResources:false,instrumentations:[],spanProcessors:[{onStart(){},onEnd(){},forceFlush:async()=>{},shutdown:async()=>{}}]});await sdk.start();after(()=>sdk.shutdown());
const {createPaymentsRuntime}=await import('../src/runtime.js');
const {createDatabase}=await import('../src/database.js');
const {migrate}=await import('../src/migrations.js');
const {HttpError}=await import('../src/errors.js');
async function serve(app){
 // Explicit test instrumentation models the production preload's active HTTP span.
 const server=createServer((req,res)=>trace.getTracer('runtime-test').startActiveSpan('HTTP fixture',{},propagation.extract(ROOT_CONTEXT,req.headers),span=>{res.on('finish',()=>span.end());app(req,res);}));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 return {url:`http://127.0.0.1:${server.address().port}`,stop:()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);})};
}
const noSql={query:()=>assert.fail('no SQL before auth'),withTransaction:()=>assert.fail('no SQL before auth')};
test('default runtime composes C but both HTTP boundaries stay closed without B',async()=>{
 const runtime=createPaymentsRuntime({database:noSql}),http=await serve(runtime.app);
 try{assert.equal(typeof runtime.participant.activate,'function');for(const [path,method] of [['/api/provider/wallet','GET'],['/internal/payment-intents','POST']])assert.equal((await fetch(http.url+path,{method})).status,503);}finally{await http.stop();}
});
test('partial/invalid verifier configuration is rejected before opening a boundary',()=>{
 for(const auth of [{authenticate:async()=>({})},{authenticateService:async()=>({})},{authenticate:()=>({}),authenticateService:null}])assert.throws(()=>createPaymentsRuntime({database:noSql,...auth}),/both user and service/);
});
test('composed HTTP runtime uses real C eligibility and one atomic charge/outbox with request context',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 const db=createDatabase(process.env.TEST_DATABASE_URL),id=randomInt(200000000,210000000),caller='runtime|'+randomUUID();let http,failOutbox=false;
 const owned={query:db.query,checkReady:db.checkReady,withTransaction:work=>db.withTransaction(tx=>work({query:(sql,args)=>{if(failOutbox&&sql.includes('INSERT INTO outbox_events'))throw new Error('test outbox failure');return tx.query(sql,args);}}))};
 try{
  await migrate(db);
  const runtime=createPaymentsRuntime({database:owned,
   authenticate:async req=>{if(req.get('authorization')!=='Bearer user-fixture')throw new HttpError(401,'test user required');return {role:'customer',domainId:id+1};},
   authenticateService:async req=>{if(req.get('authorization')!=='Bearer service-fixture')throw new HttpError(401,'test service required');return{service:'booking',callerId:caller};},
  });http=await serve(runtime.app);
  const create='create:'+id,saga='runtime-saga-'+id;
  const post=(path,body,token,key,requestId)=>fetch(http.url+path,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{}),'X-Request-Id':requestId??'runtime-fixture',traceparent:'00-1234567890abcdef1234567890abcdef-1234567890abcdef-01'},body:JSON.stringify(body)});
  await t.test('create replay and pre-activation settlement are guarded by the composed participant',async()=>{
   const input={order_id:id,customer_id:id+1,provider_id:id+2,amount_cents:107,currency:'THB',saga_id:saga};
   assert.equal((await post('/internal/payment-intents',input,'service-fixture',create)).status,201);
   assert.equal((await post('/internal/payment-intents',input,'service-fixture',create)).status,200);
   assert.equal((await post('/api/payments/simulate',{order_id:id},'user-fixture')).status,409);
   assert.equal((await db.query('SELECT 1 FROM transactions WHERE order_id=$1',[id])).rowCount,0);
   assert.equal((await post('/internal/payment-intents/activate-by-command',{create_command_id:create,saga_id:saga},'service-fixture','activate:'+id)).status,200);
  });
  await t.test('outbox failure rolls back the intent transition, charge and webhook receipt together',async()=>{
   failOutbox=true;assert.equal((await post('/api/payments/simulate',{order_id:id},'user-fixture')).status,500);failOutbox=false;
   assert.equal((await db.query('SELECT status FROM payment_intents WHERE order_id=$1',[id])).rows[0].status,'requires_payment');
   assert.equal((await db.query('SELECT 1 FROM transactions WHERE order_id=$1',[id])).rowCount,0);
   assert.equal((await db.query('SELECT 1 FROM outbox_events WHERE aggregate_id=$1',[String(id)])).rowCount,0);
   assert.equal((await db.query("SELECT 1 FROM webhook_events WHERE payload_json->>'gateway_ref' IN (SELECT gateway_ref FROM payment_intents WHERE order_id=$1)",[id])).rowCount,0);
  });
  await t.test('a retry settles once and stages the active trace plus request ID in the owning transaction',async()=>{
   assert.equal((await post('/api/payments/simulate',{order_id:id},'user-fixture',null,'runtime-paid')).status,200);
   assert.equal((await post('/api/payments/simulate',{order_id:id},'user-fixture',null,'runtime-repeat')).status,200);
   assert.equal((await db.query("SELECT 1 FROM transactions WHERE order_id=$1 AND kind='charge'",[id])).rowCount,1);
   const events=await db.query('SELECT headers,envelope FROM outbox_events WHERE aggregate_id=$1',[String(id)]);assert.equal(events.rowCount,1);
   const {headers,envelope}=events.rows[0];assert.equal(headers['x-request-id'],'runtime-paid');assert.equal(envelope.correlation_id,'runtime-paid');assert.equal(headers.traceparent.split('-')[1],'1234567890abcdef1234567890abcdef');
   assert.equal(JSON.stringify(events.rows).includes('user-fixture'),false);assert.equal(JSON.stringify(events.rows).includes('service-fixture'),false);
  });
 }finally{
  if(http)await http.stop();
  try{await db.query('DELETE FROM payment_commands WHERE caller_id=$1',[caller]);await db.query('DELETE FROM payment_provisioning WHERE caller_id=$1',[caller]);await db.query('DELETE FROM outbox_events WHERE aggregate_id=$1',[String(id)]);await db.query("DELETE FROM webhook_events WHERE payload_json->>'gateway_ref' IN (SELECT gateway_ref FROM payment_intents WHERE order_id=$1)",[id]);await db.query('DELETE FROM transactions WHERE order_id=$1',[id]);await db.query('DELETE FROM payment_intents WHERE order_id=$1',[id]);}finally{await db.close();}
 }
});
