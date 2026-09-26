import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { AppNav } from '@/components/AppNav';

const pathname = vi.hoisted(() => ({ current: '/app' }));

vi.mock('next/navigation', () => ({
  usePathname: () => pathname.current,
}));

vi.mock('@/components/WalletMenu', () => ({
  WalletMenu: () => <div data-testid="wallet-menu" />,
}));

/** The desktop top nav, scoped so mobile surfaces don't confuse the queries. */
function primaryNav() {
  return within(screen.getByTestId('primary-nav'));
}

beforeEach(() => {
  pathname.current = '/app';
});

describe('AppNav Mobile Responsiveness', () => {
  it('renders brand logo and wallet menu chip', () => {
    render(<AppNav />);
    expect(screen.getByText('SupportMe')).toBeInTheDocument();
    expect(screen.getByTestId('wallet-menu')).toBeInTheDocument();
  });

  it('toggles mobile navigation drawer on hamburger button click', () => {
    render(<AppNav />);

    const toggleButton = screen.getByRole('button', { name: /toggle mobile menu/i });
    expect(toggleButton).toBeInTheDocument();

    // Mobile nav initially closed
    expect(screen.queryByTestId('mobile-menu')).not.toBeInTheDocument();

    // Open mobile menu
    fireEvent.click(toggleButton);

    const mobileMenu = screen.getByTestId('mobile-menu');
    expect(mobileMenu).toBeInTheDocument();
    const subscriptionLink = within(mobileMenu).getByRole('link', { name: /subscriptions/i });
    expect(subscriptionLink).toBeInTheDocument();
    expect(subscriptionLink).toHaveAttribute('href', '/app/subscriptions');

    // Close mobile menu on click
    fireEvent.click(toggleButton);
    expect(screen.queryByTestId('mobile-menu')).not.toBeInTheDocument();
  });
});

describe('AppNav desktop navigation (#151)', () => {
  it('shows only App, Dashboard and Discover in the top nav', () => {
    render(<AppNav />);
    const nav = primaryNav();

    expect(nav.getByRole('link', { name: /^app$/i })).toHaveAttribute('href', '/app');
    expect(nav.getByRole('link', { name: /dashboard/i })).toHaveAttribute('href', '/dashboard');
    expect(nav.getByRole('link', { name: /discover/i })).toHaveAttribute('href', '/discover');
  });

  it.each([
    ['Subscriptions', '/app/subscriptions'],
    ['Activity', '/activity'],
    ['Settings', '/settings'],
  ])('moves %s out of the top nav', (_label, href) => {
    render(<AppNav />);
    // Still reachable in the mobile drawer, just not in the desktop top nav.
    expect(
      primaryNav().queryByRole('link', { name: new RegExp(_label, 'i') })
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /toggle mobile menu/i }));
    expect(
      within(screen.getByTestId('mobile-menu')).getByRole('link', { name: new RegExp(_label, 'i') })
    ).toHaveAttribute('href', href);
  });

  it('renders exactly three top-level links', () => {
    render(<AppNav />);
    expect(primaryNav().getAllByRole('link')).toHaveLength(3);
  });
});

describe('AppNav active link highlighting', () => {
  it.each([
    ['/app', /^app$/i],
    ['/dashboard', /dashboard/i],
    ['/discover', /discover/i],
  ])('marks %s as the current page', (route, name) => {
    pathname.current = route;
    render(<AppNav />);

    const active = primaryNav().getByRole('link', { name });
    expect(active).toHaveAttribute('aria-current', 'page');
  });

  it('marks only one top-level link active at a time', () => {
    pathname.current = '/discover';
    render(<AppNav />);

    const current = primaryNav().getAllByRole('link', { current: 'page' });
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAttribute('href', '/discover');
  });

  it('does not mark App active on a nested App route', () => {
    // /app/subscriptions is a real route, not a variant of /app, so the top
    // nav should show no active state there rather than lighting up "App".
    pathname.current = '/app/subscriptions';
    render(<AppNav />);
    expect(primaryNav().queryAllByRole('link', { current: 'page' })).toHaveLength(0);
  });
});

describe('AppNav mobile surfaces are unchanged (#151)', () => {
  it('keeps all six destinations in the mobile drawer', () => {
    render(<AppNav />);
    fireEvent.click(screen.getByRole('button', { name: /toggle mobile menu/i }));

    const drawer = within(screen.getByTestId('mobile-menu'));
    const expected = [
      ['/app', /^app$/i],
      ['/dashboard', /dashboard/i],
      ['/discover', /discover/i],
      ['/app/subscriptions', /subscriptions/i],
      ['/activity', /activity/i],
      ['/settings', /settings/i],
    ];
    for (const [href, name] of expected) {
      expect(drawer.getByRole('link', { name })).toHaveAttribute('href', href);
    }
  });

  it('keeps the four bottom tab bar destinations', () => {
    render(<AppNav />);
    const bottomNav = within(screen.getByRole('navigation', { name: /mobile bottom navigation/i }));

    expect(bottomNav.getAllByRole('link')).toHaveLength(4);
    expect(bottomNav.getByRole('link', { name: /^app$/i })).toHaveAttribute('href', '/app');
    expect(bottomNav.getByRole('link', { name: /dashboard/i })).toHaveAttribute('href', '/dashboard');
    expect(bottomNav.getByRole('link', { name: /discover/i })).toHaveAttribute('href', '/discover');
    expect(bottomNav.getByRole('link', { name: /activity/i })).toHaveAttribute('href', '/activity');
  });
});
