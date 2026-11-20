import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useNgnRate } from '../useNgnRate';

const NOW = new Date('2026-11-20T12:00:00Z').getTime();

function rateResponse(timestamp: number, rate = 1520) {
  return new Response(JSON.stringify({ rate, source: 'coingecko', timestamp }), { status: 200 });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubGlobal('fetch', vi.fn(async () => rateResponse(NOW)));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useNgnRate (#460)', () => {
  it('starts loading and then returns the fresh rate', async () => {
    const { result } = renderHook(() => useNgnRate(60_000));
    expect(result.current.loading).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current).toMatchObject({ rate: 1520, source: 'coingecko', loading: false });
    expect(result.current.isStale).toBe(false);
    expect(result.current.ageMinutes).toBe(0);
  });

  it('stops loading with no data when the fetch is not OK', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad gateway', { status: 502 })));
    const { result } = renderHook(() => useNgnRate(60_000));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.rate).toBeUndefined();
    expect(result.current.isStale).toBe(false);
    expect(result.current.ageMinutes).toBeNull();
  });

  it('stops loading with no data when the fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));
    const { result } = renderHook(() => useNgnRate(60_000));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.rate).toBeUndefined();
  });

  it('marks a rate older than 5 minutes as stale with its age', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => rateResponse(NOW - 10 * 60 * 1000)));
    const { result } = renderHook(() => useNgnRate(60_000));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.isStale).toBe(true);
    expect(result.current.ageMinutes).toBe(10);
  });

  it('does not mark a 1-minute-old rate as stale', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => rateResponse(NOW - 60 * 1000)));
    const { result } = renderHook(() => useNgnRate(60_000));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.isStale).toBe(false);
    expect(result.current.ageMinutes).toBe(1);
  });

  it('refetches on the refresh interval', async () => {
    const { result } = renderHook(() => useNgnRate(60_000));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.current.rate).toBe(1520);
  });

  it('stops refetching after unmount', async () => {
    const { unmount } = renderHook(() => useNgnRate(60_000));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetch).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
