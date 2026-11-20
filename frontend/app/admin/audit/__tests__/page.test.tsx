import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Same setup as the admin overview tests: the allowlist is read from the
// environment at module import time, so each test sets the env var and
// re-imports the page with fresh modules, and the auth state is shared
// through a hoisted object so the mocked useAuth survives the module reset.
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

function entry(id: number, action: string, targetId: string) {
  return {
    id,
    adminId: 1,
    adminWalletAddress: ADMIN_WALLET,
    action,
    targetType: 'user',
    targetId,
    before: null,
    after: { banned: true },
    requestId: `req-${id}`,
    createdAt: '2026-11-19T10:00:00Z',
  };
}

const auditPage1 = {
  items: [entry(1, 'USER_BANNED', '42')],
  pagination: { page: 1, limit: 20, total: 25, totalPages: 2 },
};

async function renderAuditPage() {
  vi.resetModules();
  const { default: AdminAuditPage } = await import('@/app/admin/audit/page');
  return render(<AdminAuditPage />);
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_ADMIN_WALLETS = ADMIN_WALLET;
  authState.user = null;
  authState.token = null;
  authState.loading = false;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(auditPage1), { status: 200 })));
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_ADMIN_WALLETS;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AdminAuditPage gate (#460)', () => {
  it('shows the sign-in screen when nobody is signed in and never fetches', async () => {
    await renderAuditPage();

    expect(screen.getByText('Sign In')).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('shows Not authorized for a signed-in non-admin and never fetches', async () => {
    authState.user = { id: 2, walletAddress: 'GREGULARWALLET123' };
    authState.token = 'tok';
    await renderAuditPage();

    await waitFor(() => expect(screen.getByText('Not authorized')).toBeInTheDocument());
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('AdminAuditPage entries (#460)', () => {
  beforeEach(() => {
    authState.user = { id: 1, walletAddress: ADMIN_WALLET };
    authState.token = 'tok';
  });

  it('fetches the first page with the auth token and renders the entries', async () => {
    await renderAuditPage();

    await waitFor(() => expect(screen.getByText('Admin audit log')).toBeInTheDocument());
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/admin/audit-logs?page=1&limit=20'),
      expect.objectContaining({ headers: { Authorization: 'Bearer tok' } })
    );
    expect(screen.getByText('USER_BANNED')).toBeInTheDocument();
    expect(screen.getByText('user:42')).toBeInTheDocument();
    expect(screen.getByText(/GADMIN…7890/)).toBeInTheDocument();
    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
  });

  it('loads the next page when Next is clicked', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const page = new URL(url).searchParams.get('page');
      const body =
        page === '2'
          ? { items: [entry(2, 'USER_UNBANNED', '43')], pagination: { page: 2, limit: 20, total: 25, totalPages: 2 } }
          : auditPage1;
      return new Response(JSON.stringify(body), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    await renderAuditPage();

    await waitFor(() => expect(screen.getByText('USER_BANNED')).toBeInTheDocument());
    await user.click(screen.getByText('Next'));

    await waitFor(() => expect(screen.getByText('USER_UNBANNED')).toBeInTheDocument());
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/admin/audit-logs?page=2&limit=20'),
      expect.anything()
    );
    expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();
  });

  it('shows the empty state when there are no audit entries', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ items: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 1 } }),
          { status: 200 }
        )
      )
    );
    await renderAuditPage();

    await waitFor(() => expect(screen.getByText('No admin actions recorded.')).toBeInTheDocument());
  });

  it('shows the backend error message when the fetch fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'Admin check failed' }), { status: 403 }))
    );
    await renderAuditPage();

    await waitFor(() => expect(screen.getByText('Admin check failed')).toBeInTheDocument());
  });
});
