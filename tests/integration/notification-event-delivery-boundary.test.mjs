import { freshBoot, getDb } from '../../bangkok-homeservice/test-helpers/boot.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewedBooking } from '../../bangkok-homeservice/test-helpers/review-fixture.js';
import { insertEvent } from '../../bangkok-homeservice/lib/db/events.js';
import { configureNotificationEventDelivery, resetNotificationEventDelivery, runRelayOnce, stopRelay } from '../../bangkok-homeservice/lib/modules/notifications/relay.js';
import { configureProviderEventWrites, resetProviderEventWrites } from '../../bangkok-homeservice/lib/modules/providers/event-writes.js';
import { approveProvider } from '../../bangkok-homeservice/lib/modules/providers/service.js';
import { relayOnce } from '../../bangkok-homeservice/lib/messaging/broker-relay.js';
import { createPublisher } from '../../bangkok-homeservice/lib/messaging/publisher.js';
import { envelopeFromRow } from '../../bangkok-homeservice/lib/messaging/envelope.js';
import { CONSUMERS, startConsumer as startMonolithConsumer } from '../../bangkok-homeservice/lib/messaging/consumers.js';
import { createDatabase } from '../../services/notifications/src/database.js';
import { migrate } from '../../services/notifications/src/migrations.js';
import { createInbox } from '../../services/notifications/src/messaging/inbox.js';
import { startConsumer } from '../../services/notifications/src/messaging/consumer.js';

