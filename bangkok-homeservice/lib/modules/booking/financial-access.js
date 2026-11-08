import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import * as booking from './service.js';
import {getBookingFinancialAccess} from './financial-state.js';
import {usesRemotePayments} from '../payments/ownership.js';
import {completedProjection,cancelledProjection} from '../payments/financial-validation.js';
import {AppError,NotFoundError,ForbiddenError,ConflictError} from '../../errors.js';
export {configureBookingFinancialAccess,getBookingFinancialAccess,resetBookingFinancialAccess} from './financial-state.js';
function owned(orderId,auth){
 const row=booking.orderById(orderId);if(!row)throw new NotFoundError('booking not found');
 if((auth.role==='customer'?row.customer_id:auth.role==='provider'?row.provider_id:null)!==auth.sub)throw new ForbiddenError('not your booking');
 return row;
}
function matchesPersisted(orderId,value){
 const row=booking.orderById(orderId);if(!row||!isDeepStrictEqual(booking.toPublicOrder(row),Object.fromEntries(Object.entries(value).filter(([k])=>k!=='accounting_status'))))throw new AppError(503,'Booking finalization not confirmed');
}
export async function completeBookingFinancial(orderId,auth,otp,context){
 if(auth.role!=='provider')throw new ForbiddenError('provider required');
 const row=owned(orderId,auth);
 if(!Number.isInteger(otp)||row.otp!==otp)throw new ConflictError('incorrect OTP');
 const runtime=getBookingFinancialAccess();
 if(!runtime){if(usesRemotePayments(orderId))throw new AppError(503,'Booking finalization unavailable');return booking.completeBooking(orderId,auth.sub,otp);}
 const value=completedProjection.safeParse(await runtime.bookingFinalization.complete({orderId,providerId:auth.sub,otp,context}));
 if(!value.success)throw new AppError(503,'Booking completion result not confirmed');
 matchesPersisted(orderId,value.data);return value.data;
}
export async function cancelBookingFinancial(orderId,auth,context){
 if(auth.role!=='customer')throw new ForbiddenError('customer required');owned(orderId,auth);
 const runtime=getBookingFinancialAccess();
 if(!runtime){if(usesRemotePayments(orderId))throw new AppError(503,'Booking finalization unavailable');return booking.cancelBooking(orderId,auth.sub);}
 const value=cancelledProjection.safeParse(await runtime.bookingFinalization.cancel({orderId,customerId:auth.sub,context}));
 if(!value.success)throw new AppError(503,'Booking cancellation result not confirmed');
 matchesPersisted(orderId,value.data.order);return value.data;
}
const status=z.object({accounting_status:z.enum(['pending','ready','attention']).optional(),cancellation_status:z.enum(['pending','ready','attention']).optional()}).strict();
export async function financialStatus(orderId,auth,context){
 const runtime=getBookingFinancialAccess();if(!runtime)return {};
 const row=owned(orderId,auth);
 try{
  const parsed=status.safeParse((await runtime.bookingFinalization.status({orderId,context}))??{});
  if(!parsed.success)throw Error('status');
  const value=parsed.data;
  if(value.accounting_status&&row.status!=='completed')throw Error('accounting');
  if(value.cancellation_status==='ready'&&row.status!=='cancelled')throw Error('cancellation');
  if(['pending','attention'].includes(value.cancellation_status)&&!['awaiting','confirmed'].includes(row.status))throw Error('pending cancellation');
  if(row.status==='completed'&&!value.accounting_status)value.accounting_status='pending';
  return value;
 }catch{return row.status==='completed'?{accounting_status:'pending'}:row.status==='cancelled'?{}:{cancellation_status:'pending'};}
}
