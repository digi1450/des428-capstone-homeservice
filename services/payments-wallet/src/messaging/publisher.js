// Area C — RabbitMQ publisher for the outbox relay (Week 9).
// Uses a confirm channel (broker acknowledges it has the message) and `mandatory`
// (an unroutable message is returned instead of silently dropped). Only a confirmed,
// non-returned message counts as published; anything else stays in the outbox.
import amqp from "amqplib";
import { EVENTS_EXCHANGE, assertProducerTopology } from "./topology.js";

export async function createPublisher(amqpUrl, { confirmTimeoutMs = 5000 } = {}) {
  const connection = await amqp.connect(amqpUrl);
  const channel = await connection.createConfirmChannel();
  await assertProducerTopology(channel);
  const returned = new Set();
  let closed = false;
  // basic.return is delivered before the confirm of the same message.
  channel.on("return", message => returned.add(message.properties.messageId));
  const markClosed = () => { closed = true; };
  connection.on("close", markClosed);
  connection.on("error", markClosed);
  channel.on("close", markClosed);
  channel.on("error", markClosed);

  return {
    get closed() { return closed; },
    publish(row) {
      if (closed) return Promise.reject(new Error("broker channel closed"));
      const id = row.event_id;
      const body = Buffer.from(JSON.stringify(row.envelope));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("broker confirm timeout")), confirmTimeoutMs);
        try {
          channel.publish(EVENTS_EXCHANGE, row.event_type, body, {
            persistent: true,
            mandatory: true,
            messageId: id,
            type: row.event_type,
            contentType: "application/json",
            timestamp: Math.floor(Date.now() / 1000),
            headers: row.headers ?? {},
          }, error => {
            clearTimeout(timer);
            if (error) return reject(new Error("broker nacked publish"));
            if (returned.delete(id)) return reject(new Error("unroutable: no queue bound for " + row.event_type));
            resolve();
          });
        } catch {
          clearTimeout(timer);
          reject(new Error("broker publish failed"));
        }
      });
    },
    async close() {
      closed = true;
      try { await channel.close(); } catch { /* already closed */ }
      try { await connection.close(); } catch { /* already closed */ }
    },
  };
}
