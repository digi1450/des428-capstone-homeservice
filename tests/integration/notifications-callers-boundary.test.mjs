import { freshBoot, getDb } from '../../bangkok-homeservice/test-helpers/boot.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { signToken } from '../../bangkok-homeservice/lib/http/auth.js';
import { call } from '../../bangkok-homeservice/test-helpers/call.js';
import { createNotificationsClient } from '../../bangkok-homeservice/lib/modules/notifications/client.js';
import { configureNotificationsAccess, resetNotificationsAccess, listNotifications } from '../../bangkok-homeservice/lib/modules/notifications/access.js';
import * as listRoute from '../../bangkok-homeservice/app/api/notifications/route.js';
import * as readRoute from '../../bangkok-homeservice/app/api/notifications/[id]/read/route.js';
import { createDatabase } from '../../services/notifications/src/database.js';
import { migrate } from '../../services/notifications/src/migrations.js';
import { createNotificationsService } from '../../services/notifications/src/service.js';
import { createApp } from '../../services/notifications/src/app.js';
import { HttpError } from '../../services/notifications/src/errors.js';

test('Next notification callers -> client -> Express -> owning PostgreSQL', {skip:!process.env.TEST_NOTIFICATIONS_DATABASE_URL}, async t=>{
  freshBoot();resetNotificationsAccess();
  const db=createDatabase(process.env.TEST_NOTIFICATIONS_DATABASE_URL);
  const id=randomInt(700000000,800000000);
  const customer={sub:id,role:'customer'},provider={sub:id,role:'provider'};
  const tokens=new Map([['customer-fixture',{role:'customer',domainId:id}],['provider-fixture',{role:'provider',domainId:id}],['other-fixture',{role:'customer',domainId:id+1}]]);
  let server,baseUrl,available=true,credentialMode='normal';
  const observed=[];
  try {
    await migrate(db);
    const business=createNotificationsService(db);
    const note=await business.record({recipientRole:'customer',recipientId:id,type:'booking_status',title:'Remote-only notification',body:'HTTP/PG boundary fixture',orderId:null});
    const providerNote=await business.record({recipientRole:'provider',recipientId:id,type:'provider_approved',title:'Provider inbox',body:'Same integer, different role',orderId:null});
    server=createApp({database:db,authenticate:async req=>{
      if(!available) throw new HttpError(503,'fixture unavailable');
      observed.push(req.get('x-request-id'));
      const actor=tokens.get(req.get('authorization')?.replace(/^Bearer /,''));
      if(!actor)throw new HttpError(401,'invalid fixture credential');
      return actor; // Explicit auth double; NOT Keycloak/JWT verification.
    }}).listen(0,'127.0.0.1');
    await new Promise(resolve=>server.once('listening',resolve));
    baseUrl=`http://127.0.0.1:${server.address().port}`;
    configureNotificationsAccess({notificationsClient:createNotificationsClient({baseUrl}),credentials:async(auth,req)=>({
      token:credentialMode==='invalid'?'invalid-fixture':auth.role==='provider'?'provider-fixture':auth.sub===id?'customer-fixture':'other-fixture',
      ...(req?{requestId:req.headers.get('x-request-id')||'notification-fixture'}:{}),
    })});
    getDb().exec('DROP TABLE notifications'); // Both API and page-accessor must be remote.
    await t.test('API and Server Component accessor read real remote rows with original IDs',async()=>{
      const result=await call(listRoute.GET,{token:signToken(customer),headers:{'X-Request-Id':'notification-boundary'}});
      assert.equal(result.status,200);assert.deepEqual(result.body.map(n=>n.id),[note.id]);assert.ok(observed.includes('notification-boundary'));
      const pageRows=await listNotifications(customer);assert.deepEqual(pageRows,result.body);
      assert.deepEqual((await listNotifications(provider)).map(n=>n.id),[providerNote.id]);
    });
    await t.test('mark-read persists once; another role or same-role different owner cannot mark it',async()=>{
      const read=()=>call(readRoute.POST,{token:signToken(customer),params:{id:String(note.id)}});
      const first=await read(),second=await read();
      assert.equal(first.status,200);assert.ok(first.body.read_at);assert.equal(second.body.read_at,first.body.read_at);
      for(const auth of [provider,{sub:id+1,role:'customer'}]) {
        assert.equal((await call(readRoute.POST,{token:signToken(auth),params:{id:String(note.id)}})).status,403);
      }
      assert.equal((await db.query('SELECT read_at FROM notifications WHERE id=$1',[note.id])).rows[0].read_at.toISOString(),first.body.read_at);
      assert.equal((await db.query('SELECT read_at FROM notifications WHERE id=$1',[providerNote.id])).rows[0].read_at,null);
    });
    await t.test('missing IDs and rejected delegated credentials preserve 404/401',async()=>{
      assert.equal((await call(readRoute.POST,{token:signToken(customer),params:{id:'2147483647'}})).status,404);
      credentialMode='invalid';
      assert.equal((await call(listRoute.GET,{token:signToken(customer)})).status,401);
      credentialMode='normal';
    });
    await t.test('remote failure stays unavailable, never an empty or local inbox',async()=>{
      available=false;
      assert.equal((await call(listRoute.GET,{token:signToken(customer)})).status,503);
      assert.equal((await call(readRoute.POST,{token:signToken(customer),params:{id:String(note.id)}})).status,503);
      await assert.rejects(listNotifications(customer),e=>e.statusCode===503);
    });
  } finally {
    resetNotificationsAccess();
    if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    try {await db.query('DELETE FROM notifications WHERE recipient_id=$1',[id]);} finally {await db.close();}
  }
});
