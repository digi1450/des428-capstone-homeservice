// Shared read-only broker inspection. Kept separate from the CLI entry point
// so offline checkpoint validation cannot create a CLI/top-level-await cycle.
import {createRequire} from 'node:module';
const amqp=createRequire(new URL('../../services/payments-wallet/package.json',import.meta.url))('amqplib');
export const QUEUES = ["booking.events", "ratings.events", "notifications.events", "payments.events"];
export async function checkBroker(url, report, { managementUrl, mode = "report" } = {}) {
  const broker = new URL(url);
  let management;
  if (managementUrl) {
    management = new URL(managementUrl);
    if (!["https:", "http:"].includes(management.protocol) || management.hostname !== broker.hostname ||
      management.username || management.password || management.search || management.hash || management.pathname !== "/")
      throw new Error("Broker management must be an explicit HTTP(S) origin on the AMQP broker hostname");
  }
  const vhost = decodeURIComponent(broker.pathname.slice(1)) || "/";
  const authorization = "Basic " + Buffer.from(decodeURIComponent(broker.username || "guest") + ":" + decodeURIComponent(broker.password || "guest")).toString("base64");
  const connection = await amqp.connect(url);
  connection.on("error", () => {});
  const queues = {};
  try {
    for (const name of QUEUES.flatMap((q) => [q, `${q}.dlq`])) {
      const channel = await connection.createChannel(); // a 404 closes the channel, so one per queue
      channel.on("error", () => {});
      try {
        const { messageCount, consumerCount } = await channel.checkQueue(name);
        queues[name] = { messages: messageCount, consumers: consumerCount, unacknowledged: null };
        if (management) {
          const response = await fetch(new URL("/api/queues/" + encodeURIComponent(vhost) + "/" + encodeURIComponent(name), management), {
            headers: { Authorization: authorization }, redirect: "error", signal: AbortSignal.timeout(5000),
          });
          if (!response.ok) throw new Error("Broker management queue read failed (HTTP " + response.status + ")");
          const data = await response.json();
          for (const key of ["messages_ready", "messages_unacknowledged", "consumers"])
            if (!Number.isSafeInteger(data[key]) || data[key] < 0) throw new Error("Broker management counters unavailable; retry after statistics refresh");
          queues[name].messages = Math.max(messageCount, data.messages_ready);
          queues[name].consumers = Math.max(consumerCount, data.consumers);
          queues[name].unacknowledged = data.messages_unacknowledged;
        }
      } catch (error) {
        if (error?.code !== 404) throw error; // network/permission failures are unreadable, not empty
        queues[name] = { missing: true };
      } finally {
        try { await channel.close(); } catch { /* closed by the broker after 404 */ }
      }
    }
  } finally { await connection.close(); }
  report.info.queues = queues;
  report.info.broker_unacknowledged_verified = Boolean(management);
  if (!management) report.add("attention", "broker.unacknowledged.unknown", 1,
    "passive AMQP does not expose unacknowledged deliveries; supply --broker-management-url before declaring quiescence");
  for (const [name, q] of Object.entries(queues)) {
    if (q.missing) continue;
    const outstanding = q.messages + (q.unacknowledged ?? 0);
    if (name.endsWith(".dlq")) report.add("attention", `broker.dlq.${name}`, outstanding, `ready or unacknowledged dead letters in ${name}`);
    else report.add("pending", `broker.queue.${name}`, outstanding, `ready or unacknowledged messages in ${name}`);
    if (mode === "quiescent") report.add("pending", `broker.consumers.${name}`, q.consumers,
      `consumers still attached to ${name}; stop/drain consumers before frozen-writer validation`);
  }
  report.add("attention", "broker.queue.missing", Object.entries(queues).filter(([,q]) => q.missing).map(([id]) => ({ id })), "expected consumer/dead-letter queue not declared");
}
