import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { AppNav } from '@/components/AppNav';

vi.mock('next/navigation', () => ({
  usePathname: () => '/app',
}));

vi.mock('@/components/WalletMenu', () => ({
  WalletMenu: () => <div data-testid="wallet-menu" />,
}));

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
