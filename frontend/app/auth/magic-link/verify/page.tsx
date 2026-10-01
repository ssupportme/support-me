'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { TipJarLoader } from '@/components/TipJarLoader';
import { ThemeToggle } from '@/components/ThemeToggle';
import { WalletConnectError, WalletConnectErrorData } from '@/components/WalletConnectError';
import { describeMagicLinkError } from '@/lib/authErrors';

/**
 * Landing page for the emailed magic link (docs/authentication.md "Magic
 * link" §How the flow works: `${APP_URL}/auth/magic-link/verify?token=...`).
 * POSTs the token to /api/auth/magic-link/verify - the emailed link itself
 * is a plain GET, the verification call it triggers from here is a POST,
 * per the backend's documented endpoint.
 *
 * Wrapped in Suspense because useSearchParams() opts a page out of static
 * prerendering without one (https://nextjs.org/docs/messages/missing-suspense-with-csr-bailout).
 */
export default function MagicLinkVerifyPage() {
  return (
    <Suspense fallback={<TipJarLoader />}>
      <MagicLinkVerifyContent />
    </Suspense>
  );
}

const MISSING_TOKEN_ERROR: WalletConnectErrorData = {
  title: 'Invalid sign-in link',
  message: 'This link is missing its sign-in token.',
  action: 'Request a new sign-in link.',
  retryLabel: 'Back to sign in',
};

function MagicLinkVerifyContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { verifyMagicLink } = useAuth();
  const [verifyError, setVerifyError] = useState<WalletConnectErrorData | null>(null);
  const attempted = useRef(false);

  const token = searchParams.get('token');
  // A pure function of the URL - derived directly during render rather than
  // via setState in the effect below, since there is nothing asynchronous
  // about a missing query param.
  const paramsError = token ? null : MISSING_TOKEN_ERROR;
  const error = paramsError ?? verifyError;

  useEffect(() => {
    // Same Strict-Mode-safe single-attempt guard as the Twitter callback:
    // the token is single-use, so a second verify call would only fail.
    if (attempted.current || paramsError || !token) return;
    attempted.current = true;

    verifyMagicLink(token)
      .then((result) => {
        router.replace(result.hasProfile ? '/app' : '/auth/username');
      })
      .catch((err) => {
        setVerifyError(describeMagicLinkError(err));
      });
  }, [token, paramsError, verifyMagicLink, router]);

  if (error) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4">
        <div className="absolute top-4 right-4">
          <ThemeToggle />
        </div>
        <div className="card-brutal p-8 max-w-md w-full text-center">
          <h1 className="sr-only">Magic link sign-in</h1>
          <WalletConnectError error={error} onRetry={() => router.push('/app')} className="text-left" />
        </div>
      </div>
    );
  }

  return <TipJarLoader />;
}