async function eventually(check,label){const end=Date.now()+10000;while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,50));}assert.fail(`timed out: ${label}`);}
const enabled=process.env.TEST_NOTIFICATIONS_DATABASE_URL&&process.env.TEST_AMQP_URL;
test('event-only Notifications delivery preserves monolith ratings and independent consumer dedupe',{skip:!enabled},async t=>{
 stopRelay();resetNotificationEventDelivery();resetProviderEventWrites();freshBoot();
 configureProviderEventWrites({mode:'events'});configureNotificationEventDelivery({mode:'events'});
 const db=createDatabase(process.env.TEST_NOTIFICATIONS_DATABASE_URL),sql=getDb(),logs=[];
 let notes,ratings,publisher;
 try{
  await migrate(db);
  const inbox=createInbox(db),ratingDefinition=CONSUMERS.find(c=>c.name==='ratings.reviews');
  // Persist Notifications binding, then leave that consumer offline while ratings stays live.
  notes=await startConsumer({amqpUrl:process.env.TEST_AMQP_URL,inbox,log:e=>logs.push(e)});await notes.close();notes=null;
  ratings=await startMonolithConsumer(process.env.TEST_AMQP_URL,ratingDefinition,{log:e=>logs.push(e)});
  sql.exec('DROP TABLE notifications');
  const p=reviewedBooking(4);
  insertEvent('booking.status_changed','order',p.orderId,{order_id:p.orderId,customer_id:p.customerId,provider_id:p.providerId,from:'awaiting',to:'confirmed',actor_role:'customer'});
  insertEvent('booking.completed','order',p.orderId,{order_id:p.orderId,customer_id:p.customerId,provider_id:p.providerId});
  const loser=sql.prepare('SELECT id FROM providers WHERE id<>? ORDER BY id LIMIT 1').get(p.providerId).id;
  insertEvent('bid.accepted','bid',9001,{job_request_id:9001,order_id:p.orderId,winner_provider_id:p.providerId,loser_provider_ids:[loser]});
  const glow=sql.prepare("SELECT id FROM providers WHERE email='glow@example.com'").get().id;approveProvider(glow);
  const rows=sql.prepare('SELECT * FROM events ORDER BY id').all(),review=rows.find(r=>r.type==='review.created');
  assert.equal(rows.length,5);
  await t.test('disabled legacy relay leaves markers untouched; broker delivers review to ratings despite Notes downtime',async()=>{
   assert.equal(runRelayOnce(),0);assert.deepEqual(sql.prepare('SELECT * FROM events ORDER BY id').all(),rows);
   publisher=await createPublisher(process.env.TEST_AMQP_URL);
   assert.equal((await relayOnce({publisher,owner:'notes-handover'})).published,5);
   await eventually(()=>sql.prepare("SELECT 1 FROM processed_events WHERE consumer_name='ratings.reviews' AND event_id=?").get(review.event_uuid),'monolith rating effect');
   assert.deepEqual(sql.prepare('SELECT rating_avg,rating_count FROM services WHERE id=?').get(p.serviceId),{rating_avg:4,rating_count:1});
   assert.deepEqual(sql.prepare('SELECT rating_avg,rating_count FROM provider_profiles WHERE provider_id=?').get(p.providerId),{rating_avg:4,rating_count:1});
   assert.equal((await db.query('SELECT count(*)::int AS n FROM notifications')).rows[0].n,0);
   assert.equal(sql.prepare('SELECT count(*) AS n FROM events WHERE processed_at IS NOT NULL').get().n,0);
  });
  await t.test('Notes recovery consumes all five event types, including atomic bid winner/loser projection',async()=>{
   notes=await startConsumer({amqpUrl:process.env.TEST_AMQP_URL,inbox,log:e=>logs.push(e)});
   await eventually(async()=> (await db.query('SELECT count(*)::int AS n FROM processed_events')).rows[0].n===5,'notification dedupe records');
   const result=await db.query('SELECT type,recipient_role,recipient_id,order_id,read_at FROM notifications ORDER BY id');
   assert.equal(result.rowCount,6);
   assert.deepEqual(result.rows.map(n=>n.type).sort(),['new_review','booking_status','rating_request','bid_accepted','bid_rejected','provider_approved'].sort());
   const rejected=result.rows.find(n=>n.type==='bid_rejected');assert.equal(rejected.recipient_id,loser);assert.equal(rejected.order_id,null);
   assert.equal(result.rows.find(n=>n.type==='rating_request').recipient_id,p.customerId);
   assert.equal(result.rows.find(n=>n.type==='provider_approved').recipient_id,glow);
   const stored=await db.query('SELECT effect_count FROM processed_events WHERE event_id=$1',[rows.find(r=>r.type==='bid.accepted').event_uuid]);
   assert.equal(stored.rows[0].effect_count,2);
  });
  await t.test('restart/redelivery dedupes independently without losing ratings or repeating notifications',async()=>{
   await notes.close();notes=null;await ratings.close();ratings=null;
   for(const row of rows)await publisher.publish(envelopeFromRow(row));
   const previous=logs.length;
   ratings=await startMonolithConsumer(process.env.TEST_AMQP_URL,ratingDefinition,{log:e=>logs.push(e)});
   notes=await startConsumer({amqpUrl:process.env.TEST_AMQP_URL,inbox,log:e=>logs.push(e)});
   for(const row of rows)await eventually(()=>logs.slice(previous).some(e=>e.event==='event_duplicate_skipped'&&!e.consumer&&e.event_id===row.event_uuid),'Notes duplicate ack');
   await eventually(()=>logs.slice(previous).some(e=>e.event==='event_duplicate_skipped'&&e.consumer==='ratings.reviews'&&e.event_id===review.event_uuid),'independent rating duplicate ack');
   assert.equal((await db.query('SELECT count(*)::int AS n FROM notifications')).rows[0].n,6);
   assert.equal((await db.query('SELECT count(*)::int AS n FROM processed_events')).rows[0].n,5);
   assert.equal(sql.prepare("SELECT count(*) AS n FROM processed_events WHERE consumer_name='ratings.reviews'").get().n,1);
   assert.deepEqual(sql.prepare('SELECT rating_avg,rating_count FROM services WHERE id=?').get(p.serviceId),{rating_avg:4,rating_count:1});
   assert.equal(runRelayOnce(),0);assert.equal(sql.prepare('SELECT count(*) AS n FROM events WHERE processed_at IS NOT NULL').get().n,0);
  });
 }finally{
  stopRelay();resetNotificationEventDelivery();resetProviderEventWrites();
  try{if(notes)await notes.close();}finally{try{if(ratings)await ratings.close();}finally{try{if(publisher)await publisher.close();}finally{await db.close();}}}
 }
});
