// Explicit reader composition only. Production bootstrap does not select remote ownership yet.
// Credentials must come from B's verified delegation, including Server Component context.
import * as legacy from "./service.js";
import { BadRequestError, UnauthorizedError } from "../../errors.js";

let runtime = null;

export function configureNotificationsAccess({ notificationsClient, credentials } = {}) {
  if (!notificationsClient ||
      ["listForUser", "markRead"].some(name => typeof notificationsClient[name] !== "function") ||
      typeof credentials !== "function") {
    throw new TypeError("Notifications access requires a client and verified end-user credentials provider");
  }
  if (runtime) throw new Error("Notifications access is already configured");
  runtime = Object.freeze({ notificationsClient, credentials });
  return runtime;
}

export const getNotificationsAccess = () => runtime;
// Explicit teardown for tests/coordinated reconfiguration, never an outage fallback.
export const resetNotificationsAccess = () => { runtime = null; };

function verifiedActor(auth) {
  if (!auth || !["customer", "provider", "admin"].includes(auth.role) ||
      !Number.isInteger(auth.sub) || auth.sub < 1 || auth.sub > 2147483647) {
    throw new UnauthorizedError("invalid notification user");
  }
  return { sub: auth.sub, role: auth.role };
}

export async function listNotifications(auth, context) {
  const who = verifiedActor(auth);
  const access = runtime;
  if (!access) return legacy.listForUser(who);
  return access.notificationsClient.listForUser(await access.credentials(who, context));
}

export async function markNotificationRead(notificationId, auth, context) {
  const who = verifiedActor(auth);
  if (!Number.isInteger(notificationId) || notificationId < 1 || notificationId > 2147483647) {
    throw new BadRequestError("invalid notification id");
  }
  const access = runtime;
  if (!access) return legacy.markRead(notificationId, who);
  return access.notificationsClient.markRead(notificationId, await access.credentials(who, context));
}
