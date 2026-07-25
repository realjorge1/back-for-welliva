import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { log } from "./logger.js";

/** A typed error that maps to a specific HTTP status + machine code. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Wrap an async route so thrown/rejected errors flow into the error handler. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

/** Final Express error handler (must keep all four args to be recognized). */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: "invalid_request",
        message: "Request validation failed",
        details: err.flatten(),
      },
    });
  }

  if (err instanceof ApiError) {
    return res
      .status(err.status)
      .json({ error: { code: err.code, message: err.message } });
  }

  // Anthropic SDK errors carry an HTTP `status` — surface as an upstream error.
  const anyErr = err as { status?: number; message?: string };
  if (typeof anyErr?.status === "number") {
    log.error("upstream model error", anyErr.status, anyErr.message);
    return res.status(502).json({
      error: {
        code: "upstream_error",
        message: anyErr.message ?? "Upstream model error",
      },
    });
  }

  log.error("unhandled error", err);
  return res
    .status(500)
    .json({ error: { code: "internal_error", message: "Internal server error" } });
}
