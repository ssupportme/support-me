'use client';

import { useEffect, useRef, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  Share08Icon,
  Copy01Icon,
  QrCode01Icon,
} from '@hugeicons/core-free-icons';
import { notify } from '@/lib/notify';
import { QrCodeCard } from '@/components/QrCodeCard';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://support-mee.vercel.app';

export interface ShareModalCreator {
  username: string;
  displayName?: string | null;
}

export type ShareMode = 'both' | 'link' | 'qr';

export interface ShareModalProps {
  creator: ShareModalCreator;
  onClose: () => void;
  initialMode?: ShareMode;
  onOpenShareCard?: () => void;
}

/**
 * Modal that lets the user choose how they want to share their profile:
 * Copy Link, QR Code (reusing the existing QrCodeCard component), or both at once.
 * The native OS share sheet also remains available as an explicit option.
 */
export function ShareModal({
  creator,
  onClose,
  initialMode = 'both',
  onOpenShareCard,
}: ShareModalProps) {
  const [mode, setMode] = useState<ShareMode>(initialMode);
  const [copied, setCopied] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);

  const profileUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/${creator.username}`
      : `${SITE_URL}/${creator.username}`;

  // Keyboard accessibility: Escape closes modal
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleCopy = async () => {
    if (!profileUrl) return;
    try {
      await navigator.clipboard.writeText(profileUrl);
      setCopied(true);
      notify.success('Profile link copied to clipboard');
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      notify.error('Could not copy link', err);
    }
  };

  const handleNativeShare = async () => {
    if (!profileUrl) return;
    const shareData = {
      title: creator.displayName || creator.username || 'SupportMe',
      text: `Support ${creator.displayName || creator.username} on SupportMe`,
      url: profileUrl,
    };

    if (typeof navigator !== 'undefined' && navigator.share) {
      try {
        await navigator.share(shareData);
      } catch {
        // User dismissed the share sheet — not an error worth surfacing
      }
      return;
    }

    // Fall back to copy link if navigator.share is unavailable
    await handleCopy();
  };

  const showLink = mode === 'both' || mode === 'link';
  const showQr = mode === 'both' || mode === 'qr';

  return (
    <div
      className="fixed inset-0 z-50 bg-ink/70 flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="share-modal-title"
    >
      <div
        ref={modalRef}
        className="card-brutal bg-background max-w-2xl w-full max-h-[90vh] overflow-y-auto p-6 sm:p-8 space-y-6"
      >
        {/* Modal Header */}
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 id="share-modal-title" className="text-2xl font-extrabold text-ink">
              Share Profile
            </h2>
            <p className="text-sm text-muted font-medium mt-1">
              Choose how you want to share your tipping profile.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="btn-brutal btn-brutal-white px-3 py-1.5 text-sm shrink-0"
          >
            Close
          </button>
        </div>

        {/* Choice buttons: Both, Copy Link, QR Code */}
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="Share choices">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'both'}
            onClick={() => setMode('both')}
            className={`btn-brutal text-sm px-4 py-2 ${
              mode === 'both' ? 'btn-brutal-primary' : 'btn-brutal-white'
            }`}
          >
            Both
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'link'}
            onClick={() => setMode('link')}
            className={`btn-brutal text-sm px-4 py-2 gap-1.5 ${
              mode === 'link' ? 'btn-brutal-primary' : 'btn-brutal-white'
            }`}
          >
            <HugeiconsIcon icon={Copy01Icon} size={16} strokeWidth={2} />
            Copy Link
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'qr'}
            onClick={() => setMode('qr')}
            className={`btn-brutal text-sm px-4 py-2 gap-1.5 ${
              mode === 'qr' ? 'btn-brutal-primary' : 'btn-brutal-white'
            }`}
          >
            <HugeiconsIcon icon={QrCode01Icon} size={16} strokeWidth={2} />
            QR Code
          </button>
          {onOpenShareCard && (
            <button
              type="button"
              onClick={() => {
                onClose();
                onOpenShareCard();
              }}
              className="btn-brutal btn-brutal-white text-sm px-4 py-2 sm:ml-auto"
            >
              Social Graphic Card →
            </button>
          )}
        </div>

        {/* Link Section */}
        {showLink && (
          <div className="card-brutal p-5 bg-card space-y-3" data-testid="share-link-section">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-extrabold text-ink">Profile Link</h3>
              <span className="text-xs font-bold text-muted uppercase tracking-wider">
                Direct URL
              </span>
            </div>
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
              <input
                type="text"
                readOnly
                value={profileUrl}
                onClick={(e) => (e.target as HTMLInputElement).select()}
                className="input-brutal font-mono text-sm flex-1 text-ink"
                aria-label="Profile link input"
              />
              <button
                type="button"
                onClick={handleCopy}
                className="btn-brutal btn-brutal-primary gap-1.5 shrink-0"
                aria-label="Copy profile link"
              >
                <HugeiconsIcon icon={Copy01Icon} size={18} strokeWidth={2} />
                {copied ? 'Copied!' : 'Copy Link'}
              </button>
            </div>

            <div className="pt-2 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={handleNativeShare}
                className="btn-brutal btn-brutal-white gap-2 text-sm"
                aria-label="Share via device"
              >
                <HugeiconsIcon icon={Share08Icon} size={18} strokeWidth={2} />
                Share via device / OS
              </button>
              <span className="text-xs text-muted font-medium">
                Opens your phone or desktop native share sheet
              </span>
            </div>
          </div>
        )}

        {/* QR Code Section (reusing QrCodeCard) */}
        {showQr && (
          <div data-testid="share-qr-section">
            <QrCodeCard creator={{ username: creator.username }} />
          </div>
        )}
      </div>
    </div>
  );
}
