import { freshBoot, getDb } from '../test-helpers/boot.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { signToken } from '../lib/http/auth.js';
import { call } from '../test-helpers/call.js';
import { AppError } from '../lib/errors.js';
import { configureNotificationsAccess, getNotificationsAccess, resetNotificationsAccess,
  listNotifications, markNotificationRead } from '../lib/modules/notifications/access.js';
import * as listRoute from '../app/api/notifications/route.js';
import * as readRoute from '../app/api/notifications/[id]/read/route.js';

const actor = { sub: 1, role: 'customer' };
const token = signToken(actor);
function fixture() {
  resetNotificationsAccess(); freshBoot();
  return getDb().prepare(`INSERT INTO notifications(recipient_role,recipient_id,type,title,body)
    VALUES ('customer',1,'audit','Local sentinel','Preserved legacy row')`).run().lastInsertRowid;
}

test('Notifications reader composition', async t => {
  t.after(resetNotificationsAccess);
  await t.test('legacy API/page access preserves local list, owner check and read replay', async () => {
    const id = fixture();
    assert.ok((await listNotifications(actor)).some(row => row.id === id));
    assert.equal((await call(listRoute.GET, { token })).status, 200);
    const first = await call(readRoute.POST, { token, params: { id: String(id) } });
    const again = await call(readRoute.POST, { token, params: { id: String(id) } });
    assert.equal(first.status, 200); assert.equal(again.body.read_at, first.body.read_at);
    assert.equal((await call(readRoute.POST, { token: signToken({sub:2,role:'customer'}), params:{id:String(id)} })).status,403);
  });
  await t.test('incomplete composition does not select remote mode and replacement is rejected', () => {
    fixture();
    assert.throws(() => configureNotificationsAccess({notificationsClient:{listForUser(){}}}),TypeError);
    assert.equal(getNotificationsAccess(),null);
    const config = {notificationsClient:{listForUser(){},markRead(){}},credentials:async()=>({token:'fixture'})};
    const first = configureNotificationsAccess(config);
    assert.throws(() => configureNotificationsAccess(config),/already configured/);
    assert.equal(getNotificationsAccess(),first);
  });
  await t.test('API and page accessor use delegated credentials without SQLite notifications', async () => {
    fixture(); const calls=[];
    const row={id:77,type:'remote',title:'Remote inbox',body:'PG-owned',order_id:null,read_at:null,created_at:'2026-11-08T00:00:00.000Z'};
    configureNotificationsAccess({
      notificationsClient:{listForUser:async creds=>{assert.equal(creds.token,'delegated-fixture');return [row];},markRead:async id=>({...row,id,read_at:'2026-11-08T01:00:00.000Z'})},
      credentials:async(who,ctx)=>{calls.push({who,ctx});return {token:'delegated-fixture'};},
    });
    getDb().exec('DROP TABLE notifications');
    assert.deepEqual(await listNotifications(actor),[row]); // same accessor as Server Component
    assert.equal(calls[0].ctx,undefined);
    const listed=await call(listRoute.GET,{token}); assert.deepEqual(listed.body,[row]);
    assert.ok(calls[1].ctx instanceof Request); assert.deepEqual(calls[1].who,actor);
    const read=await call(readRoute.POST,{token,params:{id:'77'}});
    assert.equal(read.status,200); assert.equal(read.body.id,77); assert.ok(read.body.read_at);
  });
  await t.test('upstream error cannot return local sentinel or mutate its read state',async()=>{
    const id=fixture();
    configureNotificationsAccess({notificationsClient:{listForUser:async()=>{throw new AppError(503,'unavailable');},markRead:async()=>{throw new AppError(503,'unavailable');}},credentials:async()=>({token:'fixture'})});
    assert.equal((await call(listRoute.GET,{token})).status,503);
    assert.equal((await call(readRoute.POST,{token,params:{id:String(id)}})).status,503);
    assert.equal(getDb().prepare('SELECT read_at FROM notifications WHERE id=?').get(id).read_at,null);
  });
  await t.test('invalid actors, missing authentication and malformed IDs never delegate',async()=>{
    fixture();let calls=0;
    configureNotificationsAccess({notificationsClient:{listForUser(){throw Error('unexpected');},markRead(){throw Error('unexpected');}},credentials:async()=>{calls++;return{};}});
    assert.equal((await call(listRoute.GET)).status,401);
    for(const who of [null,{sub:1,role:'root'},{sub:'1',role:'customer'}]) await assert.rejects(listNotifications(who),e=>e.statusCode===401);
    await assert.rejects(markNotificationRead(0,actor),e=>e.statusCode===400);
    assert.equal((await call(readRoute.POST,{token,params:{id:'not-an-id'}})).status,400);
    assert.equal(calls,0);
  });
});
