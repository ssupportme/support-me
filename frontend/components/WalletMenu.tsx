'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  Activity01Icon,
  RepeatIcon,
  Settings01Icon,
} from '@hugeicons/core-free-icons';
import { useAuth } from '@/context/AuthContext';

/**
 * Secondary destinations, kept out of the desktop top nav so it stays short
 * (#151). They live here alongside the wallet address and sign-out, which is
 * the one control that is always visible in the header.
 */
const SECONDARY_LINKS = [
  { href: '/app/subscriptions', label: 'Subscriptions', icon: RepeatIcon },
  { href: '/activity', label: 'Activity', icon: Activity01Icon },
  { href: '/settings', label: 'Settings', icon: Settings01Icon },
];

function sliceAddress(addr: string) {
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

export function truncateEmail(email: string, maxLen = 18): string {
  if (email.length <= maxLen) return email;
  const at = email.indexOf('@');
  if (at !== -1) {
    const user = email.slice(0, at);
    const domain = email.slice(at);
    if (user.length > 8) {
      return `${user.slice(0, 6)}…${domain}`;
    }
  }
  return `${email.slice(0, maxLen - 1)}…`;
}

/**
 * The account identifier shown in the header chip. A user signed in with a
 * wallet has walletAddress; a Twitter-only user has neither; a magic-link user has
 * email. Truncates long email addresses to prevent mobile nav overflow (#455).
 */
export function accountLabel(user: { walletAddress: string | null; email?: string | null }): string {
  if (user.walletAddress) return sliceAddress(user.walletAddress);
  if (user.email) return truncateEmail(user.email);
  return 'Account';
}

/**
 * Wallet chip shown in place of a bare "Sign Out" button: displays the
 * connected wallet's sliced address or truncated email with a down arrow;
 * clicking opens a small menu with secondary destinations and Sign Out.
 * Supports APG menu-button keyboard navigation (roving focus, arrows, Escape returns focus).
 */
export function WalletMenu() {
  const { user, logout } = useAuth();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const getMenuItems = () => {
    if (!menuRef.current) return [];
    return Array.from(menuRef.current.querySelectorAll<HTMLElement>('[role="menuitem"]'));
  };

  const focusItem = (index: number) => {
    const items = getMenuItems();
    if (items.length === 0) return;
    const targetIndex = (index + items.length) % items.length;
    items[targetIndex]?.focus();
  };

  const openAndFocus = (first = true) => {
    setOpen(true);
    setTimeout(() => {
      const items = getMenuItems();
      if (items.length > 0) {
        items[first ? 0 : items.length - 1]?.focus();
      }
    }, 0);
  };

  const closeAndFocusTrigger = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const handleTriggerKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openAndFocus(true);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      openAndFocus(false);
    }
  };

  const handleMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = getMenuItems();
    if (!items.length) return;
    const currentIndex = items.indexOf(document.activeElement as HTMLElement);

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusItem(currentIndex === -1 ? 0 : currentIndex + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusItem(currentIndex === -1 ? items.length - 1 : currentIndex - 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      focusItem(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      focusItem(items.length - 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeAndFocusTrigger();
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeAndFocusTrigger();
      }
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!user) return null;

  return (
    <div className="relative" ref={containerRef}>
      <button
        ref={triggerRef}
        onClick={() => {
          if (open) {
            setOpen(false);
          } else {
            openAndFocus(true);
          }
        }}
        onKeyDown={handleTriggerKeyDown}
        aria-label={`Wallet menu (${accountLabel(user)})`}
        aria-haspopup="menu"
        aria-expanded={open}
        className="btn-brutal btn-brutal-white text-sm sm:text-base font-mono gap-1.5 min-h-[44px] flex items-center justify-center focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-[var(--focus-ring)]"
      >
        {accountLabel(user)}
        <span className={`text-xs transition-transform ${open ? 'rotate-180' : ''}`}>▾</span>
      </button>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          onKeyDown={handleMenuKeyDown}
          className="absolute right-0 mt-2 w-48 card-brutal bg-card p-2 z-50 flex flex-col gap-1"
        >
          {/* Secondary destinations, no longer in the top nav (#151) */}
          <div className="border-b border-ink/20 pb-1 mb-1 flex flex-col gap-1">
            {SECONDARY_LINKS.map((link) => {
              const active = pathname === link.href;
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  role="menuitem"
                  tabIndex={-1}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => setOpen(false)}
                  className={`w-full text-left px-3 py-2 rounded-lg font-bold transition-colors min-h-[44px] flex items-center gap-2 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)] focus-visible:bg-accent-bg ${
                    active ? 'bg-accent-bg text-primary' : 'text-ink hover:bg-accent-bg'
                  }`}
                >
                  <HugeiconsIcon icon={link.icon} size={18} strokeWidth={2} />
                  {link.label}
                </Link>
              );
            })}
          </div>

          <button
            role="menuitem"
            tabIndex={-1}
            onClick={() => {
              logout();
              window.location.href = '/';
            }}
            className="w-full text-left px-3 py-2 rounded-lg font-bold text-ink hover:bg-brand-pink transition-colors min-h-[44px] flex items-center focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)] focus-visible:bg-brand-pink"
          >
            Sign Out
          </button>
        </div>
      )}
    </div>
  );
}
