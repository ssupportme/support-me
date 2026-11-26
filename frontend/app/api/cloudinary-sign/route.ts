import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { API_URL } from '@/lib/api';
import { RateLimiter } from '@/lib/rateLimiter';

// Signs a Cloudinary upload server-side so the API secret never ships to the
// browser. The client asks for a signature, then uploads the file directly to
// Cloudinary with it — the bytes never pass through our server.
//
// Needs three env vars (see .env.local.example):
//   CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
// A signature is only ever handed to a signed-in creator (see isAuthenticated).
//
// We pin the upload to a fixed folder and let Cloudinary's incoming
// transformation downscale avatars, so a signed request can't be abused to
// dump arbitrary large assets elsewhere in the account.
const UPLOAD_FOLDER = 'supportme/avatars';
const INCOMING_TRANSFORM = 'c_limit,w_512,h_512';

// This route is only meant for a signed-in creator changing their own avatar
// (#364): without an auth check, a script could request signatures in a
// loop and upload against our Cloudinary account until quota/cost limits
// are hit, or hand a signature to a third party. There's no shared JWT
// secret between the frontend and backend deployments, so the session is
// verified by asking the backend (which already owns that check) rather
// than duplicating JWT verification here.
//
// The backend's session cookie is scoped to the backend's own origin (see
// AUTH_COOKIE_NAME in backend/src/routes/auth.ts), so it's never visible to
// this frontend-origin route — the caller must send the token explicitly as
// an Authorization header, the same way app/settings/page.tsx already talks
// to the backend directly.
async function isAuthenticated(request: NextRequest): Promise<boolean> {
  const authHeader = request.headers.get('authorization');
  if (!authHeader) return false;

  try {
    const res = await fetch(`${API_URL}/api/auth/me`, {
      headers: { authorization: authHeader },
    });
    return res.ok;
  } catch {
    // Backend unreachable: fail closed rather than minting a signature we
    // can't actually attribute to a real session.
    return false;
  }
}

const RATE_LIMIT_WINDOW_MS = Number(process.env.CLOUDINARY_SIGN_RATE_LIMIT_WINDOW_MS) || 60_000;
const RATE_LIMIT_MAX = Number(process.env.CLOUDINARY_SIGN_RATE_LIMIT_MAX) || 10;

// Keyed separately by user and by IP, so one abusive IP can't exhaust a
// shared budget for every signed-in creator behind it (and vice versa).
const userLimiter = new RateLimiter(RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
const ipLimiter = new RateLimiter(RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);

function clientIp(request: NextRequest): string {
  const forwardedFor = request.headers.get('x-forwarded-for');
  return forwardedFor?.split(',')[0]?.trim() || 'unknown';
}

export async function POST(request: NextRequest) {
  if (!(await isAuthenticated(request))) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }

  const ip = clientIp(request);
  // The auth check above only proves the session is valid, not who it
  // belongs to — using the raw Authorization header (guaranteed present at
  // this point) as the per-user rate-limit key separates users without
  // needing to decode the token.
  const userKey = request.headers.get('authorization') as string;

  if (!userLimiter.attempt(userKey) || !ipLimiter.attempt(ip)) {
    const retryAfter = Math.max(
      userLimiter.retryAfterSeconds(userKey),
      ipLimiter.retryAfterSeconds(ip),
      1
    );
    return NextResponse.json(
      { error: 'Too many signature requests, please try again shortly.' },
      { status: 429, headers: { 'Retry-After': String(retryAfter) } }
    );
  }

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) {
    return NextResponse.json(
      { error: 'Image uploads are not configured on this deployment.' },
      { status: 501 }
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
