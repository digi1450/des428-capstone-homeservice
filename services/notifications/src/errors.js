export class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function errorHandler(error, req, res, _next) {
  const expected = error instanceof HttpError;
  const status = expected ? error.statusCode : 500;
  const message = expected && status < 500 ? error.message : "internal server error";
  res.status(status).json({ error: message, requestId: req.requestId });
}
