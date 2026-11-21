import { NextFunction, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { ZodError } from "zod";
import { AppError } from "../errors/AppError";
import { log } from "../lib/logger";
import * as Sentry from "@sentry/node";

// Shape of errors raised when an upstream provider (e.g. Twitter) fails.
// Matched structurally so this handler does not depend on a specific class
// export path; the provider response body is never forwarded to the client.
interface UpstreamErrorLike {
  name: string;
  provider: string;
  upstreamStatus?: number;
  timedOut?: boolean;
}

interface BodyParserError {
  type: string;
  status: number;
}

function isUpstreamError(err: unknown): err is UpstreamErrorLike {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "UpstreamError" &&
    typeof (err as { provider?: unknown }).provider === "string"
  );
}

function isBodyParserError(err: unknown): err is BodyParserError {
  return (
    typeof err === "object" &&
    err !== null &&
    "type" in (err as Record<string, unknown>) &&
    "status" in (err as Record<string, unknown>)
  );
}

// Adds the request's id to a response payload so a failed request can be
// cross-referenced against the request log line that shares the same id.
function withRequestId(
  req: Request,
  payload: Record<string, unknown>
): Record<string, unknown> {
  return req.requestId ? { ...payload, requestId: req.requestId } : payload;
}

// Extracts a safe, single-line description of an error without serializing
// bodies, headers or stack traces, which could contain sensitive data.
function safeErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err ?? "unknown");
}

/**
 * Single place where every error thrown or forwarded via `next(err)` in the
 * app ends up. Keeping this centralized means every route gets the same
 * response shape and log format instead of ad-hoc `res.status(...).json(...)`
 * calls scattered across route files.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  next: NextFunction
) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json(withRequestId(req, { error: err.message, code: err.code }));
  }

  // Upstream provider failures (e.g. Twitter) are reported with a fixed,
  // generic message. The provider's response body is never forwarded to the
  // client; it is only logged server-side.
  if (isUpstreamError(err)) {
    log("warn", "upstream provider error", {
      requestId: req.requestId,
      provider: err.provider,
      upstreamStatus: err.upstreamStatus,
      timedOut: err.timedOut,
    });
    return res.status(502).json(
      withRequestId(req, { error: "Upstream provider unavailable", code: "UPSTREAM_ERROR" })
    );
  }

  // express.json() rejects an unparseable body before any route schema runs;
  // report it in the same shape as a schema failure so clients only have one
  // validation error format to handle.
  if (isBodyParserError(err) && err.type === "entity.parse.failed") {
    return res.status(400).json(
      withRequestId(req, {
        error: "Validation failed",
        code: "VALIDATION_ERROR",
        details: [{ path: "", message: "Request body is not valid JSON" }],
      })
    );
  }

  if (err instanceof ZodError) {
    return res.status(400).json(
      withRequestId(req, {
        error: "Validation failed",
        code: "VALIDATION_ERROR",
        details: err.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      })
    );
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      return res.status(409).json(
        withRequestId(req, {
          error: `A record with this ${(err.meta?.target as string[] | undefined)?.join(", ") ?? "value"} already exists`,
          code: "CONFLICT",
        })
      );
    }
    if (err.code === "P2025") {
      return res.status(404).json(withRequestId(req, { error: "Record not found", code: "NOT_FOUND" }));
    }
  }

  log("error", "unhandled error", {
    requestId: req.requestId,
    method: req.method,
    path: req.path,
    error: safeErrorMessage(err),
  });

  // Report unexpected 500 errors to Sentry (#273)
  Sentry.captureException(err, {
    tags: {
      requestId: req.requestId || "unknown",
      method: req.method,
      path: req.path,
    },
  });

  return res.status(500).json(withRequestId(req, { error: "Internal server error", code: "INTERNAL_ERROR" }));
}
