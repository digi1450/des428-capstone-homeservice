import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import { mapNotificationEvent } from "../../services/notifications/src/event-mappings.js";
const schema=JSON.parse(await readFile(new URL("../notification-projections.schema.json",import.meta.url),"utf8"));
const fixtures=JSON.parse(await readFile(new URL("../fixtures/notification-projections.json",import.meta.url),"utf8"));
const validate=new Ajv2020({strict:true}).compile(schema);
test("all projection fixtures validate and produce the declared recipient counts",()=>{
  for(const fixture of fixtures){assert.ok(validate(fixture.input),JSON.stringify(validate.errors));assert.equal(mapNotificationEvent(fixture.input.event_type,fixture.input.data).length,fixture.expected_count);}
});
test("schema rejects malformed used fields and unknown event names",()=>{
  for(const input of [{event_type:"unknown",data:{}},{event_type:"review.created",data:{order_id:42,provider_id:3,rating:0}},{event_type:"payment.succeeded",data:{order_id:42,amount_cents:100}},{event_type:"bid.accepted",data:{order_id:42,job_request_id:9,winner_provider_id:3,loser_provider_ids:[4,4]}}])assert.equal(validate(input),false);
});
test("unused source data is tolerated but not copied into notification commands",()=>{
  const input={event_type:"review.created",data:{order_id:42,provider_id:3,rating:5,source_extra:"not persisted"}};
  assert.ok(validate(input));assert.ok(!JSON.stringify(mapNotificationEvent(input.event_type,input.data)).includes("not persisted"));
});
