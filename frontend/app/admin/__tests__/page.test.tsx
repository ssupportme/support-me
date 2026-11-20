import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// The admin allowlist is read from the environment at module import time
// (lib/admin.ts), so each test sets the env var and re-imports the page with
// fresh modules. The auth state is shared through a hoisted object so the
// mocked useAuth survives the module reset.
const authState = vi.hoisted(() => ({
  user: null as { id: number; walletAddress: string | null } | null,
  token: null as string | null,
  loading: false,
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => authState,
}));

vi.mock('@/components/AppNav', () => ({
  AppNav: () => <nav data-testid="app-nav">nav</nav>,
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.ComponentProps<'a'> & { href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

const ADMIN_WALLET = 'GADMINWALLET1234567890';

const overview = {
  totalSignups: 12,
  totalCreators: 5,
  earningsByCurrency: { XLM: 120.5, USDC: 30 },
  users: [
    {
      id: 1,
      walletAddress: 'GUSERWALLET123456789',
      joinedAt: '2026-11-01T00:00:00Z',
      username: 'maya',
      displayName: 'Maya',
      earningsByCurrency: { XLM: 10 },
    },
    {
      id: 2,
      walletAddress: 'GOTHERWALLET999999999',
      joinedAt: '2026-11-02T00:00:00Z',
      username: null,
      displayName: null,
      earningsByCurrency: {},
    },
  ],
};

async function renderAdminPage() {
  vi.resetModules();
  const { default: AdminPage } = await import('@/app/admin/page');
  return render(<AdminPage />);
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_ADMIN_WALLETS = ADMIN_WALLET;
  authState.user = null;
  authState.token = null;
  authState.loading = false;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(overview), { status: 200 })));
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_ADMIN_WALLETS;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AdminPage gate (#460)', () => {
  it('shows the sign-in screen when nobody is signed in and never fetches', async () => {
    await renderAdminPage();

    expect(screen.getByText('Sign In')).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('shows the loading state while auth is resolving and never fetches', async () => {
    authState.loading = true;
    await renderAdminPage();

    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('shows Not authorized for a signed-in non-admin and never fetches', async () => {
    authState.user = { id: 2, walletAddress: 'GREGULARWALLET123' };
    authState.token = 'tok';
    await renderAdminPage();

    await waitFor(() => expect(screen.getByText('Not authorized')).toBeInTheDocument());
    expect(screen.getByText('This page is restricted to platform admins.')).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('shows Not authorized when no admin wallets are configured at all', async () => {
    process.env.NEXT_PUBLIC_ADMIN_WALLETS = '';
    authState.user = { id: 1, walletAddress: ADMIN_WALLET };
    authState.token = 'tok';
    await renderAdminPage();

    await waitFor(() => expect(screen.getByText('Not authorized')).toBeInTheDocument());
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('AdminPage overview (#460)', () => {
  beforeEach(() => {
    authState.user = { id: 1, walletAddress: ADMIN_WALLET };
    authState.token = 'tok';
  });

  it('fetches the overview with the auth token and renders the headline stats', async () => {
    await renderAdminPage();

    await waitFor(() => expect(screen.getByText('Admin')).toBeInTheDocument());
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/admin/overview'),
      expect.objectContaining({ headers: { Authorization: 'Bearer tok' } })
    );
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    // The total appears once the effect picks the first currency as default.
    await waitFor(() => expect(screen.getByText(/120\.50/)).toBeInTheDocument());
  });

  it('renders the users table with names, short wallets and earnings', async () => {
    await renderAdminPage();

    await waitFor(() => expect(screen.getByText('Maya')).toBeInTheDocument());
    expect(screen.getByText('Users (2)')).toBeInTheDocument();
    expect(screen.getByText('GUSERW…6789')).toBeInTheDocument();
    expect(screen.getByText('No profile')).toBeInTheDocument();
    expect(screen.getByText('10.00 XLM')).toBeInTheDocument();
  });

  it('shows the backend error message when the overview fetch fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'Admin check failed' }), { status: 403 }))
    );
    await renderAdminPage();

    await waitFor(() => expect(screen.getByText('Admin check failed')).toBeInTheDocument());
  });

  it('shows a generic error when the overview fetch fails with no error body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    await renderAdminPage();

    await waitFor(() => expect(screen.getByText('Failed to load admin overview')).toBeInTheDocument());
  });

  it('switches the earnings total when the currency toggle is used', async () => {
    const user = userEvent.setup();
    await renderAdminPage();

    await waitFor(() => expect(screen.getByText(/120\.50/)).toBeInTheDocument());
    await user.click(screen.getByText('USDC'));

    expect(screen.getByText(/30\.00/)).toBeInTheDocument();
  });
});
