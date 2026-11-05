import { HttpError } from "./errors.js";
export function id(value, label = "id") {
  if (!Number.isInteger(value) || value < 1 || value > 2147483647) throw new HttpError(400, `invalid ${label}`);
  return value;
}
export function cents(value, label = "amount") {
  if (!Number.isInteger(value) || value < 0 || value > 2147483647) throw new HttpError(400, `invalid ${label}`);
  return value;
}
export function context(value) {
  if (!value || typeof value !== "object") throw new HttpError(400, "invalid payment context");
  return {
    order_id: id(value.order_id, "order id"), customer_id: id(value.customer_id, "customer id"),
    provider_id: id(value.provider_id, "provider id"), amount_cents: cents(value.amount_cents),
  };
}
export function principal(actor, role) {
  if (!actor || !["customer", "provider", "admin"].includes(actor.role) || !Number.isInteger(actor.domainId) || actor.domainId < 1 || actor.domainId > 2147483647) throw new HttpError(401, "invalid payment principal");
  if (role && actor.role !== role) throw new HttpError(403, "forbidden");
  return { role: actor.role, domainId: actor.domainId };
}
export function webhook(value) {
  if (!value || value.type !== "payment_intent.succeeded") throw new HttpError(400, "unsupported gateway event");
  for (const name of ["gateway_event_id", "gateway_ref"]) {
    if (typeof value[name] !== "string" || !value[name].trim() || value[name].length > 200) throw new HttpError(400, `invalid ${name}`);
  }
  return { gateway_event_id: value.gateway_event_id, type: value.type, gateway_ref: value.gateway_ref };
}
