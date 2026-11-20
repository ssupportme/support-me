import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { CreatorProvider, useCreator } from '../CreatorContext';
import { useAuth } from '@/context/AuthContext';

vi.mock('@/context/AuthContext', () => ({
  useAuth: vi.fn(),
}));

const mockUseAuth = vi.mocked(useAuth);

const creator = {
  id: 7,
  userId: 3,
  username: 'maya',
  displayName: 'Maya',
  walletAddress: 'GABC123',
  avatarUrl: null,
  donationGoal: 100,
  acceptsXlm: true,
  socialLinks: null,
  acceptsUsdc: true,
  acceptsUsdt: false,
};

function Probe() {
  const { creator: c, loading } = useCreator();
  if (loading) return <p>loading</p>;
  if (!c) return <p>no creator</p>;
  return (
    <p>
      creator:{c.username}:{c.displayName}
    </p>
  );
}

function renderWithAuth(auth: { user: unknown; token: string | null }) {
  mockUseAuth.mockReturnValue(auth as unknown as ReturnType<typeof useAuth>);
  return render(
    <CreatorProvider>
      <Probe />
    </CreatorProvider>
  );
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(creator), { status: 200 }))
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('CreatorProvider (#460)', () => {
  it('loads the creator for a signed-in user', async () => {
    renderWithAuth({ user: { id: 3 }, token: 'tok' });

    await waitFor(() => expect(screen.getByText('creator:maya:Maya')).toBeInTheDocument());
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/creators/me'),
      expect.objectContaining({ headers: { Authorization: `Bearer ${'tok'}` } })
    );
  });

  it('reports no creator when there is no signed-in user and never fetches', async () => {
    renderWithAuth({ user: null, token: null });

    await waitFor(() => expect(screen.getByText('no creator')).toBeInTheDocument());
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports no creator on a 404 (signed in, no profile yet)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));
    renderWithAuth({ user: { id: 3 }, token: 'tok' });

    await waitFor(() => expect(screen.getByText('no creator')).toBeInTheDocument());
  });

  it('keeps the previous creator null and stops loading on a server error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('oops', { status: 500 })));
    renderWithAuth({ user: { id: 3 }, token: 'tok' });

    await waitFor(() => expect(screen.getByText('no creator')).toBeInTheDocument());
  });

  it('keeps the creator null and stops loading when the fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));
    renderWithAuth({ user: { id: 3 }, token: 'tok' });

    await waitFor(() => expect(screen.getByText('no creator')).toBeInTheDocument());
  });

  it('refetches when invalidate is called', async () => {
    function InvalidateProbe() {
      const { invalidate } = useCreator();
      return <button onClick={invalidate}>refresh</button>;
    }
    mockUseAuth.mockReturnValue({ user: { id: 3 }, token: 'tok' } as unknown as ReturnType<
      typeof useAuth
    >);
    render(
      <CreatorProvider>
        <Probe />
        <InvalidateProbe />
      </CreatorProvider>
    );

    await waitFor(() => expect(screen.getByText('creator:maya:Maya')).toBeInTheDocument());
    expect(fetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      screen.getByText('refresh').click();
    });

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  });
});

describe('useCreator (#460)', () => {
  it('throws when used outside CreatorProvider', () => {
    function Outside() {
      useCreator();
      return null;
    }
    expect(() => render(<Outside />)).toThrow('useCreator must be used within CreatorProvider');
  });
});
