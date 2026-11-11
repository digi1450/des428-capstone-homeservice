// Offline-imported ownership only. Approval is configured by the deployment
// checkpoint, never learned from HTTP data. Caller holds the per-order lock.
export function legacyApproval(value) {
 if(value!==undefined&&(typeof value!=='string'||! /^[0-9a-f]{64}$/.test(value)))throw new TypeError('Invalid approved legacy manifest');
 return value;
}
export async function legacyBindingProblem(tx,intent,request,approvedManifest) {
 if(!approvedManifest)return 'legacy_reconciliation_required';
 const binding=(await tx.query('SELECT * FROM legacy_payment_bindings WHERE order_id=$1',[request.order_id])).rows[0];
 if(!binding||!intent)return 'legacy_reconciliation_required';
 const ref=request.legacy_binding;
 if(binding.manifest_sha256!==approvedManifest||binding.binding_id!==`legacy:${approvedManifest}:${request.order_id}`
   ||(ref&&(ref.manifest_sha256!==binding.manifest_sha256||ref.binding_id!==binding.binding_id))
   ||binding.intent_id!==intent.id||!['order_id','customer_id','provider_id','amount_cents','currency'].every(k=>binding[k]===request[k]&&intent[k]===request[k]))return 'context_mismatch';
 if((await tx.query('SELECT 1 FROM payment_provisioning WHERE order_id=$1',[request.order_id])).rowCount)return 'context_mismatch';
 return null;
}
