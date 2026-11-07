// Own Booking data is authorized locally; intent/simulation ownership is verified again in Payments.
import * as booking from './service.js';
import * as repository from './repository.js';
import {getPaymentsAccess} from '../payments/access.js';
import {simulateSucceeded} from '../payments/gateway.js';
import {AppError,ForbiddenError,ConflictError} from '../../errors.js';
export function usesRemotePayments(orderId) {
  return !!getPaymentsAccess() || !!repository.findSagaByOrderId(orderId);
}
async function setup(orderId,access) {
  if(!access?.readSetup) return 'pending';
  try {return (await access.readSetup(orderId))==='ready'?'ready':'pending';} catch {return 'pending';}
}
export async function getBookingView(orderId,auth,context) {
  const remote=usesRemotePayments(orderId);
  const out=booking.getBooking(orderId,auth,{includeLocalPayment:!remote});
  if(!remote || out.payment_method!=='gateway') return out;
  out.payment_setup='pending';
  const access=getPaymentsAccess();
  if(!access) return out;
  try {
    const intent=await access.paymentsClient.getIntentForOrder(orderId,await access.credentials(auth,context));
    if(intent.order_id!==out.id || intent.amount_cents!==out.total_cents) throw new AppError(503,'payment context not confirmed');
    out.payment_intent=intent;
    if(intent.status!=='failed' && out.status!=='cancelled') out.payment_setup=await setup(orderId,access);
  } catch(error) {
    if(![404,503].includes(error.statusCode)) throw error;
    // Booking remains visible during provisioning/outage; no stale local intent or false readiness.
  }
  return out;
}
export async function simulateBookingPayment(orderId,auth,context) {
  if(auth.role!=='customer') throw new ForbiddenError('customer required');
  const remote=usesRemotePayments(orderId);
  const order=booking.getBooking(orderId,auth,{includeLocalPayment:!remote});
  if(order.status==='cancelled') throw new ConflictError('cancelled booking cannot be paid');
  if(!remote) return simulateSucceeded(orderId,auth.sub);
  if(order.payment_method!=='gateway') throw new ConflictError('booking has no online payment');
  const access=getPaymentsAccess();
  if(!access || await setup(orderId,access)!=='ready') throw new AppError(503,'payment setup is still pending');
  // Payments enforces its transactional eligibility/fence even if local readiness is stale.
  return access.paymentsClient.simulateSucceeded(orderId,await access.credentials(auth,context));
}
