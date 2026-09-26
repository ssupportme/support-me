import { NextFunction, Request, RequestHandler, Response } from "express";
import { TooManyRequestsError } from "../errors/AppError";
import { RateLimiter } from "../services/rateLimiter";

/**
 * Express middleware around the shared in-process `RateLimiter`. A request past
 * the limit gets a 429 (via the global error handler) with a `Retry-After`
 * header and the wait in the message.
 *
 * `keyOf` decides what is limited: the client IP, or a value from the validated
 * body such as the wallet address. Return `undefined` to skip limiting.
 *
 * The limiter is in-memory, so limits are per process (same single-instance
 * assumption as the magic-link limiter). Behind a reverse proxy set
 * `TRUST_PROXY` (number of proxy hops, see app.ts) so `req.ip` is the real
 * client and not the proxy.
 */
export function rateLimit(
  limiter: RateLimiter,
  keyOf: (req: Request) => string | undefined,
  label: string
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = keyOf(req);
    if (key === undefined || limiter.attempt(key)) return next();

    const retryAfter = limiter.retryAfterSeconds(key) || 1;
    res.set("Retry-After", String(retryAfter));
    return next(
      new TooManyRequestsError(`Too many ${label} requests, please retry in ${retryAfter} seconds`)
    );
  };
}

export const clientIp = (req: Request): string => req.ip ?? "unknown";
