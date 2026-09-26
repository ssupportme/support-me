import * as Sentry from '@sentry/nextjs';

export type ErrorBoundaryName = 'route' | 'global';

// Reports an error caught by one of the app's error boundaries to Sentry,
// tagged with the boundary and the route the user was on so issues can be
// grouped/filtered by page. The Error object carries the stack trace; the
// digest links client reports to the server-side error for the same render.
export function reportBoundaryError(
  error: Error & { digest?: string },
  boundary: ErrorBoundaryName,
  pathname?: string | null,
) {
  const route =
    pathname ?? (typeof window !== 'undefined' ? window.location.pathname : undefined);
  const search = typeof window !== 'undefined' ? window.location.search : undefined;

  // Sentry's scope helpers (withScope/getIsolationScope) are not exported in
  // @sentry/nextjs's type surface, so the boundary metadata is attached via the
  // typed capture context instead — same level/tags/contexts, no untyped cast.
  return Sentry.captureException(error, {
    level: boundary === 'global' ? 'fatal' : 'error',
    tags: {
      error_boundary: boundary,
      ...(route ? { route } : {}),
      ...(error.digest ? { digest: error.digest } : {}),
    },
    contexts: {
      error_boundary: {
        boundary,
        route,
        search: search || undefined,
        digest: error.digest,
      },
    },
  });
}
