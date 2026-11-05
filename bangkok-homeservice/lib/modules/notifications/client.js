// Prepared adapter; existing routes/pages/relay do not use this until B/C cutover.
// The verified end-user token goes to B's service verifier; never forward role/ID
// headers or fall back to SQLite after a remote error.
import { z } from "zod";
import { AppError, BadRequestError, UnauthorizedError } from "../../errors.js";

const id = z.number().int().positive().max(2147483647);
const notification = z.object({
  id, type: z.string(), title: z.string(), body: z.string(), order_id: id.nullable(),
  read_at: z.string().datetime({ offset: true }).nullable(), created_at: z.string().datetime({ offset: true }),
}).strict();
const unavailable = () => new AppError(503, "notifications service unavailable");

export function createNotificationsClient({ baseUrl, timeoutMs = 2000, fetchImpl = fetch }) {
  let base;
  try { base = new URL(baseUrl); } catch { throw new Error("Invalid notifications base URL"); }
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password ||
      base.pathname !== "/" || base.search || base.hash) throw new Error("Notifications base URL must be an HTTP origin");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error("Invalid notifications timeout");

  async function request(path, method, credentials, schema) {
    if (typeof credentials?.token !== "string" || !credentials.token.trim() || /[\r\n]/.test(credentials.token)) {
      throw new UnauthorizedError("missing bearer token");
    }
    const headers = { Authorization: `Bearer ${credentials.token}` };
    for (const [property, header] of [["requestId", "X-Request-Id"], ["traceparent", "traceparent"], ["tracestate", "tracestate"]]) {
      const value = credentials[property];
      if (value !== undefined) {
        const valid = typeof value === "string" && (property === "requestId"
          ? /^[A-Za-z0-9._:-]{1,128}$/.test(value) : /^[\x20-\x7e]{1,512}$/.test(value));
        if (!valid) throw new BadRequestError("invalid notification request metadata");
        headers[header] = value;
      }
    }
    // One deadline covers headers AND body. Retries belong to D, not this adapter.
    const signal = AbortSignal.timeout(timeoutMs);
    let response;
    try {
      response = await fetchImpl(new URL(path, base), { method, headers, signal, redirect: "error" });
    } catch { throw unavailable(); }
    if (!response.ok) {
      // Never reflect arbitrary upstream error bodies, tokens or URLs into logs.
      try { await response.body?.cancel(); } catch { /* preserve status */ }
      const expected = { 400: "invalid notification request", 401: "invalid notifications credentials", 403: "not your notification", 404: "notification not found" };
      if (expected[response.status]) throw new AppError(response.status, expected[response.status]);
      throw unavailable();
    }
    try {
      const result = schema.safeParse(await response.json());
      if (!result.success) throw unavailable();
      return result.data;
    } catch { throw unavailable(); }
  }
  return {
    listForUser: credentials => request("/api/notifications", "GET", credentials, z.array(notification)),
    markRead(notificationId, credentials) {
      if (!id.safeParse(notificationId).success) throw new BadRequestError("invalid notification id");
      return request(`/api/notifications/${notificationId}/read`, "POST", credentials, notification);
    },
  };
}
