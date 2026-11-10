import {AsyncLocalStorage} from 'node:async_hooks';
import {context,propagation,trace,ROOT_CONTEXT,SpanKind,SpanStatusCode} from '@opentelemetry/api';
const local=globalThis[Symbol.for('edemand.telemetry.context')]??=new AsyncLocalStorage();
export function safeCarrier(input={}){
 const out={};
 if(typeof input.traceparent==='string'&&/^00-(?!0{32})[a-f0-9]{32}-(?!0{16})[a-f0-9]{16}-[a-f0-9]{2}$/.test(input.traceparent))out.traceparent=input.traceparent;
 if(out.traceparent&&typeof input.tracestate==='string'&&/^[\x20-\x7e]{1,512}$/.test(input.tracestate))out.tracestate=input.tracestate;
 const id=input['x-request-id'];if(typeof id==='string'&&/^[A-Za-z0-9._:-]{1,128}$/.test(id))out['x-request-id']=id;
 return out;
}
export function currentCarrier(){
 const carrier={};propagation.inject(context.active(),carrier);
 return safeCarrier({...carrier,'x-request-id':local.getStore()?.requestId});
}
export function traceMetadata(){const c=currentCarrier();return {...(c.traceparent?{traceparent:c.traceparent}:{}),...(c.tracestate?{tracestate:c.tracestate}:{}),...(c['x-request-id']?{requestId:c['x-request-id']}: {})};}
export function traceFields(){const c=currentCarrier();return {traceId:c.traceparent?.split('-')[1]??null,requestId:c['x-request-id']??null};}
// No body, URL query, tokens, actor, baggage or exception message enters telemetry.
export function traced(name,{carrier={},kind=SpanKind.INTERNAL,attributes={}}={},operation){
 const clean=safeCarrier(carrier),parent=propagation.extract(ROOT_CONTEXT,clean);
 return trace.getTracer('homeservice-monolith').startActiveSpan(name,{kind,attributes},parent,async span=>{
  return local.run({requestId:clean['x-request-id']},async()=>{
   try{return await operation(span);}catch(error){span.setStatus({code:SpanStatusCode.ERROR});throw error;}finally{span.end();}
  });
 });
}
export function requestSpan(req,id,operation){
 const path=new URL(req.url).pathname.replace(/\/[0-9]+(?=\/|$)/g,'/:id').replace(/\/[a-f0-9-]{36}(?=\/|$)/g,'/:id');
 const carrier=safeCarrier({traceparent:req.headers.get('traceparent'),tracestate:req.headers.get('tracestate'),'x-request-id':id});
 return traced(req.method+' '+path,{carrier,kind:SpanKind.SERVER,attributes:{'http.request.method':req.method,'http.route':path}},operation);
}
