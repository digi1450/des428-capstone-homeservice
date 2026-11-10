// The one typed-error hierarchy. Every service and route throws AppError (or a subclass) instead
// of writing a response directly, so the JSON error shape is guaranteed consistent across all
// eight bounded contexts. lib/http/respond.js is the single place that maps these to HTTP.
// Runtime callbacks cross Next instrumentation/API/RSC bundles; retain one nominal base.
const ERROR_BASE=Symbol.for("edemand.AppError");
export const AppError=globalThis[ERROR_BASE] ??= class AppError extends Error {
  constructor(statusCode, message, details) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.details = details;
  }
};

export class BadRequestError extends AppError {
  constructor(message = "bad request", details) {
    super(400, message, details);
    this.name = "BadRequestError";
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "unauthorized") {
    super(401, message);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "forbidden") {
    super(403, message);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends AppError {
  constructor(message = "not found") {
    super(404, message);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends AppError {
  constructor(message = "conflict") {
    super(409, message);
    this.name = "ConflictError";
  }
}
