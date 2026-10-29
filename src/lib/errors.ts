/** One error for "missing" and "forbidden" so callers cannot probe for hidden resources. */
export class NotFoundError extends Error {
  readonly status = 404;
  constructor() {
    super("Not found");
  }
}
export class ForbiddenError extends Error {
  readonly status = 403;
  constructor(message = "You do not have permission to do that") {
    super(message);
  }
}
export class ConflictError extends Error {
  readonly status = 409;
  constructor(message = "The item changed since you loaded it") {
    super(message);
  }
}
export class ValidationError extends Error {
  readonly status = 422;
  constructor(message: string) {
    super(message);
  }
}
export class UnauthenticatedError extends Error {
  readonly status = 401;
  constructor() {
    super("Sign in required");
  }
}
