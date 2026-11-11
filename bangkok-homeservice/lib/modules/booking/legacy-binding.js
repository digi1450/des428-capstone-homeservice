// Only the offline CLI writes bindings. A bound checkpoint alone is NOT readiness.
import {getDb} from '../../db/index.js';
export function legacyBookingReference(orderId){
 const db=getDb();
 const row=db.prepare(`SELECT b.*,c.bindings_json,c.state FROM booking_legacy_payment_bindings b
 JOIN booking_legacy_payment_checkpoints c ON c.manifest_sha256=b.manifest_sha256 WHERE b.order_id=?`).get(orderId);
 if(!row||row.state!=='approved')return null;
 if(db.prepare('SELECT 1 FROM booking_sagas WHERE order_id=?').get(orderId))return null;
 const order=db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
 let entry;try{entry=JSON.parse(row.bindings_json).find(x=>x.order_id===orderId);}catch{return null;}
 if(!order||!entry||order.payment_method!=='gateway'||order.customer_id!==entry.customer_id||order.provider_id!==entry.provider_id||order.total_cents!==entry.amount_cents||entry.currency!=='THB'||row.binding_id!==`legacy:${row.manifest_sha256}:${orderId}`)return null;
 return {binding_id:row.binding_id,manifest_sha256:row.manifest_sha256};
}
