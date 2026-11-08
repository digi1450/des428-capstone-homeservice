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
const {traceMessagePublishing}=await import("../src/messaging-tracing.js");
test("outbox publish tracing preserves durable context",async t=>{
 t.after(()=>sdk.shutdown());
 const row=()=>({event_id:"event-fixture",event_type:"payment.succeeded",headers:{traceparent:`00-${traceId}-${parentId}-01`,tracestate:"vendor=fixture","x-request-id":"request-fixture"}});
 await t.test("background publish continues the stored trace, preserving its carrier",async()=>{
  const input=row(),original={...input.headers};let output;
  await traceMessagePublishing(input,async value=>{output=value;assert.equal(trace.getSpan(context.active()).spanContext().traceId,traceId);});
  const span=spans.at(-1);
  assert.equal(span.spanContext().traceId,traceId);assert.equal(span.parentSpanContext.spanId,parentId);
  assert.equal(output.headers.traceparent.split("-")[2],span.spanContext().spanId);
  assert.equal(output.headers.tracestate,"vendor=fixture");assert.equal(output.headers["x-request-id"],"request-fixture");assert.deepEqual(input.headers,original);
 });
 await t.test("a retry retains trace and event identity but creates a new publish span",async()=>{
  const input=row(),carriers=[];
  for(let i=0;i<2;i++)await traceMessagePublishing(input,async value=>{assert.equal(value.event_id,input.event_id);carriers.push(value.headers.traceparent);});
  assert.equal(carriers[0].split("-")[1],traceId);assert.equal(carriers[1].split("-")[1],traceId);assert.notEqual(carriers[0],carriers[1]);
 });
 await t.test("missing carrier starts a root instead of inheriting an unrelated relay context",async()=>{
  let ambient;
  await trace.getTracer("test").startActiveSpan("unrelated",{},ROOT_CONTEXT,async span=>{
   ambient=span.spanContext().traceId;
   await traceMessagePublishing({...row(),headers:{}},async()=>{});
   const published=spans.at(-1);assert.equal(published.name,"rabbitmq publish");assert.notEqual(published.spanContext().traceId,ambient);assert.equal(published.parentSpanContext,undefined);span.end();
  });
 });
 await t.test("publish rejection is retained and marks the span as failed",async()=>{
  const failure=new Error("fixture publish failed");
  await assert.rejects(traceMessagePublishing(row(),async()=>{throw failure;}),error=>error===failure);
  assert.equal(spans.at(-1).status.code,2);assert.equal(spans.at(-1).events[0].name,"exception");
 });
});
