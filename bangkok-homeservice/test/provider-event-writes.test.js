import { freshBoot, getDb } from '../test-helpers/boot.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerProvider } from '../lib/modules/identity/service.js';
import { approveProvider } from '../lib/modules/providers/service.js';
import { configureProviderEventWrites, getProviderEventWrites, resetProviderEventWrites } from '../lib/modules/providers/event-writes.js';

const input = () => ({ email:`writer-${randomUUID()}@example.com`,password:'FixturePass123!',name:'Writer fixture',company_name:'Fixture' });
function boot(events=false) { resetProviderEventWrites();freshBoot();if(events)configureProviderEventWrites({mode:'events'}); }
const events = id => getDb().prepare('SELECT * FROM events WHERE aggregate_type=? AND aggregate_id=? ORDER BY id').all('provider',id);

test('Provider event-writer preparation',async t=>{
 t.after(resetProviderEventWrites);
 await t.test('default registration and approval preserve inherited local wallet/notification',()=>{
  boot();const p=registerProvider(input());approveProvider(p.id);
  assert.ok(getDb().prepare('SELECT 1 FROM provider_wallets WHERE provider_id=?').get(p.id));
  assert.equal(getDb().prepare('SELECT count(*) AS n FROM notifications WHERE recipient_id=? AND type=?').get(p.id,'provider_approved').n,1);
  assert.deepEqual(events(p.id).map(e=>e.type),['provider.registered','provider.approved']);
 });
 await t.test('mode is explicit, invalid setup leaves legacy intact and replacement rejects',()=>{
  boot();assert.throws(()=>configureProviderEventWrites(),TypeError);assert.equal(getProviderEventWrites(),null);
  const state=configureProviderEventWrites({mode:'events'});assert.equal(state.mode,'events');
  assert.throws(()=>configureProviderEventWrites({mode:'events'}),/already configured/);assert.equal(getProviderEventWrites(),state);
 });
 await t.test('event mode does not touch either moved SQLite table, preserving public projections',()=>{
  boot(true);getDb().exec('DROP TABLE provider_wallets; DROP TABLE notifications');
  const p=registerProvider(input());assert.equal(typeof p.id,'number');assert.equal(p.password_hash,undefined);
  assert.ok(getDb().prepare('SELECT 1 FROM provider_profiles WHERE provider_id=?').get(p.id));
  const approved=approveProvider(p.id);assert.equal(approved.is_approved,true);
  const rows=events(p.id);assert.equal(rows.length,2);
  for(const row of rows){assert.deepEqual(JSON.parse(row.payload_json),{provider_id:p.id});assert.ok(row.event_uuid);assert.equal(row.published_at,null);}
 });
 await t.test('registration outbox failure rolls back provider/profile together in event mode',()=>{
  boot(true);const data=input();
  getDb().exec(`CREATE TRIGGER fail_registered BEFORE INSERT ON events WHEN NEW.type='provider.registered' BEGIN SELECT RAISE(ABORT,'outbox fixture'); END`);
  assert.throws(()=>registerProvider(data),/outbox fixture/);
  assert.equal(getDb().prepare('SELECT count(*) AS n FROM providers WHERE email=?').get(data.email).n,0);
  assert.equal(getDb().prepare('SELECT count(*) AS n FROM provider_profiles p LEFT JOIN providers u ON u.id=p.provider_id WHERE u.id IS NULL').get().n,0);
 });
 await t.test('approval outbox failure rolls back flag and emits no successful approval',()=>{
  boot(true);const p=registerProvider(input());
  getDb().exec(`CREATE TRIGGER fail_approved BEFORE INSERT ON events WHEN NEW.type='provider.approved' BEGIN SELECT RAISE(ABORT,'outbox fixture'); END`);
  assert.throws(()=>approveProvider(p.id),/outbox fixture/);
  assert.equal(getDb().prepare('SELECT is_approved FROM provider_profiles WHERE provider_id=?').get(p.id).is_approved,0);
  assert.deepEqual(events(p.id).map(e=>e.type),['provider.registered']);
 });
 await t.test('duplicate registration/approval cannot stage another logical provisioning/approval',()=>{
  boot(true);const data=input(),p=registerProvider(data);approveProvider(p.id);
  assert.throws(()=>registerProvider(data),e=>e.statusCode===409);
  assert.throws(()=>approveProvider(p.id),e=>e.statusCode===409);
  assert.equal(events(p.id).length,2);
 });
});
