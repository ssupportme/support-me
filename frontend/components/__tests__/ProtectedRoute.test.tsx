import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { useAuth } from '@/context/AuthContext';

vi.mock('@/context/AuthContext', () => ({
  useAuth: vi.fn(),
}));

const mockUseAuth = vi.mocked(useAuth);

describe('ProtectedRoute', () => {
  beforeEach(() => {
    mockUseAuth.mockReset();
  });

  // ProtectedRoute's unauthenticated state renders AuthMethods, which reads
  // all four sign-in methods off useAuth() - not just loginWithWallet.
  function authMock(overrides: Partial<ReturnType<typeof useAuth>> = {}) {
    return {
      user: null,
      token: null,
      loading: false,
      loginWithWallet: vi.fn(),
      getTwitterRedirectUrl: vi.fn(),
      completeTwitterLogin: vi.fn(),
      requestMagicLink: vi.fn(),
      verifyMagicLink: vi.fn(),
      logout: vi.fn(),
      ...overrides,
    };
  }

  it('shows a loading state while auth is initializing', () => {
    mockUseAuth.mockReturnValue(authMock({ loading: true }));

    render(
      <ProtectedRoute>
        <div>Secret content</div>
      </ProtectedRoute>
    );

    expect(screen.getByRole('status', { name: /loading/i })).toBeInTheDocument();
    expect(screen.queryByText('Secret content')).not.toBeInTheDocument();
  });

  it('prompts to sign in when there is no user', () => {
    mockUseAuth.mockReturnValue(authMock());

    render(
      <ProtectedRoute>
        <div>Secret content</div>
      </ProtectedRoute>
    );

    expect(screen.getByRole('heading', { name: 'Sign In' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /connect wallet/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in with twitter/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /email me a sign-in link/i })).toBeInTheDocument();
    expect(screen.queryByText('Secret content')).not.toBeInTheDocument();
  });

  it('calls loginWithWallet when the connect button is clicked', async () => {
    const loginWithWallet = vi.fn().mockResolvedValue({});
    mockUseAuth.mockReturnValue(authMock({ loginWithWallet }));

    render(
      <ProtectedRoute>
        <div>Secret content</div>
      </ProtectedRoute>
    );

    fireEvent.click(screen.getByRole('button', { name: /connect wallet/i }));

    await waitFor(() => expect(loginWithWallet).toHaveBeenCalledTimes(1));
  });

  it('renders children when a user is authenticated', () => {
    mockUseAuth.mockReturnValue(authMock({ user: { id: 1, walletAddress: 'GABC' }, token: 'jwt' }));

    render(
      <ProtectedRoute>
        <div>Secret content</div>
      </ProtectedRoute>
    );

    expect(screen.getByText('Secret content')).toBeInTheDocument();
  });
});
