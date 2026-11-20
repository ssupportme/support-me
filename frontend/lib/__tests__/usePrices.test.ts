import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePrices } from '../usePrices';
import { fetchUsdPrices } from '@/lib/prices';

vi.mock('@/lib/prices', () => ({
  fetchUsdPrices: vi.fn(),
}));

const mockFetchUsdPrices = vi.mocked(fetchUsdPrices);
const prices = { XLM: 0.12, USDC: 1 };

beforeEach(() => {
  vi.useFakeTimers();
  mockFetchUsdPrices.mockClear();
  mockFetchUsdPrices.mockResolvedValue(prices);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('usePrices (#460)', () => {
  it('starts null and sets the prices once the fetch resolves', async () => {
    const { result } = renderHook(() => usePrices(60_000));
    expect(result.current).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current).toEqual(prices);
    expect(mockFetchUsdPrices).toHaveBeenCalledTimes(1);
  });

  it('sets an empty map when the fetch returns an empty map', async () => {
    mockFetchUsdPrices.mockResolvedValue({});
    const { result } = renderHook(() => usePrices(60_000));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current).toEqual({});
  });

  it('stays null when the fetch returns null', async () => {
    mockFetchUsdPrices.mockResolvedValue(null as unknown as Record<string, number>);
    const { result } = renderHook(() => usePrices(60_000));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current).toBeNull();
  });

  it('refetches on the refresh interval', async () => {
    const { result } = renderHook(() => usePrices(60_000));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mockFetchUsdPrices).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(mockFetchUsdPrices).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual(prices);
  });

  it('stops refetching after unmount', async () => {
    const { result, unmount } = renderHook(() => usePrices(60_000));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mockFetchUsdPrices).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(mockFetchUsdPrices).toHaveBeenCalledTimes(1);
    expect(result.current).toEqual(prices);
  });
});
