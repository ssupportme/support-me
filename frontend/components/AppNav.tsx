'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  GridViewIcon,
  DashboardSquare01Icon,
  Settings01Icon,
  RepeatIcon,
  Activity01Icon,
  Search01Icon,
} from '@hugeicons/core-free-icons';
import { WalletMenu } from '@/components/WalletMenu';

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
 * /settings). Landing page keeps its own marketing nav. Highlights the active
 * route and exposes the wallet chip + sign-out via <WalletMenu>.
 */
export function AppNav() {
  const pathname = usePathname();

  const primaryMobileLinks = LINKS.filter((link) =>
    ['/app', '/dashboard', '/discover', '/activity'].includes(link.href)
  );

  return (
    <>
      <nav
        style={{ top: 'var(--offline-banner-h, 0px)' }}
        className="sticky w-full z-50 bg-background border-b-4 border-ink"
      >
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex justify-between items-center gap-4">
          <Link href="/app" className="text-xl sm:text-2xl font-extrabold font-display text-ink shrink-0 tracking-tight">
            SupportMe
          </Link>

          <div className="hidden sm:flex items-center gap-6">
            {LINKS.map((link) => {
              const active = pathname === link.href;
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  aria-current={active ? 'page' : undefined}
                  className={`flex items-center gap-2 font-bold transition ${
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
            <WalletMenu />
          </div>
        </div>
      </nav>

      {/* Mobile Bottom Tab Bar below sm breakpoint */}
      <nav
        aria-label="Mobile Bottom Navigation"
        className="sm:hidden fixed bottom-0 left-0 right-0 z-50 bg-background border-t-4 border-ink px-2 py-2 flex justify-around items-center shadow-lg"
      >
        {primaryMobileLinks.map((link) => {
          const active = pathname === link.href;
          return (
            <Link
              key={link.href}
              href={link.href}
              aria-current={active ? 'page' : undefined}
              className={`flex flex-col items-center gap-1 font-bold text-xs transition-colors px-2 py-1 rounded-lg ${
                active ? 'text-primary bg-accent-bg border border-ink' : 'text-ink hover:text-primary'
              }`}
            >
              <HugeiconsIcon icon={link.icon} size={20} strokeWidth={2} />
              <span>{link.label}</span>
            </Link>
          );
        })}
      </nav>
    </>
  );
}
