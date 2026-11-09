// Regression: an accepted customer cancellation supersedes provisioning, even across
// network waits. SQLite/public routes are real; Payments is controlled at its seam.
import { freshBoot, getDb } from '../test-helpers/boot.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { call } from '../test-helpers/call.js';
import { signToken } from '../lib/http/auth.js';
import * as route from '../app/api/bookings/[id]/cancel/route.js';
import { configureBookingFinancialAccess, resetBookingFinancialAccess } from '../lib/modules/booking/financial-access.js';
import { createBookingFinalization, recoverFinalizationOnce, resetBookingFinalization } from '../lib/modules/booking/finalization.js';
import { configureBookingSaga, resetBookingSaga, advance, activate, recoverOnce, paymentSetupFor } from '../lib/modules/booking/saga.js';
import { FinancialOutcomeUnknownError } from '../lib/modules/payments/financial-client.js';

freshBoot();
const db = getDb();
const customer = db.prepare('SELECT id FROM customers LIMIT 1').get().id;
const provider = db.prepare('SELECT id FROM providers LIMIT 1').get().id;
let n = 0;
function fixture(state) {
  n++;
  const day = `2027-05-${String(n).padStart(2, '0')}`;
  const id = db.prepare(`INSERT INTO orders(customer_id,provider_id,service_date,starting_time,ending_time,duration_min,subtotal_cents,tax_cents,total_cents,commission_pct,payment_method,payment_status,otp,status)
    VALUES(?,?,?,'10:00','10:30',30,10000,700,10700,10,'gateway','pending',123456,'awaiting')`).run(customer, provider, day).lastInsertRowid;
  db.prepare("INSERT INTO slot_holds(provider_id,service_date,slot_time,order_id) VALUES(?,?,'10:00',?)").run(provider, day, id);
  const sagaId = `setup-cancel-${id}`;
  db.prepare(`INSERT INTO booking_sagas(saga_id,order_id,customer_id,request_key,request_digest,state,create_command_id,cancel_command_id,snapshot_json)
    VALUES(?,?,?,?,'digest',?,?,?,?)`).run(sagaId, id, customer, `req-${id}`, state, `create:${sagaId}`, `cancel:${sagaId}`,
      JSON.stringify({id, customer_id:customer, provider_id:provider, total_cents:10700, payment_method:'gateway'}));
  if (state === 'COMPLETED') db.prepare("INSERT INTO booking_saga_activations(saga_id,activate_command_id,state) VALUES(?,?,'pending')").run(sagaId, `activate:${sagaId}`);
  return {id, sagaId};
}
const holds = id => db.prepare('SELECT count(*) n FROM slot_holds WHERE order_id=?').get(id).n;
const saga = id => db.prepare('SELECT * FROM booking_sagas WHERE order_id=?').get(id);
const work = id => db.prepare('SELECT * FROM booking_financial_work WHERE order_id=?').get(id);
const cancel = id => call(route.POST, {token:signToken({sub:customer,role:'customer'}), params:{id:String(id)}, body:{}});
function install() {
  resetBookingFinancialAccess(); resetBookingFinalization(); resetBookingSaga();
  const calls=[]; let available=false;
  const callbacks=createBookingFinalization({financial:{complete:async()=>{throw Error('unexpected completion');}, cancel:async(ctx)=>{
    calls.push(ctx);
    if (!available) throw new FinancialOutcomeUnknownError('timeout');
    return {command_id:ctx.commandId,kind:'cancellation',request:ctx.request,state:'ready',outcome:'no_payment',settlement_fenced:true};
  }},credentials:async()=>({token:'fixture'}),baseBackoffMs:1,maxBackoffMs:1});
  configureBookingFinancialAccess({bookingFinalization:callbacks});
  return {calls,callbacks,available:()=>{available=true;}};
}
const tick = () => new Promise(r=>setTimeout(r,5));
function deferred() { let resolve,reject; const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject}; }

