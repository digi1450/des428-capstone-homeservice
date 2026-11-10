import {processState} from '../../runtime/process-state.js';
// C owns all durable work/transition/recovery. A owns callers/projection validation only.
import {AppError,ConflictError} from '../../errors.js';
const selection=processState('modules/booking/financial-state.js');
export function configureBookingFinancialAccess({bookingFinalization}={}){
 if(!bookingFinalization||['complete','cancel','status','assertTransitionAllowed'].some(k=>typeof bookingFinalization[k]!=='function'))throw new TypeError('Complete C Booking finalization interface required');
 if(selection.value)throw new Error('Booking financial access already configured');
 selection.value=Object.freeze({bookingFinalization});return selection.value;
}
export const getBookingFinancialAccess=()=>selection.value;
// Tests or drain/shutdown only, never an outage fallback.
export const resetBookingFinancialAccess=()=>{selection.value=null;};

// Must run INSIDE the caller's SQLite transaction, before its state/slot mutation.
export function assertFinancialTransition(orderId,operation){
 if(!selection.value)return;
 const result=selection.value.bookingFinalization.assertTransitionAllowed({orderId,operation});
 if(result&&typeof result.then==='function'){result.catch?.(()=>{});throw new AppError(503,'financial transition guard must be synchronous');}
 if(result!==true)throw new ConflictError('financial transition is pending reconciliation');
}
