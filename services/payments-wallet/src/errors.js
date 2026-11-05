export class HttpError extends Error {
  constructor(statusCode, message) { super(message); this.statusCode = statusCode; }
}
export function errorHandler(error, req, res, _next) {
  const status = error instanceof HttpError ? error.statusCode : 500;
  res.status(status).json({ error: status < 500 ? error.message : "internal server error", requestId: req.requestId });
}