test('customer cancellation during payment setup', async t=>{
  t.after(()=>{resetBookingFinancialAccess();resetBookingFinalization();resetBookingSaga();});
  for (const state of ['INTENT_CREATE_PENDING','COMPENSATION_PENDING','RECOVERY_PENDING']) {
    await t.test(`${state}: persist pending, guard transitions, recover same command after reconfiguration`, async()=>{
      const fake=install(); const {id}=fixture(state);
      const result=await cancel(id);
      assert.deepEqual([result.status,result.body.cancellation_status,holds(id)],[202,'pending',1]);
      assert.equal(fake.callbacks.assertTransitionAllowed({orderId:id,operation:'confirm'}),false);
      assert.equal(fake.calls[0].request.provisioning.create_command_id,saga(id).create_command_id);
      const saved=work(id);
      configureBookingSaga({payments:{prepare:async()=>{throw Error('must not prepare');},cancel:async()=>{throw Error('must not compensate');}}});
      assert.equal(await recoverOnce(),0,'setup recovery must not starve other sagas with cancelled work');
      // Process-equivalent reconfiguration retains SQLite work and its original identity.
      resetBookingFinalization();
      createBookingFinalization({financial:{complete:async()=>{},cancel:async(ctx)=>{
        fake.calls.push(ctx);return {state:'ready',outcome:'no_payment',settlement_fenced:true};
      }},credentials:async()=>({token:'refreshed'}),baseBackoffMs:1,maxBackoffMs:1});
      await tick();await recoverFinalizationOnce();
      assert.deepEqual([work(id).state,saga(id).state,holds(id)],['ready','CANCELLED',0]);
      assert.equal(fake.calls.at(-1).commandId,saved.command_id);
      assert.deepEqual(fake.calls.at(-1).request,JSON.parse(saved.request_json));
      assert.equal((await cancel(id)).body.cancellation_status,'ready');
    });
  }
  for (const phase of ['prepare','cancel']) for (const failure of [false,true]) {
    await t.test(`late ${phase} ${failure?'error':'success'} cannot overwrite pending or ready cancellation`,async()=>{
      const fake=install();const {id,sagaId}=fixture(phase==='prepare'?'INTENT_CREATE_PENDING':'COMPENSATION_PENDING');
      const waiting=deferred(), entered=deferred();
      configureBookingSaga({payments:{[phase]:async()=>{entered.resolve();return waiting.promise;}}});
      const inflight=advance(sagaId);await entered.promise;
      assert.equal((await cancel(id)).status,202);
      if (failure) {fake.available();await tick();await recoverFinalizationOnce();}
      if (failure) waiting.reject(Error('late outage'));
      else waiting.resolve({payment_intent:{id:55,order_id:id,amount_cents:10700,gateway_ref:'fixture',status:'requires_payment'}});
      await inflight;
      assert.equal(saga(id).state,failure?'CANCELLED':phase==='prepare'?'INTENT_CREATE_PENDING':'COMPENSATION_PENDING');
      assert.equal(holds(id),failure?0:1,'setup must not release holds before financial acknowledgement');
      assert.equal(db.prepare('SELECT count(*) n FROM booking_saga_activations WHERE saga_id=?').get(sagaId).n,0);
      assert.equal(db.prepare("SELECT count(*) n FROM events WHERE aggregate_id=? AND type='booking.status_changed'").get(id).n,failure?1:0);
      if (!failure) {fake.available();await tick();await recoverFinalizationOnce();}
      assert.equal(saga(id).state,'CANCELLED');
    });
  }
  await t.test('late activation acknowledgement cannot restore payable after cancellation',async()=>{
    const fake=install();const {id,sagaId}=fixture('COMPLETED');const waiting=deferred(),entered=deferred();
    configureBookingSaga({payments:{activate:async()=>{entered.resolve();return waiting.promise;}}});
    const inflight=activate(sagaId);await entered.promise;
    assert.equal((await cancel(id)).status,202);
    fake.available();await tick();await recoverFinalizationOnce();
    waiting.resolve({outcome:'activated'});await inflight;
    assert.equal(paymentSetupFor(id),'blocked');assert.equal(holds(id),0);
    assert.equal(db.prepare("SELECT count(*) n FROM booking_saga_transitions WHERE saga_id=? AND to_state='CANCELLED'").get(sagaId).n,0,'preserve completed provisioning history');
  });
});
