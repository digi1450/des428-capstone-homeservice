// Request-local, allow-listed metadata only. No token, body or actor object is retained.
import {AsyncLocalStorage} from 'node:async_hooks';
import {context,propagation} from '@opentelemetry/api';
const requests=new AsyncLocalStorage();
export function paymentRequestContext(req,_res,next){
  return requests.run({requestId:req.requestId},next);
}
export function paymentEventContext(){
  const carrier={};
  propagation.inject(context.active(),carrier);
  const requestId=requests.getStore()?.requestId;
  return {requestId,correlationId:requestId,traceparent:carrier.traceparent,tracestate:carrier.tracestate};
}
