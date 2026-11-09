// Synthetic in-memory business fixture, shared by the relay handover tests only.
import { getDb } from '../lib/db/index.js';
import { createReview } from '../lib/modules/reviews/service.js';
export function reviewedBooking(rating=5) {
 const db=getDb(),service=db.prepare('SELECT id,provider_id FROM services ORDER BY id LIMIT 1').get();
 const customerId=db.prepare('SELECT id FROM customers ORDER BY id LIMIT 1').get().id;
 const orderId=db.prepare(`INSERT INTO orders(customer_id,provider_id,service_date,starting_time,ending_time,duration_min,subtotal_cents,tax_cents,total_cents,commission_pct,payment_method,otp,status)
 VALUES (?,?,'2026-12-01','10:00','10:30',30,100,7,107,10,'cod',123456,'completed')`).run(customerId,service.provider_id).lastInsertRowid;
 db.prepare(`INSERT INTO order_items(order_id,service_id,service_title,unit_price_cents,tax_percent,tax_cents,quantity,subtotal_cents)
 VALUES (?,?,'Fixture service',100,7,7,1,100)`).run(orderId,service.id);
 const review=createReview(orderId,customerId,{rating,comment:'Fixture review'});
 return {orderId,reviewId:review.id,serviceId:service.id,providerId:service.provider_id,customerId};
}
