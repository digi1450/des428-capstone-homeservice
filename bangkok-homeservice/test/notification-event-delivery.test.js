import { freshBoot, getDb } from '../test-helpers/boot.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewedBooking } from '../test-helpers/review-fixture.js';
import { configureNotificationEventDelivery, getNotificationEventDelivery, resetNotificationEventDelivery,
 runRelayOnce, startRelay, stopRelay } from '../lib/modules/notifications/relay.js';
import { createInbox } from '../lib/messaging/inbound.js';
import { reviewCreatedHandler } from '../lib/modules/reviews/rating-events.js';
import { envelopeFromRow } from '../lib/messaging/envelope.js';
function boot(){stopRelay();resetNotificationEventDelivery();freshBoot();}
const event=()=>getDb().prepare("SELECT * FROM events WHERE type='review.created' ORDER BY id DESC LIMIT 1").get();
const service=id=>getDb().prepare('SELECT rating_avg,rating_count FROM services WHERE id=?').get(id);

test('Notification relay event-delivery selection',async t=>{
 t.after(()=>{stopRelay();resetNotificationEventDelivery();});
 await t.test('default relay retains one local notification/rating update and local processed marker',()=>{
  boot();const p=reviewedBooking();assert.equal(runRelayOnce(),1);assert.equal(runRelayOnce(),0);
  assert.ok(event().processed_at);assert.equal(event().published_at,null);
  assert.equal(getDb().prepare("SELECT count(*) AS n FROM notifications WHERE type='new_review'").get().n,1);
  assert.deepEqual(service(p.serviceId),{rating_avg:5,rating_count:1});
 });
 await t.test('explicit configuration stops an existing timer and refuses accidental replacement',()=>{
  boot();startRelay();assert.ok(globalThis[Symbol.for('edemand.relay.interval')]);
  assert.throws(()=>configureNotificationEventDelivery(),TypeError);assert.equal(getNotificationEventDelivery(),null);
  const config=configureNotificationEventDelivery({mode:'events'});
  assert.equal(globalThis[Symbol.for('edemand.relay.interval')],undefined);
  startRelay();assert.equal(globalThis[Symbol.for('edemand.relay.interval')],undefined);
  assert.throws(()=>configureNotificationEventDelivery({mode:'events'}),/already configured/);assert.equal(getNotificationEventDelivery(),config);
 });
 await t.test('event mode neither dispatches nor claims pending rows, even without local inbox table',()=>{
  boot();const p=reviewedBooking(),before=event(),ratings=service(p.serviceId);
  configureNotificationEventDelivery({mode:'events'});getDb().exec('DROP TABLE notifications');
  assert.equal(runRelayOnce(),0);assert.equal(runRelayOnce(),0);
  assert.deepEqual(event(),before);assert.deepEqual(service(p.serviceId),ratings);
 });
 await t.test('existing C monolith ratings inbox owns recomputation and rolls back its dedupe if the effect fails',()=>{
  boot();const p=reviewedBooking(),row=event();configureNotificationEventDelivery({mode:'events'});
  const inbox=createInbox({consumerName:'ratings.reviews',handlers:{'review.created':reviewCreatedHandler}});
  const envelope=envelopeFromRow(row);
  getDb().exec(`CREATE TRIGGER fail_rating BEFORE UPDATE ON services BEGIN SELECT RAISE(ABORT,'rating fixture failure'); END`);
  assert.throws(()=>inbox.handle(envelope),/rating fixture failure/);
  assert.equal(getDb().prepare('SELECT count(*) AS n FROM processed_events WHERE event_id=?').get(row.event_uuid).n,0);
  getDb().exec('DROP TRIGGER fail_rating');
  assert.equal(inbox.handle(envelope).duplicate,false);assert.equal(inbox.handle(envelope).duplicate,true);
  assert.deepEqual(service(p.serviceId),{rating_avg:5,rating_count:1});
  assert.deepEqual(getDb().prepare('SELECT rating_avg,rating_count FROM provider_profiles WHERE provider_id=?').get(p.providerId),{rating_avg:5,rating_count:1});
  assert.equal(event().processed_at,null);assert.equal(getDb().prepare('SELECT count(*) AS n FROM notifications').get().n,0);
 });
});
