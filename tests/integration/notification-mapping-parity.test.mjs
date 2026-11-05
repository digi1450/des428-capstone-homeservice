import { test } from "node:test";
import assert from "node:assert/strict";

// Opt-in Docker harness: run in the monolith test image with its native SQLite
// dependency; mount the pure Notifications module via NOTIFICATION_MAPPER_MODULE.
// No production file, persistent SQLite DB, broker or service runtime is changed.
test("notification projections match the inherited relay and direct approval writer",{skip:!process.env.NOTIFICATION_MAPPER_MODULE},async t=>{
  const {freshBoot,getDb,closeDb}=await import("/app/test-helpers/boot.js");
  const {runRelayOnce}=await import("/app/lib/modules/notifications/relay.js");
  const {insertEvent}=await import("/app/lib/db/events.js");
  const {approveProvider}=await import("/app/lib/modules/providers/service.js");
  const {mapNotificationEvent}=await import(process.env.NOTIFICATION_MAPPER_MODULE);
  const stored=()=>getDb().prepare("SELECT recipient_role,recipient_id,type,title,body,order_id FROM notifications ORDER BY id").all().map(row=>({recipientRole:row.recipient_role,recipientId:row.recipient_id,type:row.type,title:row.title,body:row.body,orderId:row.order_id}));
  const cases=[
    ["review.created",{order_id:42,service_id:1,provider_id:1,rating:5}],
    ["booking.status_changed",{order_id:42,customer_id:1,provider_id:1,to:"confirmed",actor_role:"provider"}],
    ["booking.status_changed",{order_id:42,customer_id:1,provider_id:1,to:"awaiting",actor_role:"customer"}],
    ["booking.completed",{order_id:42,customer_id:1}],
    ["bid.accepted",{order_id:42,job_request_id:9,winner_provider_id:1,loser_provider_ids:[2,3]}],
    ["payment.succeeded",{order_id:42,provider_id:1,amount_cents:150000}],
    ["payment.succeeded",{order_id:42,provider_id:null,amount_cents:150000}],
  ];
  try{
    for(const [type,data] of cases)await t.test(type+(data.provider_id===null?" (no recipient)":""),()=>{
      freshBoot();const write=getDb().transaction(()=>insertEvent(type,"order",42,data));write();
      assert.equal(runRelayOnce(),1);assert.deepEqual(mapNotificationEvent(type,data),stored());
    });
    await t.test("proposed approval event matches current direct approval message",()=>{
      freshBoot();const pending=getDb().prepare("SELECT provider_id FROM provider_profiles WHERE is_approved=0 ORDER BY provider_id LIMIT 1").get();
      assert.ok(pending);approveProvider(pending.provider_id);
      assert.deepEqual(mapNotificationEvent("provider.approved",{provider_id:pending.provider_id}),stored());
    });
  }finally{closeDb();}
});
