'use client';

import { ReactNode } from 'react';
import { useAuth } from '@/context/AuthContext';
import { TipJarLoader } from '@/components/TipJarLoader';
import { ThemeToggle } from '@/components/ThemeToggle';
import { AuthMethods } from '@/components/AuthMethods';

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return <TipJarLoader />;
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4">
        <div className="absolute top-4 right-4">
          <ThemeToggle />
        </div>
        <div className="card-brutal p-8 max-w-md w-full text-center">
          <h1 className="text-2xl font-extrabold text-ink mb-2">Sign In</h1>
          <p className="text-muted font-medium mb-6">
            Connect your Stellar wallet, sign in with Twitter, or use a magic link.
          </p>
          <AuthMethods />
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
