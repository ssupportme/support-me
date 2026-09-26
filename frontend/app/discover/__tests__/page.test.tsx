import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import DiscoverPage from '@/app/discover/page';
import { useAuth } from '@/context/AuthContext';

vi.mock('@/context/AuthContext', () => ({
  useAuth: vi.fn(),
}));

const mockUseAuth = vi.mocked(useAuth);

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500) {
  return { ok, status, json: async () => body } as Response;
}

describe('DiscoverPage', () => {
  beforeEach(() => {
    mockUseAuth.mockReturnValue({
      user: null,
      token: null,
      loading: false,
      loginWithWallet: vi.fn(),
      logout: vi.fn(),
    });
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('shows the empty state and an error message instead of crashing when the API returns a malformed response', async () => {
    // No `items`/`pagination` at all — e.g. an error payload returned with a
    // 200 status, or a backend shape change. Reading `.items`/`.pagination`
    // directly previously threw and tripped the route error boundary.
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: 'Internal Server Error' }));

    render(<DiscoverPage />);

    await waitFor(() => expect(screen.getByText('No creators yet')).toBeInTheDocument());
    expect(
      screen.getByText('Something went wrong loading creators. Please try again.')
    ).toBeInTheDocument();
  });

  it('shows the empty state instead of crashing when the API returns an unparsable/empty body', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('Unexpected end of JSON input');
      },
    } as unknown as Response);

    render(<DiscoverPage />);

    await waitFor(() => expect(screen.getByText('No creators yet')).toBeInTheDocument());
  });

  it('shows the empty state when items is present but pagination is missing', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ items: [] }));

    render(<DiscoverPage />);

    await waitFor(() => expect(screen.getByText('No creators yet')).toBeInTheDocument());
    expect(
      screen.getByText('Something went wrong loading creators. Please try again.')
    ).toBeInTheDocument();
  });

  it('renders creators normally for a well-formed response', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        items: [
          {
            id: 1,
            username: 'alice',
            displayName: 'Alice',
            bio: null,
            avatarUrl: null,
            _count: { donations: 3 },
          },
        ],
        pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
      })
    );

    render(<DiscoverPage />);

    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    expect(screen.getByText('3 tips received')).toBeInTheDocument();
    expect(screen.queryByText('No creators yet')).not.toBeInTheDocument();
  });
});
