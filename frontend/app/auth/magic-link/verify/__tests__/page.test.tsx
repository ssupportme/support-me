import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import MagicLinkVerifyPage from '../page';
import { useAuth } from '@/context/AuthContext';

const replace = vi.hoisted(() => vi.fn());
const push = vi.hoisted(() => vi.fn());
const params = vi.hoisted(() => ({ current: new URLSearchParams() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push }),
  useSearchParams: () => params.current,
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: vi.fn(),
}));

const mockUseAuth = vi.mocked(useAuth);

describe('MagicLinkVerifyPage', () => {
  beforeEach(() => {
    replace.mockClear();
    push.mockClear();
    params.current = new URLSearchParams();
  });

  it('verifies the token and routes to /auth/username for a new account', async () => {
    const verifyMagicLink = vi.fn().mockResolvedValue({
      user: { id: 1, email: 'you@example.com', walletAddress: null },
      token: 'jwt',
      hasProfile: false,
    });
    mockUseAuth.mockReturnValue({ verifyMagicLink } as unknown as ReturnType<typeof useAuth>);
    params.current = new URLSearchParams({ token: 'the-token' });

    render(<MagicLinkVerifyPage />);

    await waitFor(() => expect(verifyMagicLink).toHaveBeenCalledWith('the-token'));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/auth/username'));
  });

  it('routes to /app for a returning account', async () => {
    const verifyMagicLink = vi.fn().mockResolvedValue({
      user: { id: 1, email: 'you@example.com', walletAddress: null },
      token: 'jwt',
      hasProfile: true,
      username: 'you',
    });
    mockUseAuth.mockReturnValue({ verifyMagicLink } as unknown as ReturnType<typeof useAuth>);
    params.current = new URLSearchParams({ token: 'the-token' });

    render(<MagicLinkVerifyPage />);

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/app'));
  });

  it('shows an invalid-link message when the token query param is missing', async () => {
    const verifyMagicLink = vi.fn();
    mockUseAuth.mockReturnValue({ verifyMagicLink } as unknown as ReturnType<typeof useAuth>);
    params.current = new URLSearchParams();

    render(<MagicLinkVerifyPage />);

    expect(await screen.findByText('Invalid sign-in link')).toBeInTheDocument();
    expect(verifyMagicLink).not.toHaveBeenCalled();
  });

  it('shows "link already used" for a reused token', async () => {
    const verifyMagicLink = vi.fn().mockRejectedValue(new Error('This magic link has already been used'));
    mockUseAuth.mockReturnValue({ verifyMagicLink } as unknown as ReturnType<typeof useAuth>);
    params.current = new URLSearchParams({ token: 'used-token' });

    render(<MagicLinkVerifyPage />);

    expect(await screen.findByText('Link already used')).toBeInTheDocument();
  });

  it('shows "link expired" for an expired token', async () => {
    const verifyMagicLink = vi.fn().mockRejectedValue(new Error('This magic link has expired'));
    mockUseAuth.mockReturnValue({ verifyMagicLink } as unknown as ReturnType<typeof useAuth>);
    params.current = new URLSearchParams({ token: 'expired-token' });

    render(<MagicLinkVerifyPage />);

    expect(await screen.findByText('Link expired')).toBeInTheDocument();
  });
});
