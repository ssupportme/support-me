import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useNgnRate, STALE_THRESHOLD_MS } from '../useNgnRate';

describe('useNgnRate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('updates staleness over time as now ticks past threshold', async () => {
    const mockTimestamp = 1000000;
    vi.setSystemTime(mockTimestamp);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          rate: 1400,
          source: 'coingecko',
          timestamp: mockTimestamp,
        }),
      })
    );

    const { result } = renderHook(() => useNgnRate());

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.rate).toBe(1400);
    expect(result.current.source).toBe('coingecko');
    expect(result.current.isStale).toBe(false);
    expect(result.current.ageMinutes).toBe(0);

    // Advance time past STALE_THRESHOLD_MS
    act(() => {
      vi.advanceTimersByTime(STALE_THRESHOLD_MS + 20_000);
    });

    expect(result.current.isStale).toBe(true);
    expect(result.current.ageMinutes).toBeGreaterThanOrEqual(5);
  });

  it('exposes fallback source clearly', async () => {
    const mockTimestamp = 1000000;
    vi.setSystemTime(mockTimestamp);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          rate: 1380,
          source: 'fallback',
          timestamp: mockTimestamp,
        }),
      })
    );

    const { result } = renderHook(() => useNgnRate());

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.source).toBe('fallback');
    expect(result.current.isFallback).toBe(true);
  });
});
