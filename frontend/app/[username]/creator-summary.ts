import { API_URL } from '@/lib/api';

export interface CreatorSummary {
  username: string;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  donationGoal: number | null;
  // ISO timestamp of the last profile change; used for JSON-LD dateModified
  // so crawlers see a stable value instead of the render time (#459).
  updatedAt: string;
}

// Server-side only, purely for building link-preview metadata and images —
// the client component does its own fetch (with live SSE updates) for the
// actual page. Next dedupes/caches this fetch across metadata and image routes.
export async function fetchCreatorSummary(username: string): Promise<CreatorSummary | null> {
  try {
    const res = await fetch(`${API_URL}/api/creators/${encodeURIComponent(username)}`, {
      next: { revalidate: 60 },
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}
