'use client';

import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { connectWallet, disconnectWallet, signMessage } from '@/lib/wallet';

interface User {
  id: number;
  walletAddress: string;
}

interface LoginResult {
  user: User;
  token: string;
  hasProfile: boolean;
  username?: string;
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  loading: boolean;
  loginWithWallet: () => Promise<LoginResult>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const savedToken = localStorage.getItem('authToken');
    const savedUser = localStorage.getItem('authUser');
    if (savedToken && savedUser) {
      setToken(savedToken);
      setUser(JSON.parse(savedUser));
    }
    setLoading(false);
  }, []);

  const loginWithWallet = async (): Promise<LoginResult> => {
    const address = await connectWallet();

    const challengeRes = await fetch('http://localhost:4000/api/auth/challenge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress: address }),
    });
    if (!challengeRes.ok) {
      const error = await challengeRes.json();
      throw new Error(error.error || 'Failed to start sign-in challenge');
    }
    const { message } = await challengeRes.json();

    const signedMessage = await signMessage(message, address);

    const verifyRes = await fetch('http://localhost:4000/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress: address, signedMessage }),
    });
    if (!verifyRes.ok) {
      const error = await verifyRes.json();
      throw new Error(error.error || 'Sign-in verification failed');
    }
    const data: LoginResult = await verifyRes.json();

    setToken(data.token);
    setUser(data.user);
    localStorage.setItem('authToken', data.token);
    localStorage.setItem('authUser', JSON.stringify(data.user));
    return data;
  };

  const logout = () => {
    setUser(null);
    setToken(null);
    localStorage.removeItem('authToken');
    localStorage.removeItem('authUser');
    disconnectWallet().catch(() => {});
  };

  return (
    <AuthContext.Provider value={{ user, token, loading, loginWithWallet, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}
