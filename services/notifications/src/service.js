import { createNotificationsRepository } from "./repository.js";
import { HttpError } from "./errors.js";
import { notificationInput, positiveId, principalOf } from "./validation.js";

function publicNotification(row) {
  return {
    id: row.id, type: row.type, title: row.title, body: row.body,
    order_id: row.order_id,
    read_at: row.read_at == null ? null : new Date(row.read_at).toISOString(),
    created_at: new Date(row.created_at).toISOString(),
  };
}

export function createNotificationsService(database) {
  const repository = createNotificationsRepository(database);
  return {
    async listForUser(actor) {
      const { role, domainId } = principalOf(actor);
      return (await repository.listForRecipient(role, domainId)).map(publicNotification);
    },
    async markRead(id, actor) {
      const { role, domainId } = principalOf(actor);
      positiveId(id, "notification id");
      const existing = await repository.findById(id);
      if (!existing) throw new HttpError(404, `notification ${id} not found`);
      if (existing.recipient_role !== role || existing.recipient_id !== domainId) {
        throw new HttpError(403, "not your notification");
      }
      const updated = await repository.markRead(id, role, domainId);
      if (!updated) throw new HttpError(404, `notification ${id} not found`);
      return publicNotification(updated);
    },
    // Internal function only, NOT an HTTP write endpoint. C calls this using its
    // existing transaction client after inserting/checking consumer dedupe state.
    async record(input, { client } = {}) {
      const value = notificationInput(input);
      const write = async connection => publicNotification(await repository.insert(value, connection));
      return client ? write(client) : database.withTransaction(write);
    },
  };
}
