'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/context/AuthContext';

function sliceAddress(addr: string) {
  if (!addr) return '';
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

/**
 * Wallet chip shown in place of a bare "Sign Out" button: displays the
 * connected wallet's sliced address with a down arrow; clicking opens a small
 * menu with the Sign Out action. Closes on outside-click or Escape.
 */
export function WalletMenu() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
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
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="btn-brutal btn-brutal-white text-sm sm:text-base font-mono gap-1.5"
      >
        {sliceAddress(user.walletAddress)}
        <span className={`text-xs transition-transform ${open ? 'rotate-180' : ''}`}>▾</span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-2 w-48 card-brutal bg-card p-2 z-50 flex flex-col gap-1"
        >
          {/* Mobile-only menu items for secondary destinations */}
          <div className="sm:hidden border-b border-ink/20 pb-1 mb-1 flex flex-col gap-1">
            <Link
              href="/app/subscriptions"
              onClick={() => setOpen(false)}
              className="w-full text-left px-3 py-2 rounded-lg font-bold text-ink hover:bg-accent-bg transition-colors"
            >
              Subscriptions
            </Link>
            <Link
              href="/settings"
              onClick={() => setOpen(false)}
              className="w-full text-left px-3 py-2 rounded-lg font-bold text-ink hover:bg-accent-bg transition-colors"
            >
              Settings
            </Link>
          </div>

          <button
            role="menuitem"
            onClick={() => {
              logout();
              window.location.href = '/';
            }}
            className="w-full text-left px-3 py-2 rounded-lg font-bold text-ink hover:bg-brand-pink transition-colors"
          >
            Sign Out
          </button>
        </div>
      )}
    </div>
  );
}
