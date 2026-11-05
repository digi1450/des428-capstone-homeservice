import { test } from "node:test";
import assert from "node:assert/strict";
import { mapNotificationEvent } from "../src/event-mappings.js";
import { createNotificationEventWriter } from "../src/event-writer.js";
const command=(recipientRole,recipientId,type,title,body,orderId=null)=>({recipientRole,recipientId,type,title,body,orderId});

test("review maps to provider text without carrying rating/owner/private context into storage",()=>{
  const input={provider_id:3,order_id:42,rating:5,service_id:1,otp:1234,token:"test-private"},before=structuredClone(input);
  assert.deepEqual(mapNotificationEvent("review.created",input),[command("provider",3,"new_review","New review","You received a 5-star review on booking #42.",42)]);
  assert.deepEqual(input,before);
});
test("booking transitions notify the counterparty and preserve all public statuses",()=>{
  for(const status of ["awaiting","confirmed","started","completed","cancelled","rescheduled"])for(const actor of ["provider","customer","admin"]){
    const customer=actor==="provider";
    assert.deepEqual(mapNotificationEvent("booking.status_changed",{order_id:42,customer_id:7,provider_id:3,to:status,actor_role:actor}),[command(customer?"customer":"provider",customer?7:3,"booking_status",`Booking ${status}`,`Booking #42 is now ${status}.`,42)]);
  }
});
test("completion asks customer for a review",()=>{
  assert.deepEqual(mapNotificationEvent("booking.completed",{order_id:42,customer_id:7}),[command("customer",7,"rating_request","How did it go?","Booking #42 is complete — leave a review for your provider.",42)]);
});
test("accepted bids map winner first and every loser, with null order for rejections",()=>{
  assert.deepEqual(mapNotificationEvent("bid.accepted",{order_id:42,job_request_id:9,winner_provider_id:3,loser_provider_ids:[4,5]}),[
    command("provider",3,"bid_accepted","Your bid was accepted","Your bid on job #9 was accepted — booking #42 created.",42),
    command("provider",4,"bid_rejected","Bid not selected","Your bid on job #9 was not selected."),
    command("provider",5,"bid_rejected","Bid not selected","Your bid on job #9 was not selected."),
  ]);
  for(const losers of [undefined,null,[]])assert.equal(mapNotificationEvent("bid.accepted",{order_id:42,job_request_id:9,winner_provider_id:3,loser_provider_ids:losers}).length,1);
});
test("payment maps cents verbatim; explicit null provider is a recognized no-recipient event",()=>{
  assert.deepEqual(mapNotificationEvent("payment.succeeded",{order_id:42,provider_id:3,amount_cents:150000}),[command("provider",3,"payment_received","Payment received","Payment of 150000 cents was received for booking #42.",42)]);
  assert.deepEqual(mapNotificationEvent("payment.succeeded",{order_id:42,provider_id:null,amount_cents:150000}),[]);
});
test("proposed approval event preserves the inherited direct notification",()=>{
  assert.deepEqual(mapNotificationEvent("provider.approved",{provider_id:3}),[command("provider",3,"provider_approved","You're approved","Your provider account has been approved. Your services are now visible to customers.")]);
});
test("unsupported events and malformed used fields fail rather than silently acknowledge",()=>{
  const cases=[
    ["unknown",{}],["booking.completed",null],["booking.completed",[]],["booking.completed",{order_id:42,customer_id:"7"}],
    ["review.created",{order_id:42,provider_id:3,rating:6}],["review.created",{order_id:42,provider_id:3,rating:1.5}],
    ["booking.status_changed",{order_id:42,customer_id:7,provider_id:3,to:"provisioning",actor_role:"customer"}],
    ["booking.status_changed",{order_id:42,customer_id:7,provider_id:3,to:"awaiting",actor_role:"untrusted"}],
    ["payment.succeeded",{order_id:42,amount_cents:100}],["payment.succeeded",{order_id:42,provider_id:3,amount_cents:-1}],
    ["provider.approved",{provider_id:0}],["provider.approved",{provider_id:2147483648}],
  ];
  for(const [type,data] of cases)assert.throws(()=>mapNotificationEvent(type,data),error=>error.statusCode===400);
});
test("invalid/duplicate/self-losing bid recipient sets are rejected before ANY SQL",async()=>{
  const writer=createNotificationEventWriter({withTransaction:()=>assert.fail("must validate before SQL")});
  for(const losers of [[4,"5"],[4,4],[3],"4"])await assert.rejects(writer.recordEvent("bid.accepted",{order_id:42,job_request_id:9,winner_provider_id:3,loser_provider_ids:losers}),error=>error.statusCode===400);
});
test("recognized payment no-recipient mapping performs no SQL",async()=>{
  const writer=createNotificationEventWriter({withTransaction:()=>assert.fail("must not allocate empty transaction")});
  assert.deepEqual(await writer.recordEvent("payment.succeeded",{order_id:42,provider_id:null,amount_cents:0}),[]);
});
