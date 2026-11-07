// Area C — Booking applies its OWN payment status from the Payments & Wallet `payment.succeeded`
// event, instead of Payments writing the orders table (migration-handoff §3). The event is checked
// against the booking before anything changes; a payment that does not fit (unknown order, wrong
// amount/parties, cancelled or refunded booking) is recorded for reconciliation — never applied
// silently, and a late payment never revives a cancelled booking.
import * as bookingRepository from "./repository.js";
import { positiveId } from "../../messaging/inbound.js";

export const paymentSucceededHandler = {
  producer: "payments-wallet",
  apply(envelope, ctx) {
    const data = envelope.data;
    const orderId = positiveId(data.order_id, "order id");
    positiveId(data.customer_id, "customer id");
    positiveId(data.provider_id, "provider id");
    if (!Number.isInteger(data.amount_cents) || data.amount_cents < 0) positiveId(-1, "amount");
    const order = bookingRepository.findOrderById(orderId);
    if (!order) return ctx.attention("payment for an unknown booking");
    if (order.payment_method !== "gateway") return ctx.attention("payment for a non-gateway booking");
    if (order.customer_id !== data.customer_id || order.provider_id !== data.provider_id || order.total_cents !== data.amount_cents) {
      return ctx.attention("payment does not match the booking's parties or total");
    }
    if (order.status === "cancelled") return ctx.attention("payment received for a cancelled booking: refund required");
    if (order.payment_status === "refunded") return ctx.attention("payment received for a refunded booking");
    if (order.payment_status === "paid") return "already_paid";
    bookingRepository.markPaid(orderId);
    return "marked_paid";
  },
};
