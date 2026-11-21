import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import { WalletMenu, accountLabel } from '@/components/WalletMenu';

const pathname = vi.hoisted(() => ({ current: '/app' }));
const logout = vi.hoisted(() => vi.fn());
const mockUser = vi.hoisted(() => ({
  current: { walletAddress: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV' as string | null, email: null as string | null },
}));

vi.mock('next/navigation', () => ({
  usePathname: () => pathname.current,
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: mockUser.current,
    logout,
  }),
}));

/** Open the menu and return a scoped query helper for its contents. */
function openMenu() {
  render(<WalletMenu />);
  fireEvent.click(screen.getByRole('button', { expanded: false }));
  return within(screen.getByRole('menu'));
}

beforeEach(() => {
  pathname.current = '/app';
  logout.mockClear();
  mockUser.current = { walletAddress: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV', email: null };
});

describe('WalletMenu account chip (#10, #11, #455)', () => {
  it('shows a sliced wallet address for a wallet-signed-in user', () => {
    render(<WalletMenu />);
    expect(screen.getByRole('button', { expanded: false })).toHaveTextContent('GABC…STUV');
  });

  it('shows the email for a magic-link user with no wallet', () => {
    mockUser.current = { walletAddress: null, email: 'you@example.com' };
    render(<WalletMenu />);
    expect(screen.getByRole('button', { expanded: false })).toHaveTextContent('you@example.com');
  });

  it('truncates long emails to prevent overflow on mobile (#455)', () => {
    mockUser.current = { walletAddress: null, email: 'verylonguseremailaddress@example.com' };
    render(<WalletMenu />);
    expect(screen.getByRole('button', { expanded: false })).toHaveTextContent('verylo…@example.com');
  });

  it('falls back to a generic label for a Twitter user with neither', () => {
    mockUser.current = { walletAddress: null, email: null };
    render(<WalletMenu />);
    expect(screen.getByRole('button', { expanded: false })).toHaveTextContent('Account');
  });
});

describe('WalletMenu secondary destinations (#151)', () => {
  it('renders the three secondary destinations in the menu', () => {
    const menu = openMenu();

    expect(menu.getByRole('menuitem', { name: /subscriptions/i })).toHaveAttribute(
      'href',
      '/app/subscriptions'
    );
    expect(menu.getByRole('menuitem', { name: /activity/i })).toHaveAttribute('href', '/activity');
    expect(menu.getByRole('menuitem', { name: /settings/i })).toHaveAttribute('href', '/settings');
  });

  it('shows the secondary destinations at every breakpoint, not just mobile', () => {
    const menu = openMenu();
    const container = menu.getByRole('menuitem', { name: /settings/i }).closest('div');
    expect(container?.className).not.toContain('sm:hidden');
  });

  it('keeps sign out available alongside the new links', () => {
    const menu = openMenu();
    expect(menu.getByRole('menuitem', { name: /sign out/i })).toBeInTheDocument();
  });

  it('closes the menu when a destination is chosen', () => {
    const menu = openMenu();
    fireEvent.click(menu.getByRole('menuitem', { name: /activity/i }));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});

describe('WalletMenu active destination', () => {
  it.each([
    ['/app/subscriptions', /subscriptions/i, 'Subscriptions'],
    ['/activity', /activity/i, 'Activity'],
    ['/settings', /settings/i, 'Settings'],
  ])('marks %s as the current page', (route, name, label) => {
    pathname.current = route;
    const menu = openMenu();

    const current = menu.getAllByRole('menuitem', { current: 'page' });
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent(label);
  });

  it('marks nothing active on an unrelated route', () => {
    pathname.current = '/app';
    const menu = openMenu();
    expect(menu.queryAllByRole('menuitem', { current: 'page' })).toHaveLength(0);
  });
});

describe('WalletMenu dismissal and keyboard navigation (#455)', () => {
  it('closes on Escape and returns focus to the trigger button', () => {
    render(<WalletMenu />);
    const trigger = screen.getByRole('button', { expanded: false });
    fireEvent.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes on an outside click', () => {
    openMenu();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('opens and roves focus with arrow keys', () => {
    vi.useFakeTimers();
    render(<WalletMenu />);
    const trigger = screen.getByRole('button', { expanded: false });

    // Open with ArrowDown
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(screen.getByRole('menu')).toBeInTheDocument();

    act(() => {
      vi.runAllTimers();
    });

    const menu = screen.getByRole('menu');
    const items = within(menu).getAllByRole('menuitem');
    expect(document.activeElement).toBe(items[0]);

    // Navigate with ArrowDown
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);

    // Navigate with ArrowUp
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[0]);

    vi.useRealTimers();
  });
});
