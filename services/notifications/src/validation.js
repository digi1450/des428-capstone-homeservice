import { HttpError } from "./errors.js";

export function positiveId(value, label = "id") {
  if (!Number.isInteger(value) || value < 1 || value > 2147483647) {
    throw new HttpError(400, `invalid ${label}`);
  }
  return value;
}

// B supplies this object AFTER verifying JWT issuer/signature/expiry/audience and
// mapping Keycloak subject to the existing integer domain ID. Never use raw headers.
export function principalOf(actor) {
  if (!actor || !["customer", "provider", "admin"].includes(actor.role) ||
      !Number.isInteger(actor.domainId) || actor.domainId < 1 || actor.domainId > 2147483647) {
    throw new HttpError(401, "invalid notification principal");
  }
  return { role: actor.role, domainId: actor.domainId };
}

export function notificationInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new HttpError(400, "invalid notification");
  if (!["customer", "provider", "admin"].includes(input.recipientRole)) throw new HttpError(400, "invalid recipient role");
  positiveId(input.recipientId, "recipient id");
  if (input.orderId != null) positiveId(input.orderId, "order id");
  for (const key of ["type", "title", "body"]) {
    if (typeof input[key] !== "string" || !input[key].trim()) throw new HttpError(400, `invalid notification ${key}`);
  }
  return {
    recipientRole: input.recipientRole, recipientId: input.recipientId,
    type: input.type, title: input.title, body: input.body, orderId: input.orderId ?? null,
  };
}
