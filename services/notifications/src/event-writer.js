import { mapNotificationEvent } from "./event-mappings.js";
import { createNotificationsService } from "./service.js";

export function createNotificationEventWriter(database) {
  const notifications = createNotificationsService(database);
  return {
    async recordEvent(eventType, data, { client } = {}) {
      // Validate/project the ENTIRE batch before any SQL (including all bid losers).
      const commands = mapNotificationEvent(eventType, data);
      if (!commands.length) return [];
      const write = async connection => {
        const results = [];
        for (const command of commands) results.push(await notifications.record(command, { client: connection }));
        return results;
      };
      // C's consumer dedupe and ALL effects must use one transaction client.
      // Without C, this makes the batch atomic but intentionally does NOT dedupe.
      return client ? write(client) : database.withTransaction(write);
    },
  };
}
