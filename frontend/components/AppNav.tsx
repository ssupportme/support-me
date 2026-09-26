'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  GridViewIcon,
  DashboardSquare01Icon,
  Settings01Icon,
  RepeatIcon,
  Activity01Icon,
  Menu01Icon,
  Cancel01Icon,
} from '@hugeicons/core-free-icons';
import { WalletMenu } from '@/components/WalletMenu';
import { ThemeToggle } from '@/components/ThemeToggle';

const LINKS = [
  { href: '/app', label: 'App', icon: GridViewIcon },
  { href: '/dashboard', label: 'Dashboard', icon: DashboardSquare01Icon },
  { href: '/discover', label: 'Discover', icon: Search01Icon },
  { href: '/app/subscriptions', label: 'Subscriptions', icon: RepeatIcon },
  { href: '/activity', label: 'Activity', icon: Activity01Icon },
  { href: '/settings', label: 'Settings', icon: Settings01Icon },
];

/**
 * Shared navigation for the authenticated app shell (/app, /dashboard,
 * /settings, /activity). Highlights the active route and exposes mobile navigation
 * toggle and wallet chip + sign-out via <WalletMenu>.
 */
export function AppNav() {
  const pathname = usePathname();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <nav
      style={{ top: 'var(--offline-banner-h, 0px)' }}
      className="sticky w-full z-50 bg-background border-b-4 border-ink"
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex justify-between items-center gap-4">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            aria-label="Toggle mobile menu"
            aria-expanded={mobileMenuOpen}
            className="sm:hidden btn-brutal btn-brutal-white p-2 min-h-[44px] min-w-[44px] flex items-center justify-center"
          >
            <HugeiconsIcon icon={mobileMenuOpen ? Cancel01Icon : Menu01Icon} size={22} strokeWidth={2} />
          </button>
          <Link href="/app" className="text-xl sm:text-2xl font-extrabold text-ink shrink-0 tracking-tight">
            SupportMe
          </Link>
        </div>

        <div className="hidden sm:flex items-center gap-6">
          {LINKS.map((link) => {
            const active = pathname === link.href;
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={active ? 'page' : undefined}
                className={`flex items-center gap-2 font-bold transition min-h-[44px] ${
                  active ? 'text-primary underline underline-offset-4' : 'text-ink hover:text-primary'
                }`}
              >
                <HugeiconsIcon icon={link.icon} size={18} strokeWidth={2} />
                {link.label}
              </Link>
            );
          })}
        </div>

        <div className="flex items-center gap-4 shrink-0">
          <ThemeToggle />
          <WalletMenu />
        </div>
      </div>

      {/* Mobile Drawer / Dropdown Menu */}
      {mobileMenuOpen && (
        <div data-testid="mobile-menu" className="sm:hidden border-t-4 border-ink bg-background px-4 py-4 space-y-2">
          {LINKS.map((link) => {
            const active = pathname === link.href;
            return (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setMobileMenuOpen(false)}
                aria-current={active ? 'page' : undefined}
                className={`flex items-center gap-3 px-4 py-3 rounded border-2 border-ink font-bold text-base min-h-[44px] ${
                  active ? 'bg-primary text-white' : 'bg-white text-ink hover:bg-accent-bg'
                }`}
              >
                <HugeiconsIcon icon={link.icon} size={20} strokeWidth={2} />
                {link.label}
              </Link>
            );
          })}
        </div>
      )}
    </nav>
  );
}
