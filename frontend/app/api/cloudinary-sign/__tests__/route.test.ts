import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/api', () => ({ API_URL: 'http://api.test' }));

let POST: typeof import('../route').POST;

beforeEach(async () => {
  vi.resetModules();
  process.env.CLOUDINARY_CLOUD_NAME = 'test-cloud';
  process.env.CLOUDINARY_API_KEY = 'test-key';
  process.env.CLOUDINARY_API_SECRET = 'test-secret';
  delete process.env.CLOUDINARY_SIGN_RATE_LIMIT_MAX;
  delete process.env.CLOUDINARY_SIGN_RATE_LIMIT_WINDOW_MS;
  ({ POST } = await import('../route'));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function authedRequest(authorization = 'Bearer jwt-token', ip = '203.0.113.1') {
  return new NextRequest('http://localhost/api/cloudinary-sign', {
    method: 'POST',
    headers: { authorization, 'x-forwarded-for': ip },
  });
}

describe('POST /api/cloudinary-sign (#364)', () => {
  it('returns 401 with no signature when there is no Authorization header', async () => {
    const req = new NextRequest('http://localhost/api/cloudinary-sign', { method: 'POST' });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.signature).toBeUndefined();
  });

  it('returns 401 when the backend rejects the token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })));

    const res = await POST(authedRequest());

    expect(res.status).toBe(401);
    expect(fetch).toHaveBeenCalledWith(
      'http://api.test/api/auth/me',
      expect.objectContaining({ headers: { authorization: 'Bearer jwt-token' } })
    );
  });

  it('signs a request for an authenticated caller', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })));

    const res = await POST(authedRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      cloudName: 'test-cloud',
      apiKey: 'test-key',
      folder: 'supportme/avatars',
    });
    expect(typeof body.signature).toBe('string');
  });

  it('rejects a request past the per-user rate limit', async () => {
    process.env.CLOUDINARY_SIGN_RATE_LIMIT_MAX = '2';
    vi.resetModules();
    ({ POST } = await import('../route'));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })));

    await POST(authedRequest('Bearer same-user', '198.51.100.1'));
    await POST(authedRequest('Bearer same-user', '198.51.100.2'));
    const res = await POST(authedRequest('Bearer same-user', '198.51.100.3'));

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeTruthy();
  });

  it('rejects a request past the per-IP rate limit even across different users', async () => {
    process.env.CLOUDINARY_SIGN_RATE_LIMIT_MAX = '2';
    vi.resetModules();
    ({ POST } = await import('../route'));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })));

    await POST(authedRequest('Bearer user-a', '198.51.100.9'));
    await POST(authedRequest('Bearer user-b', '198.51.100.9'));
    const res = await POST(authedRequest('Bearer user-c', '198.51.100.9'));

    expect(res.status).toBe(429);
  });

  it('still returns 501 for missing Cloudinary config, after auth passes', async () => {
    delete process.env.CLOUDINARY_CLOUD_NAME;
    vi.resetModules();
    ({ POST } = await import('../route'));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })));

    const res = await POST(authedRequest());

    expect(res.status).toBe(501);
  });

  it('fails closed with 401 when the backend cannot be reached at all', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('backend down');
    }));

    const res = await POST(authedRequest());
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.signature).toBeUndefined();
  });
});
