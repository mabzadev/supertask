import type { Context } from "hono";
import type { Env, RequestVariables } from "../types/env";

type AppContext = Context<{ Bindings: Env; Variables: RequestVariables }>;

export function errorHandler(err: Error, c: AppContext) {
  console.error(`[ERROR] ${err.message}`, err.stack);

  if (err instanceof ApiError) {
    return c.json({ error: err.code, detail: err.detail }, err.status as any);
  }

  // Hono HTTP exceptions
  if ("status" in err && typeof (err as any).status === "number") {
    const httpErr = err as any;
    return c.json(
      { error: httpErr.message || "Error", detail: httpErr.message },
      httpErr.status
    );
  }

  // Validation errors (Supertask-style)
  if (err.name === "ValidationError") {
    return c.json({ error: "INVALID_REQUEST", detail: err.message }, 400);
  }

  // Auth errors
  if (err.name === "AuthenticationError") {
    return c.json({ error: "NOT_AUTHENTICATED", detail: err.message }, 401);
  }

  if (err.name === "PermissionError") {
    return c.json({ error: "PERMISSION_DENIED", detail: err.message }, 403);
  }

  if (err.name === "DoesNotExist") {
    return c.json({ error: "NOT_FOUND", detail: err.message }, 404);
  }

  // Generic 500
  return c.json(
    {
      error: "INTERNAL_SERVER_ERROR",
      detail: "An unexpected error occurred.",
    },
    500
  );
}

// Custom error classes matching Supertask error codes
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class ApiError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409,
    public code: string,
    public detail: unknown,
  ) {
    super(typeof detail === "string" ? detail : code);
    this.name = "ApiError";
  }
}

export class AuthenticationError extends Error {
  constructor(message = "Authentication credentials were not provided.") {
    super(message);
    this.name = "AuthenticationError";
  }
}

export class PermissionError extends Error {
  constructor(message = "You do not have permission to perform this action.") {
    super(message);
    this.name = "PermissionError";
  }
}

export class DoesNotExist extends Error {
  constructor(model: string, id?: number | string) {
    super(id ? `${model} with id ${id} does not exist.` : `${model} does not exist.`);
    this.name = "DoesNotExist";
  }
}

export class UserAlreadyExistError extends Error {
  constructor() {
    super("A user with this email already exists.");
    this.name = "UserAlreadyExistError";
  }
}

export class DisabledSignupError extends Error {
  constructor() {
    super("New user registration is disabled.");
    this.name = "DisabledSignupError";
  }
}
