import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { verifyAuthToken } from '@/lib/authToken';

// Signs a Cloudinary upload server-side so the API secret never ships to the
// browser. The client asks for a signature, then uploads the file directly to
// Cloudinary with it — the bytes never pass through our server.
//
// Needs three env vars (see .env.local.example):
//   CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
// plus the backend's JWT_SECRET, the shared secret this route verifies session
// tokens with — a signature is only ever handed to a signed-in creator.
//
// We pin the upload to a fixed folder and let Cloudinary's incoming
// transformation downscale avatars, so a signed request can't be abused to
// dump arbitrary large assets elsewhere in the account.
const UPLOAD_FOLDER = 'supportme/avatars';
const INCOMING_TRANSFORM = 'c_limit,w_512,h_512';

// A signature is cheap to mint but each one is redeemable for a real upload
// against our Cloudinary account, so the loop this route otherwise invites is
// capped: changing an avatar needs a signature or two, never ten a minute.
const RATE_LIMIT_PER_MINUTE = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * Fixed-window counter, deliberately in-process like the backend's RateLimiter
 * (backend/src/services/rateLimiter.ts) — there is no Redis in the frontend, so
 * the limit is per server instance rather than global.
 */
class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number
  ) {}

  /** Records an attempt for `key` and reports whether it is within the limit. */
  attempt(key: string): boolean {
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs);

    if (recent.length >= this.max) {
      // Store the pruned window so a key that keeps hammering doesn't grow
      // its entry without bound.
      this.hits.set(key, recent);
      return false;
    }

    this.hits.set(key, [...recent, now]);
    return true;
  }

  /** Whole seconds (>= 1) until `key` may retry; 0 when it isn't limited. */
  retryAfterSeconds(key: string): number {
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
    if (recent.length < this.max) return 0;
    return Math.max(1, Math.ceil((recent[0] + this.windowMs - now) / 1000));
  }
}

const signatureLimiter = new RateLimiter(RATE_LIMIT_PER_MINUTE, RATE_LIMIT_WINDOW_MS);

/** The caller's address as forwarded by the platform's proxy. */
function clientIp(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  return first || request.headers.get('x-real-ip') || 'unknown';
}

export async function POST(request: NextRequest) {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) {
    return NextResponse.json(
      { error: 'Image uploads are not configured on this deployment.' },
      { status: 501 }
    );
  }

  // Without the shared secret there is no way to tell a signed-in creator from
  // anyone else, so nothing may be signed at all: the same 501 as missing
  // Cloudinary config, for the same reason — the deployment is misconfigured,
  // not the request.
  const authSecret = process.env.JWT_SECRET;
  if (!authSecret) {
    return NextResponse.json(
      { error: 'Image uploads are not configured on this deployment.' },
      { status: 501 }
    );
  }

  const authorization = request.headers.get('authorization') ?? '';
  const token = authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : '';
  const user = token ? verifyAuthToken(token, authSecret) : null;
  if (!user) {
    return NextResponse.json({ error: 'Sign in to upload an image.' }, { status: 401 });
  }

  // Both limits are attempted rather than short-circuited, so a script that
  // hops between accounts still spends its IP's budget on every request.
  const userKey = `user:${user.id}`;
  const ipKey = `ip:${clientIp(request)}`;
  const userAllowed = signatureLimiter.attempt(userKey);
  const ipAllowed = signatureLimiter.attempt(ipKey);

  if (!userAllowed || !ipAllowed) {
    const retryAfter = Math.max(
      signatureLimiter.retryAfterSeconds(userKey),
      signatureLimiter.retryAfterSeconds(ipKey)
    );
    return NextResponse.json(
      { error: `Too many upload requests. Try again in ${retryAfter} seconds.` },
      { status: 429, headers: { 'Retry-After': String(retryAfter) } }
    );
  }

  const timestamp = Math.round(Date.now() / 1000);

  // Cloudinary's signature is the SHA-1 of the signed params sorted by key and
  // joined as `k=v` pairs, with the API secret appended. Only params sent to
  // the upload endpoint (besides file, api_key, resource_type) are signed.
  const params: Record<string, string | number> = {
    folder: UPLOAD_FOLDER,
    timestamp,
    transformation: INCOMING_TRANSFORM,
  };

  const toSign = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');

  const signature = crypto
    .createHash('sha1')
    .update(toSign + apiSecret)
    .digest('hex');

  return NextResponse.json({
    cloudName,
    apiKey,
    timestamp,
    signature,
    folder: UPLOAD_FOLDER,
    transformation: INCOMING_TRANSFORM,
  });
}
