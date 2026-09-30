/**
 * Maps Twitter OAuth and magic-link sign-in failures to actionable copy, the
 * same {title, message, action, retryLabel} shape WalletConnectError already
 * renders (see components/WalletConnectError.tsx) so both flows can share one
 * error-card component. Unlike walletErrors.js, which heuristically matches
 * third-party wallet-extension messages, these matchers are keyed off the
 * backend's own documented, stable error strings (see docs/authentication.md
 * "Endpoints" sections for each method) since this backend is ours to rely on.
 */

export interface AuthFlowError {
  title: string;
  message: string;
  action?: string;
  retryLabel?: string;
}

const OAUTH_STATE_PATTERN = /invalid or expired oauth state/i;
const NOT_CONFIGURED_PATTERN = /sign-in is not configured/i;

/** Categorizes a Twitter OAuth sign-in failure (from getTwitterRedirectUrl or completeTwitterLogin). */
export function describeTwitterAuthError(err: unknown): AuthFlowError {
  const message = err instanceof Error ? err.message : String(err ?? '');

  if (OAUTH_STATE_PATTERN.test(message)) {
    return {
      title: 'Sign-in link expired',
      message: 'This Twitter sign-in link is more than 10 minutes old, or was already used.',
      action: 'Start over by clicking "Sign in with Twitter" again.',
      retryLabel: 'Sign in with Twitter',
    };
  }

  if (NOT_CONFIGURED_PATTERN.test(message)) {
    return {
      title: 'Twitter sign-in unavailable',
      message: 'Sign-in with Twitter is not set up on this environment right now.',
      action: 'Try signing in with your wallet or email instead.',
    };
  }

  return {
    title: 'Twitter sign-in failed',
    message: message || 'Something unexpected went wrong connecting your Twitter account.',
    action: 'You can try again, or sign in with your wallet or email instead.',
    retryLabel: 'Try again',
  };
}

const LINK_USED_PATTERN = /already been used/i;
const LINK_EXPIRED_PATTERN = /has expired/i;
const LINK_INVALID_PATTERN = /invalid or expired magic link/i;
const RATE_LIMITED_PATTERN = /too many|rate limit/i;

/** Categorizes a magic-link failure from verifyMagicLink (requestMagicLink's own errors are simpler — see the request form). */
export function describeMagicLinkError(err: unknown): AuthFlowError {
  const message = err instanceof Error ? err.message : String(err ?? '');

  if (LINK_USED_PATTERN.test(message)) {
    return {
      title: 'Link already used',
      message: 'This sign-in link has already been used. Each link only works once.',
      action: 'Request a new link to sign in.',
      retryLabel: 'Request a new link',
    };
  }

  if (LINK_EXPIRED_PATTERN.test(message) || LINK_INVALID_PATTERN.test(message)) {
    return {
      title: 'Link expired',
      message: 'This sign-in link is invalid or has expired. Links are only valid for 15 minutes.',
      action: 'Request a new link to sign in.',
      retryLabel: 'Request a new link',
    };
  }

  return {
    title: "Couldn't sign you in",
    message: message || 'Something unexpected went wrong verifying this sign-in link.',
    action: 'Request a new link to try again.',
    retryLabel: 'Request a new link',
  };
}

/** Categorizes a requestMagicLink (send) failure - the 429 case is the one worth naming specifically. */
export function describeMagicLinkRequestError(err: unknown): AuthFlowError {
  const message = err instanceof Error ? err.message : String(err ?? '');

  if (RATE_LIMITED_PATTERN.test(message)) {
    return {
      title: 'Too many requests',
      message: "You've requested too many sign-in links. Please wait a bit before trying again.",
      retryLabel: 'Try again',
    };
  }

  return {
    title: "Couldn't send link",
    message: message || 'Something unexpected went wrong sending your sign-in link.',
    retryLabel: 'Try again',
  };
}
