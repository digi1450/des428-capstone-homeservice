// Explicit disposable PostgreSQL + RabbitMQ only; no real identity/auth configuration.
import { freshBoot, getDb } from '../../bangkok-homeservice/test-helpers/boot.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { call } from '../../bangkok-homeservice/test-helpers/call.js';
import { loginAdmin } from '../../bangkok-homeservice/test-helpers/auth.js';
import * as signup from '../../bangkok-homeservice/app/api/auth/provider/register/route.js';
import * as approve from '../../bangkok-homeservice/app/api/admin/providers/[id]/approve/route.js';
import { configureProviderEventWrites, resetProviderEventWrites } from '../../bangkok-homeservice/lib/modules/providers/event-writes.js';
import { relayOnce } from '../../bangkok-homeservice/lib/messaging/broker-relay.js';
import { createPublisher } from '../../bangkok-homeservice/lib/messaging/publisher.js';
import { envelopeFromRow } from '../../bangkok-homeservice/lib/messaging/envelope.js';
import { createDatabase as createPaymentsDb } from '../../services/payments-wallet/src/database.js';
import { migrate as migratePayments } from '../../services/payments-wallet/src/migrations.js';
import { createPaymentsService } from '../../services/payments-wallet/src/service.js';
import { createWalletInbox, startWalletConsumer } from '../../services/payments-wallet/src/messaging/wallet-consumer.js';
import { createDatabase as createNotesDb } from '../../services/notifications/src/database.js';
import { migrate as migrateNotes } from '../../services/notifications/src/migrations.js';
import { createInbox } from '../../services/notifications/src/messaging/inbox.js';
import { startConsumer } from '../../services/notifications/src/messaging/consumer.js';

