import test from "node:test";
import assert from "node:assert/strict";
import {freshBoot,getDb} from "../test-helpers/boot.js";
import {getIntentForOrder} from "../lib/modules/payments/service.js";
import {findIntentByOrderId} from "../lib/modules/payments/repository.js";
test("inherited intent read rejects nonparticipants at service boundary",()=>{
 freshBoot();
 const db=getDb();
 const customer=db.prepare("SELECT id FROM customers ORDER BY id LIMIT 1").get().id;
 const provider=db.prepare("SELECT id FROM providers ORDER BY id LIMIT 1").get().id;
 const orderId=Number(db.prepare("INSERT INTO orders(customer_id,provider_id,service_date,starting_time,ending_time,duration_min,subtotal_cents,tax_cents,total_cents,commission_pct,payment_method,otp) VALUES (?,?,'2026-12-01','10:00','10:30',30,100,7,107,10,'gateway',1234)").run(customer,provider).lastInsertRowid);
 db.prepare("INSERT INTO payment_intents(order_id,amount_cents,gateway_ref) VALUES (?,107,'BOLA-TEST-REF')").run(orderId);
 assert.equal(findIntentByOrderId(orderId).gateway_ref,"BOLA-TEST-REF");
 // This unscoped lookup demonstrates the inherited missing authorization guard;
 // it does not establish that the public HTTP route was exploitable.
 assert.equal(getIntentForOrder(orderId,{role:"customer",sub:customer}).gateway_ref,"BOLA-TEST-REF");
 assert.equal(getIntentForOrder(orderId,{role:"provider",sub:provider}).gateway_ref,"BOLA-TEST-REF");
 for(const actor of [undefined,{role:"customer",sub:customer+999},{role:"provider",sub:provider+999},{role:"admin",sub:customer}]) assert.throws(()=>getIntentForOrder(orderId,actor),e=>e.status===403||e.statusCode===403);
});
