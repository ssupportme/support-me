import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TipChart, buildBuckets } from '../TipChart';

const DAY = 86_400_000;

function donation(amount: number, daysAgo: number, currency = 'XLM') {
  return {
    amount,
    currency,
    createdAt: new Date(Date.now() - daysAgo * DAY).toISOString(),
  };
}

describe('buildBuckets (#460)', () => {
  it('always returns 12 buckets', () => {
    const { buckets } = buildBuckets([donation(5, 1)], 30);
    expect(buckets).toHaveLength(12);
  });

  it('sums volume and count across buckets and keeps out-of-window tips out', () => {
    const { buckets } = buildBuckets([donation(10, 1), donation(5, 2), donation(99, 40)], 30);
    const volume = buckets.reduce((s, b) => s + b.volume, 0);
    const count = buckets.reduce((s, b) => s + b.count, 0);
    expect(volume).toBe(15);
    expect(count).toBe(2);
  });

  it('puts the most recent tip in the last bucket', () => {
    const { buckets } = buildBuckets([donation(10, 0.01)], 7);
    expect(buckets[11].volume).toBe(10);
    expect(buckets[11].count).toBe(1);
    expect(buckets.slice(0, 11).every((b) => b.count === 0)).toBe(true);
  });

  it('returns empty buckets with no donations', () => {
    const { buckets, unit } = buildBuckets([], 30);
    expect(buckets).toHaveLength(12);
    expect(buckets.every((b) => b.volume === 0 && b.count === 0)).toBe(true);
    // 30 days split into 12 buckets is 2.5 days per bucket, so the week unit.
    expect(unit).toBe('wk');
  });

  it('spans all time from the earliest donation and uses the month unit for long spans', () => {
    const { buckets, unit } = buildBuckets([donation(10, 400), donation(5, 1)], null);
    const volume = buckets.reduce((s, b) => s + b.volume, 0);
    expect(volume).toBe(15);
    expect(unit).toBe('mo');
  });

  it('uses the week unit for a 90-day window', () => {
    const { unit } = buildBuckets([donation(10, 1)], 90);
    expect(unit).toBe('wk');
  });
});

describe('TipChart (#460)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-20T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the empty state with no donations', () => {
    render(<TipChart donations={[]} />);
    expect(screen.getByText('No tips in this window yet.')).toBeInTheDocument();
  });

  it('shows the tip count and total volume for the default 30-day window', () => {
    render(<TipChart donations={[donation(10, 1), donation(5, 2)]} />);
    expect(screen.getByText(/2 tips/)).toBeInTheDocument();
    expect(screen.getByText('15.00 XLM')).toBeInTheDocument();
  });

  it('excludes tips older than the window from the totals', () => {
    render(<TipChart donations={[donation(10, 1), donation(99, 40)]} />);
    expect(screen.getByText(/1 tip/)).toBeInTheDocument();
    expect(screen.getByText('10.00 XLM')).toBeInTheDocument();
  });

  it('includes older tips when the range is switched to All time', () => {
    render(<TipChart donations={[donation(10, 1), donation(99, 40)]} />);
    fireEvent.change(screen.getByLabelText('Filter tips by time range'), {
      target: { value: 'all' },
    });
    expect(screen.getByText(/2 tips/)).toBeInTheDocument();
    expect(screen.getByText('109.00 XLM')).toBeInTheDocument();
  });

  it('narrows the window when the range is switched to 7 days', () => {
    render(<TipChart donations={[donation(10, 1), donation(5, 10)]} />);
    fireEvent.change(screen.getByLabelText('Filter tips by time range'), {
      target: { value: '7d' },
    });
    expect(screen.getByText(/1 tip/)).toBeInTheDocument();
    expect(screen.getByText('10.00 XLM')).toBeInTheDocument();
  });
});
