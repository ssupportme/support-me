import crypto from 'crypto';

/**
 * The payload the backend puts in a session token (see
 * backend/src/middleware/auth.ts).
 */
export interface AuthTokenPayload {
  id: number;
  walletAddress: string | null;
}

function decodeJson(segment: string): Record<string, unknown> | null {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return typeof decoded === 'object' && decoded !== null
      ? (decoded as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Verifies a backend-issued session token (HS256, signed with the backend's
 * JWT_SECRET) from a Next.js route handler, which has no access to the Express
 * auth middleware. Returns the payload, or null when the token is malformed,
 * signed with another key, expired, or not HS256 — callers answer null with a
 * 401 and must not sign anything.
 *
 * The token's own `alg` header is checked rather than trusted: honouring it
 * would let a caller ask to be verified as `none`, or as an asymmetric
 * algorithm whose "key" is public.
 *
 * Unlike the backend middleware this cannot tell whether the account still
 * exists — that would need a database round-trip from the frontend, so a token
 * for a since-deleted account stays usable here until it expires.
 */
export function verifyAuthToken(token: string, secret: string): AuthTokenPayload | null {
  const segments = token.split('.');
  if (segments.length !== 3) return null;
  const [header, payload, signature] = segments;

  const decodedHeader = decodeJson(header);
  if (!decodedHeader || decodedHeader.alg !== 'HS256') return null;

  const expected = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest();
  const provided = Buffer.from(signature, 'base64url');
  // timingSafeEqual throws on a length mismatch, so compare lengths first.
  if (provided.length !== expected.length || !crypto.timingSafeEqual(expected, provided)) {
    return null;
  }

  const claims = decodeJson(payload);
  if (!claims || typeof claims.id !== 'number') return null;
  if (typeof claims.exp === 'number' && claims.exp * 1000 <= Date.now()) return null;

  return {
    id: claims.id,
    walletAddress: typeof claims.walletAddress === 'string' ? claims.walletAddress : null,
  };
}
