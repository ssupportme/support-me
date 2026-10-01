'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { TipJarLoader } from '@/components/TipJarLoader';
import { ThemeToggle } from '@/components/ThemeToggle';
import { WalletConnectError, WalletConnectErrorData } from '@/components/WalletConnectError';
import { describeTwitterAuthError } from '@/lib/authErrors';

/**
 * Twitter's callback redirect target (docs/authentication.md "Twitter/X
 * OAuth" §Required environment variables: TWITTER_REDIRECT_URI must be
 * exactly this path). Exchanges the ?code&state for a session the same way
 * AuthContext's other sign-in methods do, then routes onward exactly like
 * the wallet flow does post-login (hasProfile decides /auth/username vs /app).
 *
 * Wrapped in Suspense because useSearchParams() opts a page out of static
 * prerendering without one (https://nextjs.org/docs/messages/missing-suspense-with-csr-bailout).
 */
export default function TwitterCallbackPage() {
  return (
    <Suspense fallback={<TipJarLoader />}>
      <TwitterCallbackContent />
    </Suspense>
  );
}

const DENIED_ERROR: WalletConnectErrorData = {
  title: 'Sign-in cancelled',
  message: 'You declined the Twitter sign-in request.',
  action: 'You can close this page and try again, or use another sign-in method.',
  retryLabel: 'Back to sign in',
};

const MISSING_PARAMS_ERROR: WalletConnectErrorData = {
  title: 'Invalid sign-in link',
  message: "This page is missing information Twitter's sign-in redirect should have included.",
  action: 'Start over from the sign-in page.',
  retryLabel: 'Back to sign in',
};

function TwitterCallbackContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { completeTwitterLogin } = useAuth();
  const [exchangeError, setExchangeError] = useState<WalletConnectErrorData | null>(null);
  const attempted = useRef(false);

  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const deniedError = searchParams.get('error');

  // These two cases are pure functions of the URL Twitter redirected back
  // with - derived directly during render rather than via setState in the
  // effect below, since there is nothing asynchronous about them.
  const paramsError = deniedError ? DENIED_ERROR : !code || !state ? MISSING_PARAMS_ERROR : null;
  const error = paramsError ?? exchangeError;

  useEffect(() => {
    // Effects can run twice in dev (React Strict Mode); the backend's OAuth
    // state is single-use, so a second attempt with the same code/state
    // would fail anyway, but avoiding it keeps behavior identical outside
    // Strict Mode too and skips one throwaway network round-trip.
    if (attempted.current || paramsError || !code || !state) return;
    attempted.current = true;

    completeTwitterLogin(code, state)
      .then((result) => {
        router.replace(result.hasProfile ? '/app' : '/auth/username');
      })
      .catch((err) => {
        setExchangeError(describeTwitterAuthError(err));
      });
  }, [code, state, paramsError, completeTwitterLogin, router]);

  if (error) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4">
        <div className="absolute top-4 right-4">
          <ThemeToggle />
        </div>
        <div className="card-brutal p-8 max-w-md w-full text-center">
          <h1 className="sr-only">Twitter sign-in</h1>
          <WalletConnectError error={error} onRetry={() => router.push('/app')} className="text-left" />
        </div>
      </div>
    );
  }

  return <TipJarLoader />;
}
