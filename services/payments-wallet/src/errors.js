export class HttpError extends Error {
  constructor(statusCode, message) { super(message); this.statusCode = statusCode; }
}
export function errorHandler(error, req, res, _next) {
  const status = error instanceof HttpError ? error.statusCode : 500;
  const body = { error: status < 500 ? error.message : "internal server error", requestId: req.requestId };
  // Serialize reviewed conflict codes only. A financial conflict is not proof of a safe cancellation fence.
  if (status === 409 && error instanceof HttpError && ["PAYMENT_SETUP_CANCELLED","FINANCIAL_COMMAND_CONFLICT","FINANCIAL_CONTEXT_MISMATCH","FINANCIAL_OPERATION_BLOCKED","FINANCIAL_LEGACY_RECONCILIATION_REQUIRED"].includes(error.code)) {
    body.code = error.code;
  }
  res.status(status).json(body);
}
