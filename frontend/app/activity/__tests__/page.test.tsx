import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import ActivityPage from '@/app/activity/page';

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.ComponentProps<'a'> & { href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/activity',
}));

vi.mock('@/components/AppNav', () => ({
  AppNav: () => <nav data-testid="app-nav" />,
}));

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 400) {
  return { ok, status, json: async () => body } as Response;
}

const emptyOverview = {
  totalSignups: 0,
  totalCreators: 0,
  earningsByCurrency: {},
};

const populatedOverview = {
  totalSignups: 2,
  totalCreators: 1,
  earningsByCurrency: { XLM: 42, USDC: 10 },
};

describe('ActivityPage', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('shows a skeleton while the overview is loading', () => {
    vi.mocked(fetch).mockReturnValue(new Promise(() => {})); // never resolves

    const { container } = render(<ActivityPage />);

    expect(container.querySelectorAll('.motion-safe\\:animate-pulse').length).toBeGreaterThan(0);
  });

  it('shows a friendly empty state with a CTA when nothing has happened yet', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(emptyOverview));

    render(<ActivityPage />);

    await waitFor(() => expect(screen.getByText('No activity yet')).toBeInTheDocument());

    expect(screen.queryByText('Sign-ups')).not.toBeInTheDocument();

    const cta = screen.getByRole('link', { name: /create your page/i });
    expect(cta).toBeInTheDocument();
    expect(cta).toHaveAttribute('href', '/auth/username');
  });

  it('states what the page is for and what the numbers mean', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(populatedOverview));

    render(<ActivityPage />);

    await waitFor(() => expect(screen.getByText('Sign-ups')).toBeInTheDocument());

    expect(screen.getByRole('heading', { name: 'Community Activity' })).toBeInTheDocument();
    expect(screen.getByText(/aggregated across all accounts/i)).toBeInTheDocument();
    expect(screen.getByText(/never listed here/i)).toBeInTheDocument();
    expect(screen.getByText('Accounts created on SupportMe')).toBeInTheDocument();
    expect(screen.getByText('Accounts with a creator page')).toBeInTheDocument();
  });

  it('renders aggregate headline stats only', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(populatedOverview));

    render(<ActivityPage />);

    await waitFor(() => expect(screen.getByText('Sign-ups')).toBeInTheDocument());

    expect(await screen.findByText('42.00')).toBeInTheDocument();
    expect(screen.queryByText('No activity yet')).not.toBeInTheDocument();
  });

  it('renders only error state with Retry and no zero cards on fetch failure (#454)', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: 'Failed to load activity overview' }, false, 500));

    render(<ActivityPage />);

    await waitFor(() => expect(screen.getByText('Failed to load activity overview')).toBeInTheDocument());

    // No zeroed stat cards or empty state rendered
    expect(screen.queryByText('Sign-ups')).not.toBeInTheDocument();
    expect(screen.queryByText('Creators')).not.toBeInTheDocument();
    expect(screen.queryByText('Total Creator earnings')).not.toBeInTheDocument();
    expect(screen.queryByText('No activity yet')).not.toBeInTheDocument();

    const retryBtn = screen.getByRole('button', { name: /retry/i });
    expect(retryBtn).toBeInTheDocument();

    // Clicking retry refetches
    vi.mocked(fetch).mockResolvedValue(jsonResponse(populatedOverview));
    fireEvent.click(retryBtn);

    await waitFor(() => expect(screen.getByText('Sign-ups')).toBeInTheDocument());
  });

  it('exposes aria-pressed state on currency toggle buttons (#454)', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(populatedOverview));

    render(<ActivityPage />);

    await waitFor(() => expect(screen.getByText('Sign-ups')).toBeInTheDocument());

    const xlmButton = screen.getByRole('button', { name: 'XLM' });
    const usdcButton = screen.getByRole('button', { name: 'USDC' });

    expect(xlmButton).toHaveAttribute('aria-pressed', 'true');
    expect(usdcButton).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(usdcButton);

    expect(xlmButton).toHaveAttribute('aria-pressed', 'false');
    expect(usdcButton).toHaveAttribute('aria-pressed', 'true');
  });

  it('never renders per-user rows, names, wallets or earnings, even if the API returns them', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        ...populatedOverview,
        users: [
          {
            id: 1,
            walletAddress: 'GALICE1234567890',
            joinedAt: '2026-01-01T00:00:00.000Z',
            username: 'alice',
            displayName: 'Alice',
            earningsByCurrency: { XLM: 42 },
          },
        ],
      }),
    );

    const { container } = render(<ActivityPage />);

    await waitFor(() => expect(screen.getByText('Sign-ups')).toBeInTheDocument());

    expect(container.querySelector('table')).not.toBeInTheDocument();
    expect(screen.queryByText('Alice')).not.toBeInTheDocument();
    expect(screen.queryByText(/GALICE/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Users \(/)).not.toBeInTheDocument();
  });

  it('requests the overview without a pagination parameter', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(populatedOverview));

    render(<ActivityPage />);

    await waitFor(() => expect(screen.getByText('Sign-ups')).toBeInTheDocument());
    const url = String(vi.mocked(fetch).mock.calls[0][0]);
    expect(url).toMatch(/\/api\/activity\/overview$/);
  });
});
