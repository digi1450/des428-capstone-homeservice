// Derives a request id for a route handler: trust an inbound x-request-id, else mint a uuid. The
// value is echoed back as X-Request-Id and stamped into every log line + error body for the call.
import { randomUUID } from "node:crypto";

export function requestId(req) {
  const incoming = req.headers.get("x-request-id");
  return incoming && /^[A-Za-z0-9._:-]{1,128}$/.test(incoming) ? incoming : randomUUID();
}
