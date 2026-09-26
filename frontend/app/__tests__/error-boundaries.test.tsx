import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import * as Sentry from '@sentry/nextjs';
import RouteError from '@/app/error';
import GlobalError from '@/app/global-error';

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(() => 'evt-123'),
}));

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  usePathname: () => '/app/settings',
  useRouter: () => ({ refresh }),
}));

vi.mock('@/app/globals.css', () => ({}));

function makeError() {
  return Object.assign(new Error('boom'), { digest: 'abc123' });
}

describe('RouteError (app/error.tsx)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows a friendly fallback instead of a blank page', async () => {
    render(<RouteError error={makeError()} reset={vi.fn()} />);

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /something went wrong/i })).toBeInTheDocument();
    expect(await screen.findByText(/evt-123/)).toBeInTheDocument();
  });

  it('reports the error to Sentry with route context', () => {
    const error = makeError();
    render(<RouteError error={error} reset={vi.fn()} />);

    // The boundary metadata rides along in the typed capture context, which
    // Sentry applies to the event exactly as the old scope mutations did.
    expect(Sentry.captureException).toHaveBeenCalledWith(
      error,
      expect.objectContaining({
        level: 'error',
        tags: expect.objectContaining({
          error_boundary: 'route',
          route: '/app/settings',
          digest: 'abc123',
        }),
        contexts: {
          error_boundary: expect.objectContaining({
            boundary: 'route',
            route: '/app/settings',
            digest: 'abc123',
          }),
        },
      }),
    );
  });

  it('retries in place by refreshing server data and resetting the boundary', () => {
    const reset = vi.fn();
    render(<RouteError error={makeError()} reset={reset} />);

    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    expect(refresh).toHaveBeenCalled();
    expect(reset).toHaveBeenCalled();
  });
});

describe('GlobalError (app/global-error.tsx)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the fallback and reports as a fatal global error', () => {
    const error = makeError();
    const reset = vi.fn();
    // global-error renders its own <html>/<body>, which React warns about
    // when mounted inside the test container; that warning is expected here.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<GlobalError error={error} reset={reset} />);
    consoleError.mockRestore();

    expect(screen.getByRole('heading', { name: /something went wrong/i })).toBeInTheDocument();
    expect(Sentry.captureException).toHaveBeenCalledWith(
      error,
      expect.objectContaining({
        level: 'fatal',
        tags: expect.objectContaining({ error_boundary: 'global' }),
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(reset).toHaveBeenCalled();
  });
});
