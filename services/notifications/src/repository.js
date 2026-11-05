// All queries use the service database or the caller's SAME transaction client.
// No monolith imports, cross-service SQL or business/identity decisions here.
export function createNotificationsRepository(database) {
  return {
    async insert(input, client = database) {
      const result = await client.query(`
        INSERT INTO notifications (recipient_role, recipient_id, type, title, body, order_id)
        VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [input.recipientRole, input.recipientId, input.type, input.title, input.body, input.orderId]);
      return result.rows[0];
    },
    async listForRecipient(role, id) {
      const result = await database.query(`SELECT * FROM notifications
        WHERE recipient_role = $1 AND recipient_id = $2 ORDER BY id DESC`, [role, id]);
      return result.rows;
    },
    async findById(id) {
      const result = await database.query("SELECT * FROM notifications WHERE id = $1", [id]);
      return result.rows[0] ?? null;
    },
    async markRead(id, role, recipientId) {
      // Replay/concurrent clicks retain the original read_at. Role AND ID are
      // included even after the service's ownership check as a write constraint.
      const result = await database.query(`UPDATE notifications SET read_at = COALESCE(read_at, now())
        WHERE id = $1 AND recipient_role = $2 AND recipient_id = $3 RETURNING *`, [id, role, recipientId]);
      return result.rows[0] ?? null;
    },
  };
}
