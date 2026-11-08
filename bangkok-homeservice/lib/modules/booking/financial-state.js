// C owns all durable work/transition/recovery. A owns callers/projection validation only.
import {AppError,ConflictError} from '../../errors.js';
let runtime=null;
export function configureBookingFinancialAccess({bookingFinalization}={}){
 if(!bookingFinalization||['complete','cancel','status','assertTransitionAllowed'].some(k=>typeof bookingFinalization[k]!=='function'))throw new TypeError('Complete C Booking finalization interface required');
 if(runtime)throw new Error('Booking financial access already configured');
 runtime=Object.freeze({bookingFinalization});return runtime;
}
export const getBookingFinancialAccess=()=>runtime;
// Tests or drain/shutdown only, never an outage fallback.
export const resetBookingFinancialAccess=()=>{runtime=null;};

// Must run INSIDE the caller's SQLite transaction, before its state/slot mutation.
export function assertFinancialTransition(orderId,operation){
 if(!runtime)return;
 const result=runtime.bookingFinalization.assertTransitionAllowed({orderId,operation});
 if(result&&typeof result.then==='function'){result.catch?.(()=>{});throw new AppError(503,'financial transition guard must be synchronous');}
 if(result!==true)throw new ConflictError('financial transition is pending reconciliation');
}
