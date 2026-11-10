
import {
  context,
  ROOT_CONTEXT,
  propagation,
  trace,
  SpanKind,
  SpanStatusCode
} from "@opentelemetry/api";

const tracer = trace.getTracer("homeservice-rabbitmq");

export async function traceMessagePublishing(row, publish) {
  // The relay runs after the originating request, often in another process. Restore
  // the durable carrier before creating this publish span; never replace its trace with
  // an unrelated background/ambient context. Copy the carrier so retry state is immutable.
  const parent = propagation.extract(ROOT_CONTEXT, row.headers ?? {});
  return tracer.startActiveSpan(
    "rabbitmq publish",
    {
      kind: SpanKind.PRODUCER,
      attributes: {
        "messaging.system": "rabbitmq",
        "messaging.operation.name": "publish",
        "messaging.destination.name": "homeservice.events",
        "messaging.message.id": row.event_id,
        "messaging.rabbitmq.destination.routing_key": row.event_type
      }
    },
    parent,
    async span => {
      try {
        const headers = { ...(row.headers ?? {}) };

        propagation.inject(context.active(), headers);

        return await publish({
          ...row,
          headers
        });
      } catch (error) {
        span.recordException(error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    }
  );
}

export async function traceWalletProcessing(message,operation){
 const parent=propagation.extract(ROOT_CONTEXT,message.properties.headers??{});
 return tracer.startActiveSpan('rabbitmq process',{kind:SpanKind.CONSUMER,attributes:{'messaging.system':'rabbitmq','messaging.operation.name':'process','messaging.destination.name':'payments.events','messaging.message.id':message.properties.messageId??''}},parent,async span=>{
  try{return await operation();}catch(error){span.setStatus({code:SpanStatusCode.ERROR});throw error;}finally{span.end();}
 });
}
