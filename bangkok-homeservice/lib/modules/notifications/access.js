import {processState} from '../../runtime/process-state.js';
// Explicit reader composition only. Production bootstrap does not select remote ownership yet.
// Credentials must come from B's verified delegation, including Server Component context.
import * as legacy from "./service.js";
import { BadRequestError, UnauthorizedError } from "../../errors.js";

const selection=processState('modules/notifications/access.js');

export function configureNotificationsAccess({ notificationsClient, credentials } = {}) {
  if (!notificationsClient ||
      ["listForUser", "markRead"].some(name => typeof notificationsClient[name] !== "function") ||
      typeof credentials !== "function") {
    throw new TypeError("Notifications access requires a client and verified end-user credentials provider");
  }
  if (selection.value) throw new Error("Notifications access is already configured");
  selection.value = Object.freeze({ notificationsClient, credentials });
  return selection.value;
}

export const getNotificationsAccess = () => selection.value;
// Explicit teardown for tests/coordinated reconfiguration, never an outage fallback.
export const resetNotificationsAccess = () => { selection.value = null; };

function verifiedActor(auth) {
  if (!auth || !["customer", "provider", "admin"].includes(auth.role) ||
      !Number.isInteger(auth.sub) || auth.sub < 1 || auth.sub > 2147483647) {
    throw new UnauthorizedError("invalid notification user");
  }
  return { sub: auth.sub, role: auth.role };
}

export async function listNotifications(auth, context) {
  const who = verifiedActor(auth);
  const access = selection.value;
  if (!access) return legacy.listForUser(who);
  return access.notificationsClient.listForUser(await access.credentials(who, context));
}

export async function markNotificationRead(notificationId, auth, context) {
  const who = verifiedActor(auth);
  if (!Number.isInteger(notificationId) || notificationId < 1 || notificationId > 2147483647) {
    throw new BadRequestError("invalid notification id");
  }
  const access = selection.value;
  if (!access) return legacy.markRead(notificationId, who);
  return access.notificationsClient.markRead(notificationId, await access.credentials(who, context));
}
