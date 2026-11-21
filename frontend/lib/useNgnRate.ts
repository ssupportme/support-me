'use client';

import { useEffect, useState } from 'react';

export interface NgnRateData {
  rate: number;
  source: string;
  timestamp: number;
}

export const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export function useNgnRate(refreshMs = 60_000) {
  const [data, setData] = useState<NgnRateData | null>(null);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let active = true;
    const loadRate = async () => {
      try {
        const res = await fetch('/api/ngn-rate', { headers: { accept: 'application/json' } });
        if (res.ok && active) {
          const json = await res.json();
          setData(json);
        }
      } catch {
        // Best effort
      } finally {
        if (active) setLoading(false);
      }
    };
    loadRate();
    const timer = window.setInterval(loadRate, refreshMs);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [refreshMs]);

  // Ticking now state to compute staleness and age against upstream timestamp
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 10_000);
    return () => window.clearInterval(timer);
  }, []);

  const isStale = data ? now - data.timestamp > STALE_THRESHOLD_MS : false;
  const ageMinutes = data ? Math.floor((now - data.timestamp) / 60000) : null;
  const isFallback = data?.source === 'fallback';

  return {
    ...data,
    loading,
    isStale,
    ageMinutes,
    isFallback,
  };
}
