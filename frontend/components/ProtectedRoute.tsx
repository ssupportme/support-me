'use client';

import { ReactNode, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { TipJarLoader } from '@/components/TipJarLoader';
import { ThemeToggle } from '@/components/ThemeToggle';
import { WalletConnectError, WalletConnectErrorData } from '@/components/WalletConnectError';
import { categorizeWalletError } from '@/lib/walletErrors';

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { user, loading, loginWithWallet } = useAuth();
  const [connecting, setConnecting] = useState(false);
  const [walletError, setWalletError] = useState<WalletConnectErrorData | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);

  if (loading) {
    return <TipJarLoader />;
  }

  if (!user) {
    const handleConnect = async () => {
      setConnecting(true);
      setWalletError(null);
      setSessionExpired(false);
      try {
        await loginWithWallet();
      } catch (err) {
        const error = categorizeWalletError(err);
        setWalletError(error);
        // Check if error message indicates session/token issues
        const errorMessage = ('rawMessage' in error && error.rawMessage) || error.message || '';
        if (errorMessage.toLowerCase().includes('session') || 
            errorMessage.toLowerCase().includes('token') ||
            errorMessage.toLowerCase().includes('expired') ||
            errorMessage.toLowerCase().includes('unauthorized')) {
          setSessionExpired(true);
        }
      } finally {
        setConnecting(false);
      }
    };

    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4">
        <div className="absolute top-4 right-4">
          <ThemeToggle />
        </div>
        <div className="card-brutal p-8 max-w-md w-full text-center">
          <h1 className="text-2xl font-extrabold text-ink mb-2">
            {sessionExpired ? 'Session Expired' : 'Connect Your Wallet'}
          </h1>
          <p className="text-muted font-medium mb-6">
            {sessionExpired
              ? 'Your session has expired. Please reconnect your wallet to continue.'
              : 'Sign in by connecting your Stellar wallet and approving a sign-in request.'}
          </p>
          {walletError && <WalletConnectError error={walletError} onRetry={handleConnect} className="mb-4" />}
          <button
            onClick={handleConnect}
            disabled={connecting}
            className="btn-brutal btn-brutal-primary w-full"
          >
            {connecting ? 'Connecting...' : 'Connect Wallet'}
          </button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
