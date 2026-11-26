import { createHash, randomBytes, timingSafeEqual } from "crypto";
import prisma from "../prisma";
import { generateToken } from "../middleware/auth";
import { BadRequestError, ServiceUnavailableError, UnauthorizedError } from "../errors/AppError";
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  fetchTwitterProfile,
  generatePkcePair,
  getTwitterOAuthConfig,
  type TwitterProfile,
} from "./twitterOAuth";
import { TwitterStateStore } from "./twitterStateStore";

export const TWITTER_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const PROVIDER = "twitter";

const STATE_MAX_ENTRIES = 1_000;

// Keyed by the opaque `state` param round-tripped through the redirect, the
// same pattern as the wallet challenge flow in routes/auth.ts but bounded and
// self-sweeping (#438): every call to startTwitterAuth adds an entry, so an
// unthrottled flood must not be able to grow it without limit.
// Exported for the rate-limit/eviction tests.
export const pendingStates = new TwitterStateStore(STATE_MAX_ENTRIES);
pendingStates.startSweeping();

/** Starts the flow and returns the redirect URL plus the browser-binding nonce. */
export function startTwitterAuth(): { redirectUrl: string; bindingNonce: string } {
  const config = getTwitterOAuthConfig();
  if (!config) {
    throw new ServiceUnavailableError("Twitter sign-in is not configured");
  }

  const state = randomBytes(16).toString("hex");
  const bindingNonce = randomBytes(32).toString("hex");
  const { verifier, challenge } = generatePkcePair();
  pendingStates.set(state, {
    codeVerifier: verifier,
    bindingHash: createHash("sha256").update(bindingNonce).digest("hex"),
    expiresAt: Date.now() + TWITTER_OAUTH_STATE_TTL_MS,
  });

  return { redirectUrl: buildAuthorizeUrl(config, state, challenge), bindingNonce };
}

export interface TwitterAuthSession {
  user: { id: number; walletAddress: string | null };
  token: string;
  hasProfile: boolean;
  username?: string;
}

/**
 * Completes the flow: exchanges the code, fetches the Twitter profile,
 * and create-or-attaches a SupportMe account. Matched by
 * (provider, providerAccountId), not by any email the profile might
 * expose, since Twitter's OAuth 2.0 API doesn't return a verified email
 * without an additional, separately-gated scope this app doesn't request.
 */
export async function completeTwitterAuth(
  code: string,
  state: string,
  bindingNonce: string | undefined
): Promise<TwitterAuthSession> {
  const config = getTwitterOAuthConfig();
  if (!config) {
    throw new ServiceUnavailableError("Twitter sign-in is not configured");
  }
  if (!code || !state) {
    throw new BadRequestError("code and state are required");
  }

  // Validate the browser binding against a peek first: a callback that fails
  // it must not consume (and so destroy) the legitimate user's pending state.
  const pending = pendingStates.peek(state);
  if (!pending || !bindingNonce) {
    throw new UnauthorizedError("Invalid or expired OAuth state, please try again");
  }
  const providedHash = createHash("sha256").update(bindingNonce).digest();
  const expectedHash = Buffer.from(pending.bindingHash, "hex");
  if (
    providedHash.length !== expectedHash.length ||
    !timingSafeEqual(providedHash, expectedHash)
  ) {
    throw new UnauthorizedError("Invalid or expired OAuth state, please try again");
  }
  // consume() is single-use: a concurrent replay of the same state loses here.
  if (!pendingStates.consume(state)) {
    throw new UnauthorizedError("Invalid or expired OAuth state, please try again");
  }

  const { accessToken } = await exchangeCodeForToken(config, code, pending.codeVerifier);
  const profile = await fetchTwitterProfile(accessToken);

  const user = await linkTwitterIdentity(profile);
  const creator = await prisma.creator.findUnique({ where: { userId: user.id } });
  const token = generateToken(user.id, user.walletAddress);

  return {
    user: { id: user.id, walletAddress: user.walletAddress },
    token,
    hasProfile: !!creator,
    username: creator?.username,
  };
}

async function linkTwitterIdentity(profile: TwitterProfile) {
  const existing = await prisma.oAuthIdentity.findUnique({
    where: { provider_providerAccountId: { provider: PROVIDER, providerAccountId: profile.id } },
    include: { user: true },
  });

  if (existing) {
    // Account deletion never removes the OAuthIdentity row linking this
    // Twitter profile to its user, so without this check a deleted
    // account's Twitter sign-in would keep returning the same deleted
    // user and minting it a fresh token indefinitely (#270). Refuse
    // rather than silently reviving the account.
    if (existing.user.deletedAt) {
      throw new UnauthorizedError("This account no longer exists");
    }
    await prisma.oAuthIdentity.update({
      where: { id: existing.id },
      data: { updatedAt: new Date() },
    });
    return existing.user;
  }

  // New Twitter identity: create a fresh account and link it in one
  // transaction, so a failure partway through never leaves an orphaned
  // OAuthIdentity row with no user, or vice versa.
  // Third-party tokens are not persisted to database (#367).
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.create({ data: {} });
    await tx.oAuthIdentity.create({
      data: {
        provider: PROVIDER,
        providerAccountId: profile.id,
        userId: user.id,
      },
    });
    return user;
  });
}
