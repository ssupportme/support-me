import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/cloudinary-sign/route';

const JWT_SECRET = 'test-only-shared-jwt-secret';
const CLOUDINARY_API_SECRET = 'test-only-cloudinary-secret';

const CONFIGURED_ENV = {
  CLOUDINARY_CLOUD_NAME: 'test-cloud',
  CLOUDINARY_API_KEY: 'test-key',
  CLOUDINARY_API_SECRET,
  JWT_SECRET,
};

// The route caps a single user at 10 signatures per minute (RATE_LIMIT_PER_MINUTE).
const RATE_LIMIT_PER_MINUTE = 10;

beforeEach(() => {
  for (const [name, value] of Object.entries(CONFIGURED_ENV)) vi.stubEnv(name, value);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Hand-rolls a backend-shaped session token so the test doesn't share the route's verification code. */
function signToken(payload: Record<string, unknown> = {}, secret = JWT_SECRET): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const body = encode({
    id: 7,
    walletAddress: null,
    exp: Math.floor(Date.now() / 1000) + 60,
    ...payload,
  });
  const signature = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

/** Every request carries its own forwarded IP so per-IP buckets don't leak across cases. */
function post(headers: Record<string, string>) {
  return POST(
    new NextRequest(new URL('/api/cloudinary-sign', 'https://support.test'), {
      method: 'POST',
      headers,
    })
  );
}

describe('POST /api/cloudinary-sign', () => {
  it('rejects a caller with no session: 401 and no signature', async () => {
    const res = await post({ 'x-forwarded-for': '203.0.113.10' });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBeTruthy();
    expect(body.signature).toBeUndefined();
  });

  it('rejects a token that was not signed with the shared secret', async () => {
    const res = await post({
      authorization: `Bearer ${signToken({}, 'not-the-shared-secret')}`,
      'x-forwarded-for': '203.0.113.11',
    });

    expect(res.status).toBe(401);
    expect((await res.json()).signature).toBeUndefined();
  });

  it('rejects an expired token', async () => {
    const expired = signToken({ exp: Math.floor(Date.now() / 1000) - 60 });
    const res = await post({
      authorization: `Bearer ${expired}`,
      'x-forwarded-for': '203.0.113.12',
    });

    expect(res.status).toBe(401);
  });

  it('signs an upload for a signed-in creator', async () => {
    const res = await post({
      authorization: `Bearer ${signToken()}`,
      'x-forwarded-for': '203.0.113.13',
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cloudName).toBe('test-cloud');
    expect(body.folder).toBe('supportme/avatars');
    expect(body.transformation).toBe('c_limit,w_512,h_512');

    const expected = crypto
      .createHash('sha1')
      .update(
        `folder=supportme/avatars&timestamp=${body.timestamp}` +
          `&transformation=c_limit,w_512,h_512${CLOUDINARY_API_SECRET}`
      )
      .digest('hex');
    expect(body.signature).toBe(expected);
  });

  it('stops a single user past the per-minute signature limit', async () => {
    const authorization = `Bearer ${signToken({ id: 4242 })}`;
    const forwarded = '198.51.100.20';

    for (let i = 0; i < RATE_LIMIT_PER_MINUTE; i++) {
      const res = await post({ authorization, 'x-forwarded-for': forwarded });
      expect(res.status).toBe(200);
    }

    const blocked = await post({ authorization, 'x-forwarded-for': forwarded });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBeTruthy();
    expect((await blocked.json()).signature).toBeUndefined();
  });
});
