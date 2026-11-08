
import {
  context,
  propagation,
  trace,
  SpanKind,
  SpanStatusCode
} from "@opentelemetry/api";

const tracer = trace.getTracer("homeservice-rabbitmq");

export async function traceMessagePublishing(row, publish) {
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
