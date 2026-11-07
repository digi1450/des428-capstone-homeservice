#!/usr/bin/env bash
# Area C evidence run: kill -9 the real outbox relay process, keep committing payments,
# restart it, and count effects. Uses DISPOSABLE databases/broker only.
#   PAYMENTS_DATABASE_URL=... NOTIFICATIONS_DATABASE_URL=... AMQP_URL=... tests/integration/c-relay-kill-demo.sh
# Prints counts only; never prints connection strings.
set -euo pipefail
: "${PAYMENTS_DATABASE_URL:?}" "${NOTIFICATIONS_DATABASE_URL:?}" "${AMQP_URL:?}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOGS="$(mktemp -d)"
PAY="$ROOT/services/payments-wallet"
NOTE="$ROOT/services/notifications"
PROVIDER=$(( 800000000 + RANDOM * 3 ))
BASE=$(( PROVIDER * 2 % 1000000000 + 1000 ))

cleanup() { kill "${RELAY_PID:-}" "${CONSUMER_PID:-}" 2>/dev/null || true; }
trap cleanup EXIT

(cd "$PAY" && DATABASE_URL="$PAYMENTS_DATABASE_URL" node src/migrate.js >/dev/null)
(cd "$NOTE" && DATABASE_URL="$NOTIFICATIONS_DATABASE_URL" node src/migrate.js >/dev/null)

settle() { # $1 = order id; commits charge + outbox row in one Payments transaction
  (cd "$PAY" && DATABASE_URL="$PAYMENTS_DATABASE_URL" ORDER="$1" PROVIDER="$PROVIDER" node --input-type=module -e '
    import { createDatabase } from "./src/database.js";
    import { createPaymentsService } from "./src/service.js";
    import { createOutbox } from "./src/messaging/outbox.js";
    const db = createDatabase(process.env.DATABASE_URL);
    const svc = createPaymentsService(db, { assertSettlementAllowed: async () => true, stageEvent: createOutbox().stage });
    const order = Number(process.env.ORDER), provider = Number(process.env.PROVIDER);
    const intent = await svc.prepareIntent({ order_id: order, customer_id: 7, provider_id: provider, amount_cents: 500, currency: "THB" });
    await svc.settleWebhook({ gateway_event_id: "demo-" + crypto.randomUUID(), type: "payment_intent.succeeded", gateway_ref: intent.gateway_ref });
    await db.close();')
}
pending()  { psql "$PAYMENTS_DATABASE_URL" -tAc "SELECT count(*) FROM outbox_events WHERE published_at IS NULL AND aggregate_id::bigint BETWEEN $BASE AND $((BASE+99))"; }
effects()  { psql "$NOTIFICATIONS_DATABASE_URL" -tAc "SELECT count(*) FROM notifications WHERE recipient_role='provider' AND recipient_id=$PROVIDER"; }
start_relay() { (cd "$PAY" && DATABASE_URL="$PAYMENTS_DATABASE_URL" AMQP_URL="$AMQP_URL" RELAY_POLL_MS=200 RELAY_LEASE_MS=2000 exec node src/outbox-relay.js >>"$LOGS/relay.log" 2>&1) & RELAY_PID=$!; }

(cd "$NOTE" && DATABASE_URL="$NOTIFICATIONS_DATABASE_URL" AMQP_URL="$AMQP_URL" exec node src/event-consumer.js >"$LOGS/consumer.log" 2>&1) & CONSUMER_PID=$!
start_relay
sleep 2
for i in 0 1 2; do settle $((BASE+i)); done
sleep 2
echo "step 1 relay running   : committed=3 pending=$(pending) notifications=$(effects)"

kill -9 "$RELAY_PID"; wait "$RELAY_PID" 2>/dev/null || true
for i in 3 4 5 6 7; do settle $((BASE+i)); done
sleep 2
echo "step 2 relay KILLED -9 : committed=8 pending=$(pending) notifications=$(effects)"

start_relay
sleep 4
echo "step 3 relay restarted : committed=8 pending=$(pending) notifications=$(effects)"
echo "consumer duplicate skips: $(grep -c event_duplicate_skipped "$LOGS/consumer.log" || true)"
echo "logs: $LOGS"
