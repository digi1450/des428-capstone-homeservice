export function createPaymentsRepository(database) {
  const one = async (client, sql, values) => (await client.query(sql, values)).rows[0] ?? null;
  return {
    // Transaction-scoped per-booking lock shared by all A business mutations.
    // C must acquire its dedupe/command guards before calling ONE business effect.
    lockOrder: (client, orderId) => client.query("SELECT pg_advisory_xact_lock(42801, $1::integer)", [orderId]),
    intentByOrder: (client, orderId) => one(client, "SELECT * FROM payment_intents WHERE order_id=$1", [orderId]),
    intentByRef: (client, ref) => one(client, "SELECT * FROM payment_intents WHERE gateway_ref=$1", [ref]),
    async insertIntent(client, value, ref) {
      return one(client, `INSERT INTO payment_intents (order_id,customer_id,provider_id,amount_cents,gateway_ref)
        VALUES ($1,$2,$3,$4,$5) RETURNING *`, [value.order_id,value.customer_id,value.provider_id,value.amount_cents,ref]);
    },
    setIntentStatus: (client, intentId, status) => one(client, "UPDATE payment_intents SET status=$2 WHERE id=$1 RETURNING *", [intentId,status]),
    async ensureWallet(client, providerId) {
      await client.query("INSERT INTO provider_wallets (provider_id) VALUES ($1) ON CONFLICT (provider_id) DO NOTHING", [providerId]);
      return one(client, "SELECT * FROM provider_wallets WHERE provider_id=$1", [providerId]);
    },
    wallet: (client, providerId) => one(client, "SELECT * FROM provider_wallets WHERE provider_id=$1", [providerId]),
    async updateWallet(client, providerId, earnings, commission) {
      return one(client, `UPDATE provider_wallets SET balance_cents=balance_cents+$2,
        commission_owed_cents=commission_owed_cents+$3,updated_at=now() WHERE provider_id=$1 RETURNING *`, [providerId,earnings,commission]);
    },
    ledgerForOrder: async (client, orderId) => (await client.query("SELECT * FROM transactions WHERE order_id=$1 ORDER BY id", [orderId])).rows,
    providerLedger: async (client, providerId) => (await client.query("SELECT * FROM transactions WHERE provider_id=$1 ORDER BY id DESC", [providerId])).rows,
    customerLedger: async (client, customerId) => (await client.query("SELECT * FROM transactions WHERE customer_id=$1 ORDER BY id DESC", [customerId])).rows,
    insertTransaction: (client, value) => one(client, `INSERT INTO transactions
      (order_id,customer_id,provider_id,kind,amount_cents,method,gateway_ref,status,context_json)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING *`, [value.order_id,value.customer_id,value.provider_id,value.kind,value.amount_cents,value.method,value.gateway_ref ?? null,value.status ?? "succeeded",JSON.stringify(value.context_json ?? {})]),
    async recordWebhook(client, value) {
      const fresh = await client.query(`INSERT INTO webhook_events (gateway_event_id,type,payload_json)
        VALUES ($1,$2,$3::jsonb) ON CONFLICT (gateway_event_id) DO NOTHING RETURNING id`, [value.gateway_event_id,value.type,JSON.stringify(value)]);
      return { fresh: fresh.rowCount === 1, row: await one(client,"SELECT * FROM webhook_events WHERE gateway_event_id=$1",[value.gateway_event_id]) };
    },
    markWebhookProcessed: (client, key) => client.query("UPDATE webhook_events SET processed_at=now() WHERE gateway_event_id=$1",[key]),
  };
}
