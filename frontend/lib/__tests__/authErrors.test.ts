import { describe, it, expect } from 'vitest';
import {
  describeTwitterAuthError,
  describeMagicLinkError,
  describeMagicLinkRequestError,
} from '@/lib/authErrors';

describe('describeTwitterAuthError', () => {
  it('maps an expired/reused OAuth state to a specific retry message', () => {
    const error = describeTwitterAuthError(new Error('Invalid or expired OAuth state, please try again'));
    expect(error.title).toBe('Sign-in link expired');
    expect(error.retryLabel).toBe('Sign in with Twitter');
  });

  it('maps an unconfigured provider to a fallback-to-other-methods message', () => {
    const error = describeTwitterAuthError(new Error('Twitter sign-in is not configured'));
    expect(error.title).toBe('Twitter sign-in unavailable');
    expect(error.action).toMatch(/wallet or email/i);
  });

  it('falls back to a generic message with the raw error text for anything else', () => {
    const error = describeTwitterAuthError(new Error('unexpected network error'));
    expect(error.title).toBe('Twitter sign-in failed');
    expect(error.message).toBe('unexpected network error');
  });

  it('handles a non-Error value without throwing', () => {
    const error = describeTwitterAuthError('plain string failure');
    expect(error.title).toBe('Twitter sign-in failed');
  });
});

describe('describeMagicLinkError (verify step)', () => {
  it('maps an already-used token to a request-new-link message', () => {
    const error = describeMagicLinkError(new Error('This magic link has already been used'));
    expect(error.title).toBe('Link already used');
    expect(error.retryLabel).toBe('Request a new link');
  });

  it('maps an expired token to the same request-new-link message', () => {
    const error = describeMagicLinkError(new Error('This magic link has expired'));
    expect(error.title).toBe('Link expired');
  });

  it('maps an invalid/unknown token to the same request-new-link message', () => {
    const error = describeMagicLinkError(new Error('Invalid or expired magic link'));
    expect(error.title).toBe('Link expired');
  });

  it('falls back to a generic message for anything else', () => {
    const error = describeMagicLinkError(new Error('token is required'));
    expect(error.title).toBe("Couldn't sign you in");
    expect(error.message).toBe('token is required');
  });
});

describe('describeMagicLinkRequestError (send step)', () => {
  it('maps a rate-limit error to a specific wait-and-retry message', () => {
    const error = describeMagicLinkRequestError(new Error('Too many requests, please try again later'));
    expect(error.title).toBe('Too many requests');
  });

  it('falls back to a generic send-failure message for anything else', () => {
    const error = describeMagicLinkRequestError(new Error('network error'));
    expect(error.title).toBe("Couldn't send link");
    expect(error.message).toBe('network error');
  });
});
