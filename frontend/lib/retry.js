/**
 * Retry-with-backoff for Soroban RPC calls made from the browser.
 *
 * The public RPC endpoints are shared infrastructure: they rate-limit, they
 * occasionally drop a connection, and their responses sometimes time out.
 * None of that is the user's fault, and none of it is fixed by asking them to
 * try again. A contract revert, on the other hand, is a final, deterministic
 * answer from the chain — retrying it wastes the user's time and the node's
 * quota and can never change the outcome.
 *
 * This mirrors the server-side policy in backend/src/services/retry.ts so a
 * transient failure behaves the same whether the call came from the browser
 * or the backend.
 */

/** Errors the chain itself produced, or that describe a bad request. */
const PERMANENT_PATTERNS = [
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

/** HTTP statuses worth trying again. */
const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 507, 522, 523, 524]);

/** Transport-level and capacity failures. */
const TRANSIENT_PATTERNS = [
  /timed?\s*out/i,
  /timeout/i,
  /etimedout/i,
  /econnreset/i,
  /econnrefused/i,
  /econnaborted/i,
  /ehostunreach/i,
  /enetunreach/i,
  /eai_again/i,
  /socket hang\s*up/i,
  /fetch failed/i,
  /failed to fetch/i,
  /networkerror/i,
  /network\s+error/i,
  /load failed/i,
  /connection (closed|reset|refused)/i,
  /rate[\s-]?limit/i,
  /too many requests/i,
  /temporarily unavailable/i,
  /try again/i,
  /overloaded/i,
  /bad gateway/i,
  /service unavailable/i,
  /gateway timeout/i,
];

const DEFAULT_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 300;
const DEFAULT_MAX_DELAY_MS = 4_000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * True only for failures a retry could plausibly fix. Unrecognized errors
 * return false so the app fails fast rather than making a user wait through
 * four pointless attempts.
 */
export function isTransientSorobanError(error) {
  const message = (error && error.message) || String(error ?? '');

  // Checked first: a revert can arrive wrapped in text that also looks
  // transport-ish, and a revert must never be retried.
  if (PERMANENT_PATTERNS.some((pattern) => pattern.test(message))) return false;

  const code = error && typeof error.code === 'number' ? error.code : undefined;
  if (code !== undefined) {
    // -32600 invalid request, -32601 method not found, -32602 invalid params
    if (code === -32600 || code === -32601 || code === -32602) return false;
    if (code === -32603 || (code >= -32099 && code <= -32000)) return true;
  }

  // Anchored on purpose: a loose /\d{3}/ would also match the port in
  // "connect ECONNREFUSED 127.0.0.1:443" and misread it as HTTP 4xx.
  const statusMatch =
    message.match(/\bHTTP\s+(\d{3})\b/i) ??
    message.match(/\bstatus(?:\s+code)?\s+(\d{3})\b/i) ??
    message.match(/^(\d{3})\s/);
  if (statusMatch) {
    const status = Number(statusMatch[1]);
    if (TRANSIENT_HTTP_STATUSES.has(status)) return true;
    if (status >= 500) return true;
    if (status >= 400) return false;
  }

  return TRANSIENT_PATTERNS.some((pattern) => pattern.test(message));
}

function computeDelayMs(attempt, { baseDelayMs, maxDelayMs }, random) {
  const base = baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const max = maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  // Full-jitter backoff: grows between attempts while keeping concurrent
  // clients from retrying in lockstep after a shared outage.
  const ceiling = Math.min(max, base * 2 ** attempt);
  return Math.round(ceiling * (0.5 + random() * 0.5));
}

/**
 * Runs `operation`, retrying transient failures with exponential backoff and
 * jitter. Permanent failures are rethrown on the first attempt, so a contract
 * revert costs one call rather than four.
 *
 * @param {string} operationName label used in retry logging
 * @param {(attempt: number) => Promise<T>} operation
 * @param {{retries?: number, baseDelayMs?: number, maxDelayMs?: number,
 *          totalTimeoutMs?: number, sleep?: (ms: number) => Promise<void>,
 *          random?: () => number, onRetry?: (info: object) => void}} [options]
 * @returns {Promise<T>}
 */
export async function withRetry(operationName, operation, options = {}) {
  const { sleep = defaultSleep, random = Math.random, onRetry, totalTimeoutMs } = options;
  const maxRetries = options.retries ?? DEFAULT_RETRIES;
  const startedAt = Date.now();
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;

      const isLastAttempt = attempt === maxRetries;
      if (isLastAttempt || !isTransientSorobanError(error)) {
        if (!isLastAttempt) {
          onRetry?.({
            operation: operationName,
            attempt: attempt + 1,
            outcome: 'permanent',
            reason: (error && error.message) || String(error),
          });
        }
        throw error;
      }

      const delayMs = computeDelayMs(attempt, options, random);

      if (totalTimeoutMs !== undefined) {
        const elapsed = Date.now() - startedAt;
        if (elapsed + delayMs >= totalTimeoutMs) {
          onRetry?.({
            operation: operationName,
            attempt: attempt + 1,
            outcome: 'budget-exhausted',
            elapsedMs: elapsed,
            totalTimeoutMs,
            reason: (error && error.message) || String(error),
          });
          throw error;
        }
      }

      onRetry?.({
        operation: operationName,
        attempt: attempt + 1,
        maxRetries,
        delayMs,
        reason: (error && error.message) || String(error),
      });

      await sleep(delayMs);
    }
  }

  // Unreachable: the loop either returns or throws.
  throw lastError;
}

/**
 * Default retry reporter. Kept quiet in production builds (this is user-facing
 * app code, not server telemetry) but visible during development.
 */
export function reportRetry(info) {
  if (process.env.NODE_ENV === 'production') return;
  console.warn(`[Soroban RPC] ${info.operation} retrying (${info.outcome ?? 'transient'})`, info);
}
