'use client';

import { useEffect, useState, useCallback } from 'react';

interface NgnRateData {
  rate: number;
  source: string;
  timestamp: number;
}

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export function useNgnRate(refreshMs = 60_000) {
  const [data, setData] = useState<NgnRateData | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/ngn-rate', { headers: { accept: 'application/json' } });
      if (res.ok) {
        const json = await res.json();
        setData(json);
      }
    } catch {
      // Best effort
    } finally {
      setLoading(false);
    }
  }, []);

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

  const isStale = data ? (Date.now() - data.timestamp) > STALE_THRESHOLD_MS : false;
  const ageMinutes = data ? Math.floor((Date.now() - data.timestamp) / 60000) : null;

  return { ...data, loading, isStale, ageMinutes };
}
