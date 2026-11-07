export class HttpError extends Error {
  constructor(statusCode, message) { super(message); this.statusCode = statusCode; }
}
export function errorHandler(error, req, res, _next) {
  const status = error instanceof HttpError ? error.statusCode : 500;
  const body = { error: status < 500 ? error.message : "internal server error", requestId: req.requestId };
  // Only this reviewed business code on a real conflict may confirm a cancellation fence.
  if (status === 409 && error instanceof HttpError && error.code === "PAYMENT_SETUP_CANCELLED") {
    body.code = "PAYMENT_SETUP_CANCELLED";
  }
  res.status(status).json(body);
}
