import { NextResponse } from 'next/server';

export const revalidate = 60;

export async function GET() {
  const key = process.env.COINGECKO_API_KEY;
  const url = 'https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=ngn&include_last_updated_at=true';

  try {
    const res = await fetch(url, {
      headers: {
        accept: 'application/json',
        ...(key ? { 'x-cg-demo-api-key': key } : {}),
      },
      next: { revalidate: 60 },
    });

    if (res.ok) {
      const json = await res.json();
      const ngnPerUsdt = json?.tether?.ngn;
      const lastUpdatedAt = json?.tether?.last_updated_at;
      const timestamp =
        typeof lastUpdatedAt === 'number' ? lastUpdatedAt * 1000 : Date.now();
      if (ngnPerUsdt != null && typeof ngnPerUsdt === 'number') {
        return NextResponse.json({ rate: ngnPerUsdt, source: 'coingecko', timestamp });
      }
    }
  } catch {
    // Fall through to fallback
  }

  return NextResponse.json({ rate: 1380, source: 'fallback', timestamp: Date.now() });
}
