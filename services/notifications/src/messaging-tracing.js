
import {
  context,
  propagation,
  trace,
  SpanKind,
  SpanStatusCode
} from "@opentelemetry/api";

const tracer = trace.getTracer("homeservice-rabbitmq");

export async function traceMessageProcessing(message, operation) {
  const headers = message.properties.headers ?? {};

  const parentContext = propagation.extract(
    context.active(),
    headers
  );

  return tracer.startActiveSpan(
    "rabbitmq process",
    {
      kind: SpanKind.CONSUMER,
      attributes: {
        "messaging.system": "rabbitmq",
        "messaging.operation.name": "process",
        "messaging.destination.name": "notifications.events",
        "messaging.message.id": message.properties.messageId ?? ""
      }
    },
    parentContext,
    async span => {
      try {
        return await operation();
      } catch (error) {
        span.recordException(error);
        span.setStatus({
          code: SpanStatusCode.ERROR
        });
        throw error;
      } finally {
        span.end();
      }
    }
  );
}
