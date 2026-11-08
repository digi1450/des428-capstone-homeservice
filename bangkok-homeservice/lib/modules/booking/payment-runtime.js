// Explicit composition only; startup must supply B-verified service/user credentials.
// No environment switch, token stub or legacy-data activation is installed here.
import {createBookingPaymentsAdapter} from './payment-adapter.js';
import {configureBookingSaga,getBookingSaga,resetBookingSaga,paymentSetupFor,recoverOnce} from './saga.js';
import {configurePaymentsAccess,getPaymentsAccess,resetPaymentsAccess} from '../payments/access.js';
import {logger} from '../../logger.js';
const methods=['createIntent','getOperation','cancelIntent','activateIntent','getIntentForOrder','simulateSucceeded','getWallet','listCustomerTransactions'];
const optionNames=new Set(['maxCreateAttempts','maxCancelAttempts','activateEscalateAfter','baseBackoffMs','maxBackoffMs','leaseMs','retryAfterSeconds']);
export function configureBookingPaymentsRuntime({paymentsClient,serviceCredentials,userCredentials,sagaOptions={},recoveryIntervalMs=2000}={}){
  if(!paymentsClient || methods.some(name=>typeof paymentsClient[name]!=='function')) throw new TypeError('Booking runtime requires the complete Payments client');
  if(typeof serviceCredentials!=='function' || typeof userCredentials!=='function') throw new TypeError('Booking runtime requires separate service and verified end-user credential providers');
  if(!Number.isInteger(recoveryIntervalMs)||recoveryIntervalMs<1||recoveryIntervalMs>60000) throw new TypeError('Invalid recovery interval');
  if(!sagaOptions || Object.getPrototypeOf(sagaOptions)!==Object.prototype || Object.entries(sagaOptions).some(([key,value])=>!optionNames.has(key)||!Number.isSafeInteger(value)||value<1)) throw new TypeError('Invalid saga options');
  if((sagaOptions.maxBackoffMs??30000)<(sagaOptions.baseBackoffMs??1000)) throw new TypeError('Invalid saga backoff range');
  if(getBookingSaga() || getPaymentsAccess()) throw new Error('Booking Payments is already configured; stop and drain the current runtime first');
  const payments=createBookingPaymentsAdapter({paymentsClient});
  const saga=configureBookingSaga({...sagaOptions,payments,credentials:serviceCredentials});
  let access;
  try{access=configurePaymentsAccess({paymentsClient,credentials:userCredentials,readSetup:paymentSetupFor});}
  catch(error){resetBookingSaga();throw error;}
  let closed=false,started=false,timer=null,inFlight=null;
  const owns=()=>getBookingSaga()===saga && getPaymentsAccess()===access;
  const schedule=()=>{timer=setTimeout(tick,recoveryIntervalMs);timer.unref?.();};
  async function tick(){
    timer=null;
    if(closed||!owns()) return;
    // C owns the durable state machine/backoff. This scheduler never overlaps its own rounds.
    inFlight=Promise.resolve().then(()=>recoverOnce()).catch(error=>{
      logger.error({kind:String(error?.name??'error').slice(0,80)},'Booking recovery round failed');
    });
    try{await inFlight;}finally{inFlight=null;if(!closed&&owns())schedule();}
  }
  return {
    saga,access,payments,
    startRecovery(){
      if(closed||!owns())throw new Error('Booking Payments runtime is not active');
      if(started)return;
      started=true;schedule();
    },
    async stop(){
      closed=true;if(timer){clearTimeout(timer);timer=null;}
      // Callers must first drain HTTP; await this scheduler before clearing C's global runtime.
      if(inFlight)await inFlight;
      if(getBookingSaga()===saga)resetBookingSaga();
      if(getPaymentsAccess()===access)resetPaymentsAccess();
    },
  };
}
