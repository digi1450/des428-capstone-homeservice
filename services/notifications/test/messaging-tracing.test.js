import {test} from "node:test";
import assert from "node:assert/strict";
import {NodeSDK} from "@opentelemetry/sdk-node";
import {context,trace,ROOT_CONTEXT} from "@opentelemetry/api";
process.env.OTEL_METRICS_EXPORTER="none";
process.env.OTEL_LOGS_EXPORTER="none";
const spans=[];
const sdk=new NodeSDK({autoDetectResources:false,instrumentations:[],spanProcessors:[{
  onStart(){},onEnd(span){spans.push(span);},forceFlush:async()=>{},shutdown:async()=>{},
}]});
await sdk.start();
const traceId="1234567890abcdef1234567890abcdef",parentId="1234567890abcdef";
const {traceMessageProcessing}=await import("../src/messaging-tracing.js");
test("message processing tracing",async t=>{
 t.after(()=>sdk.shutdown());
 const message=headers=>({properties:{headers,messageId:"event-fixture"}});
 await t.test("consumer continues the received producer span",async()=>{
  const headers={traceparent:`00-${traceId}-${parentId}-01`};
  await traceMessageProcessing(message(headers),async()=>assert.equal(trace.getSpan(context.active()).spanContext().traceId,traceId));
  assert.equal(spans.at(-1).parentSpanContext.spanId,parentId);assert.equal(spans.at(-1).spanContext().traceId,traceId);
 });
 await t.test("missing/invalid carrier does not borrow another active message's context",async()=>{
  for(const headers of [{},{traceparent:"invalid"}]){
   await trace.getTracer("test").startActiveSpan("unrelated",{},ROOT_CONTEXT,async span=>{
    await traceMessageProcessing(message(headers),async()=>{});
    const processed=spans.at(-1);assert.notEqual(processed.spanContext().traceId,span.spanContext().traceId);assert.equal(processed.parentSpanContext,undefined);span.end();
   });
  }
 });
 await t.test("processing rejection is retained and recorded as an error",async()=>{
  const failure=new Error("fixture processing failed");
  await assert.rejects(traceMessageProcessing(message({}),async()=>{throw failure;}),error=>error===failure);
  assert.equal(spans.at(-1).status.code,2);assert.equal(spans.at(-1).events[0].name,"exception");
 });
});
