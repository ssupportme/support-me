import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let GET: typeof import('../route').GET;

beforeEach(async () => {
  vi.resetModules();
  delete process.env.COINGECKO_API_KEY;
  ({ GET } = await import('../route'));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GET /api/ngn-rate (#460)', () => {
  it('returns the CoinGecko USDT/NGN rate with its source on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ tether: { ngn: 1520.5 } }), { status: 200 }))
    );

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.rate).toBe(1520.5);
    expect(body.source).toBe('coingecko');
    expect(typeof body.timestamp).toBe('number');
  });

  it('falls back to 1380 when the upstream is not OK', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad gateway', { status: 502 })));

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ rate: 1380, source: 'fallback' });
  });

  it('falls back to 1380 when the fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));

    const res = await GET();
    const body = await res.json();

    expect(body).toMatchObject({ rate: 1380, source: 'fallback' });
  });

  it('falls back to 1380 when the upstream body has no usable rate', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ tether: {} }), { status: 200 }))
    );

    const res = await GET();
    const body = await res.json();

    expect(body).toMatchObject({ rate: 1380, source: 'fallback' });
  });

  it('falls back to 1380 when the upstream rate is not a number', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ tether: { ngn: '1520' } }), { status: 200 }))
    );

    const res = await GET();
    const body = await res.json();

    expect(body).toMatchObject({ rate: 1380, source: 'fallback' });
  });
});
