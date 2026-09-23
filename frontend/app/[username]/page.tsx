import type { Metadata } from 'next';
import { API_URL } from '@/lib/api';
import CreatorProfileClient from './CreatorProfileClient';

type ParamsPromise = Promise<{ username: string }>;

interface CreatorSummary {
  username: string;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  ogImageUrl?: string | null;
}

// Server-side only, purely for building link-preview metadata — the client
// component does its own fetch (with live SSE updates) for the actual page.
async function fetchCreatorSummary(username: string): Promise<CreatorSummary | null> {
  try {
    const res = await fetch(`${API_URL}/api/creators/${username}`, {
      next: { revalidate: 60 },
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }: { params: ParamsPromise }): Promise<Metadata> {
  const { username } = await params;
  const creator = await fetchCreatorSummary(username);

  if (!creator) {
    return { title: 'Creator not found — SupportMe' };
  }

  const name = creator.displayName || creator.username;
  const description = creator.bio?.trim() || `Support ${name} with a tip on SupportMe.`;
  const title = `${name} (@${creator.username}) on SupportMe`;
  // Prefer the dynamically generated OG image (name/avatar/goal composited server-side)
  // and fall back to the creator's avatar, then to no image at all.
  const ogImage = creator.ogImageUrl || creator.avatarUrl || undefined;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      url: `/${creator.username}`,
      siteName: 'SupportMe',
      type: 'profile',
      images: ogImage ? [{ url: ogImage }] : undefined,
    },
    twitter: {
      card: ogImage ? 'summary_large_image' : 'summary',
      title,
      description,
      images: ogImage ? [ogImage] : undefined,
    },
  };
}

export default function CreatorProfilePage({ params }: { params: ParamsPromise }) {
  return <CreatorProfileClient params={params} />;
}
