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

function coingeckoOk(body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
}

describe('GET /api/prices (#460)', () => {
  it('returns the CoinGecko XLM price plus the stablecoin values on success', async () => {
    vi.stubGlobal('fetch', coingeckoOk({ stellar: { usd: 0.1234 } }));

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.prices).toEqual({ XLM: 0.1234, USDC: 1, USDT: 1 });
  });

  it('asks CoinGecko for the stellar id', async () => {
    const fetchMock = coingeckoOk({ stellar: { usd: 0.5 } });
    vi.stubGlobal('fetch', fetchMock);

    await GET();

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('ids=stellar&vs_currencies=usd'),
      expect.objectContaining({ headers: expect.objectContaining({ accept: 'application/json' }) })
    );
  });

  it('sends the demo API key when one is configured', async () => {
    process.env.COINGECKO_API_KEY = 'demo-key';
    const fetchMock = coingeckoOk({ stellar: { usd: 0.5 } });
    vi.stubGlobal('fetch', fetchMock);

    await GET();

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-cg-demo-api-key': 'demo-key' }),
      })
    );
  });

  it('falls back to the stablecoin values when the upstream is not OK', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rate limited', { status: 429 })));

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.prices).toEqual({ USDC: 1, USDT: 1 });
  });

  it('falls back to the stablecoin values when the fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.prices).toEqual({ USDC: 1, USDT: 1 });
  });

  it('ignores a CoinGecko response with no usable XLM price', async () => {
    vi.stubGlobal('fetch', coingeckoOk({ stellar: {} }));

    const res = await GET();
    const body = await res.json();

    expect(body.prices).toEqual({ USDC: 1, USDT: 1 });
  });
});
