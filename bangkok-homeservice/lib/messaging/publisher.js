// Area C — RabbitMQ publisher for the monolith broker relay. Confirm channel + `mandatory`: only a
// broker-confirmed, routable message counts as published. (Same protocol as the Payments relay.)
import amqp from "amqplib";
import {SpanKind} from '@opentelemetry/api';
import {traced,currentCarrier} from '../telemetry/context.js';

export const EVENTS_EXCHANGE = "homeservice.events";

export async function createPublisher(amqpUrl, { confirmTimeoutMs = 5000 } = {}) {
  const connection = await amqp.connect(amqpUrl);
  const channel = await connection.createConfirmChannel();
  await channel.assertExchange(EVENTS_EXCHANGE, "topic", { durable: true });
  const returned = new Set();
  let closed = false;
  channel.on("return", (message) => returned.add(message.properties.messageId));
  const markClosed = () => { closed = true; };
  for (const emitter of [connection, channel]) {
    emitter.on("close", markClosed);
    emitter.on("error", markClosed);
  }

  return {
    get closed() { return closed; },
    publish(envelope,carrier={}) {
      if (closed) return Promise.reject(new Error("broker channel closed"));
      return traced('rabbitmq publish',{carrier,kind:SpanKind.PRODUCER,attributes:{'messaging.system':'rabbitmq','messaging.operation.name':'publish','messaging.destination.name':EVENTS_EXCHANGE,'messaging.message.id':envelope.event_id,'messaging.rabbitmq.destination.routing_key':envelope.event_type}},()=>{
      const id = envelope.event_id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("broker confirm timeout")), confirmTimeoutMs);
        try {
          channel.publish(EVENTS_EXCHANGE, envelope.event_type, Buffer.from(JSON.stringify(envelope)), {
            persistent: true, mandatory: true, messageId: id, type: envelope.event_type,
            contentType: "application/json", timestamp: Math.floor(Date.now() / 1000), headers: currentCarrier(),
          }, (error) => {
            clearTimeout(timer);
            if (error) return reject(new Error("broker nacked publish"));
            if (returned.delete(id)) return reject(new Error("unroutable: no queue bound for " + envelope.event_type));
            resolve();
          });
        } catch {
          clearTimeout(timer);
          reject(new Error("broker publish failed"));
        }
      });
      });
    },
    async close() {
      closed = true;
      try { await channel.close(); } catch { /* already closed */ }
      try { await connection.close(); } catch { /* already closed */ }
    },
  };
}
