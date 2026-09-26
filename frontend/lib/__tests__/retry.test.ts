import { afterEach, describe, expect, it, vi } from 'vitest';
import { isTransientSorobanError, reportRetry, withRetry } from '../retry';

const fakeSleep = () => Promise.resolve();
const noJitter = () => 1;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isTransientSorobanError', () => {
  it.each([
    ['a socket timeout', new Error('request timed out after 10000ms')],
    ['a connection reset', new Error('read ECONNRESET')],
    ['a browser fetch failure', new TypeError('Failed to fetch')],
    ['a rate limit', new Error('HTTP 429 Too Many Requests')],
    ['an overloaded gateway', new Error('HTTP 502 Bad Gateway')],
    ['an unavailable node', new Error('HTTP 503 Service Unavailable')],
  ])('treats %s as transient', (_label, error) => {
    expect(isTransientSorobanError(error)).toBe(true);
  });

  it.each([
    ['a contract revert', new Error('HostError: Error(Contract, #1)')],
    ['a contract panic', new Error('contract panicked with an error')],
    ['invalid params', new Error('JSON-RPC error: invalid params')],
    ['a bad request', new Error('HTTP 400 Bad Request')],
    ['a forbidden request', new Error('HTTP 403 Forbidden')],
    ['insufficient funds', new Error('insufficient balance for fee')],
  ])('treats %s as permanent', (_label, error) => {
    expect(isTransientSorobanError(error)).toBe(false);
  });

  it('classifies JSON-RPC server errors as transient and client errors as permanent', () => {
    expect(isTransientSorobanError({ code: -32603, message: 'internal' })).toBe(true);
    expect(isTransientSorobanError({ code: -32000, message: 'server error' })).toBe(true);
    expect(isTransientSorobanError({ code: -32602, message: 'invalid params' })).toBe(false);
  });

  it('does not mistake a port number for an HTTP status', () => {
    // A loose /\d{3}/ match would read this as HTTP 443 and call it permanent.
    expect(isTransientSorobanError(new Error('connect ECONNREFUSED 127.0.0.1:443'))).toBe(true);
  });

  it('prefers the permanent reading when a message hints at both', () => {
    expect(isTransientSorobanError(new Error('timeout while evaluating contract'))).toBe(false);
  });

  it('fails fast on an error it cannot classify', () => {
    expect(isTransientSorobanError(new Error('something entirely novel'))).toBe(false);
  });
});

describe('withRetry', () => {
  it('returns the first successful result without sleeping', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const operation = vi.fn().mockResolvedValue('ok');

    await expect(withRetry('op', operation, { sleep, random: noJitter })).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('recovers from a transient failure without surfacing an error', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error('HTTP 503 Service Unavailable'))
      .mockResolvedValue('recovered');

    await expect(withRetry('sendTransaction', operation, { sleep: fakeSleep, random: noJitter }))
      .resolves.toBe('recovered');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('backs off exponentially between attempts', async () => {
    const delays: number[] = [];
    const sleep = vi.fn(async (ms) => {
      delays.push(ms);
    });
    const operation = vi.fn().mockRejectedValue(new Error('Failed to fetch'));

    await expect(
      withRetry('getTransaction', operation, { retries: 3, baseDelayMs: 100, sleep, random: noJitter })
    ).rejects.toThrow('Failed to fetch');

    expect(delays).toHaveLength(3);
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]).toBeGreaterThan(delays[i - 1]);
    }
  });

  it('caps a single backoff delay at maxDelayMs', async () => {
    const delays: number[] = [];
    const sleep = vi.fn(async (ms) => {
      delays.push(ms);
    });
    const operation = vi.fn().mockRejectedValue(new Error('Failed to fetch'));

    await expect(
      withRetry('op', operation, {
        retries: 5,
        baseDelayMs: 1_000,
        maxDelayMs: 2_000,
        sleep,
        random: noJitter,
      })
    ).rejects.toThrow();

    for (const delay of delays) expect(delay).toBeLessThanOrEqual(2_000);
  });

  it('does not retry a permanent failure', async () => {
    const operation = vi.fn().mockRejectedValue(new Error('HostError: Error(Contract, #1)'));

    await expect(withRetry('sendTransaction', operation, { sleep: fakeSleep, random: noJitter }))
      .rejects.toThrow('HostError');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('gives up after the configured number of retries', async () => {
    const operation = vi.fn().mockRejectedValue(new Error('ECONNRESET'));

    await expect(withRetry('op', operation, { retries: 2, sleep: fakeSleep, random: noJitter }))
      .rejects.toThrow('ECONNRESET');
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('does not retry at all when retries is 0', async () => {
    const operation = vi.fn().mockRejectedValue(new Error('ECONNRESET'));

    await expect(withRetry('op', operation, { retries: 0, sleep: fakeSleep })).rejects.toThrow(
      'ECONNRESET'
    );
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('stops retrying once the total timeout would be exceeded', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const operation = vi.fn().mockRejectedValue(new Error('HTTP 503 Service Unavailable'));

    await expect(
      withRetry('op', operation, {
        retries: 5,
        baseDelayMs: 10_000,
        totalTimeoutMs: 50,
        sleep,
        random: noJitter,
      })
    ).rejects.toThrow('HTTP 503');

    expect(sleep).not.toHaveBeenCalled();
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('reports every retry attempt with its reason and delay', async () => {
    const onRetry = vi.fn();
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error('HTTP 503 Service Unavailable'))
      .mockResolvedValue('ok');

    await withRetry('sendTransaction', operation, {
      sleep: fakeSleep,
      random: noJitter,
      baseDelayMs: 250,
      onRetry,
    });

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'sendTransaction',
        attempt: 1,
        delayMs: expect.any(Number),
        reason: 'HTTP 503 Service Unavailable',
      })
    );
  });

  it('reports a permanent failure that will not be retried', async () => {
    const onRetry = vi.fn();
    const operation = vi.fn().mockRejectedValue(new Error('HostError: Error(Contract, #1)'));

    await expect(
      withRetry('sendTransaction', operation, { sleep: fakeSleep, onRetry })
    ).rejects.toThrow('HostError');
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'sendTransaction', outcome: 'permanent' })
    );
  });
});

describe('reportRetry', () => {
  it('logs outside production builds', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    reportRetry({ operation: 'sendTransaction', attempt: 1, delayMs: 300 });
    expect(warn).toHaveBeenCalled();
  });

  it('stays quiet in production builds', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubEnv('NODE_ENV', 'production');
    try {
      reportRetry({ operation: 'sendTransaction', attempt: 1, delayMs: 300 });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
