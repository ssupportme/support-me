import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import fs from 'fs';
import path from 'path';
import RootLayout from '@/app/layout';
import Home from '@/app/page';
import { AppNav } from '@/components/AppNav';
import { WalletMenu } from '@/components/WalletMenu';

vi.mock('next/navigation', () => ({
  usePathname: () => '/app',
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: { walletAddress: 'GBTESTWALLETADDRESS1234567890' },
    token: 'mock-token',
    loginWithWallet: vi.fn(),
    logout: vi.fn(),
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/context/CreatorContext', () => ({
  useCreator: () => ({
    creator: { username: 'testuser', walletAddress: 'GCREATOR' },
    loading: false,
    invalidate: vi.fn(),
  }),
  CreatorProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/context/ThemeContext', () => ({
  useTheme: () => ({
    theme: 'system',
    resolvedTheme: 'light',
    setTheme: vi.fn(),
  }),
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/OfflineBanner', () => ({
  OfflineBanner: () => <div data-testid="offline-banner" />,
}));

vi.mock('@/components/AppToaster', () => ({
  AppToaster: () => <div data-testid="app-toaster" />,
}));

vi.mock('@/components/TipJar', () => ({
  TipJar: () => <div data-testid="tip-jar" />,
}));

describe('WCAG 2.1 AA Accessibility Standards', () => {
  describe('Skip to Main Content Link (WCAG 2.4.1)', () => {
    it('renders a skip to main content link targeting #main-content', () => {
      render(
        <RootLayout>
          <div>Child Content</div>
        </RootLayout>
      );

      const skipLink = screen.getByRole('link', { name: /skip to main content/i });
      expect(skipLink).toBeInTheDocument();
      expect(skipLink).toHaveAttribute('href', '#main-content');
      expect(skipLink.className).toContain('sr-only');
      expect(skipLink.className).toContain('focus:not-sr-only');
    });
  });

  describe('Landmark Hierarchy (WCAG 1.3.1)', () => {
    it('Landing page provides nav, main#main-content, and footer landmarks', () => {
      render(<Home />);

      const nav = screen.getByRole('navigation', { name: /main navigation/i });
      expect(nav).toBeInTheDocument();

      const main = screen.getByRole('main');
      expect(main).toBeInTheDocument();
      expect(main).toHaveAttribute('id', 'main-content');

      const footer = screen.getByRole('contentinfo');
      expect(footer).toBeInTheDocument();
    });

    it('AppNav provides uniquely labeled navigation landmarks', () => {
      render(<AppNav />);

      const mainNav = screen.getByRole('navigation', { name: /main navigation/i });
      expect(mainNav).toBeInTheDocument();

      const bottomNav = screen.getByRole('navigation', { name: /mobile bottom navigation/i });
      expect(bottomNav).toBeInTheDocument();
    });
  });

  describe('ARIA Controls & States (WCAG 4.1.2)', () => {
    it('AppNav mobile toggle button properly declares aria-expanded and aria-controls', () => {
      render(<AppNav />);

      const toggleButton = screen.getByRole('button', { name: /toggle mobile menu/i });
      expect(toggleButton).toHaveAttribute('aria-expanded', 'false');
      expect(toggleButton).toHaveAttribute('aria-controls', 'mobile-menu-drawer');

      // Click to expand
      fireEvent.click(toggleButton);
      expect(toggleButton).toHaveAttribute('aria-expanded', 'true');
      const drawer = screen.getByTestId('mobile-menu');
      expect(drawer).toHaveAttribute('id', 'mobile-menu-drawer');
    });

    it('WalletMenu trigger declares aria-label and aria-expanded state', () => {
      render(<WalletMenu />);

      const trigger = screen.getByRole('button', { name: /wallet menu/i });
      expect(trigger).toBeInTheDocument();
      expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
      expect(trigger).toHaveAttribute('aria-expanded', 'false');

      fireEvent.click(trigger);
      expect(trigger).toHaveAttribute('aria-expanded', 'true');
    });
  });

  describe('Focus & Contrast CSS Conformance (WCAG 2.4.7 / 2.4.11 / 1.4.3)', () => {
    it('defines --focus-ring tokens and :focus-visible rules in globals.css', () => {
      const globalsCssPath = path.resolve(__dirname, '../globals.css');
      const content = fs.readFileSync(globalsCssPath, 'utf8');

      expect(content).toContain('--focus-ring');
      expect(content).toContain(':focus-visible');
      expect(content).toContain('.btn-brutal:focus-visible');
      expect(content).toContain('.input-brutal:focus-visible');
    });
  });
});
