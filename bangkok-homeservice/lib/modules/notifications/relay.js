import {processState} from '../../runtime/process-state.js';
// Inherited in-process relay for SQLite notifications and rating effects. C's broker relay
// independently tracks published_at; this relay tracks processed_at. Started once from
// instrumentation.js as setInterval(runRelayOnce, 1000); also exported so tests can drain it
// synchronously. Every domain event is claimed exactly once (processed_at) before dispatch, so a
// second pass over the same event is a no-op — the relay is idempotent.
//
// THE rating aggregate is recomputed HERE, driven by the review.created event, never inline in the
// review handler. That is the deliberate eventual-consistency contrast the course teaches.
import { listUnprocessed, claim } from "../../db/events.js";
import { logger } from "../../logger.js";
import * as notificationsRepository from "./repository.js";
import * as catalogRepository from "../catalog/repository.js";
import * as providersRepository from "../providers/repository.js";

const RELAY = Symbol.for("edemand.relay.interval");
const selection=processState('modules/notifications/relay.js');

// Explicit, disabled-by-default cutover preparation. C's ratings consumer stays in monolith.
// Configure only at a coordinated handover; this does not validate readiness or migrate data.
export function configureNotificationEventDelivery({ mode } = {}) {
  if (mode !== "events") throw new TypeError("Notification delivery mode must explicitly be events");
  if (selection.value) throw new Error("Notification event delivery is already configured");
  selection.value = Object.freeze({ mode });
  stopRelay();
  return selection.value;
}
export const getNotificationEventDelivery = () => selection.value;
// Tests/coordinated shutdown only, never automatic outage fallback. Does not restart a timer.
export const resetNotificationEventDelivery = () => { selection.value = null; };

function notify(recipientRole, recipientId, type, title, body, orderId = null) {
  notificationsRepository.insert({ recipientRole, recipientId, type, title, body, orderId });
}

function dispatch(event) {
  const payload = JSON.parse(event.payload_json);
  switch (event.type) {
    case "review.created": {
      // Eventual consistency: recompute the service AND provider aggregates from the reviews table.
      catalogRepository.recomputeRatingAggregate(payload.service_id);
      providersRepository.recomputeRatingAggregate(payload.provider_id);
      notify(
        "provider", payload.provider_id, "new_review", "New review",
        `You received a ${payload.rating}-star review on booking #${payload.order_id}.`,
        payload.order_id
      );
      break;
    }
    case "booking.status_changed": {
      // Notify the counterparty of whoever drove the transition.
      const toCustomer = payload.actor_role === "provider";
      const recipientRole = toCustomer ? "customer" : "provider";
      const recipientId = toCustomer ? payload.customer_id : payload.provider_id;
      notify(
        recipientRole, recipientId, "booking_status",
        `Booking ${payload.to}`,
        `Booking #${payload.order_id} is now ${payload.to}.`,
        payload.order_id
      );
      break;
    }
    case "booking.completed": {
      notify(
        "customer", payload.customer_id, "rating_request", "How did it go?",
        `Booking #${payload.order_id} is complete — leave a review for your provider.`,
        payload.order_id
      );
      break;
    }
    case "bid.accepted": {
      notify(
        "provider", payload.winner_provider_id, "bid_accepted", "Your bid was accepted",
        `Your bid on job #${payload.job_request_id} was accepted — booking #${payload.order_id} created.`,
        payload.order_id
      );
      for (const loserId of payload.loser_provider_ids || []) {
        notify(
          "provider", loserId, "bid_rejected", "Bid not selected",
          `Your bid on job #${payload.job_request_id} was not selected.`,
          null
        );
      }
      break;
    }
    case "payment.succeeded": {
      if (payload.provider_id != null) {
        notify(
          "provider", payload.provider_id, "payment_received", "Payment received",
          `Payment of ${payload.amount_cents} cents was received for booking #${payload.order_id}.`,
          payload.order_id
        );
      }
      break;
    }
    case "provider.registered":
      // Area C: published to the broker so Payments & Wallet provisions the provider's wallet.
      // The inherited SQLite provider_wallets row is still written locally until cutover.
      break;
    case "provider.approved":
      // Published to the broker for the extracted Notifications service (Area C). The inherited
      // direct writer in providers/service.js still records it locally until cutover.
      break;
    default:
      logger.warn({ type: event.type, id: event.id }, "relay: unknown event type");
  }
}

// Drain up to 100 unprocessed events. Each is claimed (processed_at) before dispatch; a concurrent
// or repeated pass that loses the claim skips the event. Returns the number of events processed.
export function runRelayOnce() {
  // Do not claim/stamp, dispatch or touch SQLite notifications/ratings after selecting the broker.
  // In particular, do not mark historical work processed just to satisfy migration checks.
  if (selection.value) return 0;
  const rows = listUnprocessed(100);
  let processed = 0;
  for (const event of rows) {
    if (claim(event.id) === 0) continue; // someone else already claimed it
    try {
      dispatch(event);
      processed += 1;
    } catch (err) {
      logger.error({ err: err.message, eventId: event.id }, "relay: dispatch failed");
    }
  }
  return processed;
}

export function startRelay() {
  if (selection.value || globalThis[RELAY]) return;
  const handle = setInterval(() => {
    try {
      runRelayOnce();
    } catch (err) {
      logger.error({ err: err.message }, "relay: pass failed");
    }
  }, 1000);
  // Don't keep the process alive solely for the relay.
  if (typeof handle.unref === "function") handle.unref();
  globalThis[RELAY] = handle;
  logger.info("outbox relay started");
}

export function stopRelay() {
  if (globalThis[RELAY]) {
    clearInterval(globalThis[RELAY]);
    globalThis[RELAY] = undefined;
  }
}