async function eventually(check,label) {
 const end=Date.now()+10000;
 while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,50));}
 assert.fail(`timed out: ${label}`);
}
const ready=process.env.TEST_PAYMENTS_DATABASE_URL&&process.env.TEST_NOTIFICATIONS_DATABASE_URL&&process.env.TEST_AMQP_URL;
test('provider API events -> C relay -> RabbitMQ -> owning wallet/notification databases',{skip:!ready},async t=>{
 freshBoot();resetProviderEventWrites();configureProviderEventWrites({mode:'events'});
 const sql=getDb(),pay=createPaymentsDb(process.env.TEST_PAYMENTS_DATABASE_URL),notes=createNotesDb(process.env.TEST_NOTIFICATIONS_DATABASE_URL);
 const url=process.env.TEST_AMQP_URL,logs=[];
 let walletConsumer,noteConsumer,publisher,providerId;
 try {
  await migratePayments(pay);await migrateNotes(notes);
  const walletInbox=createWalletInbox(pay,createPaymentsService(pay)),noteInbox=createInbox(notes);
  // Establish durable bindings, then stop consumers before registration and publish.
  walletConsumer=await startWalletConsumer({amqpUrl:url,inbox:walletInbox,log:e=>logs.push(e)});
  noteConsumer=await startConsumer({amqpUrl:url,inbox:noteInbox,log:e=>logs.push(e)});
  await walletConsumer.close();walletConsumer=null;await noteConsumer.close();noteConsumer=null;
  sql.exec('DROP TABLE provider_wallets; DROP TABLE notifications');
  const admin=await loginAdmin();
  await t.test('registration/approval commit with no local wallet/notification and consumers unavailable',async()=>{
   const result=await call(signup.POST,{body:{email:`provider-boundary-${randomUUID()}@example.com`,password:'FixturePass123!',name:'Boundary provider',company_name:'Fixture'}});
   assert.equal(result.status,201);providerId=result.body.id;
   const approved=await call(approve.POST,{token:admin.token,method:'POST',params:{id:String(providerId)}});
   assert.equal(approved.status,200);assert.equal(approved.body.is_approved,true);
   const rows=sql.prepare('SELECT * FROM events WHERE aggregate_id=? ORDER BY id').all(providerId);
   assert.deepEqual(rows.map(r=>r.type),['provider.registered','provider.approved']);
   for(const row of rows){assert.deepEqual(JSON.parse(row.payload_json),{provider_id:providerId});assert.equal(row.published_at,null);}
   assert.equal((await pay.query('SELECT 1 FROM provider_wallets WHERE provider_id=$1',[providerId])).rowCount,0);
   assert.equal((await notes.query('SELECT 1 FROM notifications WHERE recipient_id=$1',[providerId])).rowCount,0);
  });
  await t.test('failed delivery retains stable event identities, then broker stores messages while consumers remain stopped',async()=>{
   const before=sql.prepare('SELECT event_uuid FROM events ORDER BY id').all();
   const failed=await relayOnce({publisher:{async publish(){throw new Error('fixture broker unavailable');}},owner:'provider-boundary-failed'});
   assert.equal(failed.failed,2);
   assert.deepEqual(sql.prepare('SELECT event_uuid FROM events ORDER BY id').all(),before);
   sql.prepare("UPDATE events SET next_publish_at='2000-01-01T00:00:00.000Z' WHERE published_at IS NULL").run(); // advance disposable retry fixture
   publisher=await createPublisher(url);
   const sent=await relayOnce({publisher,owner:'provider-boundary-retry'});assert.equal(sent.published,2);
   assert.equal((await pay.query('SELECT 1 FROM provider_wallets WHERE provider_id=$1',[providerId])).rowCount,0);
   assert.equal((await notes.query('SELECT 1 FROM notifications WHERE recipient_id=$1',[providerId])).rowCount,0);
  });
  await t.test('starting real consumers provisions one wallet and one approval notification',async()=>{
   walletConsumer=await startWalletConsumer({amqpUrl:url,inbox:walletInbox,log:e=>logs.push(e)});
   noteConsumer=await startConsumer({amqpUrl:url,inbox:noteInbox,log:e=>logs.push(e)});
   await eventually(async()=> (await pay.query('SELECT 1 FROM provider_wallets WHERE provider_id=$1',[providerId])).rowCount===1,'wallet provisioning');
   await eventually(async()=> (await notes.query("SELECT 1 FROM notifications WHERE recipient_id=$1 AND type='provider_approved'",[providerId])).rowCount===1,'approval notification');
   assert.equal(sql.prepare('SELECT is_approved FROM provider_profiles WHERE provider_id=?').get(providerId).is_approved,1);
  });
  await t.test('redelivery across consumer restart preserves existing wallet balance/read state and dedupes both events',async()=>{
   await walletConsumer.close();walletConsumer=null;await noteConsumer.close();noteConsumer=null;
   await pay.query('UPDATE provider_wallets SET balance_cents=321,commission_owed_cents=17 WHERE provider_id=$1',[providerId]); // owning DB fixture, not a real payment
   await notes.query("UPDATE notifications SET read_at='2026-11-08T00:00:00.000Z' WHERE recipient_id=$1",[providerId]);
   const rows=sql.prepare('SELECT * FROM events ORDER BY id').all();
   for(const row of rows)await publisher.publish(envelopeFromRow(row));
   walletConsumer=await startWalletConsumer({amqpUrl:url,inbox:walletInbox,log:e=>logs.push(e)});
   noteConsumer=await startConsumer({amqpUrl:url,inbox:noteInbox,log:e=>logs.push(e)});
   for(const row of rows)await eventually(()=>logs.some(e=>e.event==='event_duplicate_skipped'&&e.event_id===row.event_uuid),'duplicate event ack');
   const wallets=await pay.query('SELECT balance_cents,commission_owed_cents FROM provider_wallets WHERE provider_id=$1',[providerId]);
   assert.deepEqual(wallets.rows,[{balance_cents:321,commission_owed_cents:17}]);
   const notifications=await notes.query('SELECT read_at FROM notifications WHERE recipient_id=$1',[providerId]);
   assert.equal(notifications.rowCount,1);assert.equal(notifications.rows[0].read_at.toISOString(),'2026-11-08T00:00:00.000Z');
  });
 } finally {
  resetProviderEventWrites();
  try{if(walletConsumer)await walletConsumer.close();}finally{
   try{if(noteConsumer)await noteConsumer.close();}finally{
    try{if(publisher)await publisher.close();}finally{await Promise.all([pay.close(),notes.close()]);}
   }
  }
 }
});
