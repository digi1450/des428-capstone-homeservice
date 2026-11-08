
// Area C — RabbitMQ publisher for the outbox relay (Week 9).
// Uses a confirm channel (broker acknowledges it has the message) and `mandatory`
// (an unroutable message is returned instead of silently dropped).
import amqp from "amqplib";
import { EVENTS_EXCHANGE, assertProducerTopology } from "./topology.js";
import { traceMessagePublishing } from "../messaging-tracing.js";

export async function createPublisher(amqpUrl, { confirmTimeoutMs = 5000 } = {}) {
  const connection = await amqp.connect(amqpUrl);
  const channel = await connection.createConfirmChannel();
  await assertProducerTopology(channel);

  const returned = new Set();
  let closed = false;

  channel.on("return", message => returned.add(message.properties.messageId));

  const markClosed = () => { closed = true; };
  connection.on("close", markClosed);
  connection.on("error", markClosed);
  channel.on("close", markClosed);
  channel.on("error", markClosed);

  return {
    get closed() { return closed; },

    publish(row) {
      return traceMessagePublishing(row, tracedRow => {
        if (closed) {
          return Promise.reject(new Error("broker channel closed"));
        }

        const id = tracedRow.event_id;
        const body = Buffer.from(JSON.stringify(tracedRow.envelope));

        return new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("broker confirm timeout")),
            confirmTimeoutMs
          );

          try {
            channel.publish(EVENTS_EXCHANGE, tracedRow.event_type, body, {
              persistent: true,
              mandatory: true,
              messageId: id,
              type: tracedRow.event_type,
              contentType: "application/json",
              timestamp: Math.floor(Date.now() / 1000),
              headers: tracedRow.headers ?? {},
            }, error => {
              clearTimeout(timer);

              if (error) {
                return reject(new Error("broker nacked publish"));
              }

              if (returned.delete(id)) {
                return reject(
                  new Error("unroutable: no queue bound for " + tracedRow.event_type)
                );
              }

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