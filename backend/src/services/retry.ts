import { log } from "../lib/logger";

/**
 * Retry-with-backoff for Soroban RPC calls.
 *
 * RPC calls fail transiently for reasons that have nothing to do with the
 * caller's intent: a network blip, a rate limit, an overloaded node, a slow
 * response that trips the timeout. Surfacing those to the user as a failure
 * makes a working action look broken. A contract revert, on the other hand,
 * is a permanent, deterministic answer from the chain — retrying it just
 * wastes time and RPC quota, and can never change the outcome.
 *
 * This module owns that distinction so every RPC caller gets the same policy.
 */

export type SorobanErrorClass = "transient" | "permanent";

export interface RetryOptions {
  /** Extra attempts after the first. 0 disables retrying. */
  retries?: number;
  /** First backoff delay; doubles each attempt. */
  baseDelayMs?: number;
  /** Upper bound on any single backoff delay. */
  maxDelayMs?: number;
  /** Deadline for the whole retry sequence, including backoff sleeps. */
  totalTimeoutMs?: number;
  /** Override the transient/permanent decision. */
  shouldRetry?: (error: unknown) => boolean;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests. */
  random?: () => number;
}

const DEFAULT_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 5_000;

/**
 * Signals that mean "the chain said no" or "you asked for something
 * impossible". Checked before the transient list because these strings can
 * appear inside messages that also look transport-ish, and a revert must
 * never be retried.
 */
const PERMANENT_PATTERNS: RegExp[] = [
  /contract/i,
  /revert/i,
  /panic/i,
  /host\s*function/i,
  /invoke/i,
  /malformed/i,
  /invalid\s+(params?|request|transaction|signature|argument)/i,
  /unauthorized/i,
  /forbidden/i,
  /insufficient\s+(balance|fee|funds)/i,
  /not\s+found/i,
  /bad\s+request/i,
  /already\s+exists/i,
  /unsupported/i,
];

/** HTTP statuses worth trying again. Everything else in 4xx is the caller's fault. */
const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 507, 522, 523, 524]);

/** Transport-level failures. */
const TRANSIENT_PATTERNS: RegExp[] = [
  /timed?\s*out/i,
  /timeout/i,
  /etimedout/i,
  /esockettimedout/i,
  /econnreset/i,
  /econnrefused/i,
  /econnaborted/i,
  /ehostunreach/i,
  /enetunreach/i,
  /eai_again/i,
  /enotfound/i,
  /epipe/i,
  /socket hang\s*up/i,
  /fetch failed/i,
  /network/i,
  /connection (closed|reset|refused)/i,
  /rate[\s-]?limit/i,
  /too many requests/i,
  /temporarily unavailable/i,
  /try again/i,
  /overloaded/i,
  /bad gateway/i,
  /service unavailable/i,
  /gateway timeout/i,
  /abort/i,
];

/** JSON-RPC codes: the -32000..-32099 band is reserved for server-side errors. */
const isTransientJsonRpcCode = (code: number): boolean =>
  code === -32603 || (code >= -32099 && code <= -32000);

function readJsonRpcCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { code?: unknown; status?: unknown };
  const code = candidate.code;
  return typeof code === "number" ? code : undefined;
}

function readHttpStatus(error: unknown): number | undefined {
  const message = error instanceof Error ? error.message : String(error ?? "");
  // Deliberately anchored: a loose /\d{3}/ would also match a port number in
  // transport errors like "connect ECONNREFUSED 127.0.0.1:443" and misread
  // them as HTTP 4xx.
  const match =
    message.match(/\bHTTP\s+(\d{3})\b/i) ??
    message.match(/\bstatus(?:\s+code)?\s+(\d{3})\b/i) ??
    message.match(/^(\d{3})\s/);
  if (!match) return undefined;
  const status = Number(match[1]);
  return Number.isFinite(status) ? status : undefined;
}

/**
 * Classifies an RPC failure.
 *
 * Returns "permanent" for anything unrecognized as well as for known-bad
 * calls, so an unclassified error fails fast. Retrying an operation that was
 * always going to be rejected wastes the user's time and the provider's quota;
 * the conservative answer is the safer one for actions that move funds.
 */
export function classifySorobanError(error: unknown): SorobanErrorClass {
  const message = error instanceof Error ? error.message : String(error ?? "");

  if (PERMANENT_PATTERNS.some((pattern) => pattern.test(message))) {
    return "permanent";
  }

  const code = readJsonRpcCode(error);
  if (code !== undefined) {
    // -32600 invalid request, -32601 method not found, -32602 invalid params
    if (code === -32600 || code === -32601 || code === -32602) return "permanent";
    if (isTransientJsonRpcCode(code)) return "transient";
  }

  const status = readHttpStatus(error);
  if (status !== undefined) {
    if (TRANSIENT_HTTP_STATUSES.has(status)) return "transient";
    if (status >= 400 && status < 500) return "permanent";
    if (status >= 500) return "transient";
  }

  if (TRANSIENT_PATTERNS.some((pattern) => pattern.test(message))) {
    return "transient";
  }

  return "permanent";
}

export function isTransientSorobanError(error: unknown): boolean {
  return classifySorobanError(error) === "transient";
}

function computeDelayMs(attempt: number, options: RetryOptions, random: () => number): number {
  const base = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const max = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  // Full-jitter backoff: keeps concurrent callers from retrying in lockstep
  // after a shared outage, while still growing between attempts.
  const ceiling = Math.min(max, base * 2 ** attempt);
  return Math.round(ceiling * (0.5 + random() * 0.5));
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `operation`, retrying transient failures with exponential backoff and
 * jitter. Permanent failures (including anything unclassified) are rethrown
 * immediately, so a contract revert costs one attempt rather than four.
 *
 * Every retry is logged with the attempt number, the delay, and the reason,
 * so a degraded RPC provider is visible in the logs rather than looking like
 * random latency to the user.
 */
export async function withRetry<T>(
  operationName: string,
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const maxRetries = options.retries ?? DEFAULT_RETRIES;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const shouldRetry = options.shouldRetry ?? isTransientSorobanError;
  const startedAt = Date.now();

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;

      const isLastAttempt = attempt === maxRetries;
      if (isLastAttempt || !shouldRetry(error)) {
        if (!isLastAttempt) {
          log("warn", "Soroban RPC failure is not retryable; failing fast", {
            operation: operationName,
            attempt: attempt + 1,
            reason: error instanceof Error ? error.message : String(error),
            classification: classifySorobanError(error),
          });
        }
        throw error;
      }

      const delayMs = computeDelayMs(attempt, options, random);

      if (options.totalTimeoutMs !== undefined) {
        const elapsed = Date.now() - startedAt;
        if (elapsed + delayMs >= options.totalTimeoutMs) {
          log("warn", "Soroban RPC retry budget exhausted; not retrying", {
            operation: operationName,
            attempt: attempt + 1,
            elapsedMs: elapsed,
            totalTimeoutMs: options.totalTimeoutMs,
          });
          throw error;
        }
      }

      log("warn", "Retrying transient Soroban RPC failure", {
        operation: operationName,
        attempt: attempt + 1,
        maxRetries,
        delayMs,
        reason: error instanceof Error ? error.message : String(error),
      });

      await sleep(delayMs);
    }
  }

  // Unreachable: the loop either returns or throws.
  throw lastError;
}
