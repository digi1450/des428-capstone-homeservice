// Business projections only: no SQL, broker, dedupe, acknowledgement or ratings writes.
// C validates envelope/version/producer before passing event_type and data here.
import { HttpError } from "./errors.js";
import { positiveId, notificationInput } from "./validation.js";

const statuses = ["awaiting", "confirmed", "started", "completed", "cancelled", "rescheduled"];
function invalid(field) { throw new HttpError(400, `invalid notification event ${field}`); }
function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("data");
  return value;
}
function message(recipientRole, recipientId, type, title, body, orderId = null) {
  return notificationInput({ recipientRole, recipientId, type, title, body, orderId });
}

export function mapNotificationEvent(eventType, input) {
  const data = object(input);
  switch (eventType) {
    case "review.created": {
      positiveId(data.order_id, "event order id");
      positiveId(data.provider_id, "event provider id");
      if (!Number.isInteger(data.rating) || data.rating < 1 || data.rating > 5) invalid("rating");
      return [message("provider", data.provider_id, "new_review", "New review",
        `You received a ${data.rating}-star review on booking #${data.order_id}.`, data.order_id)];
    }
    case "booking.status_changed": {
      positiveId(data.order_id, "event order id");
      positiveId(data.customer_id, "event customer id");
      positiveId(data.provider_id, "event provider id");
      if (!statuses.includes(data.to)) invalid("booking status");
      if (!["customer", "provider", "admin"].includes(data.actor_role)) invalid("actor role");
      const toCustomer = data.actor_role === "provider";
      return [message(toCustomer ? "customer" : "provider", toCustomer ? data.customer_id : data.provider_id,
        "booking_status", `Booking ${data.to}`, `Booking #${data.order_id} is now ${data.to}.`, data.order_id)];
    }
    case "booking.completed": {
      positiveId(data.order_id, "event order id");
      positiveId(data.customer_id, "event customer id");
      return [message("customer", data.customer_id, "rating_request", "How did it go?",
        `Booking #${data.order_id} is complete — leave a review for your provider.`, data.order_id)];
    }
    case "bid.accepted": {
      positiveId(data.order_id, "event order id");
      positiveId(data.job_request_id, "event job request id");
      positiveId(data.winner_provider_id, "event winner provider id");
      const losers = data.loser_provider_ids ?? [];
      if (!Array.isArray(losers)) invalid("loser provider ids");
      for (const providerId of losers) positiveId(providerId, "event loser provider id");
      if (new Set(losers).size !== losers.length || losers.includes(data.winner_provider_id)) invalid("bid recipient set");
      return [message("provider", data.winner_provider_id, "bid_accepted", "Your bid was accepted",
        `Your bid on job #${data.job_request_id} was accepted — booking #${data.order_id} created.`, data.order_id),
      ...losers.map(providerId => message("provider", providerId, "bid_rejected", "Bid not selected",
        `Your bid on job #${data.job_request_id} was not selected.`))];
    }
    case "payment.succeeded": {
      positiveId(data.order_id, "event order id");
      if (!Object.hasOwn(data, "provider_id")) invalid("provider id");
      if (!Number.isInteger(data.amount_cents) || data.amount_cents < 0 || data.amount_cents > 2147483647) invalid("amount");
      if (data.provider_id === null) return []; // Explicit legacy no-recipient case.
      positiveId(data.provider_id, "event provider id");
      return [message("provider", data.provider_id, "payment_received", "Payment received",
        `Payment of ${data.amount_cents} cents was received for booking #${data.order_id}.`, data.order_id)];
    }
    case "provider.approved": {
      // PROPOSED event for the inherited direct approval notification. C must
      // add its producer/outbox; no such event is emitted by the active monolith yet.
      positiveId(data.provider_id, "event provider id");
      return [message("provider", data.provider_id, "provider_approved", "You're approved",
        "Your provider account has been approved. Your services are now visible to customers.")];
    }
    default:
      throw new HttpError(400, "unsupported notification event");
  }
}
