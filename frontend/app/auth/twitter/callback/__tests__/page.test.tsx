import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import TwitterCallbackPage from '../page';
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

describe('TwitterCallbackPage', () => {
  beforeEach(() => {
    replace.mockClear();
    push.mockClear();
    params.current = new URLSearchParams();
  });

  it('exchanges code and state, then routes to /auth/username when the user has no profile yet', async () => {
    const completeTwitterLogin = vi.fn().mockResolvedValue({
      user: { id: 1, walletAddress: null },
      token: 'jwt',
      hasProfile: false,
    });
    mockUseAuth.mockReturnValue({ completeTwitterLogin } as unknown as ReturnType<typeof useAuth>);
    params.current = new URLSearchParams({ code: 'abc', state: 'xyz' });

    render(<TwitterCallbackPage />);

    await waitFor(() => expect(completeTwitterLogin).toHaveBeenCalledWith('abc', 'xyz'));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/auth/username'));
  });

  it('routes to /app when the user already has a profile', async () => {
    const completeTwitterLogin = vi.fn().mockResolvedValue({
      user: { id: 1, walletAddress: null },
      token: 'jwt',
      hasProfile: true,
      username: 'someone',
    });
    mockUseAuth.mockReturnValue({ completeTwitterLogin } as unknown as ReturnType<typeof useAuth>);
    params.current = new URLSearchParams({ code: 'abc', state: 'xyz' });

    render(<TwitterCallbackPage />);

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/app'));
  });

  it('shows a cancelled-sign-in message when Twitter redirects back with ?error=', async () => {
    const completeTwitterLogin = vi.fn();
    mockUseAuth.mockReturnValue({ completeTwitterLogin } as unknown as ReturnType<typeof useAuth>);
    params.current = new URLSearchParams({ error: 'access_denied', state: 'xyz' });

    render(<TwitterCallbackPage />);

    expect(await screen.findByText('Sign-in cancelled')).toBeInTheDocument();
    expect(completeTwitterLogin).not.toHaveBeenCalled();
  });

  it('shows an invalid-link message when code or state is missing', async () => {
    const completeTwitterLogin = vi.fn();
    mockUseAuth.mockReturnValue({ completeTwitterLogin } as unknown as ReturnType<typeof useAuth>);
    params.current = new URLSearchParams({ code: 'abc' }); // no state

    render(<TwitterCallbackPage />);

    expect(await screen.findByText('Invalid sign-in link')).toBeInTheDocument();
    expect(completeTwitterLogin).not.toHaveBeenCalled();
  });

  it('shows the categorized error when the exchange fails (e.g. expired state)', async () => {
    const completeTwitterLogin = vi.fn().mockRejectedValue(
      new Error('Invalid or expired OAuth state, please try again')
    );
    mockUseAuth.mockReturnValue({ completeTwitterLogin } as unknown as ReturnType<typeof useAuth>);
    params.current = new URLSearchParams({ code: 'abc', state: 'stale' });

    render(<TwitterCallbackPage />);

    expect(await screen.findByText('Sign-in link expired')).toBeInTheDocument();
  });
});
